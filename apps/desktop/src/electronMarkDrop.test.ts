import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, deserializeDocument, serializeDocument, type ChemDraftDocument } from "@chemdraft/chem-core";
import { atomDisplayLabel, moleculeLayoutLabelBoxes, transformPointForObject } from "@chemdraft/layout-engine";
import { documentDrawingDefaults, nativeAtomBondOrderUsage, nativeChargeAssociationRadiusPx, nativeImplicitHydrogenCount, phase4Timestamp,
  stereoPerceptionMolfile, type PagePoint } from "@chemdraft/document-workflow-core";
import * as workflow from "./documentWorkflow";
import { dropElectronMark, dropElectronMarksInSelection, electronMarkDropTarget, ELECTRON_MARK_DROP_CAPTURE_BOND_LENGTHS,
  resolveElectronMarksInSelectionTransform } from "./electronMarkDrop";
import { ammoniumElectronMarkDropFixture, distantAttachedElectronMarkFixture, dropMark, dropMolecule,
  electronMarkDropFixture, fourBondNitrogenElectronMarkDropFixture, rotatedElectronMarkDropFixture } from "./testSupport/electronMarkDropFixture";
import { associationSpecs } from "./testSupport/electronMarkMainParity";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { saveDirectElectronMarkEditing } from "./electronMarkEditingSettings";
import { ensureRdkit, resetRdkitForTesting } from "../../../packages/rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/testing";
import { inspectStructureInWorker } from "./depiction2d/identityInspect";

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function drop(document: ChemDraftDocument, point: PagePoint) {
  const mark = dropMark(document);
  return dropElectronMark(document, mark.id, { x: point.x - mark.width / 2, y: point.y - mark.height / 2 }, point);
}

function atomDropState(document: ChemDraftDocument, atomId: string) {
  const molecule = dropMolecule(document), atom = molecule.atoms.find(atom => atom.id === atomId)!;
  const element = workflow.nativeElementFromAtomLabel(atom.element)!;
  return { charge: atom.formalCharge, radicals: atom.markRadicals ?? 0,
    hydrogens: nativeImplicitHydrogenCount(element, nativeAtomBondOrderUsage(atom.id, molecule.bonds, molecule.atoms), atom.formalCharge, atom.markRadicals),
    label: atomDisplayLabel(atom, molecule.bonds, undefined, molecule.atoms) };
}

describe("selection transform admission", () => {
  it.each([false, true])("checks a scale that lands on another atom (four bonds: %s)", fourBonds => {
    const fixture = fourBonds ? fourBondNitrogenElectronMarkDropFixture() : electronMarkDropFixture();
    const { document } = fixture;
    const target = fourBonds ? fixture.saturatedCarbon : fixture.carbonylOxygen;
    const mark = dropMark(document);
    const center = workflow.nativeChargeMarkCenter(mark);
    const pivot = { x: 2 * center.x - target.x, y: 2 * center.y - target.y };
    const scaled = workflow.scaleDocumentObjectsAroundPoint(document, [mark.id], pivot, 2, 2);
    const result = resolveElectronMarksInSelectionTransform(document, scaled);
    expect(result.status).toBe(drop(document, target).status);
    if (fourBonds) {
      expect(result.refused).toBe(true);
      expect(result.document).toBe(document);
      expect(atomDropState(result.document, target.id).charge).toBe(0);
    } else {
      expect(result.refused).toBeUndefined();
      expect(dropMark(result.document)).toMatchObject({ anchor: { kind: "atom", atomId: target.id }, width: 2 * mark.width });
      expect(atomDropState(result.document, target.id).charge).toBe(1);
      expect(atomDropState(result.document, fixture.nitrogen.id).charge).toBe(0);
    }
  });

  it.each(["single", "group"])("carries an attached ammonium charge outside the old radius during %s resize", mode => {
    const { document } = ammoniumElectronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    const center = workflow.nativeChargeMarkCenter(mark);
    const pivot = molecule.atoms[0];
    const scaled = mode === "single" ? workflow.resizeNativeMoleculeObject(document, molecule.id, { x: 3, y: 3 })
      : workflow.scaleDocumentObjectsAroundPoint(document, [molecule.id, mark.id], pivot, 3, 3);
    const result = resolveElectronMarksInSelectionTransform(document, scaled);
    const committed = workflow.normalizeCommittedDocument(result.document);
    const newMark = dropMark(committed);
    expect(result.status).toBeUndefined();
    expect(newMark.anchor).toEqual(mark.anchor);
    expect(newMark.width).toBe(3 * mark.width);
    const nextAtom = dropMolecule(committed).atoms[0], nextCenter = workflow.nativeChargeMarkCenter(newMark);
    expect(nextCenter.x - nextAtom.x).toBeCloseTo(3 * (center.x - pivot.x));
    expect(nextCenter.y - nextAtom.y).toBeCloseTo(3 * (center.y - pivot.y));
    expect(atomDropState(committed, pivot.id)).toMatchObject({ charge: 1, hydrogens: 4 });
  });
});

