import { applyPatch, createCustomPageLayout, type ChemDraftDocument } from "@chemdraft/chem-core";
import { AssistantCapabilityPermissions, type PluginAssistantAPI, type PluginAssistantToolResult, type PluginManifest } from "@chemdraft/plugin-api";
import { writePatchOps, type PluginHost, type PluginHostAssistant } from "@chemdraft/plugin-host";
import { PluginWriteGateTimeoutError, type PluginWriteGate } from "../plugins/applyPluginDocumentPatch";
import { runThumbnail } from "./runThumbnail";
import type { AssistantToolContext, AssistantPageGrowth } from "./AssistantToolContext";
import { nativePrompt } from "../nativePrompt";
import { callAssistantTool, listAssistantTools } from "./assistantTools";
import { getAssistantTransactions, type AssistantTransactions } from "./assistantTransaction";
import { assistantDocumentContentUnchanged, getAssistantHistoryPort } from "./historyPort";
import type { AssistantMcpEngine, McpBridgeRequest, McpBridgeResponse } from "./assistantMcpEngine";
import { recheckNormalizedAssistantWrite, verifyNormalizedAssistantWrite } from "./normalizedWrite";

type Plugin = { id: string; name: string };
interface Request {
  pluginId: string;
  tabId: string;
  selection: string[];
  inserted: Set<string>;
  touched: Set<string>;
  transactions: AssistantTransactions;
  context: AssistantToolContext;
  ended: boolean;
  cancellations: Map<string, AbortController>;
  opening: number;
  /** One human decision shared by every placement in this request, including concurrent calls. */
  pageGrowthDecision?: Promise<boolean | { reason: string }>;
}
export interface AssistantToolsControllerOptions {
  host(): PluginHost;
  engine: AssistantMcpEngine;
  getActiveTabId(): string | undefined;
  /** IDs only: capturing Send must not serialize selected molecules. */
  getSelectionIds(): readonly string[];
  runWrite: PluginWriteGate["run"];
  readDocument?(tabId: string): ChemDraftDocument | undefined;
  transactions?(): AssistantTransactions;
  createContext(request: { plugin: PluginManifest; tabId: string; getDocument(): ChemDraftDocument | undefined }): Pick<AssistantToolContext, "chemistry" | "render" | "getViewportRect" | "now" | "commands">;
}

/** Owns request lifetimes; plugin code receives only the typed, permission-checked host facade. */
export class AssistantToolsController implements PluginHostAssistant {
  private readonly requests = new Map<string, Request>();
  private readonly sessions = new Map<string, { pluginId: string; requestId: string }>();
  private activeCalls = 0;
  constructor(private readonly options: AssistantToolsControllerOptions) {}

  private plugin(plugin: Plugin): PluginManifest {
    const host = this.options.host();
    for (const permission of AssistantCapabilityPermissions) host.requirePermission(plugin.id, permission);
    return host.getPlugin(plugin.id)!.manifest;
  }
  private running(plugin: Plugin, requestId: string): Request {
    const request = this.ownedRequest(plugin, requestId);
    if (!request.context.getDocument()) throw new Error("The assistant's document tab has closed.");
    return request;
  }
  private ownedRequest(plugin: Plugin, requestId: string): Request {
    this.plugin(plugin);
    const request = this.requests.get(requestId);
    if (!request || request.ended || request.pluginId !== plugin.id) throw new Error("The assistant request has ended or does not belong to this plugin.");
    return request;
  }
  async listTools(plugin: Plugin) { this.plugin(plugin); return listAssistantTools(); }

  async beginRequest(plugin: Plugin, input: Parameters<PluginAssistantAPI["beginRequest"]>[0]) {
    const manifest = this.plugin(plugin);
    if (typeof input?.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 20_000 ||
      (input.label !== undefined && (typeof input.label !== "string" || input.label.length > 200))) throw new Error("Invalid assistant request prompt or label.");
    if ([...this.requests.values()].some(r => r.pluginId === plugin.id && !r.ended)) throw new Error("This plugin already has an assistant request running.");
    const tabId = this.options.getActiveTabId();
    if (!tabId) throw new Error("No document tab is open.");
    const selection = [...this.options.getSelectionIds()];
    const transactions = this.options.transactions?.() ?? getAssistantTransactions();
    const getDocument = () => this.options.readDocument ? this.options.readDocument(tabId) : getAssistantHistoryPort().read(tabId);
    const services = this.options.createContext({ plugin: manifest, tabId, getDocument });
    const requestId = transactions.beginAssistantTransaction({ pluginId: plugin.id, runId: crypto.randomUUID(), tabId,
      label: input.label ?? input.prompt, sendSelection: { objectIds: selection } });
    const request: Request = { pluginId: plugin.id, tabId, selection, inserted: new Set(), touched: new Set(), transactions,
      ended: false, cancellations: new Map(), opening: 0,
      context: { ...services, plugin: manifest, tabId, getDocument, getSelectionAtSend: () => selection,
        getInsertedObjectIds: () => [...request.inserted],
        confirmPageGrowth: async () => { throw new Error("No tool call is running."); },
        write: async () => { throw new Error("No tool call is running."); } } };
    this.requests.set(requestId, request);
    return { requestId };
  }

