import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ensureRdkit,
  generateSmiles2DMolfile,
  resetRdkitForTesting,
  setRdkitModuleLoader,
  type RdkitJsMol,
  type RdkitMinimalModule
} from "./conformer";

const CROWDED_STEREO_SMILES =
  "C1CN2CC3=CCO[C@H]4CC(=O)N5[C@H]6[C@H]4[C@H]3C[C@H]2[C@@]61C7=CC=CC=C75";
const REPORTED_POLYETHER_SMILES =
  "C[C@@H]1C[C@H]2[C@@H](C[C@]3([C@H](O2)C[C@H]4[C@H](O3)C(=CC(=O)O4)C)C)O[C@@H]5[C@@H]1O[C@H]6C[C@@H]7[C@](C[C@@H]8[C@@H](O7)C/C=C\\[C@@H]9[C@@H](O8)C[C@@H]1[C@@H](O9)C[C@@H]2[C@@](O1)([C@H](C[C@H](O2)CC(=C)C=O)O)C)(O[C@@]6(CC5)C)C";

interface V2000Geometry {
  atoms: Array<{ x: number; y: number }>;
  bonds: Array<{ from: number; to: number; stereo: number }>;
}

function v2000Geometry(molfile: string): V2000Geometry {
  const lines = molfile.split(/\r?\n/);
  const countsIndex = lines.findIndex((line) => /\bV2000\b/.test(line));
  const atomCount = Number.parseInt((lines[countsIndex] ?? "").slice(0, 3).trim(), 10);
  const bondCount = Number.parseInt((lines[countsIndex] ?? "").slice(3, 6).trim(), 10);
  const atoms = lines.slice(countsIndex + 1, countsIndex + 1 + atomCount).map((line) => ({
    x: Number.parseFloat(line.slice(0, 10)),
    y: Number.parseFloat(line.slice(10, 20))
  }));
  const bonds = lines
    .slice(countsIndex + 1 + atomCount, countsIndex + 1 + atomCount + bondCount)
    .map((line) => ({
      from: Number.parseInt(line.slice(0, 3).trim(), 10) - 1,
      to: Number.parseInt(line.slice(3, 6).trim(), 10) - 1,
      stereo: Number.parseInt(line.slice(9, 12).trim(), 10) || 0
    }));
  return { atoms, bonds };
}

function properBondCrossings({ atoms, bonds }: V2000Geometry): number {
  const orientation = (a: number, b: number, c: number): number => {
    const first = atoms[a];
    const second = atoms[b];
    const third = atoms[c];
    if (!first || !second || !third) return 0;
    return (second.x - first.x) * (third.y - first.y) -
      (second.y - first.y) * (third.x - first.x);
  };
  let crossings = 0;
  for (let left = 0; left < bonds.length; left += 1) {
    for (let right = left + 1; right < bonds.length; right += 1) {
      const a = bonds[left];
      const b = bonds[right];
      if (!a || !b || new Set([a.from, a.to, b.from, b.to]).size < 4) continue;
      if (
        orientation(a.from, a.to, b.from) * orientation(a.from, a.to, b.to) < -1e-8 &&
        orientation(b.from, b.to, a.from) * orientation(b.from, b.to, a.to) < -1e-8
      ) {
        crossings += 1;
      }
    }
  }
  return crossings;
}

function minimumNonbondedDistanceInBondLengths({ atoms, bonds }: V2000Geometry): number {
  const bonded = new Set(bonds.flatMap((bond) => [
    `${bond.from}:${bond.to}`,
    `${bond.to}:${bond.from}`
  ]));
  const lengths = bonds.map((bond) => {
    const from = atoms[bond.from];
    const to = atoms[bond.to];
    return from && to ? Math.hypot(to.x - from.x, to.y - from.y) : 0;
  });
  const meanLength = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  let minimum = Number.POSITIVE_INFINITY;
  for (let first = 0; first < atoms.length; first += 1) {
    for (let second = first + 1; second < atoms.length; second += 1) {
      if (bonded.has(`${first}:${second}`)) continue;
      const a = atoms[first];
      const b = atoms[second];
      if (!a || !b) continue;
      minimum = Math.min(minimum, Math.hypot(b.x - a.x, b.y - a.y) / meanLength);
    }
  }
  return minimum;
}

