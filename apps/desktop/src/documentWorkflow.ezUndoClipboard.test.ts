import { describe, expect, it } from "vitest";
import { Molecule } from "openchemlib";
import { createDocumentHistory, moleculeToMolfileV3000, undo, type MoleculeObject } from "@chemdraft/chem-core";
import { depictSmiles2D, perceiveDoubleBondStereoFromMolfile } from "@chemdraft/ocl-adapter";
import {
  applyMoleculeBondStereo, copyAsMergedMolecule, createPhase4Document, createSelectionClipboardPayload,
  insertSmilesMolecule, insertSmilesMoleculeGrid, pasteSelectionClipboardPayload, selectDocumentObjects
} from "./documentWorkflow";

describe("E/Z flip undo clipboard", () => {
  // The pure snapshot/copy path already preserved chemistry. The matching DOM regression
  // in canvasContextMenu.bondStereo.dom.test.tsx covers the badge's separate part selection.
  it("copies all 12 carbons in three original components after flipping the first molecule and undoing", () => {
    const smiles = "CC=CC";
    const depiction = depictSmiles2D(smiles, { openUnspecifiedDoubleBonds: true });
    const single = insertSmilesMolecule(createPhase4Document(), { x: 200, y: 200 }, depiction, smiles,
      { openUnspecifiedDoubleBonds: true });
    const grid = insertSmilesMoleculeGrid(single, { x: 300, y: 300 }, [{ smiles, depiction }, { smiles, depiction }]);
    const originals = grid.document.pages[0].objects.filter((o): o is MoleculeObject => o.type === "molecule");
    const original = selectDocumentObjects(grid.document, grid.document.pages[0].id, originals.map(o => o.id));
    const first = originals[0];
    const bond = first.bonds.find(b => b.order === "double")!;
    const target = { objectId: first.id, bondId: bond.id };
    const flipped = applyMoleculeBondStereo(original, [target], "flipped", perceiveDoubleBondStereoFromMolfile);
    expect(flipped).not.toBe(original);
    const restored = undo({ ...createDocumentHistory(original), past: [original], present: flipped }).present;
    expect(restored.pages[0].objects).toEqual(original.pages[0].objects);
    expect(restored.selection.objectIds.every(id => restored.pages[0].objects.some(o => o.id === id))).toBe(true);
    const payload = createSelectionClipboardPayload(restored)!;
    const copied = payload.objects.filter((o): o is MoleculeObject => o.type === "molecule");
    expect(copied.flatMap(o => o.atoms).filter(a => a.element === "C")).toHaveLength(12);
    const canonical = (molecules: MoleculeObject[]) => Molecule.fromMolfile(
      moleculeToMolfileV3000(copyAsMergedMolecule(molecules)!, { fromDocFrame: true }).contents
    ).toIsomericSmiles();
    expect(canonical(copied).split(".")).toHaveLength(3);
    expect(canonical(copied)).toBe(canonical(originals));
    const pasted = pasteSelectionClipboardPayload(restored, payload, { x: 400, y: 400 });
    const pastedMolecules = pasted.pages[0].objects.filter((o): o is MoleculeObject =>
      o.type === "molecule" && pasted.selection.objectIds.includes(o.id));
    expect(canonical(pastedMolecules)).toBe(canonical(originals));
    expect(pastedMolecules.flatMap(o => o.atoms)).toHaveLength(12);
  });
});
