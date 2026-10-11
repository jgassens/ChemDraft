import { describe, expect, it } from "vitest";
import { moleculeToMolfileV2000, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeBondOrderResolution, nativeSingleBondGraphMetadata, normalizeNativeMoleculeGeometry, tryNativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import { createAtomLabelDraftRollback, recordAtomLabelDraftRollback, restoreAtomLabelDraft, type AtomLabelDraftState } from "./atomLabelDraft";
import { applyColorToNativeMoleculePart, applyNativeAtomElementTarget, commitNativeAtomLabelTarget, createPhase4Document, insertNativeTemplateMolecule, moveNativeMoleculeParts } from "./documentWorkflow";

function molecule(document: ChemDraftDocument): MoleculeObject {
  return document.pages[0].objects[0] as MoleculeObject;
}

function replaceMolecule(document: ChemDraftDocument, next: MoleculeObject): ChemDraftDocument {
  return { ...document, pages: document.pages.map(page => ({ ...page,
    objects: page.objects.map(object => object.id === next.id ? next : object) })) };
}

function fixture() {
  const document = insertNativeTemplateMolecule(createPhase4Document(), { x: 300, y: 300 }, "cyclohexane");
  const original = molecule(document);
  // Import hints left on non-aromatic atoms exercise relabel's molecule-wide orphan cleanup.
  const before: MoleculeObject = { ...original, structureFormat: "molfile-v2000",
    structure: moleculeToMolfileV2000(original, { kekuleBondOrders: nativeBondOrderResolution(original.atoms, original.bonds).kekuleOrders }).contents,
    atoms: original.atoms.map(atom => ({ ...atom, hydrogenCount: 2, warningSuppressed: true,
      labelVisible: true, labelOffset: { x: 1, y: 2 } })) };
  const state: AtomLabelDraftState = { objectId: before.id, atomId: before.atoms[0]!.id,
    draftBeforeAtom: before.atoms[0]!, draftBeforeMolecule: before,
    draftRollback: createAtomLabelDraftRollback(before) };
  return { document: replaceMolecule(document, before), before, state };
}

function draft(document: ChemDraftDocument, state: AtomLabelDraftState, label = "OMe") {
  const next = applyNativeAtomElementTarget(document, {
    objectId: state.objectId, kind: "atom", atomId: state.atomId, distanceToPointer: 0
  }, label, { literal: true });
  recordAtomLabelDraftRollback(state, molecule(document), molecule(next));
  return next;
}

function expectDerivedFromGraph(object: MoleculeObject) {
  const smiles = tryNativeSingleBondGraphSmiles(object.atoms, object.bonds);
  expect(object.structureFormat).toBe("smiles");
  expect(object.structure).toBe("smiles" in smiles ? smiles.smiles : "");
  expect(object.chemistry).toEqual(nativeSingleBondGraphMetadata(object.atoms, object.bonds));
  const geometry = normalizeNativeMoleculeGeometry(object);
  for (const key of ["x", "y", "width", "height"] as const) expect(object[key]).toBe(geometry[key]);
}

describe("atom-label draft rollback", () => {
  it("restores an imported molecule exactly, including hints cleared on other atoms", () => {
    const { document, before, state } = fixture();
    const preview = draft(document, state);
    expect(molecule(preview).atoms.every(atom => atom.hydrogenCount === undefined)).toBe(true);
    expect(molecule(restoreAtomLabelDraft(preview, state))).toEqual(before);
  });

  it("keeps another atom's move and flags and recomputes structure, chemistry and bounds", () => {
    const { document, before, state } = fixture();
    const preview = draft(document, state);
    const other = before.atoms[2]!;
    const moved = moveNativeMoleculeParts(preview, { objectId: before.id, kind: "atom", atomId: other.id }, { x: 120, y: 60 });
    const restored = molecule(restoreAtomLabelDraft(moved, state));
    expect(restored.atoms[0]).toEqual(before.atoms[0]);
    expect(restored.atoms[2]).toEqual(molecule(moved).atoms[2]);
    expect(restored.atoms[1]).toEqual(before.atoms[1]);
    expect(restored.atoms[2]!.hydrogenCount).toBeUndefined();
    expect(restored.width).toBeGreaterThan(before.width);
    expectDerivedFromGraph(restored);
  });

  it("does not adopt an external edit as draft cleanup when more keys follow it", () => {
    const { document, before, state } = fixture();
    let preview = draft(document, state, "O");
    const current = molecule(preview);
    const edited = { ...current, atoms: current.atoms.map((atom, index) => index === 2
      ? { ...atom, warningSuppressed: false, labelOffset: { x: 10, y: 20 }, hydrogenCount: 0 } : atom) };
    preview = draft(replaceMolecule(preview, edited), state);
    const restored = molecule(restoreAtomLabelDraft(preview, state));
    expect(restored.atoms[2]).toEqual(molecule(preview).atoms[2]);
    expect(restored.atoms[2]!.warningSuppressed).toBe(false);
    expect(restored.atoms[2]!.hydrogenCount).toBeUndefined();
    expect(restored.atoms[1]).toEqual(before.atoms[1]);
    expectDerivedFromGraph(restored);
  });

  it("keeps another atom's recolour without restoring that changed atom's cleared hints", () => {
    const { document, before, state } = fixture();
    const preview = draft(document, state);
    const recoloured = applyColorToNativeMoleculePart(preview, {
      objectId: before.id, kind: "atom", atomId: before.atoms[2]!.id
    }, "#b3261e");
    const restored = molecule(restoreAtomLabelDraft(recoloured, state));
    expect(restored.style).toEqual(molecule(recoloured).style);
    expect(restored.style.atomLabelColors).toEqual({ [before.atoms[2]!.id]: "#b3261e" });
    expect(restored.atoms[2]).toEqual(molecule(recoloured).atoms[2]);
    expect(restored.atoms[1]).toEqual(before.atoms[1]);
    expectDerivedFromGraph(restored);
  });

  it("does not restore hints superseded by an incident-bond change or resurrect deleted atoms", () => {
    const { document, before, state } = fixture();
    const preview = draft(document, state);
    const current = molecule(preview);
    const changed = { ...current, atoms: current.atoms.filter(atom => atom.id !== before.atoms[4]!.id),
      bonds: current.bonds.filter(bond => bond.fromAtomId !== before.atoms[4]!.id && bond.toAtomId !== before.atoms[4]!.id)
        .map((bond, index) => index === 1 ? { ...bond, order: "double" as const } : bond) };
    const restored = molecule(restoreAtomLabelDraft(replaceMolecule(preview, changed), state));
    expect(restored.atoms.some(atom => atom.id === before.atoms[4]!.id)).toBe(false);
    expect(restored.atoms[2]!.hydrogenCount).toBeUndefined();
    expect(restored.bonds).toEqual(changed.bonds);
    expectDerivedFromGraph(restored);
  });

  it("commits a substituent after rollback while keeping the other atom's move", () => {
    const { document, before, state } = fixture();
    const preview = draft(document, state);
    const moved = moveNativeMoleculeParts(preview, { objectId: before.id, kind: "atom", atomId: before.atoms[2]!.id }, { x: 120, y: 60 });
    const baseline = restoreAtomLabelDraft(moved, state);
    const result = commitNativeAtomLabelTarget(baseline, {
      objectId: before.id, kind: "atom", atomId: state.atomId, distanceToPointer: 0
    }, "OMe", { literal: true, beforeAtom: before.atoms[0], beforeMolecule: before });
    const committed = molecule(result.document);
    expect(committed.atoms[2]).toEqual(molecule(moved).atoms[2]);
    expect(committed.atoms).toHaveLength(7);
    expect(committed.bonds).toHaveLength(7);
    expect(committed.atoms[6]).toMatchObject({ element: "OMe", labelLiteral: true });
    expectDerivedFromGraph(committed);
  });
});
