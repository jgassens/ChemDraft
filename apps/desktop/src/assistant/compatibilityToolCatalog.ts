import { PluginRequestCapabilities, type PluginExpectedStructure } from "@chemdraft/plugin-api";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { unionLayoutBounds, type LayoutBounds } from "@chemdraft/layout-engine";
import { RequestWriteError, scopedObjectPage, writePatchOps } from "@chemdraft/plugin-host";
import { planDocumentPageFit } from "../pageEnlargement";
import { loadRdkitWithAppLoader } from "../plugins/rdkitAppLoader";
import type { HostToolProvider, McpToolResult } from "../plugins/toolSessions/ToolSessionController";
import type { AssistantToolsControllerOptions } from "./AssistantToolsController";
import { ASSISTANT_TOOLS, listAssistantTools, toolResult } from "./assistantTools";
import { toolSchemas } from "./tools/schemas";
import { captureWritePreconditions } from "./writeBuilder";
import { PAGE_GROWTH_UNANSWERED } from "./AssistantToolContext";
import type { ToolDeadlineClass } from "../plugins/toolSessions/transport";

export function compatibilityDeadline(tool: { name: string; annotations: { readOnlyHint: boolean } }): ToolDeadlineClass {
  if (!tool.annotations.readOnlyHint) return "requestWrite";
  if (tool.name === "render") return "render";
  if (tool.name === "name_to_structure" || tool.name === "structure_to_name") return "naming";
  return "readCompute";
}

export function placementDependencies(input: unknown): string[] {
  const placement = input as { relativeTo?: { objectId: string }; to?: { relativeTo?: string } };
  const anchor = placement?.relativeTo?.objectId ?? placement?.to?.relativeTo;
  return anchor ? [anchor] : [];
}

