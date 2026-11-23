import type { ChemDraftDocument, DocumentPatch } from "@chemdraft/chem-core";
import type { ReactionSchemeLayoutOptions } from "@chemdraft/document-workflow-core";
import type {
  PluginManifest, PluginNameToStructureRequest, PluginNameToStructureResult,
  PluginStructureFromSmilesRequest, PluginStructureFromSmilesResult,
  PluginStructureToNameRequest, PluginStructureToNameResult
} from "@chemdraft/plugin-api";
import type { PluginWriteScopePages } from "@chemdraft/plugin-host";

export interface AssistantRect { x: number; y: number; width: number; height: number }
export const PAGE_GROWTH_UNANSWERED = "declined: no answer to the enlarge-page question within 5 minutes";
export interface AssistantPageGrowth {
  pageId: string; width: number; height: number; description: string; itemCount: number;
  pages?: { pageId: string; width: number; height: number; objectIds?: string[] }[];
}
import type { StructureInspection } from "../plugins/requestWrites/structureIdentity";
export type { StructureInspection as AssistantStructureInspection } from "../plugins/requestWrites/structureIdentity";

/** All hooks are bound to the run's tab, never the currently active tab. */
export interface AssistantToolContext {
  plugin: Pick<PluginManifest, "id" | "name" | "permissions">;
  tabId: string;
  /** Undefined means the pinned tab closed: every tool fails closed. */
  getDocument(): ChemDraftDocument | undefined;
  getSelectionAtSend(): readonly string[];
  /** The Send-time selection's ids bound to the page they were selected on. Every object lookup in a
   * tool resolves through it (resolveScopedObject), so an id never resolves to a same-id object on
   * another page. A pinned object missing from its page (deleted, or moved to another page) resolves
   * to nothing: reads and writes to it are refused with a reselect message.
   * Absent: ids resolve only when they are unique in the document. */
  getSelectionPagesAtSend?(): PluginWriteScopePages | undefined;
  /** Transaction-owned ids, including writes through another session for this run. */
  getInsertedObjectIds?(): readonly string[];
  getViewportRect?(tabId: string): AssistantRect | undefined;
  signal?: AbortSignal;
  /** Host-injected shared page-fit planner, including non-insertion writes. */
  planPageGrowth(before: ChemDraftDocument, proposed: ChemDraftDocument): NonNullable<AssistantPageGrowth["pages"]>;
  /** Host-only confirmation; consent authorizes this call's computed growth, never model-supplied layout. */
  confirmPageGrowth(growth: AssistantPageGrowth, signal?: AbortSignal): Promise<boolean | { reason: string }>;
  /** applyPatchForPlugin inside the run's transaction and fixed write scope.
   * Recheck the signal and preparation preconditions after waiting for an active canvas gesture.
   * expectedSmiles comes only from the typed insert/edit builders; other writes preserve identity.
   * The host verifies the fully normalized desktop document before committing. */
  write(patch: DocumentPatch, signal?: AbortSignal, checkPreconditions?: (document: ChemDraftDocument) => void,
    expectedSmiles?: ReadonlyMap<string, string>): Promise<{ objectIds: string[]; pageSpaceUnanswered?: true }>;
  chemistry: {
    /** Host loads the existing chemistry adapter; tool builders remain engine-independent. */
    reactionProductAligner?(): Promise<NonNullable<ReactionSchemeLayoutOptions["alignProduct"]>>;
    nameToStructure(request: PluginNameToStructureRequest): Promise<PluginNameToStructureResult>;
    /** Host's RDKit -> OCL -> createSmilesMolecule path, bound to the pinned document. */
    structureFromSmiles(request: PluginStructureFromSmilesRequest): Promise<PluginStructureFromSmilesResult>;
    /** Noninteractive: return engineNotInstalled rather than opening installation UI. `pageId` is the
     * page the tool resolved the molecule on; without it the id must be unique in the document. */
    structureToName(request: PluginStructureToNameRequest, pageId?: string): Promise<PluginStructureToNameResult>;
    /** RDKit only; counts, formula and canonicalSmiles retain explicit H.
     * identitySmiles removes ordinary explicit H, preserving isotopic H. With stereoReference,
     * it compares only stereo specified by that input, while canonicalSmiles stays unmasked. */
    inspectStructure(format: "smiles" | "molfile", value: string,
      stereoReference?: string): Promise<StructureInspection>;
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
