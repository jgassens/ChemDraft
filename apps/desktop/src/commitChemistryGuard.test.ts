import { describe, expect, it } from "vitest";
import { applyPatch, applyPatches, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { createNativeTextObject, nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles, phase4Timestamp } from "@chemdraft/document-workflow-core";
import {
  atomChemistry, chemistryRefusalStatus, commitChemistryRefusals, describeMoleculeChemistryChange,
  moleculeAtomChemistryChanges, preexistingMoleculeChemistryChanges
} from "./commitChemistryGuard";
import * as workflow from "./documentWorkflow";
import { dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";

// The commit funnel's chemistry guard (AGENTS.md section 7). These cases pin the one comparison it
// makes; MainWindow.pasteRefusal.dom.test.tsx drives it through a real paste.

const B_ID = "b_mol";
const B_AT = { x: 420, y: 350 };

/** A neutral ethane at B_AT. */
function withNeutralB(document: ChemDraftDocument): ChemDraftDocument {
  const graph = testMoleculeFromSmiles("CC");
  const atoms = graph.atoms.map((atom, index) => ({ ...atom, x: B_AT.x + index * 22, y: B_AT.y }));
  const molecule: MoleculeObject = { id: B_ID, type: "molecule", x: B_AT.x, y: B_AT.y, width: 22, height: 0,
    rotation: 0, style: {}, atoms, bonds: graph.bonds, structureFormat: "smiles",
    structure: nativeSingleBondGraphSmiles(atoms, graph.bonds), chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds),
    superatoms: [], rGroups: [] };
  return applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: molecule }], { now: phase4Timestamp });
}

const moleculeById = (document: ChemDraftDocument, id: string) =>
  document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule" && object.id === id)!;

function withAtomChanges(document: ChemDraftDocument, moleculeId: string,
  update: (atoms: MoleculeObject["atoms"]) => MoleculeObject["atoms"]): ChemDraftDocument {
  return applyPatch(document, { op: "updateObject", objectId: moleculeId,
    changes: { atoms: update(moleculeById(document, moleculeId).atoms) } }, { now: phase4Timestamp });
}

const identity = (document: ChemDraftDocument) => document;
const markAtoms = workflow.committedElectronMarkAtoms;

