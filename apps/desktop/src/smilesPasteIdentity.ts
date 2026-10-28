import type { ChemDraftDocument } from "@chemdraft/chem-core";
import {
  assertMoleculeMatchesSmiles, ChemicalIdentityMismatchError, type InspectChemicalIdentity,
  type PagePoint, type PastedStructureDepiction
} from "@chemdraft/document-workflow-core";
import { insertSmilesMolecule, insertSmilesMoleculeGrid } from "./documentWorkflow";
import { loadRdkitWithAppLoader } from "./plugins/rdkitAppLoader";
import type { SmilesListPasteFailure } from "./smilesListPaste";

const inspectPasteIdentity: InspectChemicalIdentity = async (_format, value) => {
  const rdkit = await loadRdkitWithAppLoader(() => import("@chemdraft/rdkit-adapter"));
  const module = await rdkit.ensureRdkit();
  const molecule = module.get_mol(value, JSON.stringify({ removeHs: false }));
  if (!molecule) return { valid: false, reason: "RDKit could not verify the pasted structure." };
  try {
    const canonicalSmiles = molecule.get_smiles?.();
    if (!canonicalSmiles) throw new Error("RDKit did not return a canonical SMILES.");
    return { valid: true, canonicalSmiles };
  } finally { molecule.delete(); }
};

export class SmilesPasteIdentityError extends Error {
  constructor(smiles: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const loss = /\[\d+[A-Za-z]/.test(smiles) ? "isotope labels or their positions" : "chemical identity";
    super(cause instanceof ChemicalIdentityMismatchError
      ? `SMILES paste refused: the drawn structure would lose ${loss} for "${smiles}". ${detail}`
      : `SMILES paste refused: chemical identity could not be verified for "${smiles}": ${detail}`);
    this.name = "SmilesPasteIdentityError";
  }
}

/** Build and validate the normalized document before the caller commits any change. */
export async function checkedSmilesPaste(
  document: ChemDraftDocument, point: PagePoint, depiction: PastedStructureDepiction, smiles: string,
  inspect: InspectChemicalIdentity = inspectPasteIdentity
): Promise<ChemDraftDocument> {
  const next = insertSmilesMolecule(document, point, depiction, smiles);
  const molecule = next.pages.flatMap(page => page.objects).find(object =>
    next.selection.objectIds.includes(object.id) && object.type === "molecule");
  if (!molecule || molecule.type !== "molecule") throw new Error("SMILES paste produced no molecule.");
  try { await assertMoleculeMatchesSmiles(molecule, smiles, inspect); }
  catch (error) { throw new SmilesPasteIdentityError(smiles, error); }
  return next;
}

/** A bad entry cannot prevent the other structures from being pasted. */
export async function checkedSmilesGridPaste(
  document: ChemDraftDocument, point: PagePoint,
  entries: readonly { smiles: string; depiction: PastedStructureDepiction }[],
  inspect: InspectChemicalIdentity = inspectPasteIdentity
) {
  const built = insertSmilesMoleculeGrid(document, point, entries);
  const accepted: typeof entries[number][] = [];
  const failures: SmilesListPasteFailure[] = [];
  for (const [index, id] of built.objectIds.entries()) {
    const entry = entries[index]!;
    const molecule = built.document.pages.flatMap(page => page.objects).find(object => object.id === id);
    if (!molecule || molecule.type !== "molecule") throw new Error("SMILES grid produced no molecule.");
    try {
      await assertMoleculeMatchesSmiles(molecule, entry.smiles, inspect);
      accepted.push(entry);
    } catch (error) {
      failures.push({ input: entry.smiles,
        error: new SmilesPasteIdentityError(entry.smiles, error).message });
    }
  }
  return { ...(failures.length ? insertSmilesMoleculeGrid(document, point, accepted) : built), failures };
}
