import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, deserializeDocument, serializeDocument, type ChemDraftDocument, type MoleculeAtom, type MoleculeBond } from "@chemdraft/chem-core";
import { atomDisplayLabel, moleculeLayoutLabelBoxes, transformPointForObject } from "@chemdraft/layout-engine";
import { documentDrawingDefaults, nativeAtomBondOrderUsage, nativeImplicitHydrogenCount, phase4Timestamp,
  stereoPerceptionMolfile, type PagePoint } from "@chemdraft/document-workflow-core";
import * as workflow from "./documentWorkflow";
import { dropElectronMark, electronMarkDropTarget, ELECTRON_MARK_DROP_CAPTURE_BOND_LENGTHS } from "./electronMarkDrop";
import { dropMark, dropMolecule, electronMarkDropFixture, rotatedElectronMarkDropFixture } from "./testSupport/electronMarkDropFixture";
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

  it.each(associationSpecs)("keeps the source atom and chemistry in empty space for %j, including after save and normalize", spec => {
    const { document, sourceAtom } = electronMarkDropFixture(spec);
    const originalMolecule = dropMolecule(document);
    const result = drop(document, { x: 600, y: 500 });
    expect(result.refused).toBeUndefined();
    expect(dropMark(result.document)).toMatchObject({ x: 591, y: 491,
      anchor: { kind: "atom", objectId: originalMolecule.id, atomId: sourceAtom.id }, atomAssociation: "explicit" });
    expect(dropMolecule(result.document)).toEqual(originalMolecule);
    expect(result.status).toContain("no atom within capture radius");
    const reopened = workflow.normalizeCommittedDocument(deserializeDocument(serializeDocument(result.document)));
    expect(reopened.pages).toEqual(result.document.pages);
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

  it.each([1, -1] as const)("retains a distant radical ion's association when neutralising charge %s", async charge => {
    const fixture = electronMarkDropFixture({ kind: "charge", charge, radical: true });
    const distant = drop(fixture.document, { x: 600, y: 500 }).document;
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

  it("refuses to strip the charge from a four-bond nitrogen", () => {
    const fixture = electronMarkDropFixture();
    const molecule = dropMolecule(fixture.document);
    const hydrogens: MoleculeAtom[] = [-1, 1].map((side, index) => ({ id: `explicit_h${index}`, element: "H", formalCharge: 0,
      x: fixture.nitrogen.x, y: fixture.nitrogen.y + side * 22 }));
    const bonds: MoleculeBond[] = hydrogens.map(atom => ({ id: `bond_${atom.id}`, fromAtomId: fixture.nitrogen.id,
      toAtomId: atom.id, order: "single" }));
    const document = workflow.normalizeCommittedDocument(applyPatch(fixture.document, { op: "updateObject", objectId: molecule.id,
      changes: { atoms: [...molecule.atoms, ...hydrogens], bonds: [...molecule.bonds, ...bonds] } }, { now: phase4Timestamp }));
    const result = drop(document, fixture.carbonylOxygen);
    expect(result.refused).toBe(true);
    expect(result.document).toBe(document);
    expect(result.status).toBe("Cannot move Charge from N to O: N cannot carry formal charge 0 with bond/radical valence 4");
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
  const fixture = electronMarkDropFixture(spec);
  let document = drop(fixture.document, { x: 600, y: 500 }).document;
  const original = dropMolecule(document), anchor = dropMark(document).anchor;
  document = workflow.applyElectronMarkStyleToSelection(document, "size", 72);
  document = workflow.applyElectronMarkStyleToSelection(document, "thickness", 5);
  document = workflow.rotateDocumentObject(document, dropMark(document).id, 73);
  document = workflow.scaleDocumentObjectsAroundPoint(document, [dropMark(document).id], workflow.nativeChargeMarkCenter(dropMark(document)), 1.25, 1.25);
  document = workflow.normalizeCommittedDocument(document);
  expect(dropMolecule(document)).toEqual(original);
  expect(dropMark(document).anchor).toEqual(anchor);
});

it.each(associationSpecs)("keeps normal copy/paste/group anchor policy after dropping %j", spec => {
  const fixture = electronMarkDropFixture(spec);
  const explicit = drop(fixture.document, { x: fixture.sourceAtom.x, y: fixture.sourceAtom.y - 8 }).document;
  const mark = dropMark(explicit), molecule = dropMolecule(explicit);
  const legacy = applyPatch(explicit, { op: "updateObject", objectId: mark.id, changes: { atomAssociation: undefined } }, { now: phase4Timestamp });
  const selected = (document: ChemDraftDocument) => workflow.selectDocumentObjects(document, document.pages[0].id, [mark.id, molecule.id]);
  const chemistryAndAnchors = (document: ChemDraftDocument) => workflow.normalizeCommittedDocument(document).pages[0].objects.map(object =>
    object.type === "molecule" ? [object.id, object.atoms, object.chemistry] : object.type === "electron-mark" ? [object.id, object.anchor] : [object.id]);
  for (const operate of [
    (document: ChemDraftDocument) => workflow.duplicateSelectedDocumentObjects(document, { x: 0, y: 0 }),
    (document: ChemDraftDocument) => workflow.duplicateSelectedDocumentObjects(document, { x: 4, y: 4 }),
    (document: ChemDraftDocument) => workflow.moveDocumentObjects(selected(document), [molecule.id, mark.id], 80, 100),
    (document: ChemDraftDocument) => {
      const payload = workflow.createSelectionClipboardPayload(selected(document))!;
      return workflow.pasteSelectionClipboardPayload(workflow.createPhase4Document("Paste dropped marks"), payload,
        { x: payload.bounds.centerX + 4, y: payload.bounds.centerY + 4 });
    }
  ]) expect(chemistryAndAnchors(operate(explicit))).toEqual(chemistryAndAnchors(operate(legacy)));
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
