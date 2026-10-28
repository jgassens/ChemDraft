import { createEmptyDocument, type ChemDraftDocument } from "@chemdraft/chem-core";
import {
  assertMoleculeMatchesSmiles, ChemicalIdentityMismatchError,
  inspectHydrogenNormalizedIdentity,
  type InspectChemicalIdentity,
  type PagePoint, type PastedStructureDepiction
} from "@chemdraft/document-workflow-core";
import { insertSmilesMolecule, insertSmilesMoleculeGrid } from "./documentWorkflow";
import { loadRdkitWithAppLoader } from "./plugins/rdkitAppLoader";
import type { SmilesListPasteFailure } from "./smilesListPaste";
import type { RdkitMinimalModule } from "@chemdraft/rdkit-adapter";

export class SmilesIdentityEngineUnavailableError extends Error {
  constructor(cause: unknown) {
    super("the structure could not be verified because the RDKit engine did not load: " +
      (cause instanceof Error ? cause.message : String(cause)));
    this.name = "SmilesIdentityEngineUnavailableError";
  }
}

export function createPasteIdentityInspector(
  load: () => Promise<{ ensureRdkit(): Promise<RdkitMinimalModule> }> =
    () => loadRdkitWithAppLoader(() => import("@chemdraft/rdkit-adapter"))
): InspectChemicalIdentity {
  return async (_format, value, stereoReference) => {
    let module;
    try { module = await (await load()).ensureRdkit(); }
    catch (error) {
      throw new SmilesIdentityEngineUnavailableError(error);
    }
    return inspectHydrogenNormalizedIdentity(module, value, stereoReference);
  };
}
const inspectPasteIdentity = createPasteIdentityInspector();

export class SmilesPasteIdentityError extends Error {
  constructor(smiles: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(cause instanceof ChemicalIdentityMismatchError
      ? `SMILES paste refused: the drawn structure would change ${cause.difference} ` +
        `for "${smiles}". ${detail}`
      : `SMILES paste refused: chemical identity could not be verified for "${smiles}": ${detail}`);
    this.name = "SmilesPasteIdentityError";
  }
}

/** Check a depiction without holding a document snapshot across an engine load. */
export async function verifySmilesPaste(
  depiction: PastedStructureDepiction, smiles: string,
  inspect: InspectChemicalIdentity = inspectPasteIdentity
): Promise<void> {
  // Normalization of the isolated insert is the same as the final insert into the live document.
  await checkedSmilesPaste(createEmptyDocument(), { x: 200, y: 200 }, depiction, smiles, inspect);
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

export async function verifySmilesGridEntries(
  entries: readonly { smiles: string; depiction: PastedStructureDepiction }[],
  inspect: InspectChemicalIdentity = inspectPasteIdentity
) {
  const accepted: typeof entries[number][] = [];
  const failures: SmilesListPasteFailure[] = [];
  for (const entry of entries) {
    try {
      await verifySmilesPaste(entry.depiction, entry.smiles, inspect);
      accepted.push(entry);
    } catch (error) {
      failures.push({ input: entry.smiles, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { entries: accepted, failures };
}