  async callTool(plugin: Plugin, input: Parameters<PluginAssistantAPI["callTool"]>[0]): Promise<PluginAssistantToolResult> {
    const entry = [...this.requests].find(([, r]) => r.pluginId === plugin.id && !r.ended);
    if (!entry) throw new Error("No assistant request is running.");
    return this.call(plugin, entry[0], input);
  }

  private async call(plugin: Plugin, requestId: string, input: { name: string; input: unknown }, callId: string = crypto.randomUUID()): Promise<PluginAssistantToolResult> {
    const request = this.running(plugin, requestId);
    if (this.activeCalls >= 4) throw new Error("At most four assistant tool calls may run concurrently.");
    if (typeof input?.name !== "string") throw new Error("An assistant tool name is required.");
    const abort = new AbortController();
    request.cancellations.set(callId, abort);
    this.activeCalls++;
    const timeoutMs = input.name === "name_to_structure" || input.name === "structure_to_name" ? 45_000 : input.name === "render" ? 60_000 : 120_000;
    const startDeadline = () => setTimeout(() => abort.abort(new Error("Assistant tool deadline exceeded.")), timeoutMs);
    let deadline = startDeadline();
    let approvedGrowth: { growth: AssistantPageGrowth; document: ChemDraftDocument } | undefined;
    let prompted = false;
    let work: Promise<PluginAssistantToolResult> | undefined;
    try {
      work = callAssistantTool({ ...request.context,
        plugin: this.plugin(plugin),
        signal: abort.signal,
        getDocument: () => request.ended || abort.signal.aborted ? undefined : request.context.getDocument(),
        confirmPageGrowth: async (growth, signal) => {
          this.running(plugin, requestId);
          abort.signal.throwIfAborted();
          signal?.throwIfAborted();
          if (prompted || !["insert_structures", "insert_reaction", "insert_text", "move_objects"].includes(input.name)) {
            throw new Error("Page growth is only available once per assistant placement.");
          }
          prompted = true;
          const document = request.context.getDocument()!;
          clearTimeout(deadline); // Pause preparation, but bound the human decision separately.
          try {
            request.pageGrowthDecision ??= (async () => {
              const decision = new AbortController();
              const cancelDecision = () => decision.abort();
              signal?.addEventListener("abort", cancelDecision, { once: true });
              const decisionDeadline = setTimeout(cancelDecision, 300_000);
              try {
                const choice = await nativePrompt({ title: "ChemDraft Assistant", owner: "document", kind: "info",
                  message: `${growth.description} ${growth.itemCount === 1 ? "needs" : "need"} a page ${Math.round(growth.width * 0.75)} × ${Math.round(growth.height * 0.75)} pt. Enlarge the page to fit?`,
                  // The answer covers subsequent growth in this request. Its single Undo
                  // restores every page enlargement and all inserted objects.
                  choices: [{ id: "enlarge", label: "Enlarge Page" }, { id: "decline", label: "Cancel", cancel: true }]
                }, async () => "decline", decision.signal);
                if (decision.signal.aborted) return { reason: "declined: no answer to the enlarge-page question within 5 minutes" };
                return choice === "enlarge";
              } finally {
                clearTimeout(decisionDeadline);
                signal?.removeEventListener("abort", cancelDecision);
              }
            })();
            const accepted = await request.pageGrowthDecision;
            this.running(plugin, requestId);
            abort.signal.throwIfAborted();
            signal?.throwIfAborted();
            if (accepted !== true) return accepted;
            approvedGrowth = { growth, document };
            return true;
          } finally {
            if (!abort.signal.aborted) deadline = startDeadline();
          }
        },
        write: async (patch, signal, checkPreconditions, expectedSmiles) => {
          this.running(plugin, requestId);
          if (abort.signal.aborted || signal?.aborted) throw new Error("Assistant tool call was cancelled.");
          const plannedDocument = request.context.getDocument()!;
          const growth = approvedGrowth?.growth;
          const patchDocument = (document: ChemDraftDocument) => {
            const page = growth && document.pages.find(page => page.id === growth.pageId);
            return applyPatch(document, growth && page ? { op: "batch", patches: [
              { op: "updatePageLayout", pageId: page.id,
                layout: createCustomPageLayout(Math.max(page.width, growth.width), Math.max(page.height, growth.height), "css-px", page.margin) },
              ...writePatchOps(patch)
            ] } : patch);
          };
          const scope = new Set([...request.selection, ...request.inserted]);
          for (const op of writePatchOps(patch)) {
            if (op.op === "addObject" || op.op === "addAnnotation") scope.add(op.op === "addObject" ? op.object.id : op.annotation.id);
          }
          const dependencies = new Set(writePatchOps(patch).flatMap(op =>
            op.op === "setCrossingOverride" ? op.crossing.bonds.map(ref => ref.objectId) :
            op.op === "clearCrossingOverride" ? op.bonds.map(ref => ref.objectId) :
            op.op === "setObjectOrder" ? op.objectIds : "objectId" in op ? [op.objectId] : []));
          // Relative placement also depends on the anchor, even though the patch never edits it.
          const toolInput = input.input as { relativeTo?: { objectId: string }; to?: { relativeTo?: string } };
          const anchor = toolInput?.relativeTo?.objectId ?? toolInput?.to?.relativeTo;
          if (anchor) dependencies.add(anchor);
          const dependencyContent = (document: ChemDraftDocument) => document.pages.flatMap(page =>
            page.objects.filter(object => dependencies.has(object.id)).map(object => ({ pageId: page.id, object })));
          const plannedContent = JSON.stringify(dependencyContent(plannedDocument));
          const verified = await verifyNormalizedAssistantWrite(request.context, plannedDocument, patchDocument(plannedDocument), scope, expectedSmiles);
          const apply = () => {
            this.running(plugin, requestId);
            if (abort.signal.aborted || signal?.aborted) throw new Error("Assistant tool call was cancelled.");
            checkPreconditions?.(request.context.getDocument()!);
            if (approvedGrowth && !assistantDocumentContentUnchanged(approvedGrowth.document, request.context.getDocument()!)) {
              throw new Error("The document changed while the page confirmation was open; read it again and retry.");
            }
            // The gate may have waited for a gesture to commit. Never overwrite its new geometry.
            if (JSON.stringify(dependencyContent(request.context.getDocument()!)) !== plannedContent) {
              throw new Error("The document changed while the assistant prepared this write; read it again and retry.");
            }
            return this.options.host().applyPatchForPlugin(plugin.id, undefined,
              { patch, reason: `Assistant: ${input.name}`, warnings: [], requiresUserApproval: true }, {
                objectIds: [...request.selection, ...request.inserted], assistantTransactionId: requestId,
                getDocument: () => request.context.getDocument(),
                apply: application => {
                  this.running(plugin, requestId);
                  if (abort.signal.aborted || signal?.aborted) throw new Error("Assistant tool call was cancelled.");
                  const before = request.context.getDocument()!;
                  const touched = writePatchOps(application.patch.patch).flatMap(op => op.op === "addObject" ? [op.object.id] :
                    op.op === "addAnnotation" ? [op.annotation.id] :
                    op.op === "setCrossingOverride" ? op.crossing.bonds.map(ref => ref.objectId) :
                    op.op === "clearCrossingOverride" ? op.bonds.map(ref => ref.objectId) : "objectId" in op ? [op.objectId] :
                    op.op === "setObjectOrder" ? op.objectIds.filter(id => scope.has(id)) : []);
                  // Recompute after a gesture or concurrent tool call, including every nearby
                  // mark. No await separates this scope/chemistry recheck and the history commit.
                  const after = recheckNormalizedAssistantWrite(before, patchDocument(before), scope, verified, plannedDocument);
                  request.transactions.writeAssistantTransaction(requestId, after, touched);
                  const existing = new Set(before.pages.flatMap(page => page.objects.map(object => object.id)));
                  for (const id of touched) { request.touched.add(id); if (!existing.has(id)) request.inserted.add(id); }
                  return { applied: true as const, objectIds: touched };
                }
              });
          };
          try {
            const receipt = await this.options.runWrite(apply);
            return { objectIds: receipt.objectIds };
          } catch (error) {
            if (error instanceof PluginWriteGateTimeoutError) throw new Error("The drawing is being edited; try again");
            throw error;
          }
        }
      }, input.name, input.input);
      // Cancelling a caller blocks its writes immediately, but does not make native work disappear.
      // Keep its concurrency slot until the bounded tool invocation actually settles.
      void work.then(() => { this.activeCalls--; }, () => { this.activeCalls--; });
      return await Promise.race([work, new Promise<never>((_, reject) => {
        abort.signal.addEventListener("abort", () => reject(abort.signal.reason ?? new Error("Assistant tool call was cancelled.")), { once: true });
      })]);
    } finally {
      if (!work) this.activeCalls--;
      clearTimeout(deadline);
      request.cancellations.delete(callId);
    }
  }