describe.each([false, true])("electron-mark drops with direct editing %s", enabled => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    saveDirectElectronMarkEditing(enabled);
  });

  it("moves +1 through Boc-glycine's carbonyl O, OH and back to N, recomputing both labels and H counts", async () => {
    const fixture = electronMarkDropFixture();
    let document = fixture.document;
    const { nitrogen: n, carbonylOxygen: o, hydroxylOxygen: oh } = fixture;
    const module = await ensureRdkit();
    const canonical = (document: ChemDraftDocument) => {
      const result = inspectStructureInWorker(module, stereoPerceptionMolfile(dropMolecule(document)));
      expect(result.valid).toBe(true);
      if (!result.valid) throw new Error(result.reason);
      return result.canonicalSmiles;
    };
    const expectedCanonical = (smiles: string) => {
      const mol = module.get_mol(smiles);
      if (!mol) throw new Error(`Cannot canonicalize expected SMILES: ${smiles}`);
      try {
        if (!mol.get_smiles) throw new Error(`Cannot canonicalize expected SMILES: ${smiles}`);
        return mol.get_smiles();
      } finally {
        mol.delete();
      }
    };
    const startCanonical = canonical(document);
    expect(startCanonical).toBe(expectedCanonical("CC(C)(C)OC(=O)[NH2+]CC(=O)O"));
    expect(atomDropState(document, n.id)).toMatchObject({ charge: 1, hydrogens: 2, label: "NH2" });
    const nearN = drop(document, { x: n.x, y: n.y - 8 });
    expect(nearN.status).toBe("Charge repositioned on N");
    expect(atomDropState(nearN.document, n.id)).toEqual(atomDropState(document, n.id));
    expect(canonical(nearN.document)).toBe(startCanonical);
    document = nearN.document;

    for (const [point, message, charges, hydrogens, labels, smiles] of [
      [o, "Charge moved from N to O (O now OH, N now NH)", [0, 1, 0], [1, 1, 1], ["NH", "OH", "OH"], "CC(C)(C)OC(=O)NCC(=[OH+])O"],
      [oh, "Charge moved from O (C=O) to O (OH) (OH now OH2, C=O now O)", [0, 0, 1], [1, 0, 2], ["NH", "O", "OH2"], "CC(C)(C)OC(=O)NCC(=O)[OH2+]"],
      [n, "Charge moved from O to N (N now NH2, O now OH)", [1, 0, 0], [2, 0, 1], ["NH2", "O", "OH"], "CC(C)(C)OC(=O)[NH2+]CC(=O)O"]
    ] as const) {
      const before = serializeDocument(document);
      const result = drop(document, point);
      expect(result.refused).toBeUndefined();
      expect(result.status).toBe(message);
      expect(result.undoLabel).toBe("Move Charge");
      [n, o, oh].forEach((atom, index) => expect(atomDropState(result.document, atom.id)).toMatchObject({
        charge: charges[index], hydrogens: hydrogens[index], label: labels[index]
      }));
      expect(canonical(result.document)).toBe(expectedCanonical(smiles));
      expect(serializeDocument(document)).toBe(before);
      document = result.document;
      expect(workflow.normalizeCommittedDocument(document)).toBe(document);
    }
    expect(canonical(document)).toBe(startCanonical);
  });

  it("distinguishes carbonyl and hydroxyl oxygens in both charge-transfer directions", () => {
    const { document, carbonylOxygen, hydroxylOxygen } = electronMarkDropFixture();
    const onCarbonyl = drop(document, carbonylOxygen);
    const onHydroxyl = drop(onCarbonyl.document, hydroxylOxygen);
    expect(onHydroxyl.refused).toBeUndefined();
    expect(onHydroxyl.status).toBe("Charge moved from O (C=O) to O (OH) (OH now OH2, C=O now O)");
    const backOnCarbonyl = drop(onHydroxyl.document, carbonylOxygen);
    expect(backOnCarbonyl.refused).toBeUndefined();
    expect(backOnCarbonyl.status).toBe("Charge moved from O (OH2) to O (C=O) (C=O now OH, OH2 now OH)");
    expect(dropMolecule(backOnCarbonyl.document)).toEqual(dropMolecule(onCarbonyl.document));
  });

  it.each([false, true])("places a dropped charge beside the reconciled label, including reversed H labels (%s)", mirrored => {
    const fixture = electronMarkDropFixture();
    let document = fixture.document;
    if (mirrored) {
      const molecule = dropMolecule(document);
      document = applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: {
        x: 600 - molecule.x - molecule.width,
        atoms: molecule.atoms.map(atom => ({ ...atom, x: 600 - atom.x }))
      } }, { now: phase4Timestamp });
    }
    // N -> carbonyl O -> N proves both ends use their changed H count; OH then grows to OH2.
    for (const targetId of [fixture.carbonylOxygen.id, fixture.nitrogen.id, fixture.hydroxylOxygen.id, fixture.nitrogen.id]) {
      const beforeMark = dropMark(document), beforeMolecule = dropMolecule(document);
      const target = beforeMolecule.atoms.find(atom => atom.id === targetId)!;
      const result = drop(document, target);
      expect(result.refused).toBeUndefined();
      document = result.document;
      const mark = dropMark(document), molecule = dropMolecule(document), page = document.pages[0];
      const sourceId = beforeMark.anchor.atomId;
      const labels = moleculeLayoutLabelBoxes(molecule);
      for (const atomId of [sourceId, targetId]) {
        const label = labels.find(label => molecule.atoms[label.atom].id === atomId)!;
        expect(mark.x < label.x + label.width && mark.x + mark.width > label.x &&
          mark.y < label.y + label.height && mark.y + mark.height > label.y).toBe(false);
      }
      expect(workflow.nativeChargeMarkCenter(mark)).toEqual(workflow.nativeChargePlacementPointForAtom(
        molecule, targetId, page.objects.filter(object => object.id !== mark.id), page.width, page.height, mark));
      expect(mark).toMatchObject({ id: beforeMark.id, width: beforeMark.width, height: beforeMark.height,
        atomAssociation: "explicit", anchor: { kind: "atom", objectId: molecule.id, atomId: targetId } });
      expect(workflow.normalizeCommittedDocument(document)).toBe(document);
      expect(workflow.normalizeCommittedDocument(deserializeDocument(serializeDocument(document))).pages).toEqual(document.pages);
    }
  });

  it.each(associationSpecs)("dissociates %j in empty space, recomputes chemistry, and reattaches on return", spec => {
    const { document, sourceAtom } = electronMarkDropFixture(spec);
    const originalMolecule = dropMolecule(document);
    const result = drop(document, { x: 600, y: 500 });
    expect(result.refused).toBeUndefined();
    expect(dropMark(result.document)).toMatchObject({ x: 591, y: 491,
      anchor: { kind: "point", point: { x: 600, y: 500 } }, atomAssociation: "explicit" });
    expect(dropMark(result.document).anchor.objectId).toBeUndefined();
    expect(dropMark(result.document).anchor.atomId).toBeUndefined();
    expect(atomDropState(result.document, sourceAtom.id)).toMatchObject({ charge: 0, radicals: 0 });
    expect(result.status).toContain(`removed from ${sourceAtom.element}`);
    expect(result.undoLabel).toMatch(/^Move /);
    const reopened = workflow.normalizeCommittedDocument(deserializeDocument(serializeDocument(result.document)));
    expect(reopened.pages).toEqual(result.document.pages);
    const returned = drop(reopened, sourceAtom);
    expect(returned.refused).toBeUndefined();
    expect(dropMark(returned.document).anchor).toEqual(dropMark(document).anchor);
    expect(dropMolecule(returned.document)).toEqual(originalMolecule);
  });

  it("removes ammonium's positive charge and recomputes NH4 to NH3 through the shared valence code", () => {
    const { document, nitrogen } = ammoniumElectronMarkDropFixture();
    expect(atomDropState(document, nitrogen.id)).toMatchObject({ charge: 1, hydrogens: 4, label: "NH4" });
    const result = drop(document, { x: 600, y: 500 });
    expect(result.refused).toBeUndefined();
    expect(atomDropState(result.document, nitrogen.id)).toMatchObject({ charge: 0, radicals: 0, hydrogens: 3, label: "NH3" });
    expect(dropMolecule(result.document).atoms[0].markCharge).toBeUndefined();
    expect(result.status).toBe("Charge removed from N (N now NH3)");
    const returned = drop(result.document, nitrogen);
    expect(returned.status).toBe("Charge attached to N (N now NH4)");
    expect(dropMolecule(returned.document)).toEqual(dropMolecule(document));
  });

  it("keeps the requested offset for a charge dropped within its atom's capture radius", () => {
    const { document, nitrogen } = electronMarkDropFixture();
    const mark = dropMark(document);
    const radius = documentDrawingDefaults(document).bondLengthPx * ELECTRON_MARK_DROP_CAPTURE_BOND_LENGTHS;
    const point = { x: nitrogen.x, y: nitrogen.y - radius + 0.001 };
    const result = drop(document, point);
    expect(dropMark(result.document).anchor).toEqual(mark.anchor);
    expect(workflow.nativeChargeMarkCenter(dropMark(result.document))).toEqual(point);
    expect(dropMolecule(result.document)).toEqual(dropMolecule(document));
  });

  it("uses an atom-centered association boundary regardless of starting offset", () => {
    const { document, nitrogen } = ammoniumElectronMarkDropFixture();
    const mark = dropMark(document);
    const centered = applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
      x: nitrogen.x - mark.width / 2, y: nitrogen.y - mark.height / 2
    } }, { now: phase4Timestamp });
    for (const drawing of [document, centered]) {
      const inside = { x: nitrogen.x, y: nitrogen.y - nativeChargeAssociationRadiusPx + 0.001 };
      expect(dropMark(drop(drawing, inside).document).anchor).toEqual(mark.anchor);
      const outside = { x: nitrogen.x, y: nitrogen.y - nativeChargeAssociationRadiusPx - 0.001 };
      const detached = drop(drawing, outside).document;
      expect(dropMark(detached).anchor).toEqual({ kind: "point", point: outside });
      expect(atomDropState(detached, nitrogen.id).charge).toBe(0);
    }
  });

  it("detaches at the same endpoint after short outward drags or one long drag", () => {
    const { document, nitrogen } = ammoniumElectronMarkDropFixture();
    const endpoint = (distance: number) => ({ x: nitrogen.x, y: nitrogen.y - distance });
    let sequential = document;
    for (const distance of [8, 16, 24, 32, 40]) sequential = drop(sequential, endpoint(distance)).document;
    const single = drop(document, endpoint(40)).document;
    expect(dropMark(sequential)).toEqual(dropMark(single));
    expect(atomDropState(sequential, nitrogen.id).charge).toBe(0);
  });

  it.each(["point", "stale"])("keeps a %s-anchored floating charge outside capture radius durably, without changing legacy files", anchorKind => {
    const fixture = electronMarkDropFixture();
    let document = workflow.normalizeCommittedDocument(workflow.moveDocumentObject(fixture.document,
      dropMark(fixture.document).id, { x: 591, y: 491 }));
    if (anchorKind === "stale") document = applyPatch(document, { op: "updateObject", objectId: dropMark(document).id,
      changes: { anchor: { kind: "atom", objectId: "missing", atomId: "missing" }, atomAssociation: "explicit" }
    }, { now: phase4Timestamp });
    const point = { x: fixture.carbonylOxygen.x, y: fixture.carbonylOxygen.y - 20 };
    expect(electronMarkDropTarget(document, point)).toBeUndefined();
    const before = atomDropState(document, fixture.carbonylOxygen.id);
    const result = drop(document, point);
    expect(result.refused).toBeUndefined();
    expect(dropMark(result.document).anchor.kind).toBe("point");
    // undefined -> explicit: record the floating drop decision for every future normalization.
    expect(dropMark(result.document).atomAssociation).toBe("explicit");
    expect(dropMolecule(result.document)).toEqual(dropMolecule(document));
    expect(atomDropState(result.document, fixture.carbonylOxygen.id)).toEqual(before);
    expect(workflow.electronMarkChemistryChanges(document, result.document)).toEqual([]);
    expect(result.status).toBe("Moved electron mark");
    // Later O attachment/+1 -> unchanged: unrelated normalization must retain the drop decision.
    expect(workflow.normalizeCommittedDocument(result.document)).toBe(result.document);
    const reopened = workflow.normalizeCommittedDocument(deserializeDocument(serializeDocument(result.document)));
    // Reopen attaching to O -> exact floating mark: the native file must retain the same decision.
    expect(dropMark(reopened)).toEqual(dropMark(result.document));
    expect(dropMolecule(reopened)).toEqual(dropMolecule(document));
    const legacy = applyPatch(result.document, { op: "updateObject", objectId: dropMark(result.document).id,
      changes: { atomAssociation: undefined } }, { now: phase4Timestamp });
    const reopenedLegacy = workflow.normalizeCommittedDocument(deserializeDocument(serializeDocument(legacy)));
    expect(dropMark(reopenedLegacy).anchor.atomId).toBe(fixture.carbonylOxygen.id);
    expect(atomDropState(reopenedLegacy, fixture.carbonylOxygen.id)).toMatchObject({ charge: 1, hydrogens: 1 });
  });

  it("attaches a floating charge inside capture radius and names the committed chemistry", () => {
    const fixture = electronMarkDropFixture();
    const document = workflow.normalizeCommittedDocument(workflow.moveDocumentObject(fixture.document,
      dropMark(fixture.document).id, { x: 591, y: 491 }));
    const result = drop(document, { x: fixture.carbonylOxygen.x, y: fixture.carbonylOxygen.y - 8 });
    expect(result.refused).toBeUndefined();
    expect(dropMark(result.document)).toMatchObject({ atomAssociation: "explicit",
      anchor: { kind: "atom", objectId: dropMolecule(document).id, atomId: fixture.carbonylOxygen.id } });
    expect(atomDropState(result.document, fixture.carbonylOxygen.id)).toMatchObject({ charge: 1, hydrogens: 1 });
    expect(result.status).toBe("Charge attached to O (O now OH)");
  });

  it.each([[20, "native reopen"], [20, "text insertion"], [8, "native reopen"], [8, "text insertion"]] as const)("preserves the drop decision %s px from O through %s", (separation, action) => {
    const fixture = electronMarkDropFixture();
    const floating = workflow.normalizeCommittedDocument(workflow.moveDocumentObject(fixture.document,
      dropMark(fixture.document).id, { x: 591, y: 491 }));
    const dropped = drop(floating, { x: fixture.carbonylOxygen.x, y: fixture.carbonylOxygen.y - separation }).document;
    const molecule = dropMolecule(dropped), mark = dropMark(dropped);
    expect(molecule.atoms[10].formalCharge).toBe(separation === 20 ? 0 : 1);
    expect(mark.anchor.kind).toBe(separation === 20 ? "point" : "atom");
    const next = workflow.normalizeCommittedDocument(action === "native reopen"
      ? workflow.openNativeDocument(serializeDocument(dropped)).document!
      : workflow.insertNativeTextObject(dropped, { x: 500, y: 400 }, "Unrelated text"));
    if (action === "text insertion") expect(next.pages[0].objects.some(object => object.type === "text")).toBe(true);
    expect(dropMolecule(next)).toEqual(molecule);
    expect(dropMark(next)).toEqual(mark);
  });

  it.each([0, 180])("targets rendered O rather than N with molecule rotation %s", rotation => {
    const document = rotatedElectronMarkDropFixture(rotation), molecule = dropMolecule(document);
    const point = { x: rotation === 180 ? 200 : 100, y: 110 };
    expect(electronMarkDropTarget(document, point)).toMatchObject({ kind: "atom", atomId: molecule.atoms[0].id });
    const result = drop(document, point);
    expect(result.refused).toBeUndefined();
    expect(dropMark(result.document).anchor.atomId).toBe(molecule.atoms[0].id);
    expect(dropMolecule(result.document).atoms.map(atom => atom.formalCharge)).toEqual([1, 0, 0, 0]);
    const center = workflow.nativeChargeMarkCenter(dropMark(result.document));
    const oxygen = transformPointForObject(molecule, molecule.atoms[0]);
    const nitrogen = transformPointForObject(molecule, molecule.atoms[3]);
    const oxygenDistance = Math.hypot(center.x - oxygen.x, center.y - oxygen.y);
    // The unrotated placement is about 22 px from O; allow at most 1.5 drawing bonds.
    expect(oxygenDistance).toBeLessThanOrEqual(documentDrawingDefaults(document).bondLengthPx * 1.5);
    expect(Math.hypot(center.x - nitrogen.x, center.y - nitrogen.y)).toBeGreaterThan(oxygenDistance);
  });

  it.each([0, 180])("places a new charge-tool mark beside rendered O with molecule rotation %s", rotation => {
    const fixture = rotatedElectronMarkDropFixture(rotation);
    const document = applyPatch(fixture, { op: "removeObject", objectId: dropMark(fixture).id }, { now: phase4Timestamp });
    const molecule = dropMolecule(document), atom = molecule.atoms[0];
    const result = workflow.applyChargeToolAtNativeAtom(document, 1,
      { kind: "atom", objectId: molecule.id, atomId: atom.id, distanceToPointer: 0 });
    const mark = dropMark(result), center = workflow.nativeChargeMarkCenter(mark);
    const oxygen = transformPointForObject(molecule, atom);
    const nitrogen = transformPointForObject(molecule, molecule.atoms[3]);
    const oxygenDistance = Math.hypot(center.x - oxygen.x, center.y - oxygen.y);
    expect(mark.anchor).toMatchObject({ kind: "atom", objectId: molecule.id, atomId: atom.id });
    expect(oxygenDistance).toBeLessThanOrEqual(documentDrawingDefaults(document).bondLengthPx * 1.5);
    expect(Math.hypot(center.x - nitrogen.x, center.y - nitrogen.y)).toBeGreaterThan(oxygenDistance);
    const committed = workflow.normalizeCommittedDocument(result);
    expect(dropMark(committed)).toEqual(mark);
    expect(dropMolecule(committed).atoms.map(atom => atom.formalCharge)).toEqual([1, 0, 0, 0]);
  });

  it.each(associationSpecs)("keeps a deliberate floating %j through appearance and layout edits until an atom drop", spec => {
    const fixture = electronMarkDropFixture(spec);
    const floating = workflow.normalizeCommittedDocument(workflow.moveDocumentObject(fixture.document,
      dropMark(fixture.document).id, { x: 591, y: 491 }));
    const point = { x: fixture.carbonylOxygen.x, y: fixture.carbonylOxygen.y - 20 };
    let document = drop(floating, point).document;
    const molecule = dropMolecule(document), mark = dropMark(document);
    expect(mark).toMatchObject({ atomAssociation: "explicit", anchor: { kind: "point" } });
    expect(molecule.atoms.every(atom => (atom.markRadicals ?? 0) === 0)).toBe(true);
    document = workflow.applyElectronMarkStyleToSelection(document, "size", 72);
    document = workflow.rotateDocumentObject(document, mark.id, 73);
    document = workflow.moveDocumentObjects(document, [mark.id], 0, 1);
    document = workflow.normalizeCommittedDocument(document);
    expect(dropMolecule(document)).toEqual(molecule);
    expect(dropMark(document)).toMatchObject({ atomAssociation: "explicit", anchor: { kind: "point" } });
    const selected = workflow.normalizeCommittedDocument(workflow.selectDocumentObjects(document,
      document.pages[0].id, document.pages[0].objects.map(object => object.id)));
    const withText = workflow.normalizeCommittedDocument(workflow.insertNativeTextObject(selected,
      { x: 500, y: 400 }, "Unrelated text"));
    expect(dropMolecule(withText)).toEqual(molecule);
    expect(dropMark(withText)).toEqual(dropMark(document));
    const reopened = workflow.normalizeCommittedDocument(workflow.openNativeDocument(serializeDocument(withText)).document!);
    expect(dropMolecule(reopened)).toEqual(molecule);
    expect(dropMark(reopened)).toEqual(dropMark(document));
    // The next intentional atom drop can replace the floating decision, including for radicals.
    const attached = drop(reopened, fixture.sourceAtom);
    expect(attached.refused).toBeUndefined();
    expect(dropMark(attached.document)).toMatchObject({ atomAssociation: "explicit",
      anchor: { kind: "atom", objectId: molecule.id, atomId: fixture.sourceAtom.id } });
    const contribution = workflow.electronMarkAtomContribution(mark);
    expect(atomDropState(attached.document, fixture.sourceAtom.id)).toMatchObject({
      charge: contribution.charge, radicals: contribution.radicals
    });
    expect(dropMolecule(attached.document).atoms.reduce((sum, atom) => sum + (atom.markRadicals ?? 0), 0))
      .toBe(contribution.radicals);
  });

  it("reports chemistry introduced by normalization even without an intended transfer", () => {
    const fixture = electronMarkDropFixture();
    const document = workflow.normalizeCommittedDocument(workflow.moveDocumentObject(fixture.document,
      dropMark(fixture.document).id, { x: 591, y: 491 }));
    const normalize = workflow.normalizeCommittedDocument;
    // Belt and braces: simulate a future normalization pass unexpectedly capturing the mark.
    vi.spyOn(workflow, "normalizeCommittedDocument").mockImplementation(next => normalize(applyPatch(next, {
      op: "updateObject", objectId: dropMark(next).id, changes: { atomAssociation: undefined }
    }, { now: phase4Timestamp })));
    const result = drop(document, { x: fixture.carbonylOxygen.x, y: fixture.carbonylOxygen.y - 20 });
    expect(atomDropState(result.document, fixture.carbonylOxygen.id)).toMatchObject({ charge: 1, hydrogens: 1 });
    expect(result.status).toBe("Charge attached to O (O now OH)");
  });

  it("refuses an unsupported charge assigned during normalization without an intended target", () => {
    const { document, saturatedCarbon } = electronMarkDropFixture();
    const floating = drop(document, { x: 600, y: 500 }).document;
    const normalize = workflow.normalizeCommittedDocument;
    vi.spyOn(workflow, "normalizeCommittedDocument").mockImplementation(next => normalize(applyPatch(next, {
      op: "updateObject", objectId: dropMark(next).id, changes: {
        anchor: { kind: "atom", objectId: dropMolecule(next).id, atomId: saturatedCarbon.id }
      }
    }, { now: phase4Timestamp })));
    const result = drop(floating, { x: 610, y: 500 });
    expect(result.document).toBe(floating);
    expect(result.status).toBe("Cannot move Charge to C: C cannot carry formal charge +1 with bond/radical valence 4");
  });

  it.each([1, -1] as const)("retains a distant radical ion's association when neutralising charge %s", async charge => {
    const fixture = electronMarkDropFixture({ kind: "charge", charge, radical: true });
    const distant = distantAttachedElectronMarkFixture({ kind: "charge", charge, radical: true }).document;
    const original = dropMark(distant), molecule = dropMolecule(distant);
    const neutral = workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(distant, -charge as 1 | -1,
      { kind: "atom", objectId: molecule.id, atomId: fixture.sourceAtom.id, distanceToPointer: 0 }));
    expect(dropMark(neutral)).toMatchObject({ id: original.id, markKind: "radical-dot", x: original.x, y: original.y,
      anchor: original.anchor, atomAssociation: "explicit" });
    expect(dropMark(neutral).charge).toBeUndefined();
    expect(dropMark(neutral).radical).toBeUndefined();
    expect(atomDropState(neutral, fixture.sourceAtom.id)).toMatchObject({ charge: 0, radicals: 1, hydrogens: charge > 0 ? 0 : 2 });
    const module = await ensureRdkit();
    const result = inspectStructureInWorker(module, stereoPerceptionMolfile(dropMolecule(neutral)));
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(result.reason);
    const expected = module.get_mol(charge > 0 ? "CC(C)(C)OC(=O)[N]CC(=O)O" : "[CH2]C(C)(C)OC(=O)NCC(=O)O");
    if (!expected?.get_smiles) {
      expected?.delete();
      throw new Error("Cannot canonicalize expected neutral radical");
    }
    try { expect(result.canonicalSmiles).toBe(expected.get_smiles()); } finally { expected.delete(); }
    expect(workflow.normalizeCommittedDocument(neutral)).toBe(neutral);
  });

  it.each(associationSpecs)("re-associates and transfers exactly the contribution of %j", spec => {
    const { document, sourceAtom, hydroxylOxygen } = electronMarkDropFixture(spec);
    // The hydroxyl O can accept one unpaired electron; use carbon for negative radical ions.
    const destination = spec.kind === "charge" && spec.charge < 0 && spec.radical ? dropMolecule(document).atoms[8] : hydroxylOxygen;
    const contribution = workflow.electronMarkAtomContribution(dropMark(document));
    const oldSource = atomDropState(document, sourceAtom.id), oldTarget = atomDropState(document, destination.id);
    const result = drop(document, destination);
    expect(result.refused).toBeUndefined();
    expect(dropMark(result.document).anchor).toEqual({ kind: "atom", objectId: dropMolecule(document).id, atomId: destination.id });
    expect(atomDropState(result.document, sourceAtom.id)).toMatchObject({
      charge: oldSource.charge - contribution.charge, radicals: oldSource.radicals - contribution.radicals });
    expect(atomDropState(result.document, destination.id)).toMatchObject({
      charge: oldTarget.charge + contribution.charge, radicals: oldTarget.radicals + contribution.radicals });
    if (spec.kind === "lone-pair") {
      expect(dropMolecule(result.document)).toEqual(dropMolecule(document));
      expect(result.status).toBe("Lone pair moved from N to O");
    } else expect(result.status).toContain("now");
  });

  it("refuses the nearest atom's invalid valence without falling back to a different atom or adding an undo candidate", () => {
    const { document, saturatedCarbon } = electronMarkDropFixture();
    const result = drop(document, saturatedCarbon);
    expect(result.document).toBe(document);
    expect(result.refused).toBe(true);
    expect(result.status).toBe("Cannot move Charge from N to C: C cannot carry formal charge +1 with bond/radical valence 4");
  });

  it.each(["transfer", "detach"])("refuses to strip the charge from a four-bond nitrogen on %s", action => {
    const { document, carbonylOxygen } = fourBondNitrogenElectronMarkDropFixture();
    const result = drop(document, action === "transfer" ? carbonylOxygen : { x: 600, y: 500 });
    expect(result.refused).toBe(true);
    expect(result.document).toBe(document);
    expect(result.status).toBe(`Cannot move Charge from N${action === "transfer" ? " to O" : ""}: N cannot carry formal charge 0 with bond/radical valence 4`);
  });

  it("refuses two radical drops that together exceed the target atom's valence", () => {
    const { document, nitrogen } = electronMarkDropFixture({ kind: "lone-pair" });
    const start = { x: 555, y: 495 };
    const first = workflow.applyChargeToolAtPoint(document, { kind: "radical-dot" }, start);
    const before = workflow.normalizeCommittedDocument(workflow.applyChargeToolAtPoint(first,
      { kind: "radical-dot" }, { x: start.x + 10, y: start.y }));
    const [firstRadical, secondRadical] = before.pages[0].objects.filter(object =>
      object.type === "electron-mark" && object.markKind === "radical-dot");
    const point = { x: nitrogen.x - 5, y: nitrogen.y };
    const delta = { x: point.x - start.x, y: point.y - start.y };
    for (const radical of [firstRadical, secondRadical]) {
      const position = { x: radical.x + delta.x, y: radical.y + delta.y };
      expect(dropElectronMark(before, radical.id, position, { x: position.x + radical.width / 2,
        y: position.y + radical.height / 2 }).refused).toBeUndefined();
    }
    const result = dropElectronMarksInSelection(before, [firstRadical.id, secondRadical.id], delta,
      { grabbedObjectId: firstRadical.id, point });
    expect(result.document).toBe(before);
    expect(result.status).toBe("Cannot move Radical electron to N: N cannot carry formal charge 0 with bond/radical valence 4");
  });

  it("re-associates unknown display marks too", () => {
    const fixture = electronMarkDropFixture({ kind: "lone-pair" });
    const document = applyPatch(fixture.document, { op: "updateObject", objectId: dropMark(fixture.document).id,
      changes: { markKind: "unknown" } }, { now: phase4Timestamp });
    const result = drop(document, fixture.carbonylOxygen);
    expect(dropMark(result.document).anchor.atomId).toBe(fixture.carbonylOxygen.id);
    expect(dropMolecule(result.document)).toEqual(dropMolecule(document));
    expect(result.status).toBe("Electron mark moved from N to O");
  });

  it("moves chemistry between molecules whose local atom ids match", () => {
    const fixture = electronMarkDropFixture(), base = dropMolecule(electronMarkDropFixture({ kind: "lone-pair" }).document);
    const target = { ...base, id: "other_molecule", x: base.x + 160,
      atoms: base.atoms.map(atom => ({ ...atom, x: atom.x + 160 })) };
    const document = applyPatch(fixture.document, { op: "addObject", pageId: fixture.document.pages[0].id, object: target }, { now: phase4Timestamp });
    const targetAtom = target.atoms[10], result = drop(document, targetAtom);
    expect(result.refused).toBeUndefined();
    expect(dropMark(result.document).anchor).toEqual({ kind: "atom", objectId: target.id, atomId: targetAtom.id });
    expect(atomDropState(result.document, fixture.nitrogen.id)).toMatchObject({ charge: 0, label: "NH", hydrogens: 1 });
    const finalTarget = workflow.findDocumentObject(result.document, target.id);
    expect(finalTarget?.type === "molecule" && finalTarget.atoms[10]).toMatchObject({ formalCharge: 1, markCharge: 1 });
    expect(atomDropState(result.document, fixture.carbonylOxygen.id).charge).toBe(0);
    expect(result.status).toBe("Charge moved from N to O (O now OH, N now NH)");
  });

  it("preserves intrinsic charge and other marks while moving just one contribution", () => {
    const fixture = electronMarkDropFixture(), molecule = dropMolecule(fixture.document);
    let document = applyPatch(fixture.document, { op: "updateObject", objectId: molecule.id, changes: {
      atoms: molecule.atoms.map(atom => atom.id === fixture.hydroxylOxygen.id ? { ...atom, formalCharge: -1 } : atom)
    } }, { now: phase4Timestamp });
    const sourceMark = dropMark(document);
    document = workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(document, { kind: "radical-dot" },
      { kind: "atom", objectId: molecule.id, atomId: fixture.nitrogen.id, distanceToPointer: 0 }));
    const otherMark = document.pages[0].objects.find(object => object.type === "electron-mark" && object.id !== sourceMark.id)!;
    const before = document;
    const result = drop(document, fixture.hydroxylOxygen);
    expect(result.refused).toBeUndefined();
    expect(atomDropState(result.document, fixture.nitrogen.id)).toMatchObject({ charge: 0, radicals: 1 });
    expect(atomDropState(result.document, fixture.hydroxylOxygen.id)).toMatchObject({ charge: 0, radicals: 0 });
    expect(workflow.findDocumentObject(result.document, otherMark.id)).toEqual(otherMark);
    const restored = drop(result.document, fixture.nitrogen).document;
    expect(dropMolecule(restored)).toEqual(dropMolecule(before));
  });
});

