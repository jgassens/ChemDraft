import { describe, expect, it } from "vitest";
import { applyPatches, createEmptyDocument, type MoleculeObject } from "./index";

const imported = (): MoleculeObject => ({
  id: "m", type: "molecule", x: 0, y: 0, width: 40, height: 40, rotation: 0, style: {},
  structureFormat: "molfile-v2000", structure: "", superatoms: [], rGroups: [],
  atoms: [
    { id: "n", element: "N", x: 0, y: 0, formalCharge: 0, hydrogenCount: 1 },
    { id: "c", element: "C", x: 20, y: 0, formalCharge: 0, hydrogenCount: 3 },
    { id: "zn", element: "Zn", x: 40, y: 0, formalCharge: 0 }
  ],
  bonds: [{ id: "b", fromAtomId: "n", toAtomId: "c", order: "single" }]
});

describe("imported hydrogen hints expire on chemical edits", () => {
  it.each([
    ["add covalent bond", (m: MoleculeObject) => m.bonds.push({ id: "new", fromAtomId: "n", toAtomId: "zn", order: "single" })],
    ["add dative bond", (m: MoleculeObject) => m.bonds.push({ id: "new", fromAtomId: "n", toAtomId: "zn", order: "single", display: { bondStyle: "dashed" } })],
    ["remove bond", (m: MoleculeObject) => { m.bonds = []; }],
    ["change order", (m: MoleculeObject) => { m.bonds[0]!.order = "double"; }],
    ["change dative meaning", (m: MoleculeObject) => { m.bonds[0]!.display = { bondStyle: "dashed" }; }],
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
    expect(result.atoms.map((atom) => atom.hydrogenCount)).toEqual([1, 3, undefined]);
  });
});
