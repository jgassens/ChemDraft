import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureRdkit, resetRdkitForTesting } from "../../rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";
import { detectMolfileFormat, parseMolfileGraph } from "./index";

// Literal counts headers deliberately do not use the production writer or a formatter.
const cases = [
  [99, 99, " 99 99  0  0  0  0            999 V2000"],
  [100, 100, "100100  0  0  0  0            999 V2000"],
  [266, 267, "266267  0  0  0  0            999 V2000"],
  [999, 999, "999999  0  0  0  0            999 V2000"]
] as const;

function handwrittenMolfile(atomCount: number, bondCount: number, counts: string): string {
  const atoms = Array.from({ length: atomCount }, (_, index) =>
    `${index.toFixed(4).padStart(10)}    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0`);
  const bonds = Array.from({ length: bondCount }, (_, index) => {
    // One ring, with an extra chord for the 266/267 case.
    const from = index < atomCount ? index + 1 : 1;
    const to = index < atomCount ? (index + 1) % atomCount + 1 : 3;
    return `${String(from).padStart(3)}${String(to).padStart(3)}  1  0`;
  });
  return ["Counts regression", "", "", counts, ...atoms, ...bonds, "M  END"].join("\n");
}

function expectGraph(molfile: string, atoms: number, bonds: number): void {
  expect(detectMolfileFormat(molfile)).toBe("molfile-v2000");
  const graph = parseMolfileGraph(molfile);
  expect(graph.atoms).toHaveLength(atoms);
  expect(graph.bonds).toHaveLength(bonds);
  expect(graph.warnings).toEqual([]);
  const ids = new Set(graph.atoms.map((atom) => atom.id));
  for (const bond of graph.bonds) {
    expect(ids.has(bond.fromAtomId)).toBe(true);
    expect(ids.has(bond.toAtomId)).toBe(true);
  }
}

describe("V2000 fixed-width counts", () => {
  it.each(cases)("reads hand-written %i/%i counts with and without a version tag", (atoms, bonds, counts) => {
    for (const header of [counts, counts.replace(" V2000", "")]) {
      expectGraph(handwrittenMolfile(atoms, bonds, header), atoms, bonds);
    }
  });

  it.each(["3 3 V2000", "3 3 0 0 0 0 V2000", "3 3 0 0 0 0"])(
    "accepts unambiguous under-padded counts: %s", (counts) => {
      expectGraph(handwrittenMolfile(3, 3, counts), 3, 3);
    }
  );

  it.each(["1x  3 V2000", "3.0 3 V2000", "1000 3 V2000"])(
    "does not partially parse malformed or overflowing fields: %s", (counts) => {
      expect(() => parseMolfileGraph(handwrittenMolfile(3, 3, counts))).toThrow(/counts line/);
    }
  );
});

describe("real RDKit V2000 counts", () => {
  beforeAll(installRealRdkitModuleLoader);
  afterAll(resetRdkitForTesting);

  it.each(cases)("reads RDKit output at %i atoms / %i bonds", async (atoms, bonds, counts) => {
    const rdkit = await ensureRdkit();
    // A macrocycle, or a macrocycle with a second ring closure for 266/267.
    const smiles = bonds === atoms
      ? `C1${"C".repeat(atoms - 1)}1`
      : `C12CC2${"C".repeat(atoms - 3)}1`;
    const molecule = rdkit.get_mol(smiles);
    expect(molecule).not.toBeNull();
    try {
      const molfile = molecule!.get_molblock!();
      expect(molfile.split("\n")[3]?.slice(0, 6)).toBe(counts.slice(0, 6));
      expect(molfile).toContain("V2000");
      expectGraph(molfile, atoms, bonds);
    } finally {
      molecule?.delete();
    }
  }, 30_000);
});
