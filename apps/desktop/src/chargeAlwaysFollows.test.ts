// Owner ruling 2026-11-21 (charge always follows): the shared rule, `followElectronMarksWithMovedAtoms`,
// on moves the DOM suite (chargeAlwaysFollows.dom.test.tsx) does not reach: an engine 2D relayout,
// and rigid turns and mirrors of atoms that leave the mark where it was, where the mark's offset from
// its atom must turn or mirror with the atoms.
import { beforeAll, describe, expect, it } from "vitest";
import { applyPatch, applyPatches, type ChemDraftDocument, type ElectronMarkObject, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { transformPointForObject } from "@chemdraft/layout-engine";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles, phase4Timestamp } from "@chemdraft/document-workflow-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { depictSmiles2D, ensureOclResources, perceiveDoubleBondStereoFromMolfile, relayoutMolfile2D } from "@chemdraft/ocl-adapter";
import * as workflow from "./documentWorkflow";
import { commitChemistryRefusals, marksFollowAtoms, selectionTransformChemistry, structureEditorChemistry } from "./commitChemistryGuard";
import { resolveElectronMarksAfterMoleculePartMove, resolveElectronMarksInSelectionTransform } from "./electronMarkDrop";
import { arrowNudgeOffset } from "./keyboardShortcuts";
import { dropMark, dropMolecule, electronMarkDropFixture, threeAtomChainElectronMarkFixture } from "./testSupport/electronMarkDropFixture";

type Point = { x: number; y: number };

/** Boc-glycine N+ with its tool-placed mark, atom-anchored or re-stored as a legacy bond-anchored mark below N. */
function chargedNitrogen(kind: "atom" | "bond") {
  const { document, nitrogen } = electronMarkDropFixture();
  if (kind === "atom") return { document, nitrogenId: nitrogen.id };
  const molecule = dropMolecule(document), mark = dropMark(document);
  const bond = molecule.bonds.find(bond => bond.fromAtomId === nitrogen.id || bond.toAtomId === nitrogen.id)!;
  const toolCenter = workflow.nativeChargeMarkCenter(mark);
  const atom = transformPointForObject(molecule, nitrogen);
  const center = { x: atom.x, y: atom.y + Math.hypot(toolCenter.x - atom.x, toolCenter.y - atom.y) };
  const legacy = workflow.normalizeCommittedDocument(applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
    x: center.x - mark.width / 2, y: center.y - mark.height / 2,
    anchor: { kind: "bond", objectId: molecule.id, bondId: bond.id }, atomAssociation: undefined
  } }, { now: phase4Timestamp }));
  return { document: legacy, nitrogenId: nitrogen.id };
}

const chemistry = (atom: MoleculeAtom) => [atom.formalCharge, atom.markCharge ?? 0, atom.markRadicals ?? 0];

function offset(document: ChemDraftDocument, atomId: string): Point {
  const molecule = dropMolecule(document);
  const atom = transformPointForObject(molecule, molecule.atoms.find(candidate => candidate.id === atomId)!);
  const center = workflow.nativeChargeMarkCenter(dropMark(document));
  return { x: center.x - atom.x, y: center.y - atom.y };
}

function owner(document: ChemDraftDocument, markId: string) {
  return workflow.committedElectronMarkAssignments(document.pages[0]).anchorByMarkId.get(markId);
}

/** The rule's result, committed, keeps every atom's chemistry and the mark's atom, and passes the commit guard. */
function expectCommittedWithMarkKept(before: ChemDraftDocument, moved: ChemDraftDocument, nitrogenId: string) {
  const followed = workflow.followElectronMarksWithMovedAtoms(before, moved);
  const mark = dropMark(before);
  expect(followed.followedMarkIds.has(mark.id)).toBe(true);
  const committed = workflow.normalizeCommittedDocument(followed.document);
  expect(dropMolecule(committed).atoms.map(chemistry)).toEqual(dropMolecule(before).atoms.map(chemistry));
  expect(owner(committed, mark.id)).toEqual({ objectId: dropMolecule(before).id, atomId: nitrogenId });
  // A legacy mark is re-anchored to its atom explicitly; an atom-anchored one keeps its anchor.
  expect(dropMark(committed).anchor).toMatchObject({ kind: "atom", atomId: nitrogenId });
  if (dropMark(before).anchor.kind !== "atom") expect(dropMark(committed).atomAssociation).toBe("explicit");
  expect(commitChemistryRefusals({ before, next: followed.document, after: committed,
    normalize: workflow.normalizeCommittedDocument, markAtoms: workflow.committedElectronMarkAtoms, operation: "clean up" })).toEqual([]);
  return committed;
}

/**
 * Turn or mirror every atom of the molecule about a point just off N (so N moves too), leaving the
 * mark where it was. A turn about N itself leaves N, and so its mark, in place (review 2 P2a).
 */
function mapAtomsAboutNitrogen(document: ChemDraftDocument, nitrogenId: string, map: (offset: Point) => Point) {
  const molecule = dropMolecule(document);
  const nitrogen = molecule.atoms.find(atom => atom.id === nitrogenId)!;
  const pivot = { x: nitrogen.x + 7, y: nitrogen.y + 5 };
  const atoms = molecule.atoms.map(atom => {
    const next = map({ x: atom.x - pivot.x, y: atom.y - pivot.y });
    return { ...atom, x: pivot.x + next.x, y: pivot.y + next.y };
  });
  return applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: { atoms } }, { now: phase4Timestamp });
}

