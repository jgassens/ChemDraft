import { describe, expect, it } from "vitest";
import { moleculeToMolfileV2000, moleculeToMolfileV3000 } from "./molfile";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "./schemas";

type AtomSpec = {
  id: string;
  element: string;
  x: number;
  y: number;
  charge?: number;
  markRadicals?: number;
};
type BondSpec = { id: string; from: string; to: string; order?: MoleculeBond["order"]; style?: "wedge" | "hashed" };

function molecule(atoms: AtomSpec[], bonds: BondSpec[]): MoleculeObject {
  return {
    id: "mol_1",
    type: "molecule",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    style: {},
    structureFormat: "molfile-v2000",
    structure: "",
    atoms: atoms.map(
      ({ id, element, x, y, charge = 0, markRadicals }): MoleculeAtom => ({
        id,
        element,
        x,
        y,
        formalCharge: charge,
        ...(markRadicals !== undefined ? { markRadicals } : {})
      })
    ),
    bonds: bonds.map(
      ({ id, from, to, order = "single", style }): MoleculeBond => ({
        id,
        fromAtomId: from,
        toAtomId: to,
        order,
        ...(style ? { display: { bondStyle: style } } : {})
      })
    ),
    superatoms: [],
    rGroups: []
  };
}

function atomLines(molfile: string): string[] {
  const lines = molfile.split("\n");
  const counts = lines.findIndex((l) => l.includes("V2000"));
  return lines.slice(counts + 1, counts + 1 + 4); // the 4-atom fixtures below
}

const chiral = molecule(
  [
    { id: "a0", element: "C", x: 0, y: 0 },
    { id: "a1", element: "F", x: 1, y: 1 },
    { id: "a2", element: "Cl", x: -1, y: 1 },
    { id: "a3", element: "Br", x: 0, y: -1 }
  ],
  [
    { id: "b1", from: "a0", to: "a1", style: "wedge" },
    { id: "b2", from: "a0", to: "a2" },
    { id: "b3", from: "a0", to: "a3" }
  ]
);

describe("moleculeToMolfileV2000 — structure", () => {
  it("writes a counts line with atom/bond counts and chiral flag set when wedged", () => {
    const mf = moleculeToMolfileV2000(chiral);
    const counts = mf.split("\n").find((l) => l.includes("V2000")) as string;
    expect(counts).toMatch(/^\s{2}4\s{2}3\s{2}0\s{2}0\s{2}1\s/); // 4 atoms, 3 bonds, chiral=1
    expect(mf.trimEnd().endsWith("M  END")).toBe(true);
  });

  it("clears the chiral flag when there is no wedge/hash", () => {
    const flat = molecule(
      [
        { id: "a0", element: "C", x: 0, y: 0 },
        { id: "a1", element: "O", x: 0, y: 1 }
      ],
      [{ id: "b1", from: "a0", to: "a1", order: "double" }]
    );
    const counts = moleculeToMolfileV2000(flat).split("\n").find((l) => l.includes("V2000")) as string;
    expect(counts).toMatch(/^\s{2}2\s{2}1\s{2}0\s{2}0\s{2}0\s/); // chiral=0
  });

  it("preserves atom order and element symbols", () => {
    const lines = atomLines(moleculeToMolfileV2000(chiral));
    expect(lines[0]).toContain("C  ");
    expect(lines[1]).toContain("F  ");
    expect(lines[2]).toContain("Cl ");
    expect(lines[3]).toContain("Br ");
  });

  it("encodes the wedge as a bond stereo flag 1 at the narrow end (fromAtomId first)", () => {
    const mf = moleculeToMolfileV2000(chiral);
    // bond b1: a0(1) -> a1(2), single(1), wedge(1)
    expect(mf).toMatch(/\n\s{2}1\s{2}2\s{2}1\s{2}1\s{2}0/);
  });

  it("negates y only under fromDocFrame, leaving x and styles untouched", () => {
    const math = atomLines(moleculeToMolfileV2000(chiral));
    const doc = atomLines(moleculeToMolfileV2000(chiral, { fromDocFrame: true }));
    // a1 is at y=1; math frame writes +1.0000, doc frame writes -1.0000.
    expect(math[1]).toContain("1.0000");
    expect(doc[1]).toContain("-1.0000");
    // x column identical between the two.
    expect(math[1].slice(0, 10)).toBe(doc[1].slice(0, 10));
  });

  it("emits an M  CHG line for nonzero formal charges", () => {
    const ion = molecule(
      [
        { id: "a0", element: "N", x: 0, y: 0, charge: 1 },
        { id: "a1", element: "O", x: 1, y: 0, charge: -1 }
      ],
      [{ id: "b1", from: "a0", to: "a1" }]
    );
    const mf = moleculeToMolfileV2000(ion);
    expect(mf).toMatch(/M {2}CHG {2}2 {3}1 {3}1 {3}2 {2}-1/);
  });

  it("emits an M  RAD line for a drawn radical, using the doublet code for one unpaired electron", () => {
    const radical = molecule(
      [
        { id: "a0", element: "C", x: 0, y: 0, markRadicals: 1 },
        { id: "a1", element: "C", x: 1, y: 0 }
      ],
      [{ id: "b1", from: "a0", to: "a1" }]
    );
    const mf = moleculeToMolfileV2000(radical);
    expect(mf).toMatch(/M {2}RAD {2}1 {3}1 {3}2/);
  });

  it("uses the triplet code for two unpaired electrons on the same atom", () => {
    const carbene = molecule([{ id: "a0", element: "C", x: 0, y: 0, markRadicals: 2 }], []);
    const mf = moleculeToMolfileV2000(carbene);
    expect(mf).toMatch(/M {2}RAD {2}1 {3}1 {3}3/);
  });

  it("omits M  RAD entirely when no atom carries an unpaired electron", () => {
    const flat = molecule(
      [
        { id: "a0", element: "C", x: 0, y: 0 },
        { id: "a1", element: "O", x: 1, y: 0 }
      ],
      [{ id: "b1", from: "a0", to: "a1" }]
    );
    expect(moleculeToMolfileV2000(flat)).not.toContain("M  RAD");
  });
});

describe("moleculeToMolfileV3000 — radicals and charges", () => {
  it("appends RAD= to the atom line for a drawn radical", () => {
    const radical = molecule([{ id: "a0", element: "C", x: 0, y: 0, markRadicals: 1 }], []);
    const mf = moleculeToMolfileV3000(radical);
    expect(mf).toContain("RAD=2");
  });

  it("appends both CHG= and RAD= when an atom carries both", () => {
    const radicalCation = molecule([{ id: "a0", element: "N", x: 0, y: 0, charge: 1, markRadicals: 1 }], []);
    const mf = moleculeToMolfileV3000(radicalCation);
    expect(mf).toContain("CHG=1");
    expect(mf).toContain("RAD=2");
  });

  it("omits RAD= for a non-radical atom", () => {
    const flat = molecule([{ id: "a0", element: "C", x: 0, y: 0 }], []);
    expect(moleculeToMolfileV3000(flat)).not.toContain("RAD=");
  });
});
