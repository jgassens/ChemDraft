import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, ElectronMarkObject, MoleculeObject } from "@chemdraft/chem-core";
import {
  applyChargeToolAtNativeAtom, applyElectronMarkStyleToSelection, createPhase4Document,
  electronMarkMoveAssociation, insertNativeSingleBondMolecule, moveDocumentObject,
  moveDocumentObjects, nativeChargeMarkCenter, normalizeCommittedDocument,
  rotateDocumentObject, rotateDocumentObjectsAroundPoint, scaleDocumentObjectsAroundPoint,
  type NativeElectronMarkSpec
} from "./documentWorkflow";
import { saveDirectElectronMarkEditing } from "./electronMarkEditingSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { ensureRdkit, resetRdkitForTesting } from "../../../packages/rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/testing";
import { inspectStructureInWorker } from "./depiction2d/identityInspect";

const specs: NativeElectronMarkSpec[] = [
  { kind: "charge", charge: 1 }, { kind: "charge", charge: -1 },
  { kind: "charge", charge: 1, radical: true }, { kind: "charge", charge: -1, radical: true },
  { kind: "radical-dot" }, { kind: "lone-pair" }
];
const markIn = (document: ChemDraftDocument) => document.pages[0].objects.find(o => o.type === "electron-mark") as ElectronMarkObject;
const moleculesIn = (document: ChemDraftDocument) => document.pages[0].objects.filter(o => o.type === "molecule") as MoleculeObject[];

function fixture(spec: NativeElectronMarkSpec) {
  let document = insertNativeSingleBondMolecule(createPhase4Document("Mark association"), { x: 300, y: 300 });
  document = insertNativeSingleBondMolecule(document, { x: 450, y: 300 });
  const molecule = moleculesIn(document)[0];
  const atom = molecule.atoms[0];
  document = applyChargeToolAtNativeAtom(document, spec,
    { objectId: molecule.id, kind: "atom", atomId: atom.id, distanceToPointer: 0 });
  const mark = markIn(document);
  // Start directly on the intended atom so a neighbouring atom remains within its sticky radius.
  document = normalizeCommittedDocument({ ...document, pages: [{ ...document.pages[0], objects: document.pages[0].objects.map(o =>
    o.id === mark.id ? { ...mark, x: atom.x - 9, y: atom.y - 9 } : o) }] });
  return { document, mark: markIn(document), molecule: moleculesIn(document)[0] };
}

afterEach(() => vi.unstubAllGlobals());
beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

