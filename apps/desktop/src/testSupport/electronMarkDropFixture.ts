import { applyPatch, applyPatches, type ChemDraftDocument, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles, phase4Timestamp } from "@chemdraft/document-workflow-core";
import { applyChargeToolAtNativeAtom, createPhase4Document, moveDocumentObject, normalizeCommittedDocument, type NativeElectronMarkSpec } from "../documentWorkflow";

export const dropMark = (document: ChemDraftDocument) => document.pages[0].objects.find(object => object.type === "electron-mark") as ElectronMarkObject;
export const dropMolecule = (document: ChemDraftDocument) => document.pages[0].objects.find(object => object.type === "molecule") as MoleculeObject;

/** O–C–C–N in the reported rotation frame, with a distant floating +. */
export function rotatedElectronMarkDropFixture(rotation: number) {
  const fixture = electronMarkDropFixture();
  const floating = normalizeCommittedDocument(moveDocumentObject(fixture.document,
    dropMark(fixture.document).id, { x: 591, y: 491 }));
  const graph = testMoleculeFromSmiles("OCCN");
  const atoms = graph.atoms.map((atom, index) => ({ ...atom, x: 100 + index * 100 / 3, y: 110 }));
  return applyPatch(floating, { op: "updateObject", objectId: dropMolecule(floating).id, changes: {
    x: 100, y: 100, width: 100, height: 20, rotation, atoms, bonds: graph.bonds,
    structure: nativeSingleBondGraphSmiles(atoms, graph.bonds), chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds)
  } }, { now: phase4Timestamp });
}

/** Boc-glycine with separated, hand-authored drop targets and no explicitly bonded hydrogens. */
export function electronMarkDropFixture(spec: NativeElectronMarkSpec = { kind: "charge", charge: 1 }) {
  let document = createPhase4Document("Electron mark drop");
  const graph = testMoleculeFromSmiles("CC(C)(C)OC(=O)NCC(=O)O");
  const points = [[140, 250], [162, 250], [162, 228], [162, 272], [184, 250], [206, 250],
    [206, 228], [228, 250], [250, 250], [272, 250], [272, 228], [294, 250]];
  const atoms = graph.atoms.map((atom, index) => ({ ...atom, x: points[index][0], y: points[index][1] }));
  const molecule: MoleculeObject = { id: "boc_glycine", type: "molecule", x: 140, y: 228, width: 154, height: 44,
    rotation: 0, style: {}, atoms, bonds: graph.bonds, structureFormat: "smiles",
    structure: nativeSingleBondGraphSmiles(atoms, graph.bonds), chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds),
    superatoms: [], rGroups: [] };
  document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: molecule }], { now: phase4Timestamp });
  const nitrogen = atoms[7], carbonylOxygen = atoms[10], hydroxylOxygen = atoms[11], saturatedCarbon = atoms[1];
  // N with two bonds cannot carry a negative radical ion; use a terminal carbon for that variant.
  const sourceAtom = spec.kind === "charge" && spec.charge < 0 && spec.radical ? atoms[0] : nitrogen;
  document = normalizeCommittedDocument(applyChargeToolAtNativeAtom(document, spec,
    { kind: "atom", objectId: molecule.id, atomId: sourceAtom.id, distanceToPointer: 0 }));
  return { document, nitrogen, carbonylOxygen, hydroxylOxygen, saturatedCarbon, sourceAtom };
}