/** Map the named atoms' coordinates by `map`, leaving every mark where it was (a part move the rule must follow). */
function mapAtoms(document: ChemDraftDocument, atomIds: readonly string[], map: (point: Point) => Point) {
  const molecule = dropMolecule(document), ids = new Set(atomIds);
  const atoms = molecule.atoms.map(atom => ids.has(atom.id) ? { ...atom, ...map({ x: atom.x, y: atom.y }) } : atom);
  return applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: { atoms } }, { now: phase4Timestamp });
}

const turnAbout = (pivot: Point, radians: number) => ({ x, y }: Point) => ({
  x: pivot.x + (x - pivot.x) * Math.cos(radians) - (y - pivot.y) * Math.sin(radians),
  y: pivot.y + (x - pivot.x) * Math.sin(radians) + (y - pivot.y) * Math.cos(radians)
});

const markCenter = (document: ChemDraftDocument) => workflow.nativeChargeMarkCenter(dropMark(document));

describe.each(["atom", "bond"] as const)("charge always follows: the shared rule (%s-anchored N+)", kind => {
  beforeAll(async () => { await ensureOclResources(); });

  it("an engine 2D relayout keeps the mark with N at its offset, and the commit guard passes", () => {
    const { document, nitrogenId } = chargedNitrogen(kind);
    const molecule = dropMolecule(document);
    const relaid = workflow.applyNativeMoleculeEngineRelayout(document, molecule.id, relayoutMolfile2D);
    const before = transformPointForObject(molecule, molecule.atoms.find(atom => atom.id === nitrogenId)!);
    const after = transformPointForObject(dropMolecule(relaid), dropMolecule(relaid).atoms.find(atom => atom.id === nitrogenId)!);
    expect(Math.hypot(after.x - before.x, after.y - before.y), "the relayout moves N").toBeGreaterThan(0.5);
    const committed = expectCommittedWithMarkKept(document, relaid, nitrogenId);
    const kept = offset(committed, nitrogenId), original = offset(document, nitrogenId);
    expect(Math.hypot(kept.x, kept.y)).toBeCloseTo(Math.hypot(original.x, original.y), 3);
  });

  it("a quarter turn of all the atoms turns the mark's offset with them", () => {
    const { document, nitrogenId } = chargedNitrogen(kind);
    const turned = mapAtomsAboutNitrogen(document, nitrogenId, ({ x, y }) => ({ x: -y, y: x }));
    const committed = expectCommittedWithMarkKept(document, turned, nitrogenId);
    const original = offset(document, nitrogenId), kept = offset(committed, nitrogenId);
    expect(kept.x).toBeCloseTo(-original.y, 3);
    expect(kept.y).toBeCloseTo(original.x, 3);
  });

  it("a mirror of all the atoms mirrors the mark's offset", () => {
    const { document, nitrogenId } = chargedNitrogen(kind);
    const mirrored = mapAtomsAboutNitrogen(document, nitrogenId, ({ x, y }) => ({ x, y: -y }));
    const committed = expectCommittedWithMarkKept(document, mirrored, nitrogenId);
    const original = offset(document, nitrogenId), kept = offset(committed, nitrogenId);
    expect(kept.x).toBeCloseTo(original.x, 3);
    expect(kept.y).toBeCloseTo(-original.y, 3);
  });

  it("turning a part of the molecule that holds N turns the mark's offset with that part", () => {
    const { document, nitrogenId } = chargedNitrogen(kind);
    const molecule = dropMolecule(document);
    const partIds = molecule.atoms.slice(7).map(atom => atom.id);
    expect(partIds[0]).toBe(nitrogenId);
    // Turned about a point off N, so N itself moves with the part.
    const turned = mapAtoms(document, partIds, turnAbout({ x: 261, y: 245 }, Math.PI / 2));
    const committed = expectCommittedWithMarkKept(document, turned, nitrogenId);
    const original = offset(document, nitrogenId), kept = offset(committed, nitrogenId);
    expect(kept.x).toBeCloseTo(-original.y, 3);
    expect(kept.y).toBeCloseTo(original.x, 3);
  });

  it("a part turned about N leaves N, and so its mark, where they were", () => {
    // Review P2a: the part's map is fitted to the atoms it displaced. N is the turn's pivot and
    // does not move, so its mark neither moves nor turns (1.2.3 turned it about N).
    const { document, nitrogenId } = chargedNitrogen(kind);
    const molecule = dropMolecule(document);
    const partIds = molecule.atoms.slice(7).map(atom => atom.id);
    const turned = workflow.rotateNativeMoleculeParts(document,
      { objectId: molecule.id, kind: "parts", atomIds: partIds, bondIds: [] }, 90);
    const n = (drawing: ChemDraftDocument) => {
      const next = dropMolecule(drawing);
      return transformPointForObject(next, next.atoms.find(atom => atom.id === nitrogenId)!);
    };
    expect(n(turned), "N is the pivot").toEqual(n(document));
    const followed = workflow.followElectronMarksWithMovedAtoms(document, turned, { motion: "turn" });
    expect(followed.followedMarkIds.has(dropMark(document).id)).toBe(false);
    expect(markCenter(followed.document)).toEqual(markCenter(document));
    const committed = workflow.normalizeCommittedDocument(followed.document);
    expect(owner(committed, dropMark(document).id)).toEqual({ objectId: molecule.id, atomId: nitrogenId });
    expect(dropMolecule(committed).atoms.map(chemistry)).toEqual(dropMolecule(document).atoms.map(chemistry));
  });
});