/** Adapts the published descriptors and builders to the same verified request write as a worker. */
export function compatibilityTools(createContext: AssistantToolsControllerOptions["createContext"], hasPageSpace = false): HostToolProvider {
  const descriptors = listAssistantTools();
  return (binding, name) => {
    const tool = ASSISTANT_TOOLS.find(item => item.name === name);
    const descriptor = descriptors.find(item => item.name === name);
    if (!tool || !descriptor) return undefined;
    const permissions = tool.readOnly ? tool.permissions :
      new Set([...tool.permissions, ...PluginRequestCapabilities.documents.applyRequestPatch.permissions]);
    for (const permission of permissions) {
      if (!binding.plugin.permissions.includes(permission)) {
        throw new RequestWriteError("permission", `Tool "${name}" requires permission "${permission}".`);
      }
    }
    return {
      descriptor, deadline: compatibilityDeadline(descriptor),
      validate: input => {
        if (!toolSchemas[tool.name].safeParse(input).success) throw new RequestWriteError("invalid", `Invalid arguments for ${name}.`);
      },
      execute: async (call, signal, timing) => {
        let output: McpToolResult | undefined;
        let pageSpaceUnanswered = false;
        let guard: ((document: ChemDraftDocument) => void) | undefined;
        let minimum: { pageId: string; width: number; height: number } | undefined;
        const result = await binding.invoke(call, signal, tool.readOnly, {
          ...timing, checkWrite: document => guard?.(document), minimumPageSize: () => minimum,
          onPageSpaceUnanswered: () => { pageSpaceUnanswered = true; },
          handler: async (ctx, _call, stop) => {
            for (const permission of permissions) ctx.requirePermission(permission);
            const getDocument = () => stop.aborted ? undefined : binding.document.read();
            const tabId = binding.document.key;
            const services = createContext({ plugin: binding.plugin, tabId, getDocument });
            const overflow = new Map<string, LayoutBounds>();
            let pageSpace: { pageId: string; decisionId: string } | undefined;
            output = toolResult(await tool.handler({
              ...services, plugin: binding.plugin, tabId, signal: stop, getDocument,
              getSelectionAtSend: binding.selection, getSelectionPagesAtSend: () => binding.selectionPages?.(),
              getInsertedObjectIds: binding.insertions,
              getViewportRect: () => binding.document.viewport?.(),
              chemistry: { ...services.chemistry, reactionProductAligner: async () => {
                const adapter = await loadRdkitWithAppLoader(() => import("@chemdraft/rdkit-adapter/depiction"));
                return adapter.createReactionProductAligner();
              } },
              planPageGrowth: (before, proposed) => planDocumentPageFit(before, proposed, overflow).growth,
              confirmPageGrowth: async growth => {
                if (!hasPageSpace || !ctx.requests?.requestPageSpace) {
                  throw new RequestWriteError("unsupported", "This page-space request is unavailable.");
                }
                // Generic edits get one implicit fit over all normalized pages at commit.
                // Insertions have a planner minimum, including margins, and can keep fitting items on timeout.
                if (growth.pages) return true;
                const context = await ctx.requests.getContext({ requestId: binding.requestId });
                if (!context.ok) throw new RequestWriteError(context.error.code, context.error.message);
                const { pageId, width, height } = growth;
                const page = context.value.pages.find(item => item.pageId === pageId);
                if (!page) throw new RequestWriteError("stale", "The placement page was closed.");
                const ink = overflow.get(pageId);
                const placement = { x: 0, y: 0, width, height };
                const requiredBounds = ink ? unionLayoutBounds([placement, ink])! : placement;
                const decision = await ctx.requests.requestPageSpace({ requestId: binding.requestId, pageId,
                  requiredBounds, revision: page.revision });
                if (!decision.ok) throw new RequestWriteError(decision.error.code, decision.error.message);
                if (decision.value.outcome === "unanswered") return { reason: PAGE_GROWTH_UNANSWERED };
                pageSpace = { pageId, decisionId: decision.value.decisionId };
                if (decision.value.outcome === "enlarge") minimum = { pageId, width, height };
                return decision.value.outcome !== "keep";
              },
              write: async (patch, _, check, sources) => {
                stop.throwIfAborted();
                const document = getDocument();
                if (!document || !ctx.documents.applyRequestPatch) throw new RequestWriteError("permission", "Request write unavailable.");
                const dependencies = placementDependencies(call.input);
                if (typeof call.input.besideObjectId === "string") dependencies.push(call.input.besideObjectId);
                const anchors = captureWritePreconditions(document, dependencies);
                guard = current => { check?.(current); anchors(current); };
                const expectedStructures: PluginExpectedStructure[] = [];
                for (const [opIndex, op] of writePatchOps(patch).entries()) {
                  if (op.op === "addObject") {
                    const sourceSmiles = sources?.get(op.object.id);
                    if (sourceSmiles) expectedStructures.push({ kind: "insertion", opIndex, sourceSmiles });
                  } else if (op.op === "updateObject") {
                    const sourceSmiles = sources?.get(op.objectId);
                    // Name the object by its Send-time page, never the first same-id object in the document.
                    const pageId = scopedObjectPage(document, op.objectId, binding.selectionPages?.());
                    if (sourceSmiles && pageId) expectedStructures.push({ kind: "object", pageId, objectId: op.objectId, sourceSmiles });
                  }
                }
                const receipt = await ctx.documents.applyRequestPatch({ requestId: binding.requestId,
                  patch: JSON.parse(JSON.stringify(patch)), expectedStructures, ...(pageSpace && { pageSpace }) });
                if (!receipt.ok) {
                  stop.throwIfAborted();
                  if (pageSpaceUnanswered && receipt.error.code === "cancelled") return { objectIds: [], pageSpaceUnanswered: true };
                  throw new RequestWriteError(receipt.error.code, receipt.error.message);
                }
                return { objectIds: receipt.value.touched.map(ref => ref.objectId) };
              }
            }, call.input));
            return { ok: true, value: null };
          }
        });
        if (!result.ok) throw new RequestWriteError(result.error.code, result.error.message);
        if (!output) throw new Error("The host tool did not return a result.");
        return output;
      }
    };
  };
}
