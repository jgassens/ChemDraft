import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { nameStructure, type StructureNameDeps } from "@chemdraft/document-workflow-core";
import type { PluginSelectionSnapshot, PluginStructureToNameResult } from "@chemdraft/plugin-api";
import { loadRdkitWithAppLoader } from "./rdkitAppLoader";
import type { StructureNamingEngine, StructureNamingEngineStatus, StructureNamingRawResult } from "./structureNamingEngine";

/** Always read the molecule from the document, never from plugin-provided chemistry. */
export function scopedNamingMolecule(document: ChemDraftDocument | undefined, selection: PluginSelectionSnapshot | undefined,
  objectId: string): MoleculeObject {
  const pageId = selection?.molecules.find(molecule => molecule.objectId === objectId)?.pageId;
  const page = pageId ? document?.pages.find(page => page.id === pageId) : document?.pages[0];
  const molecule = page?.objects.find(object => object.id === objectId && object.type === "molecule");
  const ids = selection?.objectIds ?? [];
  const inScope = ids.length ? ids.includes(objectId) : page?.objects.filter(object => object.type === "molecule").length === 1;
  if (!molecule || molecule.type !== "molecule" || !inScope) throw new Error("Structure naming requires a molecule in the current selection, or the page's only molecule when nothing is selected.");
  return molecule;
}

/** The saved OPSIN reply belongs to this exact name and this call only. */
export function namingReadBack(result: StructureNamingRawResult | undefined, name: string): { smiles: string | null; failureReason?: string } {
  if (!result || result.name !== name || !result.opsinReadBack) return { smiles: null, failureReason: "The naming engine supplied no read-back for this exact name." };
  return { smiles: result.opsinReadBack.smiles, ...(result.opsinReadBack.failureReason ? { failureReason: result.opsinReadBack.failureReason } : {}) };
}
export interface NamingCanonicalizer {
  canonicalize: StructureNameDeps["canonicalize"];
  version: string;
}
export async function loadNamingCanonicalizer(): Promise<NamingCanonicalizer> {
  const [{ computeStructureIdentifiers }, { ensureRdkit }] = await Promise.all([
    loadRdkitWithAppLoader(() => import("@chemdraft/rdkit-adapter/identifiers")),
    import("@chemdraft/rdkit-adapter")
  ]);
  const module = await ensureRdkit();
  const version = module.version?.();
  if (!version) throw new Error("The loaded RDKit MinimalLib did not report its version.");
  return { version, canonicalize: async structure => (await computeStructureIdentifiers(structure))?.smiles ?? null };
}

export async function nameStructureForPlugin(molecule: MoleculeObject, engine: StructureNamingEngine,
  status: StructureNamingEngineStatus, canonicalizer?: NamingCanonicalizer): Promise<PluginStructureToNameResult> {
  const canonical = canonicalizer ?? await loadNamingCanonicalizer();
  let raw: StructureNamingRawResult | undefined;
  let engineError: unknown;
  const result = await nameStructure({
    canonicalize: canonical.canonicalize,
    name: async smiles => {
      try { raw = await engine.name(smiles); return raw; }
      catch (error) { engineError = error; throw error; }
    },
    readName: async name => namingReadBack(raw, name)
  }, molecule);
  // Native IPC failure is unavailable, rather than a chemical decline.
  if (engineError !== undefined) throw engineError;
  if (result.status !== "named") return result;
  const receipt = status.installed;
  if (!receipt || receipt.orthonymVersion !== "1.0.8" || !receipt.orthonymCommit) {
    return { status: "failed", code: "invalidResult", message: "The naming engine supplied no valid installed provenance." };
  }
  return {
    ...result, warnings: [...result.warnings],
    kindLabel: result.kind === "preferredIupacName" ? "Preferred IUPAC name" : "Systematic name (not the preferred IUPAC name)",
    engine: { id: "orthonym", version: "1.0.8", commit: receipt.orthonymCommit, tier: "valid" },
    verification: { method: "opsin-exact-isomeric-smiles", opsin: { id: "opsin", version: "2.9.0", radicals: true },
      canonicalizer: { id: "rdkit-minimallib", version: canonical.version } }
  };
}
