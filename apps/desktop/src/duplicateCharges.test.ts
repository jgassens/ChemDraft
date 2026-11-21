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
function legacyMarkFixture(kind: "point" | "bond" | "object") {
  const fixture = electronMarkDropFixture({ kind: "charge", charge: 1 });
  const molecule = dropMolecule(fixture.document), mark = dropMark(fixture.document), nitrogen = fixture.nitrogen;
  const bond = molecule.bonds.find(candidate => candidate.fromAtomId === nitrogen.id || candidate.toAtomId === nitrogen.id)!;
  const centerX = nitrogen.x, centerY = nitrogen.y;
  const anchor: ElectronMarkObject["anchor"] = kind === "bond"
    ? { kind: "bond", objectId: molecule.id, bondId: bond.id }
    : kind === "object" ? { kind: "object", objectId: molecule.id }
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

/** The atom a mark is attributed to: its own anchor atom, or the one the committed resolver chose. */
const attributedAtomId = (document: ChemDraftDocument, mark: ElectronMarkObject) => mark.anchor.kind === "atom"
  ? mark.anchor.atomId : workflow.committedElectronMarkAssignments(document.pages[0]).anchorByMarkId.get(mark.id)?.atomId;

const cases: Array<{ name: string; make: () => { document: ChemDraftDocument }; anchorKind: "atom" | "bond" | "point" | "object";
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
    chemistry: { formalCharge: 1, markCharge: 1, markRadicals: 0 } },
  { name: "object-anchored plus", make: () => legacyMarkFixture("object"), anchorKind: "object",
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

    // Every copied anchor points at the copy, never at the original. A bond, object or loose-point
    // anchor resolves by distance to any molecule's atoms, so the copy is anchored explicitly to the
    // copied atom its original was attributed to; the original keeps its own anchor.
    expect(original.anchor.kind).toBe(anchorKind);
    const atomId = attributedAtomId(selected, original);
    expect(atomId).toBeDefined();
    expect(copied.anchor).toEqual({ kind: "atom", objectId: copy.id, atomId });
    expect(copied.atomAssociation).toBe("explicit");

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

  it.each(["atom", "bond", "point"] as const)("copies a %s-anchored mark selected with its molecule exactly once", kind => {
    const { document } = kind === "atom" ? electronMarkDropFixture({ kind: "charge", charge: 1 }) : legacyMarkFixture(kind);
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

describe("Duplicate never changes the chemistry of a molecule it copies, neutral ones included", () => {
  /** A neutral Boc-glycine with a + mark floating at `center`, attributed to no atom. */
  function floatingMarkFixture(center: { x: number; y: number }, explicit: boolean) {
    const fixture = electronMarkDropFixture({ kind: "charge", charge: 1 });
    const mark = dropMark(fixture.document);
    const document = workflow.normalizeCommittedDocument(applyPatch(fixture.document, {
      op: "updateObject", objectId: mark.id, changes: {
        anchor: { kind: "point", point: center }, atomAssociation: explicit ? "explicit" : undefined,
        x: center.x - mark.width / 2, y: center.y - mark.height / 2
      }
    }, { now: phase4Timestamp }));
    // The molecule really is neutral and the mark really floats, or these cases would prove nothing.
    expect(workflow.committedElectronMarkAssignments(document.pages[0]).anchorByMarkId.get(mark.id)).toBeUndefined();
    for (const atom of chemistryOf(dropMolecule(document))) {
      expect(atom).toMatchObject({ formalCharge: 0, markCharge: 0, markRadicals: 0 });
    }
    return { document, mark: dropMark(document) };
  }

  const neutral = (document: ChemDraftDocument) => moleculesOf(document).every(molecule =>
    chemistryOf(molecule).every(atom => atom.formalCharge === 0 && atom.markCharge === 0 && atom.markRadicals === 0));

  it("copies a deliberately floating mark selected with a neutral molecule as a floating mark", () => {
    // 14 px above the nitrogen. Its copy lands 10 px from the ORIGINAL molecule's CH2 carbon, which
    // charged that carbon when the copy lost its floating flag.
    const { nitrogen } = electronMarkDropFixture({ kind: "charge", charge: 1 });
    const center = { x: nitrogen.x, y: nitrogen.y - 14 };
    const { document, mark } = floatingMarkFixture(center, true);
    const selected = select(document, [dropMolecule(document).id, mark.id]);
    const originalIds = new Set(selected.pages[0].objects.map(object => object.id));
    const warnings: string[] = [];
    const edited = workflow.duplicateSelectedDocumentObjects(selected, OFFSET, warnings);
    expect(warnings).toEqual([]);
    const committed = workflow.normalizeCommittedDocument(edited);
    expect(moleculesOf(committed)).toHaveLength(2);
    expect(neutral(committed)).toBe(true);
    const [copiedMark] = marksOf(edited).filter(candidate => !originalIds.has(candidate.id));
    expect(copiedMark.atomAssociation).toBe("explicit");
    expect(copiedMark.anchor).toEqual({ kind: "point", point: { x: center.x + OFFSET.x, y: center.y + OFFSET.y } });
    expect(workflow.committedElectronMarkAssignments(committed.pages[0]).anchorByMarkId.get(copiedMark.id)).toBeUndefined();
  });

  it.each([
    // Selected with the molecule; its copy lands on the ORIGINAL nitrogen.
    { name: "a selected loose mark whose copy lands on the original", selectMark: true, at: { x: 0, y: -60 } },
    // Not selected; the copied nitrogen lands under it.
    { name: "an unselected loose mark the copy lands under", selectMark: false, at: { x: 0, y: 60 } }
  ])("refuses a duplicate that would charge a neutral molecule: $name", ({ selectMark, at }) => {
    const offset = { x: 0, y: 60 };
    const probe = electronMarkDropFixture({ kind: "charge", charge: 1 });
    const { document, mark } = floatingMarkFixture({ x: probe.nitrogen.x + at.x, y: probe.nitrogen.y + at.y }, false);
    const selected = select(document, selectMark ? [dropMolecule(document).id, mark.id] : [dropMolecule(document).id]);
    const before = serializeDocument(selected);
    const warnings: string[] = [];
    const edited = workflow.duplicateSelectedDocumentObjects(selected, offset, warnings);
    // Refused, not committed with a silently charged molecule.
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/^Cannot duplicate molecule "boc_glycine" without changing chemistry: the (original|copy)'s atom/);
    expect(edited).toBe(selected);
    expect(serializeDocument(selected)).toBe(before);
    expect(() => workflow.duplicateSelectedDocumentObjects(selected, offset)).toThrow(/Cannot duplicate molecule/);
  });
});

describe("Copy and paste carries the same marks as Duplicate", () => {
  it.each(["bond", "point", "object"] as const)("a %s-anchored charge travels with its molecule", kind => {
    const { document } = legacyMarkFixture(kind);
    const source = dropMolecule(document), mark = dropMark(document);
    const selected = select(document, [source.id]);
    const expected = chemistryOf(moleculesOf(workflow.normalizeCommittedDocument(selected))[0]);
    expect(expected.filter(atom => atom.formalCharge === 1)).toHaveLength(1);

    const payload = workflow.parseSelectionClipboardPayload(
      workflow.serializeSelectionClipboardPayload(workflow.createSelectionClipboardPayload(selected)!))!;
    const copiedMarks = payload.objects.filter((object): object is ElectronMarkObject => object.type === "electron-mark");
    expect(copiedMarks).toHaveLength(1);
    // The clipboard holds the mark anchored to the atom it charges, not the original's legacy anchor.
    expect(copiedMarks[0].anchor).toEqual({ kind: "atom", objectId: source.id, atomId: attributedAtomId(selected, mark) });
    expect(dropMark(selected)).toEqual(mark);

    const at = { x: payload.bounds.centerX + OFFSET.x, y: payload.bounds.centerY + OFFSET.y };
    const elsewhere = workflow.normalizeCommittedDocument(
      workflow.pasteSelectionClipboardPayload(workflow.createPhase4Document("Paste target"), payload, at));
    expect(moleculesOf(elsewhere)).toHaveLength(1);
    expect(marksOf(elsewhere)).toHaveLength(1);
    expect(marksOf(elsewhere)[0].anchor.objectId).toBe(moleculesOf(elsewhere)[0].id);
    expect(chemistryOf(moleculesOf(elsewhere)[0])).toEqual(expected);

    // Pasted beside the original: each molecule keeps exactly its own charge.
    const beside = workflow.normalizeCommittedDocument(workflow.pasteSelectionClipboardPayload(selected, payload, at));
    expect(moleculesOf(beside)).toHaveLength(2);
    expect(marksOf(beside)).toHaveLength(2);
    for (const molecule of moleculesOf(beside)) expect(chemistryOf(molecule)).toEqual(expected);
    const pasted = moleculesOf(beside).find(molecule => molecule.id !== source.id)!;
    const pastedMark = marksOf(beside).find(candidate => candidate.id !== mark.id)!;
    expect(pastedMark.anchor.objectId).toBe(pasted.id);
    expect(pastedMark.x).toBeCloseTo(mark.x + OFFSET.x);
    expect(pastedMark.y).toBeCloseTo(mark.y + OFFSET.y);
  });
});

describe("Duplicating a group offsets each copied mark exactly once", () => {
  it.each(["bond", "point"] as const)("a charged molecule grouped with its %s-anchored mark", kind => {
    const { document } = legacyMarkFixture(kind);
    const molecule = dropMolecule(document), mark = dropMark(document);
    const grouped = workflow.groupSelectedDocumentObjects(select(document, [molecule.id, mark.id]));
    const group = grouped.pages[0].objects.find(object => object.type === "group")!;
    expect(grouped.selection.objectIds).toEqual([group.id]);
    const originalIds = new Set(grouped.pages[0].objects.map(object => object.id));

    const edited = workflow.duplicateSelectedDocumentObjects(grouped, OFFSET);
    const copy = moleculesOf(edited).find(candidate => !originalIds.has(candidate.id))!;
    const copiedMarks = marksOf(edited).filter(candidate => !originalIds.has(candidate.id));
    expect(copiedMarks).toHaveLength(1);
    const [copiedMark] = copiedMarks;
    expect(copy.x).toBeCloseTo(molecule.x + OFFSET.x);
    expect(copy.y).toBeCloseTo(molecule.y + OFFSET.y);
    // The original position plus the duplicate offset, once: not moved by the group and again with its molecule.
    expect(copiedMark.x).toBeCloseTo(mark.x + OFFSET.x);
    expect(copiedMark.y).toBeCloseTo(mark.y + OFFSET.y);
    expect(copiedMark.anchor).toEqual({ kind: "atom", objectId: copy.id, atomId: attributedAtomId(document, mark) });

    const copiedGroup = edited.pages[0].objects.find(object => object.type === "group" && !originalIds.has(object.id))!;
    expect(copiedGroup.type === "group" && new Set(copiedGroup.childObjectIds)).toEqual(new Set([copy.id, copiedMark.id]));
    expect(edited.selection.objectIds).toEqual([copiedGroup.id]);
    for (const original of grouped.pages[0].objects) {
      expect(edited.pages[0].objects.find(object => object.id === original.id)).toEqual(original);
    }
    const committed = workflow.normalizeCommittedDocument(edited);
    expect(chemistryOf(moleculesOf(committed).find(candidate => candidate.id === copy.id)!))
      .toEqual(chemistryOf(moleculesOf(workflow.normalizeCommittedDocument(document))[0]));
  });
});
