import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { structureTemplateForSmiles, structureTemplateMolecule } from "@chemdraft/document-workflow-core";
import { applyPatches } from "@chemdraft/chem-core";
import { structureTemplateById } from "@chemdraft/template-library";

/** Same add/select patch transaction as SMILES inserts, without a depiction engine. */
export function insertStructureTemplate(document: ChemDraftDocument, id: string, centre: { x: number; y: number }) {
  const template = structureTemplateById(id);
  if (!template) throw new Error(`Unknown structure template: ${id}`);
  const page = document.pages[0];
  if (!page) throw new Error("The drawing has no page for this template.");
  const object = structureTemplateMolecule(template, { document, centre });
  return { document: applyPatches(document, [
    { op: "addObject", pageId: page.id, object },
    { op: "setSelection", pageId: page.id, objectIds: [object.id] }
  ]), label: `Insert ${template.name}` };
}

// Keep this callback stable for the core's canonical identity cache. RDKit returns canonical
// isomeric SMILES by default; no stereo removal, neutralization or alternate identity engine.
const canonicalize = async (smiles: string): Promise<string | null> => {
  const rdkit = await import("@chemdraft/rdkit-adapter");
  const module = await rdkit.ensureRdkit().catch(async (error: unknown) => {
    // Template lookup must reuse the host's loader and cached module. Installing the browser
    // loader unconditionally here replaces an already configured loader and clears its cache.
    // Only an unconfigured host needs browser setup; real load failures retain their own error.
    if (!(error instanceof rdkit.RdkitNotConfiguredError)) throw error;
    const { loadRdkitWithAppLoader } = await import("./plugins/rdkitAppLoader");
    await loadRdkitWithAppLoader(() => Promise.resolve(rdkit));
    return rdkit.ensureRdkit();
  });
  const molecule = module.get_mol(smiles);
  if (!molecule) return null;
  try { return molecule.get_smiles?.() || null; }
  finally { molecule.delete(); }
};

/** Resolve only coordinate-less input, never a document graph or molfile. */
export async function templateForSmiles(smiles: string) {
  return structureTemplateForSmiles(smiles, canonicalize).catch(() => undefined);
}

/** Only call for coordinate-less input, never a document graph or molfile. */
export async function templateMoleculeForSmiles(smiles: string, document: ChemDraftDocument,
  centre: { x: number; y: number }, reservedObjectIds?: Set<string>) {
  // Failed identity verification cannot authorize a template; retain the ordinary host's
  // depiction fallback and its existing chemistry-refusal/error contract.
  const template = await templateForSmiles(smiles);
  return template ? structureTemplateMolecule(template, { document, centre, reservedObjectIds }) : undefined;
}