describe("the commit chemistry comparison", () => {
  it("reports nothing when no molecule that existed before changed", () => {
    const { document } = electronMarkDropFixture();
    const withText = applyPatch(document, { op: "addObject", pageId: document.pages[0].id,
      object: createNativeTextObject(document, { x: 600, y: 500 }, "Caption") }, { now: phase4Timestamp });
    expect(preexistingMoleculeChemistryChanges(document, withText)).toEqual([]);
    expect(preexistingMoleculeChemistryChanges(document, document)).toEqual([]);
    expect(commitChemistryRefusals({ before: document, next: withText, after: withText, normalize: identity, markAtoms })).toEqual([]);
  });

  it("names the molecule and atom when a pre-existing molecule's charge changes", () => {
    const { document, nitrogen } = electronMarkDropFixture();
    const molecule = dropMolecule(document);
    const charged = molecule.atoms.find(atom => atom.id === nitrogen.id)!;
    expect(charged).toMatchObject({ formalCharge: 1, markCharge: 1 });
    const neutral = withAtomChanges(document, molecule.id, atoms => atoms.map(atom => atom.id !== nitrogen.id ? atom
      : (({ markCharge: _markCharge, ...rest }) => ({ ...rest, formalCharge: 0 }))(atom)));

    const changes = preexistingMoleculeChemistryChanges(document, neutral);
    expect(changes).toEqual([{ pageId: document.pages[0].id, moleculeId: molecule.id, atomId: nitrogen.id, before: atomChemistry(charged),
      after: { formalCharge: 0, markCharge: 0, markRadicals: 0 } }]);
    expect(describeMoleculeChemistryChange(changes[0], "paste")).toBe(
      `Cannot paste without changing the chemistry of molecule "${molecule.id}": its atom "${nitrogen.id}" ` +
      "would have charge 0 and 0 radical marks instead of 1 and 0.");
    expect(commitChemistryRefusals({ before: document, next: neutral, after: neutral, normalize: identity, markAtoms, operation: "move" }))
      .toEqual([describeMoleculeChemistryChange(changes[0], "move")]);
    // A mark-charge change alone (the same total charge, now from a mark) is a change too.
    const fromMark = withAtomChanges(document, molecule.id, atoms => atoms.map(atom => atom.id !== nitrogen.id ? atom
      : (({ markCharge: _markCharge, ...rest }) => rest)(atom)));
    const [markOnly] = preexistingMoleculeChemistryChanges(document, fromMark);
    expect(markOnly).toMatchObject({ atomId: nitrogen.id, after: { formalCharge: 1, markCharge: 0 } });
    expect(describeMoleculeChemistryChange(markOnly)).toBe(`Cannot complete this edit without changing the chemistry of molecule ` +
      `"${molecule.id}": its atom "${nitrogen.id}" would take 0 of its charge 1 from charge marks instead of 1.`);
  });

  it("ignores the chemistry of a molecule the operation added", () => {
    const { document } = electronMarkDropFixture();
    const added = withNeutralB(document);
    const chargedNew = withAtomChanges(added, B_ID, atoms => atoms.map((atom, index) => index === 0 ? { ...atom, formalCharge: -1 } : atom));
    expect(preexistingMoleculeChemistryChanges(document, chargedNew)).toEqual([]);
    expect(commitChemistryRefusals({ before: document, next: chargedNew, after: chargedNew, normalize: identity, markAtoms })).toEqual([]);
  });

  it("reports removed atoms and removed molecules", () => {
    const { document, hydroxylOxygen } = electronMarkDropFixture();
    const molecule = dropMolecule(document);
    const withoutOxygen = withAtomChanges(document, molecule.id, atoms => atoms.filter(atom => atom.id !== hydroxylOxygen.id));
    const [atomGone] = preexistingMoleculeChemistryChanges(document, withoutOxygen);
    expect(atomGone).toEqual({ pageId: document.pages[0].id, moleculeId: molecule.id, atomId: hydroxylOxygen.id,
      before: atomChemistry(hydroxylOxygen) });
    expect(describeMoleculeChemistryChange(atomGone, "move")).toBe(
      `Cannot move without changing the chemistry of molecule "${molecule.id}": its atom "${hydroxylOxygen.id}" would be removed.`);

    const withoutMolecule = applyPatch(document, { op: "removeObject", objectId: molecule.id }, { now: phase4Timestamp });
    const changes = preexistingMoleculeChemistryChanges(document, withoutMolecule);
    expect(changes).toEqual([{ pageId: document.pages[0].id, moleculeId: molecule.id }]);
    expect(describeMoleculeChemistryChange(changes[0], "align")).toBe(
      `Cannot align without changing the chemistry of molecule "${molecule.id}": it would be removed.`);
  });

  it("compares a copy with its original atom by atom (Duplicate's use)", () => {
    const { document, nitrogen } = electronMarkDropFixture();
    const original = dropMolecule(document);
    expect(moleculeAtomChemistryChanges(original, { ...original, id: "copy" })).toEqual([]);
    const neutralCopy = { ...original, id: "copy", atoms: original.atoms.map(atom => atom.id === nitrogen.id ? { ...atom, formalCharge: 0, markCharge: undefined } : atom) };
    expect(moleculeAtomChemistryChanges(original, neutralCopy)).toEqual([{ atomId: nitrogen.id,
      before: atomChemistry(original.atoms.find(atom => atom.id === nitrogen.id)!), after: { formalCharge: 0, markCharge: 0, markRadicals: 0 } }]);
  });

  it("matches molecules on their own page: object ids are unique only within a page", () => {
    const { document } = electronMarkDropFixture();
    const molecule = dropMolecule(document);
    // A neutral molecule on a second page with the same id as the charged one on the first.
    const neutralTwin = { ...molecule, atoms: molecule.atoms.map(atom =>
      (({ markCharge: _markCharge, ...rest }) => ({ ...rest, formalCharge: 0 }))(atom)) };
    const twoPages: ChemDraftDocument = { ...document, pages: [document.pages[0], { ...document.pages[0], id: "second-page",
      objects: [neutralTwin] }] };
    const withText = { ...twoPages, pages: [{ ...twoPages.pages[0], objects: [...twoPages.pages[0].objects,
      createNativeTextObject(document, { x: 600, y: 500 }, "Caption")] }, twoPages.pages[1]] };
    expect(preexistingMoleculeChemistryChanges(twoPages, withText)).toEqual([]);
    // A molecule moved to another page is still found there when its id is unique.
    const moved: ChemDraftDocument = { ...document, pages: [{ ...document.pages[0], objects: document.pages[0].objects
      .filter(object => object.id !== molecule.id) }, { ...document.pages[0], id: "second-page", objects: [molecule] }] };
    expect(preexistingMoleculeChemistryChanges(document, moved)).toEqual([]);
  });

  it("puts the first refusal on the status line and counts the rest", () => {
    expect(chemistryRefusalStatus(["one"])).toBe("one");
    expect(chemistryRefusalStatus(["one", "two", "three"])).toBe("one (and 2 more)");
  });
});

