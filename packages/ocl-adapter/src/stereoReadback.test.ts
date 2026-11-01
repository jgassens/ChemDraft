import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Molecule } from "openchemlib";
import {
  depictSmiles2D, ensureOclResources, oclConformerGenerator,
  perceiveDoubleBondStereoFromMolfile, storedCoordinatesMatchStereo
} from "./index";

const fixture = (name: string, format = "v2000") => readFileSync(
  new URL(`../../fixtures/open-double-bonds/${name}.${format}.mol`, import.meta.url), "utf8"
);

function unmarked(molfile: string): string {
  const mol = Molecule.fromMolfile(molfile);
  for (let bond = 0; bond < mol.getAllBonds(); bond++) {
    if (mol.getBondOrder(bond) === 1) mol.setBondType(bond, Molecule.cBondTypeSingle);
  }
  return mol.toMolfile();
}

describe("plain-data stereo perception and stored-coordinate read-back", () => {
  beforeAll(async () => { await ensureOclResources(); });

  it.each(["v2000", "v3000"])("perceives specified E/Z and excludes either (%s)", format => {
    expect(perceiveDoubleBondStereoFromMolfile(fixture("e", format)))
      .toEqual([{ from: 1, to: 2, descriptor: "E" }]);
    expect(perceiveDoubleBondStereoFromMolfile(fixture("z", format)))
      .toEqual([{ from: 1, to: 2, descriptor: "Z" }]);
    expect(perceiveDoubleBondStereoFromMolfile(fixture("open", format))).toEqual([]);
  });

  it.each(["CC=C(C)C", "CC(=C1CCCCC1)C", "C1CCC(=C2CCCCC2)CC1", "CC=O", "c1ccccc1"])(
    "does not invent E/Z for equivalent ligands, terminal bonds or aromatic rings: %s", smiles => {
      expect(perceiveDoubleBondStereoFromMolfile(depictSmiles2D(smiles).molfile)).toEqual([]);
    }
  );

  it("keeps double-bond endpoints in input order when explicit H is compacted", () => {
    const lines = fixture("e").split(/\r?\n/);
    const source = [
      ...lines.slice(0, 3),
      "  5  4  0  0  0  0  0  0  0  0999 V2000",
      "  121.9996 -125.7516    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0",
      ...lines.slice(4, 8),
      "  2  3  1  0  0  0  0",
      "  3  4  2  0  0  0  0",
      "  4  5  1  0  0  0  0",
      "  1  3  1  0  0  0  0",
      "M  END", ""
    ].join("\n");
    const parsed = Molecule.fromMolfileWithAtomMap(source);
    expect(parsed.map[0]).not.toBe(0);
    const result = perceiveDoubleBondStereoFromMolfile(source);
    expect(result).toEqual([{ from: 2, to: 3, descriptor: "E" }]);
    for (const index of [result[0].from, result[0].to]) {
      expect(parsed.molecule.getAtomicNo(parsed.map[index])).toBe(6);
    }
    expect(parsed.molecule.getBondOrder(parsed.molecule.getBond(
      parsed.map[result[0].from], parsed.map[result[0].to]
    ))).toBe(2);
  });

  it.each(["C[C@H](O)/C=C/C", "C[C@H](O)[C@H](F)Cl", "[H][C@](F)(Cl)Br"])(
    "accepts matching 3D stereo, refuses its mirror and planar tetrahedra: %s", async smiles => {
      const reference = depictSmiles2D(smiles).molfile;
      const coords = (await oclConformerGenerator.generate3DConformer({ molfile: reference }, { optimize: "none" }))
        .mapping.coords3dByOriginalAtom;
      const bare = unmarked(reference);
      expect(storedCoordinatesMatchStereo(reference, bare, coords)).toBe(true);
      expect(storedCoordinatesMatchStereo(reference, bare, Array.from(coords, (value, i) => i % 3 === 0 ? -value : value)))
        .toBe(false);
      expect(storedCoordinatesMatchStereo(reference, bare, Array.from(coords, (value, i) => i % 3 === 2 ? 0 : value)))
        .toBe(false);
      // A proper rotation must not change the stereo verdict.
      const rotated = Array.from({ length: coords.length / 3 }, (_, i) =>
        [coords[i * 3 + 2], coords[i * 3], coords[i * 3 + 1]]).flat();
      expect(storedCoordinatesMatchStereo(reference, bare, rotated)).toBe(true);
    }, 30_000
  );

  it("compares 3D E/Z against the drawing and permits open double bonds", async () => {
    const reference = fixture("e");
    const coords = (await oclConformerGenerator.generate3DConformer({ molfile: reference }, { optimize: "none" }))
      .mapping.coords3dByOriginalAtom;
    expect(storedCoordinatesMatchStereo(reference, reference, coords)).toBe(true);
    expect(storedCoordinatesMatchStereo(fixture("z"), reference, coords)).toBe(false);
    expect(storedCoordinatesMatchStereo(fixture("open"), reference, coords)).toBe(true);
    expect(storedCoordinatesMatchStereo(reference, reference, coords.slice(1))).toBe(false);
    expect(storedCoordinatesMatchStereo(reference, reference, Array(coords.length).fill(Number.NaN))).toBe(false);
  });
});