it("chooses the nearest atom inside half the document bond length, including the boundary, independent of mark size", () => {
  const { document, carbonylOxygen } = electronMarkDropFixture();
  const radius = documentDrawingDefaults(document).bondLengthPx * ELECTRON_MARK_DROP_CAPTURE_BOND_LENGTHS;
  expect(radius).toBe(11);
  expect(electronMarkDropTarget(document, { x: carbonylOxygen.x, y: carbonylOxygen.y - radius })).toMatchObject({ atomId: carbonylOxygen.id });
  expect(electronMarkDropTarget(document, { x: carbonylOxygen.x, y: carbonylOxygen.y - radius - 0.001 })).toBeUndefined();
  const molecule = dropMolecule(document), oh = molecule.atoms[11];
  const crowded = applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: {
    atoms: molecule.atoms.map(atom => atom.id === oh.id ? { ...atom, x: carbonylOxygen.x + 6, y: carbonylOxygen.y } : atom)
  } }, { now: phase4Timestamp });
  // Both targets are within the radius: ties use document order, otherwise the nearest wins.
  expect(electronMarkDropTarget(crowded, { x: carbonylOxygen.x + 3, y: carbonylOxygen.y })).toMatchObject({ atomId: carbonylOxygen.id });
  expect(electronMarkDropTarget(crowded, { x: carbonylOxygen.x + 4, y: carbonylOxygen.y })).toMatchObject({ atomId: oh.id });
  const largeMark = workflow.applyElectronMarkStyleToSelection(crowded, "size", 108);
  expect(electronMarkDropTarget(largeMark, { x: carbonylOxygen.x + 4, y: carbonylOxygen.y })).toMatchObject({ atomId: oh.id });
  const scaled = { ...document, styles: { ...document.styles, drawing: { bondLengthPx: 44 } } };
  expect(electronMarkDropTarget(scaled, { x: carbonylOxygen.x, y: carbonylOxygen.y - 20 })).toMatchObject({ atomId: carbonylOxygen.id });
});