describe("charge always follows: what the shared rule leaves alone", () => {
  it("a stationary loose mark is not taken by an atom moved onto it", () => {
    const { document, nitrogen } = electronMarkDropFixture();
    const mark = dropMark(document), molecule = dropMolecule(document);
    const free = workflow.normalizeCommittedDocument(applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
      x: 400 - mark.width / 2, y: 400 - mark.height / 2, anchor: { kind: "point", point: { x: 400, y: 400 } }, atomAssociation: undefined
    } }, { now: phase4Timestamp }));
    expect(owner(free, mark.id)).toBeUndefined();
    const onMark = workflow.moveNativeMoleculeParts(free, { objectId: molecule.id, kind: "atom", atomId: nitrogen.id },
      { x: 400 - nitrogen.x, y: 400 - nitrogen.y });
    const followed = workflow.followElectronMarksWithMovedAtoms(free, onMark);
    expect(followed.followedMarkIds.size).toBe(0);
    const committed = workflow.normalizeCommittedDocument(followed.document);
    expect(owner(committed, mark.id)).toBeUndefined();
    expect(dropMolecule(committed).atoms.map(chemistry)).toEqual(dropMolecule(free).atoms.map(chemistry));
  });

  it("a mark moved without its atom is left to the mark-move policy", () => {
    const { document } = electronMarkDropFixture();
    const mark = dropMark(document);
    const moved = workflow.moveDocumentObject(document, mark.id, { x: 600, y: 500 });
    const followed = workflow.followElectronMarksWithMovedAtoms(document, moved);
    expect(followed.followedMarkIds.size).toBe(0);
    expect(followed.document).toBe(moved);
  });
});

describe.each(["atom", "bond"] as const)("charge always follows: review fixes (%s-anchored N+)", kind => {
  // P2a: a rigid turn of part of the molecule fits a map to the moved atoms only; a mark whose
  // atom stayed where it was must neither move nor turn about it.
  it("a mark on an atom a partial turn leaves in place stays exactly where it was", () => {
    const { document, nitrogenId } = chargedNitrogen(kind);
    const molecule = dropMolecule(document);
    const nIndex = molecule.atoms.findIndex(atom => atom.id === nitrogenId);
    // The four atoms beyond N (C, C, =O, OH) turn a quarter about a point between them; N stays.
    const partIds = molecule.atoms.slice(nIndex + 1).map(atom => atom.id);
    expect(partIds).toHaveLength(4);
    const turned = mapAtoms(document, partIds, turnAbout({ x: 261, y: 245 }, Math.PI / 2));
    const n = (drawing: ChemDraftDocument) => dropMolecule(drawing).atoms.find(atom => atom.id === nitrogenId)!;
    expect(n(turned)).toMatchObject({ x: n(document).x, y: n(document).y });
    const pass = workflow.followElectronMarksWithMovedAtoms(document, turned);
    expect(pass.followedMarkIds.has(dropMark(document).id)).toBe(false);
    expect(markCenter(pass.document)).toEqual(markCenter(document));
    expect(dropMark(pass.document).rotation).toBe(dropMark(document).rotation);
    // The commit funnel's second pass over the already-followed document leaves it as well.
    const again = workflow.followElectronMarksWithMovedAtoms(document, pass.document);
    expect(markCenter(again.document)).toEqual(markCenter(document));
    const committed = workflow.normalizeCommittedDocument(again.document);
    expect(owner(committed, dropMark(document).id)).toEqual({ objectId: molecule.id, atomId: nitrogenId });
  });

  // P2b: two moved atoms define a turn (rotation, scale, translation); when the caller knows the
  // operation was a turn, the mark's offset turns with them.
  it("a partial turn of exactly two atoms, known to be a turn, turns the mark's offset", () => {
    const { document, nitrogenId } = chargedNitrogen(kind);
    const molecule = dropMolecule(document);
    const nIndex = molecule.atoms.findIndex(atom => atom.id === nitrogenId);
    const partIds = [nitrogenId, molecule.atoms[nIndex + 1].id];
    const turned = mapAtoms(document, partIds, turnAbout({ x: 239, y: 280 }, Math.PI / 2));
    const followed = workflow.followElectronMarksWithMovedAtoms(document, turned, { motion: "turn" });
    expect(followed.followedMarkIds.has(dropMark(document).id)).toBe(true);
    const original = offset(document, nitrogenId), kept = offset(followed.document, nitrogenId);
    expect(kept.x).toBeCloseTo(-original.y, 3);
    expect(kept.y).toBeCloseTo(original.x, 3);
    // Not known: two atoms cannot tell a turn from a mirror, so the offset is only translated.
    const unknown = workflow.followElectronMarksWithMovedAtoms(document, turned);
    const translated = offset(unknown.document, nitrogenId);
    expect(translated.x).toBeCloseTo(original.x, 6);
    expect(translated.y).toBeCloseTo(original.y, 6);
  });
});

