import { describe, expect, it } from "vitest";
import {
  applyPatch, applyPatches, createDocumentHistory, redo, serializeDocument, undo,
  type ChemDraftDocument, type DocumentObject, type ElectronMarkObject, type MoleculeObject
} from "@chemdraft/chem-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles, phase4Timestamp } from "@chemdraft/document-workflow-core";
import * as workflow from "./documentWorkflow";
import {
  ammoniumElectronMarkDropFixture, dropMark, dropMolecule, electronMarkDropFixture
} from "./testSupport/electronMarkDropFixture";

// Edit > Duplicate used to copy only the selected objects. A molecule's charge and radical marks
// are separate objects, so selecting the molecule alone produced a copy whose atoms were recomputed
// to charge 0 by normalization (AGENTS.md section 7: no silent chemistry change).

const OFFSET = { x: 24, y: 24 };

const moleculesOf = (document: ChemDraftDocument) =>
  document.pages[0].objects.filter((object): object is MoleculeObject => object.type === "molecule");
const marksOf = (document: ChemDraftDocument) =>
  document.pages[0].objects.filter((object): object is ElectronMarkObject => object.type === "electron-mark");
const chemistryOf = (molecule: MoleculeObject) => molecule.atoms.map(atom => ({
  id: atom.id, formalCharge: atom.formalCharge, markCharge: atom.markCharge ?? 0, markRadicals: atom.markRadicals ?? 0
}));
const select = (document: ChemDraftDocument, ids: readonly string[]) =>
  workflow.selectDocumentObjects(document, document.pages[0].id, ids);

/** A lone carbon carrying a minus mark from the charge tool. */
function carbanionFixture() {
  const base = electronMarkDropFixture().document;
  const graph = testMoleculeFromSmiles("C");
  const atoms = graph.atoms.map(atom => ({ ...atom, x: 228, y: 250 }));
  const withCarbon = applyPatches(base, [
    { op: "removeObject", objectId: dropMark(base).id },
    { op: "updateObject", objectId: dropMolecule(base).id, changes: {
      x: 228, y: 250, width: 0, height: 0, atoms, bonds: graph.bonds,
      structure: nativeSingleBondGraphSmiles(atoms, graph.bonds), chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds)
    } }
  ], { now: phase4Timestamp });
  const molecule = dropMolecule(withCarbon);
  const document = workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(withCarbon,
    { kind: "charge", charge: -1 }, { kind: "atom", objectId: molecule.id, atomId: atoms[0].id, distanceToPointer: 0 }));
  return { document };
}

/** The Boc-glycine nitrogen's mark rewritten as a legacy mark that is not anchored to an atom. */
function legacyMarkFixture(kind: "point" | "bond") {
  const fixture = electronMarkDropFixture({ kind: "charge", charge: 1 });
  const molecule = dropMolecule(fixture.document), mark = dropMark(fixture.document), nitrogen = fixture.nitrogen;
  const bond = molecule.bonds.find(candidate => candidate.fromAtomId === nitrogen.id || candidate.toAtomId === nitrogen.id)!;
  const centerX = nitrogen.x, centerY = nitrogen.y;
  const anchor: ElectronMarkObject["anchor"] = kind === "bond"
    ? { kind: "bond", objectId: molecule.id, bondId: bond.id }
    : { kind: "point", point: { x: centerX, y: centerY } };
  // Not normalized afterwards: a loose mark inside the association radius is what an older file holds.
  const document = applyPatch(fixture.document, { op: "updateObject", objectId: mark.id, changes: {
    anchor, atomAssociation: undefined, x: centerX - mark.width / 2, y: centerY - mark.height / 2
  } }, { now: phase4Timestamp });
  // The mark must really be attributed to the molecule, or these cases would prove nothing.
  const owner = workflow.committedElectronMarkAssignments(document.pages[0]).anchorByMarkId.get(mark.id);
  expect(owner?.objectId).toBe(molecule.id);
  expect(owner?.atomId).toBe(nitrogen.id);
  return { document };
}