function normalizedDepictionBounds({ atoms, bonds }: V2000Geometry): {
  width: number;
  height: number;
  aspectRatio: number;
  bondLengthCoefficientOfVariation: number;
} {
  const lengths = bonds.map((bond) => {
    const from = atoms[bond.from];
    const to = atoms[bond.to];
    return from && to ? Math.hypot(to.x - from.x, to.y - from.y) : 0;
  });
  const meanLength = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  const variance = lengths.reduce((sum, length) => sum + (length - meanLength) ** 2, 0) / lengths.length;
  const xs = atoms.map((atom) => atom.x);
  const ys = atoms.map((atom) => atom.y);
  const width = (Math.max(...xs) - Math.min(...xs)) / meanLength;
  const height = (Math.max(...ys) - Math.min(...ys)) / meanLength;
  return {
    width,
    height,
    aspectRatio: width / height,
    bondLengthCoefficientOfVariation: Math.sqrt(variance) / meanLength
  };
}

async function canonicalIsomericSmiles(structure: string): Promise<string> {
  const rdkit = await ensureRdkit();
  const molecule = rdkit.get_mol(structure) as RdkitJsMol | null;
  if (!molecule?.get_smiles) {
    molecule?.delete();
    throw new Error("The real RDKit fixture cannot produce canonical isomeric SMILES.");
  }
  try {
    return molecule.get_smiles();
  } finally {
    molecule.delete();
  }
}

beforeAll(() => {
  const glueUrl = new URL("../vendor/RDKit_minimal.js", import.meta.url);
  const wasmUrl = new URL("../vendor/RDKit_minimal.wasm", import.meta.url);
  const glueSource = readFileSync(glueUrl, "utf8");
  const wasmBinary = new Uint8Array(readFileSync(wasmUrl));
  const factory = new Function("require", "__dirname", `${glueSource}\n;return initRDKitModule;`)(
    createRequire(import.meta.url),
    dirname(fileURLToPath(glueUrl))
  ) as (options: {
    locateFile: (file: string) => string;
    wasmBinary: Uint8Array;
  }) => Promise<RdkitMinimalModule>;
  setRdkitModuleLoader(() => factory({
    locateFile: () => fileURLToPath(wasmUrl),
    wasmBinary
  }));
});

afterAll(() => resetRdkitForTesting());

describe("RDKit real 2D depiction", () => {
  it("lays out the reported bridged polycycle without crossings or lost stereo", async () => {
    const geometry = v2000Geometry(await generateSmiles2DMolfile(CROWDED_STEREO_SMILES));
    expect(geometry.atoms).toHaveLength(25);
    expect(geometry.bonds).toHaveLength(31);
    expect(properBondCrossings(geometry)).toBe(0);
    expect(minimumNonbondedDistanceInBondLengths(geometry)).toBeGreaterThan(0.6);
    expect(geometry.bonds.filter((bond) => bond.stereo === 1 || bond.stereo === 6)).toHaveLength(6);
  });

  it("uses a wide, readable CoordGen layout for the reported polyether without changing stereo", async () => {
    const molfile = await generateSmiles2DMolfile(REPORTED_POLYETHER_SMILES);
    const geometry = v2000Geometry(molfile);
    const bounds = normalizedDepictionBounds(geometry);

    expect(geometry.atoms).toHaveLength(63);
    expect(geometry.bonds).toHaveLength(73);
    expect(geometry.bonds.filter((bond) => bond.stereo === 1 || bond.stereo === 6)).toHaveLength(23);
    expect(properBondCrossings(geometry)).toBe(0);
    expect(minimumNonbondedDistanceInBondLengths(geometry)).toBeGreaterThan(0.9);
    expect(bounds.width).toBeGreaterThan(20);
    expect(bounds.height).toBeLessThan(9);
    expect(bounds.aspectRatio).toBeGreaterThan(2.5);
    expect(bounds.bondLengthCoefficientOfVariation).toBeLessThan(0.01);
    expect(geometry.atoms[0]!.x).toBeLessThan(
      geometry.atoms.reduce((sum, atom) => sum + atom.x, 0) / geometry.atoms.length
    );
    expect(await canonicalIsomericSmiles(molfile)).toBe(
      await canonicalIsomericSmiles(REPORTED_POLYETHER_SMILES)
    );
  });
});