describe("charge always follows: an unmoved atom keeps its mark (review 2 P2a)", () => {
  /** Tetramethylammonium: N+ at the centre, its four methyls symmetric about it, the charge tool's mark on N. */
  function chargedTetramethylammonium() {
    const fixture = electronMarkDropFixture(), molecule = dropMolecule(fixture.document);
    const graph = testMoleculeFromSmiles("CN(C)(C)C");
    expect(graph.atoms.map(atom => atom.element)).toEqual(["C", "N", "C", "C", "C"]);
    const n = { x: 228, y: 250 };
    const points = [{ x: n.x - 22, y: n.y }, n, { x: n.x + 22, y: n.y }, { x: n.x, y: n.y - 22 }, { x: n.x, y: n.y + 22 }];
    const atoms = graph.atoms.map((atom, index) => ({ ...atom, ...points[index] }));
    let document = applyPatches(fixture.document, [
      { op: "removeObject", objectId: dropMark(fixture.document).id },
      { op: "updateObject", objectId: molecule.id, changes: {
        x: n.x - 22, y: n.y - 22, width: 44, height: 44, atoms, bonds: graph.bonds,
        structure: nativeSingleBondGraphSmiles(atoms, graph.bonds), chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds)
      } }
    ], { now: phase4Timestamp });
    document = workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(document, 1,
      { kind: "atom", objectId: molecule.id, atomId: atoms[1].id, distanceToPointer: 0 }));
    return { document, nitrogenId: atoms[1].id, methylIds: [atoms[0].id, atoms[2].id, atoms[3].id, atoms[4].id] };
  }

  it.each(["turn", undefined] as const)(
    "the four methyls turned about the unselected N leave N's mark exactly where it was (motion %s)", motion => {
      // Every atom, N included, fits the same quarter turn about N; N did not move, so its mark
      // must neither move nor turn (it was treated as a whole-molecule turn and turned with it).
      const { document, nitrogenId, methylIds } = chargedTetramethylammonium();
      const molecule = dropMolecule(document), mark = dropMark(document);
      expect(owner(document, mark.id)).toEqual({ objectId: molecule.id, atomId: nitrogenId });
      const nitrogen = molecule.atoms.find(atom => atom.id === nitrogenId)!;
      const turned = workflow.rotateNativeMoleculeParts(document,
        { objectId: molecule.id, kind: "parts", atomIds: methylIds, bondIds: [] }, 90);
      const nAfter = dropMolecule(turned).atoms.find(atom => atom.id === nitrogenId)!;
      expect(nAfter, "N is the pivot").toMatchObject({ x: nitrogen.x, y: nitrogen.y });
      expect(dropMolecule(turned).atoms.find(atom => atom.id === methylIds[0])!.x, "the methyls turned")
        .not.toBeCloseTo(molecule.atoms.find(atom => atom.id === methylIds[0])!.x, 3);
      const followed = workflow.followElectronMarksWithMovedAtoms(document, turned, motion ? { motion } : {});
      expect(followed.followedMarkIds.has(mark.id)).toBe(false);
      expect(markCenter(followed.document)).toEqual(markCenter(document));
      expect(dropMark(followed.document).rotation).toBe(mark.rotation);
      const committed = workflow.normalizeCommittedDocument(followed.document);
      expect(owner(committed, mark.id)).toEqual({ objectId: molecule.id, atomId: nitrogenId });
      expect(dropMolecule(committed).atoms.map(chemistry)).toEqual(molecule.atoms.map(chemistry));
    });
});

describe("charge always follows: a two-atom molecule mirrored or turned by an edit that does not say which", () => {
  /** CH3–NH3+ with the charge tool's mark on N. */
  function chargedMethylammonium() {
    const fixture = electronMarkDropFixture(), molecule = dropMolecule(fixture.document);
    const graph = testMoleculeFromSmiles("CN");
    const atoms = graph.atoms.map((atom, index) => ({ ...atom, x: 206 + index * 22, y: 250 }));
    let document = applyPatches(fixture.document, [
      { op: "removeObject", objectId: dropMark(fixture.document).id },
      { op: "updateObject", objectId: molecule.id, changes: {
        x: 206, y: 250, width: 22, height: 0, atoms, bonds: graph.bonds,
        structure: nativeSingleBondGraphSmiles(atoms, graph.bonds), chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds)
      } }
    ], { now: phase4Timestamp });
    document = workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(document, 1,
      { kind: "atom", objectId: molecule.id, atomId: atoms[1].id, distanceToPointer: 0 }));
    return { document, nitrogenId: atoms[1].id, carbonId: atoms[0].id };
  }

  it("keeps the offset translated only, never guessing a mirror or a turn; a known mirror mirrors it", () => {
    const { document, nitrogenId, carbonId } = chargedMethylammonium();
    const original = offset(document, nitrogenId);
    expect(Math.abs(original.y), "the tool places the mark off the C–N axis").toBeGreaterThan(1);
    // C and N swap places: a mirror across x = 217, or a half turn about (217, 250).
    const swapped = mapAtoms(document, [carbonId, nitrogenId], ({ x, y }) => ({ x: 434 - x, y }));
    const unknown = workflow.followElectronMarksWithMovedAtoms(document, swapped);
    const kept = offset(unknown.document, nitrogenId);
    expect(kept.x).toBeCloseTo(original.x, 6);
    expect(kept.y).toBeCloseTo(original.y, 6);
    const mirrored = offset(workflow.followElectronMarksWithMovedAtoms(document, swapped, { motion: "mirror" }).document, nitrogenId);
    expect(mirrored.x).toBeCloseTo(-original.x, 3);
    expect(mirrored.y).toBeCloseTo(original.y, 3);
    const turned = offset(workflow.followElectronMarksWithMovedAtoms(document, swapped, { motion: "turn" }).document, nitrogenId);
    expect(turned.x).toBeCloseTo(-original.x, 3);
    expect(turned.y).toBeCloseTo(-original.y, 3);
  });
});

