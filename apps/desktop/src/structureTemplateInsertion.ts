import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { structureTemplateForSmiles, structureTemplateMolecule } from "@chemdraft/document-workflow-core";
import { loadRdkitWithAppLoader } from "./plugins/rdkitAppLoader";

// Keep this callback stable for the core's canonical identity cache. RDKit returns canonical
// isomeric SMILES by default; no stereo removal, neutralization or alternate identity engine.
const canonicalize = async (smiles: string): Promise<string | null> => {
  const rdkit = await loadRdkitWithAppLoader(() => import("@chemdraft/rdkit-adapter"));
  const module = await rdkit.ensureRdkit();
  const molecule = module.get_mol(smiles);
  if (!molecule) return null;
  try { return molecule.get_smiles?.() || null; }
  finally { molecule.delete(); }
};

/** Only call for coordinate-less input, never a document graph or molfile. */
export async function templateMoleculeForSmiles(smiles: string, document: ChemDraftDocument,
  centre: { x: number; y: number }, reservedObjectIds?: Set<string>) {
  // Failed identity verification cannot authorize a template; retain the ordinary host's
  // depiction fallback and its existing chemistry-refusal/error contract.
  const template = await structureTemplateForSmiles(smiles, canonicalize).catch(() => undefined);
  return template ? structureTemplateMolecule(template, { document, centre, reservedObjectIds }) : undefined;
}
