import { applyPatches, type ChemDraftDocument } from "@chemdraft/chem-core";
import { createSmilesMolecule, structureTemplateLayoutMessage, type PastedStructureDepiction } from "@chemdraft/document-workflow-core";
import { templateMoleculeForSmiles } from "./structureTemplateInsertion";

/** The clipboard's coordinate-less SMILES path. Existing patch/history callers own the commit. */
export async function insertPastedSmiles(document: ChemDraftDocument, point: { x: number; y: number },
  depiction: PastedStructureDepiction, smiles: string) {
  const molecule = await templateMoleculeForSmiles(smiles, document, point)
    ?? createSmilesMolecule(document, point, depiction, smiles);
  const page = document.pages[0]!;
  return { document: applyPatches(document, [
    { op: "addObject", pageId: page.id, object: molecule },
    { op: "setSelection", pageId: page.id, objectIds: [molecule.id] }
  ]), status: structureTemplateLayoutMessage(molecule) };
}