describe("charge always follows: a structure-editor (Ketcher) save", () => {
  // P1: the editor save reuses the previous atom ids by array index, so deleting an earlier atom
  // shifts every later atom onto the previous id of its predecessor. An id is then not the same
  // atom, and a mark must never follow (or be anchored to) the atom that inherited its atom's id.
  function legacyLooseNitrogen() {
    const { document, nitrogen } = electronMarkDropFixture();
    // A loose "+" 10 px below N, nearer N than any other atom, stored (unnormalized) as an older
    // file keeps it: normalization would anchor it to N by id.
    const mark = dropMark(document), center = { x: nitrogen.x, y: nitrogen.y + 10 };
    const loose = applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
      x: center.x - mark.width / 2, y: center.y - mark.height / 2, anchor: { kind: "point", point: center }, atomAssociation: undefined
    } }, { now: phase4Timestamp });
    expect(dropMark(loose).anchor.kind).toBe("point");
    expect(owner(loose, mark.id)).toEqual({ objectId: dropMolecule(loose).id, atomId: nitrogen.id });
    return { document: loose, nitrogenId: nitrogen.id };
  }

  /** As the editor save rebuilds the molecule: the first atom deleted, ids reused by index. */
  function deleteFirstAtomReusingIdsByIndex(document: ChemDraftDocument) {
    const molecule = dropMolecule(document);
    const [gone, ...kept] = molecule.atoms;
    const idByOldId = new Map(kept.map((atom, index) => [atom.id, molecule.atoms[index].id]));
    const atoms = kept.map(atom => ({ ...atom, id: idByOldId.get(atom.id)! }));
    const bonds = molecule.bonds.filter(bond => bond.fromAtomId !== gone.id && bond.toAtomId !== gone.id)
      .map((bond, index) => ({ ...bond, id: molecule.bonds[index].id,
        fromAtomId: idByOldId.get(bond.fromAtomId)!, toAtomId: idByOldId.get(bond.toAtomId)! }));
    return applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: {
      atoms, bonds, structure: nativeSingleBondGraphSmiles(atoms, bonds), chemistry: nativeSingleBondGraphMetadata(atoms, bonds)
    } }, { now: phase4Timestamp });
  }

  it("does not move a legacy mark to, or anchor it on, the atom that inherited its atom's id", () => {
    const { document, nitrogenId } = legacyLooseNitrogen();
    const edited = deleteFirstAtomReusingIdsByIndex(document);
    const inherited = dropMolecule(edited).atoms.find(atom => atom.id === nitrogenId)!;
    expect(inherited.element, "N's old id now names the carbon after it").toBe("C");
    const policy = structureEditorChemistry(dropMolecule(document).id);
    expect(marksFollowAtoms(policy)).toBe(false);
    const committed = workflow.normalizeCommittedDocument(workflow.carryElectronMarksWithMovedAtoms(document, edited, policy));
    // The mark stays where it was, and normal association gives it to the nitrogen it sits beside.
    expect(markCenter(committed)).toEqual(markCenter(document));
    const markOwner = owner(committed, dropMark(document).id)!;
    const ownerAtom = dropMolecule(committed).atoms.find(atom => atom.id === markOwner.atomId)!;
    expect(ownerAtom.element).toBe("N");
    expect(ownerAtom).toMatchObject({ formalCharge: 1, markCharge: 1 });
    expect(dropMolecule(committed).atoms.find(atom => atom.id === nitrogenId)).toMatchObject({ element: "C", formalCharge: 0 });
    expect(dropMark(committed).anchor).not.toMatchObject({ kind: "atom", atomId: nitrogenId });
  });
});

