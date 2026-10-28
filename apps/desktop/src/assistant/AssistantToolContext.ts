import type { ChemDraftDocument, DocumentPatch } from "@chemdraft/chem-core";
import type {
  PluginManifest, PluginNameToStructureRequest, PluginNameToStructureResult,
  PluginStructureFromSmilesRequest, PluginStructureFromSmilesResult,
  PluginStructureToNameRequest, PluginStructureToNameResult
} from "@chemdraft/plugin-api";

export interface AssistantRect { x: number; y: number; width: number; height: number }
export interface AssistantPageGrowth { pageId: string; width: number; height: number; description: string; itemCount: number }
export type AssistantStructureInspection =
  | { valid: true; canonicalSmiles: string; identitySmiles: string;
      formula: string; heavyAtoms: number; warnings: string[] }
  | { valid: false; reason: string };

/** All hooks are bound to the run's tab, never the currently active tab. */
export interface AssistantToolContext {
  plugin: Pick<PluginManifest, "id" | "name" | "permissions">;
  tabId: string;
  /** Undefined means the pinned tab closed: every tool fails closed. */
  getDocument(): ChemDraftDocument | undefined;
  getSelectionAtSend(): readonly string[];
  /** Transaction-owned ids, including writes through another session for this run. */
  getInsertedObjectIds?(): readonly string[];
  getViewportRect?(tabId: string): AssistantRect | undefined;
  signal?: AbortSignal;
  /** Host-only confirmation; consent authorizes this call's computed growth, never model-supplied layout. */
  confirmPageGrowth(growth: AssistantPageGrowth, signal?: AbortSignal): Promise<boolean | { reason: string }>;
  /** applyPatchForPlugin inside the run's transaction and fixed write scope.
   * Recheck the signal and preparation preconditions after waiting for an active canvas gesture.
   * expectedSmiles comes only from the typed insert/edit builders; other writes preserve identity.
   * The host verifies the fully normalized desktop document before committing. */
  write(patch: DocumentPatch, signal?: AbortSignal, checkPreconditions?: (document: ChemDraftDocument) => void,
    expectedSmiles?: ReadonlyMap<string, string>): Promise<{ objectIds: string[] }>;
  chemistry: {
    nameToStructure(request: PluginNameToStructureRequest): Promise<PluginNameToStructureResult>;
    /** Host's RDKit -> OCL -> createSmilesMolecule path, bound to the pinned document. */
    structureFromSmiles(request: PluginStructureFromSmilesRequest): Promise<PluginStructureFromSmilesResult>;
    /** Noninteractive: return engineNotInstalled rather than opening installation UI. */
    structureToName(request: PluginStructureToNameRequest): Promise<PluginStructureToNameResult>;
    /** RDKit only; counts, formula and canonicalSmiles retain explicit H.
     * identitySmiles removes ordinary explicit H, preserving isotopic H. With stereoReference,
     * it compares only stereo specified by that input, while canonicalSmiles stays unmasked. */
    inspectStructure(format: "smiles" | "molfile", value: string,
      stereoReference?: string): Promise<AssistantStructureInspection>;
  };
  render(svg: string, opts: { maxDimensionPx: number; background?: string }): Promise<{
    bytes: Uint8Array; width: number; height: number;
  }>;
  now(): Date | string;
}

const insertedByContext = new WeakMap<AssistantToolContext, Set<string>>();
export function assistantScope(context: AssistantToolContext): Set<string> {
  return new Set([
    ...context.getSelectionAtSend(), ...(context.getInsertedObjectIds?.() ?? []),
    ...(insertedByContext.get(context) ?? [])
  ]);
}
export function recordAssistantInsertions(context: AssistantToolContext, ids: readonly string[]): void {
  const inserted = insertedByContext.get(context) ?? new Set<string>();
  ids.forEach(id => inserted.add(id));
  insertedByContext.set(context, inserted);
}
export function requireDocument(context: AssistantToolContext): ChemDraftDocument {
  const document = context.getDocument();
  if (!document) throw new Error("The assistant's document tab has closed.");
  return document;
}