const cases: Array<{ name: string; make: () => { document: ChemDraftDocument }; anchorKind: "atom" | "bond" | "point";
  chemistry: { formalCharge: number; markCharge: number; markRadicals: number } }> = [
  { name: "atom-anchored minus on a carbon", make: carbanionFixture, anchorKind: "atom",
    chemistry: { formalCharge: -1, markCharge: -1, markRadicals: 0 } },
  { name: "atom-anchored plus on a nitrogen", make: ammoniumElectronMarkDropFixture, anchorKind: "atom",
    chemistry: { formalCharge: 1, markCharge: 1, markRadicals: 0 } },
  { name: "radical on a nitrogen", make: () => electronMarkDropFixture({ kind: "radical-dot" }), anchorKind: "atom",
    chemistry: { formalCharge: 0, markCharge: 0, markRadicals: 1 } },
  { name: "legacy loose plus within association range", make: () => legacyMarkFixture("point"), anchorKind: "point",
    chemistry: { formalCharge: 1, markCharge: 1, markRadicals: 0 } },
  { name: "bond-anchored plus", make: () => legacyMarkFixture("bond"), anchorKind: "bond",
    chemistry: { formalCharge: 1, markCharge: 1, markRadicals: 0 } }
];

describe("Duplicate keeps the charge and radical marks of the molecule it copies", () => {
  it.each(cases)("$name: the copy keeps the chemistry and gets its own mark", ({ make, anchorKind, chemistry }) => {
    const { document } = make();
    const source = dropMolecule(document);
    const selected = select(document, [source.id]);
    const before = serializeDocument(selected);
    const originalObjects = structuredClone(selected.pages[0].objects) as DocumentObject[];
    const originalIds = new Set(originalObjects.map(object => object.id));
    const originalMarks = marksOf(selected);
    expect(originalMarks).toHaveLength(1);

    const edited = workflow.duplicateSelectedDocumentObjects(selected, OFFSET);
    expect(serializeDocument(selected)).toBe(before);
    // Duplicating never touches the original objects.
    for (const original of originalObjects) {
      expect(edited.pages[0].objects.find(object => object.id === original.id)).toEqual(original);
    }
    const copy = moleculesOf(edited).find(molecule => !originalIds.has(molecule.id))!;
    expect(copy).toBeDefined();
    const copiedMarks = marksOf(edited).filter(mark => !originalIds.has(mark.id));
    expect(copiedMarks).toHaveLength(1);
    const [copied] = copiedMarks, [original] = originalMarks;

    // Its own mark, at the original's offset plus the duplicate offset.
    expect(copied.id).not.toBe(original.id);
    expect(copied.markKind).toBe(original.markKind);
    expect(copied.charge).toBe(original.charge);
    expect(copied.x).toBeCloseTo(original.x + OFFSET.x);
    expect(copied.y).toBeCloseTo(original.y + OFFSET.y);
    expect(copy.x).toBeCloseTo(source.x + OFFSET.x);
    expect(copy.y).toBeCloseTo(source.y + OFFSET.y);

    // Every copied anchor points at the copy, never at the original.
    expect(copied.anchor.kind).toBe(anchorKind);
    if (original.anchor.kind === "atom") {
      expect(copied.anchor).toEqual({ kind: "atom", objectId: copy.id, atomId: original.anchor.atomId });
    } else if (original.anchor.kind === "bond") {
      expect(copied.anchor).toEqual({ kind: "bond", objectId: copy.id, bondId: original.anchor.bondId });
    } else {
      expect(copied.anchor.objectId).toBeUndefined();
      expect(copied.anchor.point!.x).toBeCloseTo(original.anchor.point!.x + OFFSET.x);
      expect(copied.anchor.point!.y).toBeCloseTo(original.anchor.point!.y + OFFSET.y);
    }

    // After commit-normalization the copy has the original's charge, mark charge and radicals.
    const committed = workflow.normalizeCommittedDocument(edited);
    const committedSource = moleculesOf(committed).find(molecule => molecule.id === source.id)!;
    const committedCopy = moleculesOf(committed).find(molecule => molecule.id === copy.id)!;
    expect(chemistryOf(committedCopy)).toEqual(chemistryOf(committedSource));
    const changed = committedSource.atoms.filter(atom => atom.formalCharge !== 0 || (atom.markRadicals ?? 0) !== 0);
    expect(changed).toHaveLength(1);
    expect(chemistryOf(committedSource).find(atom => atom.id === changed[0].id)).toMatchObject(chemistry);
    expect(chemistryOf(committedCopy).find(atom => atom.id === changed[0].id)).toMatchObject(chemistry);
    expect(committedCopy.structure).toBe(committedSource.structure);
    expect(committedCopy.chemistry).toEqual(committedSource.chemistry);
    // The original keeps its chemistry too.
    expect(chemistryOf(committedSource)).toEqual(chemistryOf(moleculesOf(workflow.normalizeCommittedDocument(selected))[0]));
    // After commit every mark that points at a molecule points at one that exists, copy included.
    for (const mark of marksOf(committed)) {
      if (mark.anchor.objectId !== undefined) expect([source.id, copy.id]).toContain(mark.anchor.objectId);
    }
    expect(marksOf(committed).filter(mark => mark.anchor.objectId === copy.id)).toHaveLength(1);
  });

  it("gives the copy new ids, with every copied anchor pointing at the copy", () => {
    const { document } = electronMarkDropFixture({ kind: "charge", charge: 1 });
    const selected = select(document, [dropMolecule(document).id]);
    const originalIds = new Set(selected.pages[0].objects.map(object => object.id));
    const edited = workflow.duplicateSelectedDocumentObjects(selected, OFFSET);
    const copiedObjects = edited.pages[0].objects.filter(object => !originalIds.has(object.id));
    expect(copiedObjects).toHaveLength(2);
    for (const id of originalIds) expect(copiedObjects.map(object => object.id)).not.toContain(id);
    expect(new Set(edited.pages[0].objects.map(object => object.id)).size).toBe(edited.pages[0].objects.length);
    const copy = copiedObjects.find((object): object is MoleculeObject => object.type === "molecule")!;
    for (const mark of copiedObjects.filter((object): object is ElectronMarkObject => object.type === "electron-mark")) {
      expect(mark.anchor.objectId).toBe(copy.id);
    }
    // The copies are what is selected: the molecule, not the marks carried with it.
    expect(edited.selection.objectIds).toEqual([copy.id]);
  });

  it("duplicates two charged molecules at once", () => {
    const { document } = electronMarkDropFixture({ kind: "charge", charge: 1 });
    const first = select(document, [dropMolecule(document).id]);
    const pair = workflow.duplicateSelectedDocumentObjects(first, { x: 0, y: 120 });
    expect(moleculesOf(pair)).toHaveLength(2);
    expect(marksOf(pair)).toHaveLength(2);
    const both = select(pair, moleculesOf(pair).map(molecule => molecule.id));
    const pairIds = new Set(both.pages[0].objects.map(object => object.id));
    const edited = workflow.duplicateSelectedDocumentObjects(both, { x: 0, y: 150 });
    const committed = workflow.normalizeCommittedDocument(edited);
    expect(moleculesOf(committed)).toHaveLength(4);
    expect(marksOf(committed)).toHaveLength(4);
    for (const molecule of moleculesOf(committed)) {
      expect(molecule.atoms.filter(atom => atom.formalCharge === 1)).toHaveLength(1);
      expect(molecule.atoms.filter(atom => atom.markCharge === 1)).toHaveLength(1);
      // Each molecule owns exactly one mark, and that mark names it.
      expect(marksOf(committed).filter(mark => mark.anchor.objectId === molecule.id)).toHaveLength(1);
    }
    const copiedMolecules = moleculesOf(edited).filter(molecule => !pairIds.has(molecule.id));
    expect(copiedMolecules).toHaveLength(2);
    for (const mark of marksOf(edited).filter(candidate => !pairIds.has(candidate.id))) {
      expect(copiedMolecules.map(molecule => molecule.id)).toContain(mark.anchor.objectId);
    }
  });

  it.each(["atom", "bond"] as const)("copies a %s-anchored mark selected with its molecule exactly once", kind => {
    const { document } = kind === "atom" ? electronMarkDropFixture({ kind: "charge", charge: 1 }) : legacyMarkFixture("bond");
    const molecule = dropMolecule(document), mark = dropMark(document);
    const selected = select(document, [molecule.id, mark.id]);
    const originalIds = new Set(selected.pages[0].objects.map(object => object.id));
    const edited = workflow.duplicateSelectedDocumentObjects(selected, OFFSET);
    expect(marksOf(edited)).toHaveLength(2);
    expect(moleculesOf(edited)).toHaveLength(2);
    const copy = moleculesOf(edited).find(candidate => !originalIds.has(candidate.id))!;
    const [copiedMark] = marksOf(edited).filter(candidate => !originalIds.has(candidate.id));
    expect(copiedMark.anchor.objectId).toBe(copy.id);
    expect(copiedMark.x).toBeCloseTo(mark.x + OFFSET.x);
    expect(copiedMark.y).toBeCloseTo(mark.y + OFFSET.y);
    const committed = workflow.normalizeCommittedDocument(edited);
    expect(chemistryOf(moleculesOf(committed).find(candidate => candidate.id === copy.id)!))
      .toEqual(chemistryOf(moleculesOf(committed).find(candidate => candidate.id === molecule.id)!));
    // Both the molecule and the mark that was selected with it are selected on the copy.
    expect(new Set(edited.selection.objectIds)).toEqual(new Set([copy.id, copiedMark.id]));
  });

  it("undoes to the original without the copy or its marks, and redoes to the same chemistry", () => {
    const { document } = electronMarkDropFixture({ kind: "charge", charge: 1 });
    const selected = select(document, [dropMolecule(document).id]);
    const committed = workflow.normalizeCommittedDocument(workflow.duplicateSelectedDocumentObjects(selected, OFFSET));
    const history = { ...createDocumentHistory(selected), present: committed, past: [selected] };
    const undone = undo(history);
    expect(undone.present).toBe(selected);
    expect(moleculesOf(undone.present)).toHaveLength(1);
    expect(marksOf(undone.present)).toHaveLength(1);
    const redone = redo(undone);
    expect(redone.present).toBe(committed);
    expect(moleculesOf(redone.present)).toHaveLength(2);
    expect(marksOf(redone.present)).toHaveLength(2);
    const [first, second] = moleculesOf(redone.present);
    expect(chemistryOf(second)).toEqual(chemistryOf(first));
    expect(second.atoms.filter(atom => atom.formalCharge === 1)).toHaveLength(1);
  });

  it("still keeps charges through copy and paste", () => {
    const { document } = electronMarkDropFixture({ kind: "charge", charge: 1 });
    const selected = select(document, [dropMolecule(document).id]);
    const payload = workflow.createSelectionClipboardPayload(selected)!;
    const pasted = workflow.normalizeCommittedDocument(workflow.pasteSelectionClipboardPayload(
      workflow.createPhase4Document("Paste target"), payload, { x: payload.bounds.centerX + 24, y: payload.bounds.centerY + 24 }));
    expect(moleculesOf(pasted)).toHaveLength(1);
    expect(marksOf(pasted)).toHaveLength(1);
    expect(marksOf(pasted)[0].anchor.objectId).toBe(moleculesOf(pasted)[0].id);
    expect(chemistryOf(moleculesOf(pasted)[0])).toEqual(chemistryOf(dropMolecule(document)));
  });
});