describe("charge always follows: a partial double-bond reflection (round 4)", () => {
  beforeAll(async () => { await ensureOclResources(); });

  it("c: partial double-bond reflection leaves the mark of an atom on the mirror line unchanged", () => {
    // Flipping E/Z mirrors one end of C=C about the double bond's own line. That end's double-bond
    // carbon lies ON the line, so it does not move: its + must neither move nor turn (the reflection
    // patched every mark of the end, and the charge-follows rule accepted the patch).
    const drawn = workflow.insertNativeMolfileMolecule(workflow.createPhase4Document(), { x: 220, y: 220 },
      depictSmiles2D("C/C=C/C").molfile, "molfile-v2000");
    const molecule = workflow.getSelectedMolecule(drawn)!;
    const bond = molecule.bonds.find(candidate => candidate.order === "double")!;
    const from = molecule.atoms.find(atom => atom.id === bond.fromAtomId)!;
    const to = molecule.atoms.find(atom => atom.id === bond.toAtomId)!;
    // The reflected end is the smaller side; for 2-butene the two are equal and the `to` side is mirrored.
    const onLine = to;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const normal = { x: -(to.y - from.y) / length, y: (to.x - from.x) / length };
    const markCenter0 = { x: onLine.x + 6 * normal.x, y: onLine.y + 6 * normal.y };
    const mark: ElectronMarkObject = {
      id: "on-line-plus", type: "electron-mark", markKind: "charge", charge: 1,
      x: markCenter0.x - 5, y: markCenter0.y - 5, width: 10, height: 10, rotation: 17, style: {},
      anchor: { kind: "atom", objectId: molecule.id, atomId: onLine.id }, atomAssociation: "explicit"
    };
    const document = workflow.normalizeCommittedDocument(applyPatch(drawn, { op: "addObject", pageId: drawn.pages[0].id, object: mark },
      { now: phase4Timestamp }));
    expect(owner(document, mark.id)).toEqual({ objectId: molecule.id, atomId: onLine.id });
    const target = { objectId: molecule.id, bondId: bond.id };
    const flipped = workflow.applyMoleculeBondStereo(document, [target], "flipped", perceiveDoubleBondStereoFromMolfile);
    expect(flipped, "the flip is enabled").not.toBe(document);
    const atom = (drawing: ChemDraftDocument, id: string) => dropMolecule(drawing).atoms.find(candidate => candidate.id === id)!;
    expect(atom(flipped, onLine.id), "the carbon on the mirror line stays put").toMatchObject({ x: onLine.x, y: onLine.y });
    const methyl = dropMolecule(document).bonds.flatMap(edge => edge.id === bond.id ? []
      : edge.fromAtomId === onLine.id ? [edge.toAtomId] : edge.toAtomId === onLine.id ? [edge.fromAtomId] : [])[0];
    expect(Math.hypot(atom(flipped, methyl).x - atom(document, methyl).x, atom(flipped, methyl).y - atom(document, methyl).y),
      "the end's methyl is mirrored").toBeGreaterThan(1);
    const original = dropMark(document);
    // The reflection itself no longer carries it.
    expect(dropMark(flipped)).toEqual(original);
    // As the commit funnel runs it: the flip, then the charge-follows rule.
    const followed = workflow.followElectronMarksWithMovedAtoms(document, flipped, { motion: "mirror" });
    expect(followed.followedMarkIds.has(mark.id)).toBe(false);
    expect(dropMark(followed.document)).toMatchObject({ x: original.x, y: original.y, width: original.width,
      height: original.height, rotation: original.rotation, anchor: original.anchor });
    const committed = workflow.normalizeCommittedDocument(followed.document);
    expect(owner(committed, mark.id)).toEqual({ objectId: molecule.id, atomId: onLine.id });
    expect(dropMolecule(committed).atoms.map(chemistry)).toEqual(dropMolecule(document).atoms.map(chemistry));
  });
});