  async endRequest(plugin: Plugin, { requestId }: { requestId: string }) {
    const request = this.ownedRequest(plugin, requestId);
    request.ended = true;
    request.cancellations.forEach(stop => stop.abort());
    // Mark ended before awaiting IPC, so a queued bridge call cannot write meanwhile.
    try {
      const result = request.transactions.endAssistantTransaction(requestId, { touchedIds: [...request.touched] });
      let previewSvg: string | undefined;
      try {
        const document = request.context.getDocument();
        if (document) previewSvg = runThumbnail(document, result.touchedIds);
      } catch { /* A transcript preview must not turn a completed request into a failure. */ }
      return { ...result, ...(previewSvg ? { previewSvg } : {}), summary: `${request.touched.size} object(s) changed.` };
    } finally {
      this.requests.delete(requestId);
      await this.closeRequestSessions(requestId);
    }
  }

  async createToolSession(plugin: Plugin, { requestId }: { requestId: string }) {
    const request = this.running(plugin, requestId);
    const count = [...this.sessions.values()].filter(s => s.pluginId === plugin.id).length + request.opening;
    if (count >= 2) throw new Error("At most two MCP sessions per plugin are allowed.");
    request.opening++;
    try {
      const session = await this.options.engine.open(plugin, message => { void this.bridge(plugin, requestId, message); });
      if (request.ended || !request.context.getDocument()) {
        await this.options.engine.close(session.sessionId);
        throw new Error("The assistant request ended while opening its MCP session.");
      }
      this.sessions.set(session.sessionId, { pluginId: plugin.id, requestId });
      return { ...session, tools: listAssistantTools().map(tool => tool.name) };
    } finally { request.opening--; }
  }
  async closeToolSession(plugin: Plugin, { sessionId }: { sessionId: string }) {
    this.plugin(plugin);
    if (this.sessions.get(sessionId)?.pluginId !== plugin.id) throw new Error("MCP session does not belong to this plugin.");
    const request = this.requests.get(this.sessions.get(sessionId)!.requestId);
    request?.cancellations.forEach((stop, id) => { if (id.startsWith(`${sessionId}:`)) stop.abort(); });
    this.sessions.delete(sessionId);
    await this.options.engine.close(sessionId);
  }
  private async closeRequestSessions(requestId: string) {
    await Promise.all([...this.sessions].filter(([, s]) => s.requestId === requestId).map(async ([id]) => {
      this.sessions.delete(id); await this.options.engine.close(id);
    }));
  }
  closeAllForPlugin(pluginId: string): void {
    for (const [id, request] of this.requests) {
      if (request.pluginId !== pluginId) continue;
      this.abandonRequest(id, request);
    }
  }
  closeAllForTab(tabId: string): void {
    for (const [id, request] of this.requests) if (request.tabId === tabId) this.abandonRequest(id, request);
  }
  private abandonRequest(id: string, request: Request): void {
    request.ended = true;
    request.cancellations.forEach(stop => stop.abort());
    try { request.transactions.endAssistantTransaction(id, { touchedIds: [...request.touched] }); } catch { /* Tab already closed. */ }
    this.requests.delete(id);
    void this.closeRequestSessions(id).catch(() => {});
  }
  private async bridge(plugin: Plugin, requestId: string, message: McpBridgeRequest): Promise<void> {
    let response: McpBridgeResponse;
    try {
      const request = this.running(plugin, requestId);
      const session = this.sessions.get(message.sessionId);
      if (session?.requestId !== requestId || session.pluginId !== plugin.id) throw new Error("Unknown MCP session.");
      const params = message.params as Record<string, unknown> | null;
      if (message.method === "cancel") {
        request.cancellations.get(`${message.sessionId}:${message.requestId}`)?.abort();
        return;
      }
      if (message.method === "tools/list") response = { result: { tools: await this.listTools(plugin) } };
      else if (message.method === "tools/call") response = { result: await this.call(plugin, requestId,
        { name: params?.name as string, input: params?.arguments ?? {} }, `${message.sessionId}:${message.requestId}`) };
      else throw new Error(`Unsupported MCP method ${message.method}.`);
    } catch (error) { response = { error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }; }
    try { await this.options.engine.respond(message.sessionId, message.requestId, response); } catch { /* Rust may already have closed or timed out the call. */ }
  }
}