describe("the commit check against commit normalization", () => {
  // A legacy loose "+" 10 px left of B's first atom: commit normalization attributes it to B.
  const stealCenter = { x: B_AT.x - 10, y: B_AT.y };

  /** As an older file stores it: the + is a loose point (not anchored to B's atom), unnormalized. */
  function legacyLooseMarkBesideB() {
    const fixture = electronMarkDropFixture({ kind: "charge", charge: 1 });
    const mark = dropMark(fixture.document);
    const document = withNeutralB(applyPatch(fixture.document, { op: "updateObject", objectId: mark.id, changes: {
      anchor: { kind: "point", point: stealCenter }, atomAssociation: undefined,
      x: stealCenter.x - mark.width / 2, y: stealCenter.y - mark.height / 2
    } }, { now: phase4Timestamp }));
    expect(workflow.committedElectronMarkAssignments(document.pages[0]).anchorByMarkId.get(mark.id)?.objectId).toBe(B_ID);
    return { document, mark: dropMark(document), a: dropMolecule(document), hydroxylOxygen: fixture.hydroxylOxygen };
  }

  function check(before: ChemDraftDocument, next: ChemDraftDocument, operation?: string, transform = false): string[] {
    return commitChemistryRefusals({ before, next, after: workflow.normalizeCommittedDocument(next),
      normalize: workflow.normalizeCommittedDocument, markAtoms, operation, transform });
  }

  it("refuses a copy placed where normalization hands B's loose + to it, naming B", () => {
    const { document, a, hydroxylOxygen } = legacyLooseMarkBesideB();
    const selected = workflow.selectDocumentObjects(document, document.pages[0].id, [a.id]);
    const payload = workflow.createSelectionClipboardPayload(selected)!;
    // Pasted at the source position, then placed so the copy's hydroxyl O sits on the +.
    const pasted = workflow.pasteSelectionClipboardPayload(selected, payload, { x: payload.bounds.centerX, y: payload.bounds.centerY });
    const insertedIds = pasted.pages[0].objects.filter(object => !selected.pages[0].objects.some(old => old.id === object.id)).map(object => object.id);
    const placed = workflow.translateInsertedDocumentObjects(pasted, insertedIds, stealCenter.x - hydroxylOxygen.x, stealCenter.y - hydroxylOxygen.y);
    // Without the guard, B would lose its charge.
    expect(moleculeById(workflow.normalizeCommittedDocument(selected), B_ID).atoms[0]).toMatchObject({ formalCharge: 1 });
    expect(moleculeById(workflow.normalizeCommittedDocument(placed), B_ID).atoms[0]).toMatchObject({ formalCharge: 0 });

    const refusals = check(selected, placed, "paste");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(new RegExp(`^Cannot paste without changing the chemistry of molecule "${B_ID}": its atom ` +
      `"[^"]+" would have charge 0 and 0 radical marks instead of 1 and 0\\.$`));
  });

  it("does not blame an operation for what normalization alone settles in an opened file", () => {
    // The fixture's stored charge on A's nitrogen no longer has its mark nearby: any commit settles it.
    const { document } = legacyLooseMarkBesideB();
    const withText = applyPatch(document, { op: "addObject", pageId: document.pages[0].id,
      object: createNativeTextObject(document, { x: 600, y: 500 }, "Caption") }, { now: phase4Timestamp });
    expect(preexistingMoleculeChemistryChanges(document, workflow.normalizeCommittedDocument(withText))).not.toEqual([]);
    expect(check(document, withText)).toEqual([]);
  });

  it("lets a selected mark the operation moved change its own atoms, but not an unselected one", () => {
    const { document, nitrogen } = electronMarkDropFixture();
    const mark = dropMark(document);
    const pageId = document.pages[0].id;
    const moved = (before: ChemDraftDocument) => applyPatch(before, { op: "updateObject", objectId: mark.id, changes: {
      x: mark.x + 200, y: mark.y + 200, anchor: { kind: "point", point: { x: mark.x + 200, y: mark.y + 200 } }, atomAssociation: "explicit"
    } }, { now: phase4Timestamp });
    const selected = workflow.selectDocumentObjects(document, pageId, [mark.id]);
    const unselected = workflow.selectDocumentObjects(document, pageId, []);
    expect(moleculeById(workflow.normalizeCommittedDocument(moved(selected)), dropMolecule(document).id)
      .atoms.find(atom => atom.id === nitrogen.id)).toMatchObject({ formalCharge: 0 });
    expect(check(selected, moved(selected), "align")).toEqual([]);
    expect(check(unselected, moved(unselected), "align")).toHaveLength(1);
    // A selected mark the operation left where it was explains nothing: N's own charge changing is refused.
    const recharged = withAtomChanges(selected, dropMolecule(document).id, atoms => atoms.map(atom =>
      atom.id === nitrogen.id ? { ...atom, formalCharge: atom.formalCharge + 1 } : atom));
    expect(check(selected, recharged, "align")).toEqual([expect.stringMatching(new RegExp(
      `^Cannot align without changing the chemistry of molecule "${dropMolecule(document).id}": its atom "${nitrogen.id}" would have charge 2 `))]);
  });

  it("lets a selection transform change the molecules it moved, never one it did not", () => {
    // A + on A's nitrogen, B neutral. Moving A 200 px away leaves its stationary + behind (a
    // selection transform announces that itself); a + left beside B must not land on B.
    const { document, nitrogen } = electronMarkDropFixture();
    const a = dropMolecule(document);
    const pageId = document.pages[0].id;
    const withB = withNeutralB(document);
    const shiftA = (before: ChemDraftDocument, dx: number, dy: number) => applyPatch(before, { op: "updateObject", objectId: a.id, changes: {
      x: a.x + dx, y: a.y + dy, atoms: a.atoms.map(atom => ({ ...atom, x: atom.x + dx, y: atom.y + dy }))
    } }, { now: phase4Timestamp });
    const selectedA = workflow.selectDocumentObjects(withB, pageId, [a.id]);
    const away = shiftA(selectedA, 0, 200);
    expect(moleculeById(workflow.normalizeCommittedDocument(away), a.id).atoms.find(atom => atom.id === nitrogen.id))
      .toMatchObject({ formalCharge: 0 });
    expect(check(selectedA, away, "move", true)).toEqual([]);
    // The same change is refused when the operation is not a selection transform, or A was not selected.
    expect(check(selectedA, away, "move")).toHaveLength(1);
    const unselected = workflow.selectDocumentObjects(withB, pageId, []);
    expect(check(unselected, shiftA(unselected, 0, 200), "move", true)).toHaveLength(1);
    // B, not moved, is never exempt: put the + beside B's first atom and move A away.
    const mark = dropMark(withB);
    const besideB = applyPatch(selectedA, { op: "updateObject", objectId: mark.id, changes: {
      anchor: { kind: "point", point: { x: B_AT.x - 10, y: B_AT.y } }, atomAssociation: undefined,
      x: B_AT.x - 10 - mark.width / 2, y: B_AT.y - mark.height / 2 } }, { now: phase4Timestamp });
    // Stored as a legacy loose point (as an opened file keeps it), so normalization attributes it by distance.
    expect(moleculeById(workflow.normalizeCommittedDocument(besideB), B_ID).atoms[0]).toMatchObject({ formalCharge: 1 });
    // A moved so that its hydroxyl oxygen sits on the +: the + would leave B for A.
    const { hydroxylOxygen } = electronMarkDropFixture();
    const onMark = shiftA(besideB, B_AT.x - 10 - hydroxylOxygen.x, B_AT.y - hydroxylOxygen.y);
    expect(moleculeById(workflow.normalizeCommittedDocument(onMark), B_ID).atoms[0]).toMatchObject({ formalCharge: 0 });
    expect(check(besideB, onMark, "move", true)).toEqual([expect.stringMatching(
      new RegExp(`^Cannot move without changing the chemistry of molecule "${B_ID}": `))]);
  });
});