describe("charge always follows: a mark keeps its exact offset unless its atoms turned or mirrored rigidly (1.2.3 hands-on)", () => {
  beforeAll(async () => { await ensureOclResources(); });

  /** The mark's center minus its atom's page point. */
  function chainOffset(document: ChemDraftDocument, atomId: string): Point {
    const molecule = dropMolecule(document);
    const atom = transformPointForObject(molecule, molecule.atoms.find(candidate => candidate.id === atomId)!);
    const center = markCenter(document);
    return { x: center.x - atom.x, y: center.y - atom.y };
  }
  function atomPoint(document: ChemDraftDocument, atomId: string): Point {
    const molecule = dropMolecule(document);
    return transformPointForObject(molecule, molecule.atoms.find(candidate => candidate.id === atomId)!);
  }
  /** As the commit funnel runs it (`prepareDocumentCommit`): follow from `before`, then normalize. */
  const commit = (before: ChemDraftDocument, next: ChemDraftDocument, policy = selectionTransformChemistry("move")) =>
    workflow.normalizeCommittedDocument(workflow.carryElectronMarksWithMovedAtoms(before, next, policy));
  function expectOffsetKept(before: ChemDraftDocument, after: ChemDraftDocument, atomId: string, tolerance = 1e-6) {
    const original = chainOffset(before, atomId), kept = chainOffset(after, atomId);
    expect(Math.abs(kept.x - original.x), `offset x ${kept.x} vs ${original.x}`).toBeLessThan(tolerance);
    expect(Math.abs(kept.y - original.y), `offset y ${kept.y} vs ${original.y}`).toBeLessThan(tolerance);
    expect(dropMark(after).rotation).toBe(dropMark(before).rotation);
    expect(owner(after, dropMark(before).id)).toEqual({ objectId: dropMolecule(before).id, atomId });
    expect(dropMolecule(after).atoms.map(chemistry)).toEqual(dropMolecule(before).atoms.map(chemistry));
  }
  function expectAtomMoved(before: ChemDraftDocument, after: ChemDraftDocument, atomId: string, atLeast: number) {
    const from = atomPoint(before, atomId), to = atomPoint(after, atomId);
    expect(Math.hypot(to.x - from.x, to.y - from.y), "the edit moves the marked atom").toBeGreaterThan(atLeast);
  }
  /** C–C–N+ with the far carbon dragged off (a part drag, as the app runs it), distorting the chain. */
  function distortedEthylamine() {
    const fixture = threeAtomChainElectronMarkFixture("CCN", 2);
    const [farCarbon] = fixture.atomIds;
    const dragged = workflow.moveNativeMoleculeParts(fixture.document, { objectId: fixture.moleculeId, kind: "atom", atomId: farCarbon }, { x: -14, y: 30 });
    const document = commit(fixture.document, resolveElectronMarksAfterMoleculePartMove(fixture.document, dragged).document);
    expect(markCenter(document), "dragging the far carbon leaves N's mark").toEqual(markCenter(fixture.document));
    expect(dropMolecule(document).atoms[2]).toMatchObject({ formalCharge: 1 });
    return { ...fixture, document };
  }

  it("Clean Up of a distorted ethylamine keeps the + at its offset from N", () => {
    const { document, moleculeId, markedAtomId } = distortedEthylamine();
    const cleaned = workflow.cleanUpNativeMolecules2d(document, [moleculeId]);
    expectAtomMoved(document, cleaned, markedAtomId, 0.5);
    const committed = commit(document, cleaned, undefined);
    expectOffsetKept(document, committed, markedAtomId);
  });

  // The engine relayout is 3D Clean-up's (and 2D Clean Up's engine stage). Since the Spin 3D mark
  // fix (2026-11-25) it carries marks with the shared rule (layout-engine
  // carryElectronMarksToRedrawnMolecule): the exact offset, unless that spot lands on another atom or
  // a bond, when the mark turns about its atom, at the same distance, to a free side. Here the
  // relayout flips the chain, and the kept offset would sit ON the C–N bond, nearer the middle C than N.
  it("an engine 2D relayout of a distorted ethylamine keeps the + at its distance from N, turned off the bond it would land on", () => {
    const { document, moleculeId, markedAtomId } = distortedEthylamine();
    const relaid = workflow.applyNativeMoleculeEngineRelayout(document, moleculeId, relayoutMolfile2D);
    expectAtomMoved(document, relaid, markedAtomId, 0.5);
    const committed = commit(document, relaid, undefined);
    const atoms = dropMolecule(committed).atoms.map(atom => ({ id: atom.id, ...atomPoint(committed, atom.id) }));
    const nitrogen = atomPoint(committed, markedAtomId);
    const original = chainOffset(document, markedAtomId);
    const keptSpot = { x: nitrogen.x + original.x, y: nitrogen.y + original.y };
    const byId = new Map(atoms.map(atom => [atom.id, atom]));
    const bondDistance = (point: Point) => Math.min(...dropMolecule(committed).bonds.map(bond => {
      const from = byId.get(bond.fromAtomId)!, to = byId.get(bond.toAtomId)!;
      const dx = to.x - from.x, dy = to.y - from.y;
      const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(point.x - from.x - t * dx, point.y - from.y - t * dy);
    }));
    const nearestOther = (point: Point) => Math.min(...atoms.filter(atom => atom.id !== markedAtomId)
      .map(atom => Math.hypot(atom.x - point.x, atom.y - point.y)));
    const distance = Math.hypot(original.x, original.y);
    // Why it turned: the kept offset lands on a bond, nearer another atom than N.
    expect(bondDistance(keptSpot)).toBeLessThan(1);
    expect(nearestOther(keptSpot)).toBeLessThan(distance);
    // Where it went: as far from N as it was drawn, nearer N than any other atom, off every bond.
    const center = markCenter(committed);
    expect(Math.hypot(center.x - nitrogen.x, center.y - nitrogen.y)).toBeCloseTo(distance, 6);
    expect(nearestOther(center)).toBeGreaterThanOrEqual(distance - 1e-9);
    expect(bondDistance(center)).toBeGreaterThan(dropMark(committed).width * 0.35);
    // Chemistry and association unchanged.
    expect(dropMark(committed).rotation).toBe(dropMark(document).rotation);
    expect(owner(committed, dropMark(document).id)).toEqual({ objectId: dropMolecule(document).id, atomId: markedAtomId });
    expect(dropMolecule(committed).atoms.map(chemistry)).toEqual(dropMolecule(document).atoms.map(chemistry));
  });

  it("bond-length scaling keeps the mark offset", () => {
    const { document, moleculeId, markedAtomId } = threeAtomChainElectronMarkFixture("CCN", 2);
    const scaled = workflow.applyMoleculeTargetBondLength(document, [moleculeId], 44);
    expectAtomMoved(document, scaled, markedAtomId, 1);
    expectOffsetKept(document, commit(document, scaled, undefined), markedAtomId);
  });

  /** Arrow-key nudges as the app runs them: each press from the current document, the first one
   * committed and the rest amending that entry (both through the commit funnel's follow). */
  function nudge(document: ChemDraftDocument, moleculeId: string, atomIds: readonly string[], bondIds: readonly string[],
    presses: number) {
    const fragments = [{ objectId: moleculeId, atomIds, bondIds }];
    const delta = arrowNudgeOffset("ArrowDown")!;
    let current = workflow.selectDocumentObjects(document, document.pages[0].id, []);
    for (let press = 0; press < presses; press++) {
      const { document: transformed } = workflow.moveCanvasSelectionWithPositions(current, fragments, delta);
      const result = resolveElectronMarksInSelectionTransform(current, transformed);
      expect(result.independentlyMovedMarkIds.size).toBe(0);
      current = commit(current, result.document, selectionTransformChemistry("move", result.independentlyMovedMarkIds));
    }
    return current;
  }

  it("nudging one marked atom 12 times moves its radical by exactly the same vector", () => {
    const { document, moleculeId, markedAtomId } = threeAtomChainElectronMarkFixture("CCC", 1, { kind: "radical-dot" });
    expect(dropMolecule(document).atoms[1].markRadicals).toBe(1);
    const nudged = nudge(document, moleculeId, [markedAtomId], [], 12);
    const from = atomPoint(document, markedAtomId), to = atomPoint(nudged, markedAtomId);
    expect(to.x - from.x).toBeCloseTo(0, 9);
    expect(to.y - from.y).toBeCloseTo(12, 9);
    const start = markCenter(document), end = markCenter(nudged);
    expect(Math.abs(end.x - start.x - (to.x - from.x))).toBeLessThan(1e-6);
    expect(Math.abs(end.y - start.y - (to.y - from.y))).toBeLessThan(1e-6);
    expectOffsetKept(document, nudged, markedAtomId);
  });

  it("nudging two atoms keeps the + offset exactly", () => {
    const { document, moleculeId, atomIds, bondIds, markedAtomId } = threeAtomChainElectronMarkFixture("CCN", 2);
    const nudged = nudge(document, moleculeId, [atomIds[1], markedAtomId], [bondIds[1]], 10);
    expectAtomMoved(document, nudged, markedAtomId, 9);
    expectOffsetKept(document, nudged, markedAtomId);
  });

  it("a part-selection resize carries the mark of a resized atom at its offset", () => {
    // Choice (1.2.3): a part resize scales atom positions only; the mark is a label-like glyph that
    // the resize does not scale, so it keeps its exact offset from its atom. (A whole-object resize
    // scales the mark with the object, its size and offset alike: electronMarkDrop.test.ts.)
    const { document, moleculeId, atomIds, bondIds, markedAtomId } = threeAtomChainElectronMarkFixture("CCN", 2);
    const selected = workflow.selectDocumentObjects(document, document.pages[0].id, []);
    const resized = workflow.resizeNativeMoleculeParts(selected,
      { objectId: moleculeId, kind: "parts", atomIds: [atomIds[1], markedAtomId], bondIds: [bondIds[1]] }, { x: 2.5, y: 2.5 });
    expectAtomMoved(selected, resized, markedAtomId, 10);
    const edit = resolveElectronMarksInSelectionTransform(selected, resized);
    const committed = commit(selected, edit.document, selectionTransformChemistry("resize", edit.independentlyMovedMarkIds));
    expectOffsetKept(selected, committed, markedAtomId);
  });

  it("a uniform scale of the whole molecule's atoms keeps the offset; a rigid turn of the chain still turns it", () => {
    const { document, moleculeId, atomIds, markedAtomId } = threeAtomChainElectronMarkFixture("CCN", 2);
    const pivot = { x: 190, y: 240 };
    const scaled = mapAtoms(document, atomIds, ({ x, y }) => ({ x: pivot.x + 1.7 * (x - pivot.x), y: pivot.y + 1.7 * (y - pivot.y) }));
    expectOffsetKept(document, commit(document, scaled, undefined), markedAtomId);
    const turned = mapAtoms(document, atomIds, turnAbout(pivot, Math.PI / 2));
    const original = chainOffset(document, markedAtomId), kept = chainOffset(commit(document, turned, undefined), markedAtomId);
    expect(kept.x).toBeCloseTo(-original.y, 6);
    expect(kept.y).toBeCloseTo(original.x, 6);
    expect(moleculeId).toBe(dropMolecule(document).id);
  });

  it("a whole-object resize pivoted on the mark's own center keeps the resize's placement of the mark", () => {
    // Review P2 (1.2.3): the object transform scales the mark about the pivot, so a mark centered on
    // the pivot keeps its center while its size and its atom change. Only its size moved, and the
    // follow rule must not re-place it at its unscaled offset (A' + (P - A)): a whole-object resize
    // scales the mark with the object, size and offset alike.
    const { document, moleculeId, markedAtomId } = threeAtomChainElectronMarkFixture("CCN", 2);
    const selected = workflow.selectDocumentObjects(document, document.pages[0].id, [moleculeId]);
    const pivot = markCenter(selected), mark = dropMark(selected);
    const atom = atomPoint(selected, markedAtomId);
    expect(Math.hypot(pivot.x - atom.x, pivot.y - atom.y), "the mark sits off its atom").toBeGreaterThan(1);
    const scale = 2;
    const resized = workflow.scaleDocumentObjectsAroundPoint(selected, [moleculeId], pivot, scale, scale);
    expect(dropMark(resized).width).toBeCloseTo(scale * mark.width, 9);
    expectAtomMoved(selected, resized, markedAtomId, 1);
    const edit = resolveElectronMarksInSelectionTransform(selected, resized);
    for (const placed of [edit.document, commit(selected, edit.document, selectionTransformChemistry("resize", edit.independentlyMovedMarkIds))]) {
      const center = markCenter(placed), nextAtom = atomPoint(placed, markedAtomId);
      expect(Math.abs(center.x - pivot.x), `mark x ${center.x} vs pivot ${pivot.x}`).toBeLessThan(1e-6);
      expect(Math.abs(center.y - pivot.y), `mark y ${center.y} vs pivot ${pivot.y}`).toBeLessThan(1e-6);
      expect(center.x - nextAtom.x).toBeCloseTo(scale * (pivot.x - atom.x), 6);
      expect(center.y - nextAtom.y).toBeCloseTo(scale * (pivot.y - atom.y), 6);
      expect(dropMark(placed).width).toBeCloseTo(scale * mark.width, 9);
      expect(owner(placed, mark.id)).toEqual({ objectId: moleculeId, atomId: markedAtomId });
      expect(dropMolecule(placed).atoms.map(chemistry)).toEqual(dropMolecule(selected).atoms.map(chemistry));
    }
  });
});
