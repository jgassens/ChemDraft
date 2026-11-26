import { describe, expect, it } from "vitest";
import { applyPatch, applyPatches, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { createNativeTextObject, nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles, phase4Timestamp } from "@chemdraft/document-workflow-core";
import {
  CHEMISTRY_EDIT, atomChemistry, chemistryEditOf, chemistryRefusalStatus, commitChemistryRefusals, describeMoleculeChemistryChange,
  moleculeAtomChemistryChanges, moleculeKey, policyChemistryRefusals, preexistingMoleculeChemistryChanges,
  marksFollowAtoms, structureEditChemistry, structureEditorChemistry, structurallyEditedMoleculeKeys
} from "./commitChemistryGuard";
import * as workflow from "./documentWorkflow";
import { ammoniumElectronMarkDropFixture, dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";

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

  /** `independentlyMovedMarkIds`: the marks the operation declares it moved by itself (none when absent). */
  function check(before: ChemDraftDocument, next: ChemDraftDocument, operation?: string,
    independentlyMovedMarkIds?: ReadonlySet<string>): string[] {
    return commitChemistryRefusals({ before, next, after: workflow.normalizeCommittedDocument(next),
      normalize: workflow.normalizeCommittedDocument, markAtoms, operation, independentlyMovedMarkIds });
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

  it("lets a mark the operation declares it moved by itself change its own atoms, and nothing else", () => {
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
    // The exemption comes only from the operation's own declaration, never from the selection.
    expect(check(selected, moved(selected), "align", new Set([mark.id]))).toEqual([]);
    expect(check(selected, moved(selected), "align")).toHaveLength(1);
    expect(check(unselected, moved(unselected), "align")).toHaveLength(1);
    // A declared mark the operation left where it was explains nothing: N's own charge changing is refused.
    const recharged = withAtomChanges(selected, dropMolecule(document).id, atoms => atoms.map(atom =>
      atom.id === nitrogen.id ? { ...atom, formalCharge: atom.formalCharge + 1 } : atom));
    expect(check(selected, recharged, "align", new Set([mark.id]))).toEqual([expect.stringMatching(new RegExp(
      `^Cannot align without changing the chemistry of molecule "${dropMolecule(document).id}": its atom "${nitrogen.id}" would have charge 2 `))]);
  });

  it("exempts nothing for a pure move: a selected mark that followed its moved atom explains no change", () => {
    // Review P2c: a selection holding A and its + moved together. The + followed N, so it is not a
    // mark moved by itself: N's chemistry changing is refused (it was exempt as a moved selected mark).
    const { document, nitrogen } = electronMarkDropFixture();
    const a = dropMolecule(document), mark = dropMark(document);
    const selected = workflow.selectDocumentObjects(document, document.pages[0].id, [a.id, mark.id]);
    const together = applyPatches(selected, [
      { op: "updateObject", objectId: a.id, changes: { x: a.x, y: a.y + 200,
        atoms: a.atoms.map(atom => ({ ...atom, y: atom.y + 200,
          ...(atom.id === nitrogen.id ? { formalCharge: atom.formalCharge + 1 } : {}) })) } },
      { op: "updateObject", objectId: mark.id, changes: { y: mark.y + 200 } }
    ], { now: phase4Timestamp });
    expect(check(selected, together, "move")).toEqual([expect.stringMatching(new RegExp(
      `^Cannot move without changing the chemistry of molecule "${a.id}": its atom "${nitrogen.id}" would have charge 2 `))]);
    // The same move done right (the + carried, N untouched) passes with no exemption needed.
    const carried = applyPatches(selected, [
      { op: "updateObject", objectId: a.id, changes: { x: a.x, y: a.y + 200, atoms: a.atoms.map(atom => ({ ...atom, y: atom.y + 200 })) } },
      { op: "updateObject", objectId: mark.id, changes: { y: mark.y + 200 } }
    ], { now: phase4Timestamp });
    expect(check(selected, carried, "move")).toEqual([]);
  });

  it.each([
    { name: "rotate", transform: (document: ChemDraftDocument, moleculeId: string) =>
      workflow.rotateDocumentObject(document, moleculeId, 90) },
    { name: "scale", transform: (document: ChemDraftDocument, moleculeId: string, center: { x: number; y: number }) =>
      workflow.scaleDocumentObjectsAroundPoint(document, [moleculeId], center, 2, 2) }
  ])("exempts nothing when a lone marked atom is turned or scaled about itself ($name): the mark stays with its unmoved atom", ({ transform }) => {
    // Review 2 P2b(i): turning or scaling a one-atom molecule about its atom leaves the atom where
    // it was. Owner ruling 2026-11-21: a mark whose atom did not move does not move, so the
    // charge-follows rule puts back the mark the transform carried (round 4). Nothing was moved by
    // itself, so nothing is exempt: N's chemistry must stay as it was.
    const { document, nitrogen } = ammoniumElectronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    const selected = workflow.selectDocumentObjects(document, document.pages[0].id, [molecule.id, mark.id]);
    // As the commit funnel runs it: the transform, then the charge-follows rule.
    const turned = workflow.followElectronMarksWithMovedAtoms(selected,
      transform(selected, molecule.id, { x: nitrogen.x, y: nitrogen.y })).document;
    const transformed = transform(selected, molecule.id, { x: nitrogen.x, y: nitrogen.y });
    const center = workflow.nativeChargeMarkCenter(mark);
    const carried = workflow.nativeChargeMarkCenter(dropMark(transformed)), nextCenter = workflow.nativeChargeMarkCenter(dropMark(turned));
    expect(Math.hypot(carried.x - center.x, carried.y - center.y), "the transform itself carries the mark").toBeGreaterThan(1);
    expect(nextCenter, "the charge-follows rule puts it back").toEqual(center);
    expect(dropMark(turned)).toMatchObject({ width: mark.width, height: mark.height, rotation: mark.rotation });
    expect(dropMolecule(turned).atoms[0]).toMatchObject({ x: nitrogen.x, y: nitrogen.y });
    // Done right, the chemistry is unchanged and the move passes.
    expect(check(selected, turned, "rotate")).toEqual([]);
    // N's charge changing with it is refused: a pure move has no exempt atom.
    const recharged = withAtomChanges(turned, molecule.id, atoms => atoms.map(atom =>
      atom.id === nitrogen.id ? { ...atom, formalCharge: atom.formalCharge + 1 } : atom));
    expect(check(selected, recharged, "rotate")).toEqual([expect.stringMatching(new RegExp(
      `^Cannot rotate without changing the chemistry of molecule "${molecule.id}": its atom "${nitrogen.id}" would have charge 2 `))]);
  });

  it("keeps a mark drop's exemption when other atoms of its molecule change the molecule's bounds", () => {
    // Review 2 P2b(ii): the + is dropped off N while another atom (the terminal methyl) moves and
    // widens the molecule's frame. N itself stayed put, so the + moved by itself: N losing its
    // charge is the drop's own business, and the drop commits.
    const { document, nitrogen } = electronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    const selected = workflow.selectDocumentObjects(document, document.pages[0].id, [molecule.id, mark.id]);
    const methyl = molecule.atoms[0];
    const dropped = applyPatches(selected, [
      { op: "updateObject", objectId: molecule.id, changes: { x: molecule.x - 40, width: molecule.width + 40,
        atoms: molecule.atoms.map(atom => atom.id === methyl.id ? { ...atom, x: atom.x - 40 } : atom) } },
      { op: "updateObject", objectId: mark.id, changes: {
        x: mark.x + 200, y: mark.y + 200, anchor: { kind: "point", point: { x: mark.x + 200, y: mark.y + 200 } }, atomAssociation: "explicit" } }
    ], { now: phase4Timestamp });
    expect(dropMolecule(dropped).atoms.find(atom => atom.id === nitrogen.id)).toMatchObject({ x: nitrogen.x, y: nitrogen.y });
    expect(moleculeById(workflow.normalizeCommittedDocument(dropped), molecule.id)
      .atoms.find(atom => atom.id === nitrogen.id)).toMatchObject({ formalCharge: 0 });
    // The drop declares the mark it moved by itself; without that declaration nothing is inferred.
    expect(check(selected, dropped, "move", new Set([mark.id]))).toEqual([]);
    expect(check(selected, dropped, "move")).toHaveLength(1);
  });

  // Round 4: the guard infers nothing from how atoms moved. Only the marks the operation declares it
  // moved by itself (`independentlyMovedMarkIds`) are exempt, so both of these were wrong on 1.2.3's
  // "every other atom moved" clause.
  const turnAbout = (pivot: { x: number; y: number }, radians: number) => (point: { x: number; y: number }) => ({
    x: pivot.x + (point.x - pivot.x) * Math.cos(radians) - (point.y - pivot.y) * Math.sin(radians),
    y: pivot.y + (point.x - pivot.x) * Math.sin(radians) + (point.y - pivot.y) * Math.cos(radians)
  });

  it("a: dragging a mark off a stationary N during a partial turn keeps the mark-drop exemption", () => {
    // Every atom but N turns a quarter about N (a partial turn of the rest of the molecule), while
    // the selected + is dragged well off N. N did not move; the + moved by itself, and the operation
    // says so. N losing its charge is the drop's own business, so the commit goes through.
    const { document, nitrogen } = electronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    const selected = workflow.selectDocumentObjects(document, document.pages[0].id, [mark.id]);
    const turn = turnAbout({ x: nitrogen.x, y: nitrogen.y }, Math.PI / 2);
    const dragged = applyPatches(selected, [
      { op: "updateObject", objectId: molecule.id, changes: {
        atoms: molecule.atoms.map(atom => atom.id === nitrogen.id ? atom : { ...atom, ...turn(atom) }) } },
      { op: "updateObject", objectId: mark.id, changes: {
        x: mark.x + 200, y: mark.y + 200, anchor: { kind: "point", point: { x: mark.x + 200, y: mark.y + 200 } }, atomAssociation: "explicit" } }
    ], { now: phase4Timestamp });
    expect(dropMolecule(dragged).atoms.find(atom => atom.id === nitrogen.id)).toMatchObject({ x: nitrogen.x, y: nitrogen.y });
    expect(dropMolecule(dragged).atoms.filter(atom => atom.id !== nitrogen.id)
      .every(atom => { const before = molecule.atoms.find(old => old.id === atom.id)!; return Math.hypot(atom.x - before.x, atom.y - before.y) > 1; }),
    "every other atom moved").toBe(true);
    expect(moleculeById(workflow.normalizeCommittedDocument(dragged), molecule.id)
      .atoms.find(atom => atom.id === nitrogen.id)).toMatchObject({ formalCharge: 0 });
    expect(check(selected, dragged, "rotate", new Set([mark.id]))).toEqual([]);
  });

  it("b: a reflection whose axis contains the marked N and another atom does not exempt a charge change on N", () => {
    // The whole molecule, with its + selected, is mirrored about the line through N and one of its
    // neighbours: both stay put, every other atom moves, and the transform carries N's + across the
    // line. Nothing moved by itself, so nothing is exempt: a charge change on N riding along is refused.
    const { document, nitrogen } = electronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    const center = workflow.nativeChargeMarkCenter(mark);
    const neighbours = molecule.bonds.flatMap(bond => bond.fromAtomId === nitrogen.id ? [bond.toAtomId]
      : bond.toAtomId === nitrogen.id ? [bond.fromAtomId] : []).map(id => molecule.atoms.find(atom => atom.id === id)!);
    const mirrorAbout = (on: { x: number; y: number }) => {
      const dx = on.x - nitrogen.x, dy = on.y - nitrogen.y, squared = dx * dx + dy * dy;
      return (point: { x: number; y: number }) => {
        const t = ((point.x - nitrogen.x) * dx + (point.y - nitrogen.y) * dy) / squared;
        return { x: 2 * (nitrogen.x + t * dx) - point.x, y: 2 * (nitrogen.y + t * dy) - point.y };
      };
    };
    // The neighbour whose line through N leaves the + farthest off it, so the mirror carries the + visibly.
    const axisAtom = neighbours.reduce((best, atom) => {
      const away = (on: typeof atom) => { const m = mirrorAbout(on)(center); return Math.hypot(m.x - center.x, m.y - center.y); };
      return away(atom) > away(best) ? atom : best;
    });
    const mirror = mirrorAbout(axisAtom);
    const carried = mirror(center);
    expect(Math.hypot(carried.x - center.x, carried.y - center.y), "the mirror carries the +").toBeGreaterThan(1);
    const selected = workflow.selectDocumentObjects(document, document.pages[0].id, [molecule.id, mark.id]);
    const reflected = applyPatches(selected, [
      { op: "updateObject", objectId: molecule.id, changes: { atoms: molecule.atoms.map(atom => ({ ...atom, ...mirror(atom),
        ...(atom.id === nitrogen.id ? { formalCharge: atom.formalCharge + 1 } : {}) })) } },
      { op: "updateObject", objectId: mark.id, changes: { x: carried.x - mark.width / 2, y: carried.y - mark.height / 2 } }
    ], { now: phase4Timestamp });
    const stays = (id: string) => dropMolecule(reflected).atoms.find(atom => atom.id === id)!;
    expect(stays(nitrogen.id).x).toBeCloseTo(nitrogen.x, 9);
    expect(stays(axisAtom.id).x).toBeCloseTo(axisAtom.x, 9);
    expect(check(selected, reflected, "flip")).toEqual([expect.stringMatching(new RegExp(
      `^Cannot flip without changing the chemistry of molecule "${molecule.id}": its atom "${nitrogen.id}" would have charge 2 `))]);
  });

  it("refuses a move that changes any molecule's chemistry, moved or not", () => {
    // owner ruling 2026-11-21: charge always follows. Moves preserve: the move paths carry every
    // mark with its atom (`followElectronMarksWithMovedAtoms`), so a move that would leave A's +
    // behind is refused even when A is selected (1.2.2 exempted the selected molecules a selection
    // transform moved). A + left beside B must not land on B either.
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
    expect(check(selectedA, away, "move")).toHaveLength(1);
    const unselected = workflow.selectDocumentObjects(withB, pageId, []);
    expect(check(unselected, shiftA(unselected, 0, 200), "move")).toHaveLength(1);
    // The move path's own result carries the + with N, and passes.
    const followed = workflow.followElectronMarksWithMovedAtoms(selectedA, away).document;
    expect(moleculeById(workflow.normalizeCommittedDocument(followed), a.id).atoms.find(atom => atom.id === nitrogen.id))
      .toMatchObject({ formalCharge: 1 });
    expect(check(selectedA, followed, "move")).toEqual([]);
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
    // Both are refused: B would lose its +, and A, moved, would take it.
    expect(check(besideB, onMark, "move")).toEqual(expect.arrayContaining([expect.stringMatching(
      new RegExp(`^Cannot move without changing the chemistry of molecule "${B_ID}": `))]));
    expect(check(besideB, onMark, "move")).toHaveLength(2);
  });
});

describe("scoped chemistry edits", () => {
  // A (Boc-glycine, + on its N) and a neutral B. A scoped edit may change the molecules it edits
  // structurally or names; every other molecule that existed before stays guarded.
  function aAndB() {
    const { document, nitrogen } = electronMarkDropFixture();
    const withB = withNeutralB(document);
    return { document: withB, a: dropMolecule(withB), b: moleculeById(withB, B_ID), nitrogen, pageId: withB.pages[0].id };
  }
  const charge = (document: ChemDraftDocument, moleculeId: string, atomId: string, formalCharge: number) =>
    withAtomChanges(document, moleculeId, atoms => atoms.map(atom => atom.id === atomId ? { ...atom, formalCharge } : atom));
  const addCarbon = (document: ChemDraftDocument, moleculeId: string) => {
    const molecule = moleculeById(document, moleculeId);
    const from = molecule.atoms[0];
    return applyPatch(document, { op: "updateObject", objectId: moleculeId, changes: {
      atoms: [...molecule.atoms, { id: "added_c", element: "C", formalCharge: 0, x: from.x, y: from.y + 22 }],
      bonds: [...molecule.bonds, { id: "added_bond", fromAtomId: from.id, toAtomId: "added_c", order: "single" as const }]
    } }, { now: phase4Timestamp });
  };
  const check = (before: ChemDraftDocument, next: ChemDraftDocument, policy: ReturnType<typeof structureEditChemistry>) =>
    policyChemistryRefusals(policy, { before, next, after: next, normalize: identity, markAtoms });

  it("finds the molecules whose atoms or bonds an operation added, removed or changed, never a charge-only change", () => {
    const { document, a, b, nitrogen, pageId } = aAndB();
    expect(structurallyEditedMoleculeKeys(document, document)).toEqual(new Set());
    expect(structurallyEditedMoleculeKeys(document, addCarbon(document, a.id))).toEqual(new Set([moleculeKey(pageId, a.id)]));
    expect(structurallyEditedMoleculeKeys(document, charge(document, a.id, nitrogen.id, 2))).toEqual(new Set());
    const movedAtom = withAtomChanges(document, B_ID, atoms => atoms.map((atom, index) => index === 0 ? { ...atom, x: atom.x + 5 } : atom));
    expect(structurallyEditedMoleculeKeys(document, movedAtom)).toEqual(new Set([moleculeKey(pageId, B_ID)]));
    const removed = applyPatch(document, { op: "removeObject", objectId: b.id }, { now: phase4Timestamp });
    expect(structurallyEditedMoleculeKeys(document, removed)).toEqual(new Set([moleculeKey(pageId, B_ID)]));
    const copied = withAtomChanges(document, B_ID, atoms => atoms.map(atom => ({ ...atom })));
    expect(structurallyEditedMoleculeKeys(document, copied)).toEqual(new Set());
  });

  it("lets a structure edit change the molecule it edits, never another one", () => {
    const { document, a, b, nitrogen } = aAndB();
    // A grows an atom and its N's charge changes: A is the edit's own molecule.
    const grownAndRecharged = charge(addCarbon(document, a.id), a.id, nitrogen.id, 2);
    expect(check(document, grownAndRecharged, structureEditChemistry("draw this bond"))).toEqual([]);
    // A's charge changing with no structural edit is refused, naming A.
    expect(check(document, charge(document, a.id, nitrogen.id, 2), structureEditChemistry("draw this bond"))).toEqual([
      expect.stringMatching(new RegExp(`^Cannot draw this bond without changing the chemistry of molecule "${a.id}": `))]);
    // A grows, but B (not edited) changes: B is refused even though A is exempt.
    const grownAAndChargedB = charge(addCarbon(document, a.id), B_ID, b.atoms[0].id, 1);
    expect(check(document, grownAAndChargedB, structureEditChemistry("place this template"))).toEqual([
      expect.stringMatching(new RegExp(`^Cannot place this template without changing the chemistry of molecule "${B_ID}": `))]);
    // The document-wide exemption checked nothing at all.
    expect(policyChemistryRefusals(CHEMISTRY_EDIT, { before: document, next: grownAAndChargedB, after: grownAAndChargedB,
      normalize: identity, markAtoms })).toEqual([]);
    // A molecule the edit removed (a bond joining B into A) is the edit's own.
    const joined = applyPatch(addCarbon(document, a.id), { op: "removeObject", objectId: b.id }, { now: phase4Timestamp });
    expect(check(document, joined, structureEditChemistry())).toEqual([]);
    // Unscoped, B's removal is refused, and so are A's added atom and bond (chemistry-guard-too-narrow).
    expect(commitChemistryRefusals({ before: document, next: joined, after: joined, normalize: identity, markAtoms })).toEqual([
      expect.stringMatching(new RegExp(`^Cannot complete this edit without changing the chemistry of molecule "${a.id}": it would gain atom "added_c"`)),
      expect.stringMatching(new RegExp(`^Cannot complete this edit without changing the chemistry of molecule "${a.id}": it would gain bond "added_bond"`)),
      expect.stringMatching(new RegExp(`^Cannot complete this edit without changing the chemistry of molecule "${B_ID}": it would be removed\\.$`))
    ]);
  });

  it("lets a structure-editor (Ketcher) save change only the molecule it edited, and turns off the follow rule", () => {
    // Review P1: the editor save reuses atom ids by index, so it may not be document-wide exempt.
    const { document, a, b, nitrogen } = aAndB();
    const policy = structureEditorChemistry(a.id);
    expect(marksFollowAtoms(policy)).toBe(false);
    expect(marksFollowAtoms(chemistryEditOf([a.id]))).toBe(true);
    expect(marksFollowAtoms(CHEMISTRY_EDIT)).toBe(true);
    expect(check(document, charge(addCarbon(document, a.id), a.id, nitrogen.id, 2), policy)).toEqual([]);
    expect(check(document, charge(document, B_ID, b.atoms[0].id, 1), policy)).toEqual([
      expect.stringMatching(new RegExp(`molecule "${B_ID}"`))]);
  });

  it("lets a named-molecule edit change only the molecules it names", () => {
    const { document, a, b, nitrogen } = aAndB();
    const rechargedA = charge(document, a.id, nitrogen.id, 2);
    expect(check(document, rechargedA, chemistryEditOf([a.id]))).toEqual([]);
    expect(check(document, rechargedA, chemistryEditOf([b.id]))).toHaveLength(1);
    expect(check(document, charge(rechargedA, B_ID, b.atoms[0].id, 1), chemistryEditOf([a.id]))).toEqual([
      expect.stringMatching(new RegExp(`molecule "${B_ID}"`))]);
  });
});
