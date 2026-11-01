import { parseV2000AtomBlock } from "@chemdraft/chemistry-adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureRdkit, resetRdkitForTesting, type RdkitMinimalModule } from "./conformer";
import { installRealRdkitModuleLoader } from "./testing";

let rdkit: RdkitMinimalModule;
let overlappingMolblock: string;
let fragmentHeavyAtoms: [number[], number[]];

interface OptimizeResult {
  embedOk: boolean;
  coords3dByEngineAtom: number[];
  forceField: { status: string; energy: number; iterations: number };
}

/** Translate ethane (including its explicit Hs) to a realistic clash near benzene. */
function overlappingFragments(molblock: string): {
  molblock: string;
  heavyAtoms: [number[], number[]];
} {
  const atoms = parseV2000AtomBlock(molblock);
  if (!atoms) throw new Error("Expected an embedded V2000 molblock");
  const lines = molblock.split(/\r?\n/);
  const countsIndex = lines.findIndex((line) => /\bV2000\b/.test(line));
  const bondCount = Number.parseInt(lines[countsIndex].slice(3, 6), 10);
  const atomStart = countsIndex + 1;
  const adjacency = atoms.map(() => [] as number[]);
  for (const line of lines.slice(atomStart + atoms.length, atomStart + atoms.length + bondCount)) {
    const from = Number.parseInt(line.slice(0, 3), 10) - 1;
    const to = Number.parseInt(line.slice(3, 6), 10) - 1;
    adjacency[from].push(to);
    adjacency[to].push(from);
  }
  // SMILES order: benzene carbons 0..5, ethane carbons 6..7, then generated Hs.
  // Follow bonds so every H on ethane is translated with its parent fragment.
  const ethane = new Set([6]);
  const pending = [6];
  while (pending.length) {
    for (const neighbor of adjacency[pending.pop()!]) {
      if (ethane.has(neighbor)) continue;
      ethane.add(neighbor);
      pending.push(neighbor);
    }
  }
  const offset = {
    x: atoms[0].x + 0.4 - atoms[6].x,
    y: atoms[0].y + 0.3 - atoms[6].y,
    // A 1.868 Å closest heavy-atom contact models an overlapping 3D embed. The old
    // z=0.2 start (0.539 Å) trapped UFF in a distorted, high-energy local minimum;
    // even 50,000 iterations left a 2.447 Å contact and a 2.299 Å benzene bond.
    z: atoms[0].z + 1.8 - atoms[6].z
  };
  const fixed = (value: number) => value.toFixed(4).padStart(10);
  for (const index of ethane) {
    const atom = atoms[index];
    const line = lines[atomStart + index];
    lines[atomStart + index] =
      `${fixed(atom.x + offset.x)}${fixed(atom.y + offset.y)}${fixed(atom.z + offset.z)}${line.slice(30)}`;
  }
  const heavyAtoms: [number[], number[]] = [[], []];
  atoms.forEach((atom, index) => {
    if (atom.element !== "H") heavyAtoms[ethane.has(index) ? 1 : 0].push(index);
  });
  expect(heavyAtoms.map((group) => group.length)).toEqual([6, 2]);
  return { molblock: lines.join("\n"), heavyAtoms };
}

function closestHeavyAtomDistance(coords: number[]): number {
  const distances = fragmentHeavyAtoms[0].flatMap((first) =>
    fragmentHeavyAtoms[1].map((second) => Math.hypot(
      coords[first * 3] - coords[second * 3],
      coords[first * 3 + 1] - coords[second * 3 + 1],
      coords[first * 3 + 2] - coords[second * 3 + 2]
    ))
  );
  return Math.min(...distances);
}

function optimize(forceField: "mmff94s" | "uff", ignoreInterfragInteractions?: boolean): {
  raw: string;
  result: OptimizeResult;
} {
  // Each mode starts from the identical overlapping geometry, with explicit Hs retained.
  const mol = rdkit.get_mol(overlappingMolblock, JSON.stringify({ removeHs: false }));
  if (!mol) throw new Error("RDKit could not parse the overlapping fragments");
  try {
    const raw = mol.optimize_3d_conformer(JSON.stringify({
      forceField, maxIters: 2000, ignoreInterfragInteractions
    }));
    const result = JSON.parse(raw) as OptimizeResult;
    expect(result.embedOk).toBe(true);
    expect(result.forceField.status).toBe("converged");
    expect(Number.isFinite(result.forceField.energy)).toBe(true);
    expect(result.coords3dByEngineAtom.length).toBe(60); // C6H6 + C2H6
    expect(result.coords3dByEngineAtom.every(Number.isFinite)).toBe(true);
    return { raw, result };
  } finally {
    mol.delete();
  }
}

beforeAll(async () => {
  installRealRdkitModuleLoader();
  rdkit = await ensureRdkit();
  const mol = rdkit.get_mol("c1ccccc1.CC");
  if (!mol) throw new Error("RDKit could not parse benzene and ethane");
  try {
    // Fixed seed, no wall-clock timeout. Fragment positioning is explicit after embedding.
    const embed = JSON.parse(mol.generate_3d_embed(JSON.stringify({ seed: 42 })));
    expect(embed.embedOk).toBe(true);
    const overlap = overlappingFragments(embed.molblock);
    overlappingMolblock = overlap.molblock;
    fragmentHeavyAtoms = overlap.heavyAtoms;
    const atoms = parseV2000AtomBlock(overlappingMolblock)!;
    const closest = closestHeavyAtomDistance(atoms.flatMap(({ x, y, z }) => [x, y, z]));
    expect(closest).toBeGreaterThan(1.5);
    expect(closest).toBeLessThan(2);
  } finally {
    mol.delete();
  }
});
afterAll(() => resetRdkitForTesting());

describe("optimize_3d_conformer interfragment interactions (requires vendor patch 0008)", () => {
  for (const forceField of ["mmff94s", "uff"] as const) {
    it(`${forceField}: default and explicit true leave fragments overlapping`, () => {
      const defaultPath = optimize(forceField);
      const explicitTrue = optimize(forceField, true);
      expect(explicitTrue.raw).toBe(defaultPath.raw);
      expect(closestHeavyAtomDistance(defaultPath.result.coords3dByEngineAtom)).toBeLessThan(2.5);
    });

    it(`${forceField}: explicit false reads the flag and separates realistic clashes beyond 2.5 Å`, () => {
      const defaultPath = optimize(forceField);
      const enabled = optimize(forceField, false);
      const defaultDistance = closestHeavyAtomDistance(defaultPath.result.coords3dByEngineAtom);
      const enabledDistance = closestHeavyAtomDistance(enabled.result.coords3dByEngineAtom);
      // Unconditional value probe: an older WASM exposes the same method but ignores this flag.
      // This must fail on the pre-0008 artifact, rather than silently skipping the missing behavior.
      expect(enabledDistance - defaultDistance).toBeGreaterThan(1);
      expect(enabledDistance).toBeGreaterThan(2.5);
    });
  }
});