describe.each([false, true])("main's mark association policy with direct editing %s", enabled => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    saveDirectElectronMarkEditing(enabled);
  });
  it.each(specs)("pins sticky/nearest/released associations and reports chemistry for %j", spec => {
    const { document, mark, molecule } = fixture(spec);
    const original = molecule.atoms[0];
    const neighbour = molecule.atoms[1];
    const remote = moleculesIn(document)[1];
    const from = nativeChargeMarkCenter(mark);
    expect(electronMarkMoveAssociation(document, mark, from, from)).toEqual({ anchor: mark.anchor });
    const cases = [
      { to: { x: original.x + 4, y: original.y }, atom: original, objectId: molecule.id },
      // Charges drop stickiness; radicals/lone pairs retain it even right on a nearby neighbour.
      { to: neighbour, atom: spec.kind === "charge" ? neighbour : original, objectId: molecule.id },
      { to: remote.atoms[0], atom: remote.atoms[0], objectId: remote.id },
      { to: { x: 650, y: 650 }, atom: undefined, objectId: undefined }
    ];
    for (const { to, atom, objectId } of cases) {
      const originalJson = JSON.stringify(document);
      const result = electronMarkMoveAssociation(document, mark, from, to);
      expect(JSON.stringify(document)).toBe(originalJson);
      expect(result.anchor).toEqual(spec.kind === "charge"
        ? { ...mark.anchor, kind: "point", point: { x: to.x, y: to.y } } : mark.anchor);
      const moved = moveDocumentObject(document, mark.id, { x: to.x - mark.width / 2, y: to.y - mark.height / 2 });
      expect(markIn(moved).anchor).toEqual(result.anchor);
      const finalMark = markIn(normalizeCommittedDocument(moved));
      expect(finalMark.anchor).toMatchObject(atom ? { kind: "atom", atomId: atom.id, objectId } : { kind: "point" });
      const changesChemistry = spec.kind !== "lone-pair" && (atom?.id !== original.id || objectId !== molecule.id);
      expect(result.chemistryChange).toEqual(changesChemistry ? {
        objectIdBefore: molecule.id, atomIdBefore: original.id, objectIdAfter: objectId, atomIdAfter: atom?.id,
        kind: spec.kind === "charge" ? spec.radical ? "radical-ion" : "charge" : "radical-dot"
      } : undefined);
    }
  });

  it.each(specs)("uses the same policy for translations and general transforms of %j", spec => {
    const { document, mark, molecule } = fixture(spec);
    const from = nativeChargeMarkCenter(mark);
    const neighbour = molecule.atoms[1];
    const moved = moveDocumentObjects(document, [mark.id], neighbour.x - from.x, neighbour.y - from.y);
    expect(markIn(moved).anchor).toEqual(electronMarkMoveAssociation(document, mark, from, neighbour).anchor);
    const pivot = { x: from.x + 11, y: from.y };
    const rotated = rotateDocumentObjectsAroundPoint(document, [mark.id], pivot, 180);
    const to = nativeChargeMarkCenter(markIn(rotated));
    expect(markIn(rotated).anchor).toEqual(electronMarkMoveAssociation(document, mark, from, to, { operation: "transform" }).anchor);
  });

  it("reports main's charge reassociation even for a centered general transform in a crowded placement", () => {
    const { document, mark, molecule } = fixture({ kind: "charge", charge: 1 });
    const neighbour = molecule.atoms[1];
    const crowdedMark = { ...mark, x: neighbour.x - 9, y: neighbour.y - 9 };
    const crowded = normalizeCommittedDocument({ ...document, pages: [{ ...document.pages[0], objects:
      document.pages[0].objects.map(o => o.id === mark.id ? crowdedMark : o) }] });
    const center = nativeChargeMarkCenter(crowdedMark);
    expect(markIn(crowded).anchor).toEqual(mark.anchor); // Sticky to the original atom.
    expect(electronMarkMoveAssociation(crowded, crowdedMark, center, center, { operation: "frame" }))
      .toEqual({ anchor: mark.anchor });
    const result = electronMarkMoveAssociation(crowded, crowdedMark, center, center, { operation: "transform" });
    expect(result.chemistryChange).toEqual({
      objectIdBefore: molecule.id, atomIdBefore: molecule.atoms[0].id,
      objectIdAfter: molecule.id, atomIdAfter: neighbour.id, kind: "charge"
    });
    const rotated = normalizeCommittedDocument(rotateDocumentObjectsAroundPoint(crowded, [mark.id], center, 73));
    expect(markIn(rotated).anchor).toMatchObject({ kind: "atom", atomId: neighbour.id });
  });
});

it.each(specs)("preserves main's stale point anchors for floating %j", spec => {
  const { document, mark } = fixture(spec);
  const floating = { ...mark, anchor: { kind: "point" as const, point: { x: 600, y: 600 } }, x: 591, y: 591 };
  const context = { ...document, pages: [{ ...document.pages[0], objects: document.pages[0].objects.map(o => o.id === mark.id ? floating : o) }] };
  const result = electronMarkMoveAssociation(context, floating, { x: 600, y: 600 }, { x: 620, y: 620 });
  expect(result.anchor).toEqual(spec.kind === "charge" ? { kind: "point", point: { x: 620, y: 620 } } : floating.anchor);
  expect(result.chemistryChange).toBeUndefined();
});

it.each(specs)("keeps canonical SMILES, formula, charge, radicals and anchors during appearance edits of %j", async spec => {
  const { document, mark } = fixture(spec);
  const before = moleculesIn(document);
  expect(before[0].chemistry?.formula).toBeTruthy();
  expect(before[0].structure).toBeTruthy();
  const module = await ensureRdkit();
  const originalIdentity = inspectStructureInWorker(module, stereoPerceptionMolfile(before[0]));
  expect(originalIdentity.valid).toBe(true);
  if (!originalIdentity.valid) throw new Error(originalIdentity.reason);
  expect(originalIdentity.canonicalSmiles).toBeTruthy();
  expect(originalIdentity.formula).toBeTruthy();
  let edited = applyElectronMarkStyleToSelection(document, "size", 72);
  edited = applyElectronMarkStyleToSelection(edited, "thickness", 5.5);
  edited = scaleDocumentObjectsAroundPoint(edited, [mark.id], nativeChargeMarkCenter(markIn(edited)), 1.25, 1.25);
  edited = rotateDocumentObject(edited, mark.id, 73);
  edited = normalizeCommittedDocument(edited);
  expect(moleculesIn(edited)).toEqual(before);
  expect(inspectStructureInWorker(module, stereoPerceptionMolfile(moleculesIn(edited)[0]))).toEqual(originalIdentity);
  expect(markIn(edited).anchor).toEqual(mark.anchor);
});
