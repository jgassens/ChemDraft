import { describe, expect, it } from "vitest";
import { applyPatches, createEmptyDocument, dropOrphanedHydrogenHints, type MoleculeObject } from "./index";

// A pyrrole as CDXML imports it (aromatic ring bonds, the N's NumHydrogens and one carbon's kept),
// with a single N–Zn bond whose dative meaning an edit can toggle.
const imported = (): MoleculeObject => ({
  id: "m", type: "molecule", x: 0, y: 0, width: 40, height: 40, rotation: 0, style: {},
  structureFormat: "molfile-v2000", structure: "", superatoms: [], rGroups: [],
  atoms: [
    { id: "n", element: "N", x: 0, y: 0, formalCharge: 0, hydrogenCount: 1 },
    { id: "c", element: "C", x: 20, y: 0, formalCharge: 0, hydrogenCount: 1 },
    { id: "c2", element: "C", x: 26, y: 18, formalCharge: 0 },
    { id: "c3", element: "C", x: 10, y: 30, formalCharge: 0 },
    { id: "c4", element: "C", x: -6, y: 18, formalCharge: 0 },
    { id: "zn", element: "Zn", x: 40, y: 0, formalCharge: 0 },
    { id: "zn2", element: "Zn", x: -20, y: 0, formalCharge: 0 }
  ],
  bonds: [
    { id: "b", fromAtomId: "n", toAtomId: "c", order: "aromatic" },
    { id: "b2", fromAtomId: "c", toAtomId: "c2", order: "aromatic" },
    { id: "b3", fromAtomId: "c2", toAtomId: "c3", order: "aromatic" },
    { id: "b4", fromAtomId: "c3", toAtomId: "c4", order: "aromatic" },
    { id: "b5", fromAtomId: "c4", toAtomId: "n", order: "aromatic" },
    { id: "bz", fromAtomId: "n", toAtomId: "zn2", order: "single" }
  ]
});

describe("imported hydrogen hints expire on chemical edits", () => {
  it.each([
    ["add covalent bond", (m: MoleculeObject) => m.bonds.push({ id: "new", fromAtomId: "n", toAtomId: "zn", order: "single" })],
    ["add dative bond", (m: MoleculeObject) => m.bonds.push({ id: "new", fromAtomId: "n", toAtomId: "zn", order: "single", display: { bondStyle: "dashed" } })],
    ["remove bond", (m: MoleculeObject) => { m.bonds = m.bonds.filter((bond) => bond.id !== "b5"); }],
    ["change order", (m: MoleculeObject) => { m.bonds[0]!.order = "double"; }],
    ["change dative meaning", (m: MoleculeObject) => { m.bonds[5]!.display = { bondStyle: "dashed" }; }],
    ["change element", (m: MoleculeObject) => { m.atoms[0]!.element = "C"; }],
    ["change charge", (m: MoleculeObject) => { m.atoms[0]!.formalCharge = 1; }]
  ] as const)("%s clears the affected atom's hint through document patches", (_name, edit) => {
    const document = createEmptyDocument();
    const before = imported();
    const after = structuredClone(before);
    edit(after);
    const result = applyPatches(document, [
      { op: "addObject", pageId: document.pages[0]!.id, object: before },
      { op: "updateObject", objectId: before.id, changes: after }
    ]).pages[0]!.objects[0] as MoleculeObject;
    expect(result.atoms[0]!.hydrogenCount).toBeUndefined();
    expect(before.atoms[0]!.hydrogenCount).toBe(1);
  });

  it("keeps imported hints on geometry, wedge and color edits", () => {
    const document = createEmptyDocument();
    const before = imported();
    const result = applyPatches(document, [
      { op: "addObject", pageId: document.pages[0]!.id, object: before },
      { op: "updateObject", objectId: before.id, changes: {
        atoms: before.atoms.map((atom) => ({ ...atom, x: atom.x + 1 })),
        bonds: before.bonds.map((bond) => ({
          ...bond, fromAtomId: bond.toAtomId, toAtomId: bond.fromAtomId, display: { bondStyle: "wedge" as const }
        })),
        style: { bondColor: "#123456" }
      } }
    ]).pages[0]!.objects[0] as MoleculeObject;
    expect(result.atoms.map((atom) => atom.hydrogenCount)).toEqual([1, 1, undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("a hint only survives on an atom with an aromatic bond in a ring", () => {
  const add = (molecule: MoleculeObject): MoleculeObject => {
    const document = createEmptyDocument();
    return applyPatches(document, [{ op: "addObject", pageId: document.pages[0]!.id, object: molecule }])
      .pages[0]!.objects[0] as MoleculeObject;
  };

  it("keeps the hints of a whole aromatic ring when the molecule is added", () => {
    expect(add(imported()).atoms.map((atom) => atom.hydrogenCount))
      .toEqual([1, 1, undefined, undefined, undefined, undefined, undefined]);
  });

  it("drops a hint when a new molecule keeps only part of the ring (a copied N plus one neighbour)", () => {
    // Built directly, as a fragment copy, split or external paste would: there is no previous
    // graph to diff, so the stale count must be dropped on the way in.
    const whole = imported();
    const fragment: MoleculeObject = {
      ...whole,
      atoms: whole.atoms.filter((atom) => atom.id === "n" || atom.id === "c"),
      bonds: whole.bonds.filter((bond) => bond.id === "b")
    };
    expect(fragment.bonds.map((bond) => bond.order)).toEqual(["aromatic"]);
    expect(add(fragment).atoms.map((atom) => atom.hydrogenCount)).toEqual([undefined, undefined]);
    // The input is never mutated.
    expect(fragment.atoms[0]!.hydrogenCount).toBe(1);
  });

  it("drops a hint on an atom with no aromatic bond at all", () => {
    const molecule: MoleculeObject = {
      ...imported(),
      atoms: [
        { id: "n", element: "N", x: 0, y: 0, formalCharge: 0, hydrogenCount: 2 },
        { id: "c", element: "C", x: 20, y: 0, formalCharge: 0, hydrogenCount: 3 }
      ],
      bonds: [{ id: "b", fromAtomId: "n", toAtomId: "c", order: "single" }]
    };
    expect(add(molecule).atoms.map((atom) => atom.hydrogenCount)).toEqual([undefined, undefined]);
  });

  it("drops the hint through an update that cuts the ring down to an acyclic aromatic bond", () => {
    const document = createEmptyDocument();
    const before = imported();
    const result = applyPatches(document, [
      { op: "addObject", pageId: document.pages[0]!.id, object: before },
      { op: "updateObject", objectId: before.id, changes: {
        atoms: before.atoms.filter((atom) => atom.id === "n" || atom.id === "c"),
        bonds: before.bonds.filter((bond) => bond.id === "b")
      } }
    ]).pages[0]!.objects[0] as MoleculeObject;
    expect(result.atoms.map((atom) => atom.hydrogenCount)).toEqual([undefined, undefined]);
  });

  it("returns the same array when there is nothing to drop", () => {
    const { atoms, bonds } = imported();
    expect(dropOrphanedHydrogenHints(atoms, bonds)).toBe(atoms);
  });
});