it.each(associationSpecs)("keeps a distant explicit attachment through appearance edits of %j", spec => {
  let document = distantAttachedElectronMarkFixture(spec).document;
  const original = dropMolecule(document), anchor = dropMark(document).anchor;
  document = workflow.applyElectronMarkStyleToSelection(document, "size", 72);
  document = workflow.applyElectronMarkStyleToSelection(document, "thickness", 5);
  document = workflow.rotateDocumentObject(document, dropMark(document).id, 73);
  document = workflow.scaleDocumentObjectsAroundPoint(document, [dropMark(document).id], workflow.nativeChargeMarkCenter(dropMark(document)), 1.25, 1.25);
  document = workflow.normalizeCommittedDocument(document);
  expect(dropMolecule(document)).toEqual(original);
  expect(dropMark(document).anchor).toEqual(anchor);
});

it.each(associationSpecs)("keeps standalone-copy policy and explicit carried associations after dropping %j", spec => {
  const fixture = electronMarkDropFixture(spec);
  const explicit = drop(fixture.document, { x: fixture.sourceAtom.x, y: fixture.sourceAtom.y - 8 }).document;
  const mark = dropMark(explicit), molecule = dropMolecule(explicit);
  const legacy = applyPatch(explicit, { op: "updateObject", objectId: mark.id, changes: { atomAssociation: undefined } }, { now: phase4Timestamp });
  const chemistryAndAnchors = (document: ChemDraftDocument) => workflow.normalizeCommittedDocument(document).pages[0].objects.map(object =>
    object.type === "molecule" ? [object.id, object.atoms, object.chemistry] : object.type === "electron-mark" ? [object.id, object.anchor] : [object.id]);
  for (const operate of [
    (document: ChemDraftDocument) => workflow.duplicateSelectedDocumentObjects(document, { x: 0, y: 0 }),
    (document: ChemDraftDocument) => workflow.duplicateSelectedDocumentObjects(document, { x: 4, y: 4 })
  ]) expect(chemistryAndAnchors(operate(explicit))).toEqual(chemistryAndAnchors(operate(legacy)));

  const selected = workflow.selectDocumentObjects(explicit, explicit.pages[0].id, [mark.id, molecule.id]);
  const payload = workflow.createSelectionClipboardPayload(selected)!;
  // Carrying the whole structure preserves the chosen atom, even when a neighbor is closer.
  for (const edited of [
    workflow.moveDocumentObjects(selected, [molecule.id, mark.id], 80, 100),
    workflow.duplicateSelectedDocumentObjects(selected, { x: 4, y: 4 }),
    workflow.pasteSelectionClipboardPayload(workflow.createPhase4Document("Paste dropped marks"), payload,
      { x: payload.bounds.centerX + 4, y: payload.bounds.centerY + 4 })
  ]) {
    const committed = workflow.normalizeCommittedDocument(edited);
    for (const copied of committed.pages[0].objects.filter(object => object.type === "molecule")) {
      const chemistry = (object: typeof molecule) => object.atoms.map(({ x: _x, y: _y, ...atom }) => atom);
      expect(chemistry(copied)).toEqual(chemistry(molecule));
      expect(copied.chemistry).toEqual(molecule.chemistry);
      expect(committed.pages[0].objects.find(object => object.type === "electron-mark" &&
        object.anchor.objectId === copied.id)).toMatchObject({ atomAssociation: "explicit",
        anchor: { kind: "atom", objectId: copied.id, atomId: fixture.sourceAtom.id } });
    }
  }
});

it("calls the chemistry reporter only for the dropped mark and its two affected atoms", () => {
  const { document, carbonylOxygen, nitrogen } = electronMarkDropFixture();
  const reporter = vi.spyOn(workflow, "electronMarkChemistryChanges");
  const result = drop(document, carbonylOxygen);
  expect(result.status).toBe("Charge moved from N to O (O now OH, N now NH)");
  expect(reporter).toHaveBeenCalledTimes(1);
  expect(reporter.mock.calls[0][0]).toBe(document);
  expect(reporter.mock.calls[0][1]).toBe(result.document);
  expect(reporter.mock.calls[0][2]).toEqual({ markIds: [dropMark(document).id], atoms: [
    { objectId: dropMolecule(document).id, atomId: nitrogen.id },
    { objectId: dropMolecule(document).id, atomId: carbonylOxygen.id }
  ] });
});
