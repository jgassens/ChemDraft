import type { ChemDraftDocument, DocumentPatch } from "@chemdraft/chem-core";
import type {
  PluginManifest, PluginNameToStructureRequest, PluginNameToStructureResult,
  PluginStructureFromSmilesRequest, PluginStructureFromSmilesResult,
  PluginStructureToNameRequest, PluginStructureToNameResult
} from "@chemdraft/plugin-api";

export interface AssistantRect { x: number; y: number; width: number; height: number }
export type AssistantStructureInspection =
  | { valid: true; canonicalSmiles: string; formula: string; heavyAtoms: number; warnings: string[] }
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
  /** applyPatchForPlugin inside the run's transaction and fixed write scope. */
  write(patch: DocumentPatch): Promise<{ objectIds: string[] }>;
  chemistry: {
    nameToStructure(request: PluginNameToStructureRequest): Promise<PluginNameToStructureResult>;
    /** Host's RDKit -> OCL -> createSmilesMolecule path, bound to the pinned document. */
    structureFromSmiles(request: PluginStructureFromSmilesRequest): Promise<PluginStructureFromSmilesResult>;
    /** Noninteractive: return engineNotInstalled rather than opening installation UI. */
    structureToName(request: PluginStructureToNameRequest): Promise<PluginStructureToNameResult>;
    /** RDKit only, no native-writer or OCL fallback; counts and formula are engine results. */
    inspectStructure(format: "smiles" | "molfile", value: string): Promise<AssistantStructureInspection>;
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
