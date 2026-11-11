import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { PluginManifest, ProposedPatchStatus } from "@chemdraft/plugin-api";
import type { AcceptProposedPatchOptions, CommandRegistry, QueuedProposedPatch } from "@chemdraft/plugin-host";
import type { DesktopPluginRuntime } from "./createPluginRuntime";
import type { PluginRuntimeView } from "./pluginRuntimeOwner";
import type { PluginPanelController } from "./PluginPanelController";
import type { StructureNamingController } from "./StructureNamingController";
import type { StructureRecognitionController } from "./StructureRecognitionController";
import type { ExternalToolsController } from "../externalTools/ExternalToolsController";
import { PluginInstallError, type PluginInstallErrorCode } from "./installPluginPackage";
import { PluginReleaseMetadataUnavailableError } from "./pluginUpdates";
import { RuntimeBroker } from "./runtimeBroker";
import type { RuntimeDocumentPort } from "./runtimeBrokerDocument";
import { RUNTIME_HOST_LABEL } from "./runtimeBrokerProtocol";
import type { RuntimeRequest, RuntimeTarget } from "./runtimeBrokerProtocol";
import { decodeRuntimeView, encodeRuntimeView, runtimeViewActionArguments, type RuntimeViewAction, type RuntimeViewState } from "./runtimeViewProtocol";

export interface PluginRuntimeClient extends Pick<DesktopPluginRuntime,
  "proposalDocumentTab" | "closeProposalDocumentTab" | "invokeCommand" | "listCanvasOverlays" |
  "getCanvasOverlayStatuses" | "subscribeCanvasOverlayStatus" | "getCanvasOverlayTranscripts" |
  "subscribeCanvasOverlayTranscript" | "getCanvasOverlayContents" | "getCanvasOverlayDraftRestore" |
  "clearCanvasOverlayDraftRestore" | "subscribeCanvasOverlayContent" | "getCanvasOverlayOpenRequests" |
  "subscribeCanvasOverlayOpen" | "listPluginToolsets" | "onDidChange"> {
  /** A snapshot-backed read facade. This object is not a PluginHost. */
  host: {
    getPlugin(id: string): { manifest: PluginManifest } | undefined;
    listPlugins(): PluginManifest[];
    subscribe(listener: () => void): () => void;
    commands: { get(id: string): RuntimeViewState["commands"][number] | undefined };
    listProposedPatches(status?: ProposedPatchStatus): QueuedProposedPatch[];
    recognitionScreenCaptureOf(id: string): boolean | Promise<boolean>;
    acceptProposedPatch(id: string, document: ChemDraftDocument, options?: AcceptProposedPatchOptions): ChemDraftDocument;
    rejectProposedPatch(id: string): QueuedProposedPatch | Promise<QueuedProposedPatch>;
  };
  panels: Pick<PluginPanelController, "getOpenPanel" | "getDetachedPanels" | "subscribe" | "closeDetachedPanel" | "detachPanel" | "reattachPanel" | "reportDiagnostic">;
  naming: Pick<StructureNamingController, "getStatus" | "getInstallRun" | "subscribe" | "refreshStatus" | "installEngine" | "cancelEngineInstall" | "uninstall" | "getActivity" | "cancelNaming">;
  recognition: Pick<StructureRecognitionController, "getActiveRecognition" | "subscribeActivity" | "getInstallRun" | "subscribe">;
  externalTools: Pick<ExternalToolsController, "consentList" | "consentRevoke">;
  applyEnabledPluginIds(disabledIds: readonly string[]): void;
  registerFixture(): void;
  unregisterFixture(): void;
  discardPreparedPackages(): void;
  /** Authorization at Send needs the owner's live declaration, beyond the render snapshot. */
  readCanvasOverlays(): Promise<ReturnType<DesktopPluginRuntime["listCanvasOverlays"]>>;
  prepareCommand?: (id: string, options?: { input?: import("@chemdraft/plugin-api").PluginCommandInput; selectionWarnings?: string[] }) => () => Promise<unknown>;
  /** The callback remains in the committing document; only its one-use receipt is sent. */
  acceptPreparedProposal(id: string, target: RuntimeTarget, documentKey: string, commit: () => void): Promise<void>;
}

export type BrokerPluginRuntimeView = Omit<PluginRuntimeView, "runtime"> & { runtime: PluginRuntimeClient };

type Reply = { ok: true; value: unknown } | { ok: false; error: { message: string; installCode?: PluginInstallErrorCode; metadataKind?: string } };
type ProposalCommit = RuntimeRequest<"acceptPreparedProposal">;
const sameCommit = (a: ProposalCommit, b: ProposalCommit) => a.proposalId === b.proposalId &&
  a.preparationId === b.preparationId && a.documentKey === b.documentKey &&
  a.target.windowId === b.target.windowId && a.target.tabId === b.target.tabId;

/** Document-side adapter: plugin actions use the broker; core actions stay in the local registry. */
export class RuntimeViewClient {
  private state: RuntimeViewState = { installedPluginCatalogReady: false, cachedPluginUpdateResults: [],
    plugins: [], pluginMenuItems: [], canvasOverlays: [], bundledPlugins: [], installedPlugins: [],
    availableActions: [], proposals: [], proposalTabs: [], toolsets: [], commands: [],
    openPanel: undefined, detachedPanels: [], openTextPrompt: undefined, openImageRequest: undefined,
    openRecognitionInstall: undefined, recognitionEngineStatus: undefined, recognitionEngineInstall: undefined, diagnostics: [] };
  private disposed = false;
  private stateRevision = 0;
  readonly ready: Promise<void>;
  private readonly topics = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly actions = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  private bundledView: PluginRuntimeView["bundledPlugins"] = [];
  private bundledSource?: RuntimeViewState["bundledPlugins"];
  private readonly previews = new Map<string, string>();
  private readonly pendingPreviews = new Map<string, Promise<string>>();
  private livePreviewTokens = new Set<string>();
  private initialized = false;
  private startupFailure?: Error;
  private readonly isPluginCommand = (id: string): boolean => {
    const local = this.commandRegistry?.get(id);
    return local ? local.source === "plugin" || !!local.pluginId
      : id.startsWith("plugin.") || this.state.commands.some(command => command.id === id && !!command.pluginId);
  };
  private readonly stop: () => void;
  private readonly preparations = new Map<string, { request: RuntimeRequest<"commitProposal">; commit(): void }>();
  // Retain ambiguous outcomes until host settlement or drawing retirement, beyond RPC deadlines.
  // Retiring also removes the callback: an old preparation can never become executable again.
  private readonly proposalReceipts = new Map<string, { request: ProposalCommit; committed: boolean }>();
  private readonly committedProposals = new Map<string, ProposalCommit>();
  private readonly stopProposalCommit: () => void;
  private readonly stopProposalRetirement: () => void;
  readonly runtime: PluginRuntimeClient;

  constructor(private readonly broker: RuntimeBroker, invokeCommand?: PluginRuntimeClient["invokeCommand"], private readonly asynchronous = !broker.supportsImmediate,
    private readonly startup: Promise<void> = Promise.resolve(), prepareCommand?: PluginRuntimeClient["prepareCommand"],
    private readonly commandRegistry?: CommandRegistry, private readonly documentPort?: Pick<RuntimeDocumentPort, "read">) {
    this.stopProposalRetirement = broker.handle("retireProposalCommits", request => {
      this.retireProposalCommits(request.proposalId, request.preparationId);
      return null;
    });
    this.stopProposalCommit = broker.handle("commitProposal", request => {
      if (request.target.windowId !== broker.label) throw new Error("The proposal belongs to another document window.");
      this.refreshProposalDocuments();
      const receipt = this.proposalReceipts.get(request.preparationId);
      if (receipt) {
        if (!sameCommit(receipt.request, request)) throw new Error("The proposal commit receipt does not match this preparation.");
        return receipt.committed;
      }
      const prepared = this.preparations.get(request.preparationId);
      const expected = prepared?.request;
      if (expected && !sameCommit(expected, request)) throw new Error("The proposal has no matching prepared document commit.");
      const previous = this.committedProposals.get(request.proposalId);
      if (previous && (previous.documentKey !== request.documentKey || previous.target.windowId !== request.target.windowId ||
        previous.target.tabId !== request.target.tabId)) throw new Error("The proposal was committed to another document target.");
      if (request.reconcile) {
        // Synchronous with commits: a negative receipt cancels even a not-yet-delivered request.
        this.preparations.delete(request.preparationId);
        // Unknown/retired preparations have no callback, so a negative reconciliation needs no
        // tombstone. In particular, delayed reconciliation must not recreate retired metadata.
        return !!previous;
      }
      if (!prepared || !expected) {
        throw new Error("The proposal has no matching prepared document commit.");
      }
      this.preparations.delete(request.preparationId);
      this.proposalReceipts.set(request.preparationId, { request, committed: !!previous });
      if (!previous) {
        prepared.commit();
        this.committedProposals.set(request.proposalId, request);
        this.proposalReceipts.set(request.preparationId, { request, committed: true });
      }
      return true;
    });
    if (!asynchronous) {
      const initial = decodeRuntimeView<{ state: RuntimeViewState; topics: Record<string, unknown> }>(broker.callImmediate(RUNTIME_HOST_LABEL, "getRuntimeView", {}));
      this.state = this.resolvePreviews(initial.state);
      for (const [topic, value] of Object.entries(initial.topics)) this.topics.set(topic, value);
    }
    this.stop = broker.subscribeView((topic, encoded) => {
      const value = decodeRuntimeView<unknown>(encoded);
      if (topic === "state") {
        const revision = ++this.stateRevision;
        const next = value as RuntimeViewState;
        this.prunePreviews(next);
        if (this.asynchronous && this.hasPreviewReferences(next)) {
          void this.resolvePreviewsAsync(next).then(resolved => {
            if (!this.disposed && revision === this.stateRevision) this.applyState(resolved);
          }).catch(() => undefined);
        } else this.applyState(this.asynchronous ? next : this.resolvePreviews(next));
        return;
      }
      if (JSON.stringify(this.topics.get(topic)) === JSON.stringify(value)) return;
      this.topics.set(topic, value);
      this.notify(topic);
    });
    this.ready = asynchronous ? startup.then(async () => {
      const revision = this.stateRevision;
      const requestedTopics = new Map(this.topics);
      const encoded = await broker.call(RUNTIME_HOST_LABEL, "getRuntimeView", {});
      const initial = decodeRuntimeView<{ state: RuntimeViewState; topics: Record<string, unknown> }>(encoded);
      // A state notification may have superseded this initial reply while it was in flight.
      // Only the latest incoming state owns preview tokens, including an empty proposal list.
      let state: RuntimeViewState | undefined;
      if (!this.disposed && this.stateRevision === revision) {
        this.prunePreviews(initial.state);
        try { state = await this.resolvePreviewsAsync(initial.state); }
        catch (error) { if (!this.disposed && this.stateRevision === revision) throw error; }
      }
      if (this.disposed) return;
      for (const [topic, value] of Object.entries(initial.topics)) {
        if (this.topics.get(topic) !== requestedTopics.get(topic)) continue;
        if (JSON.stringify(this.topics.get(topic)) === JSON.stringify(value)) continue;
        this.topics.set(topic, value);
        this.notify(topic);
      }
      if (state && this.stateRevision === revision) this.applyState(state);
    }).then(() => { this.initialized = true; }) : Promise.resolve();
    if (!asynchronous) this.initialized = true;
    void this.ready.catch(error => {
      this.startupFailure = error instanceof Error ? error : new Error(String(error));
      if (!this.disposed) this.applyState({ ...this.state, installedPluginCatalogReady: true,
        diagnostics: [...this.state.diagnostics, { code: "runtime-host-startup-failed", message: this.startupFailure.message, at: new Date().toISOString() }] });
    });
    const immediate = <T>(action: RuntimeViewAction["action"], ...args: unknown[]): T => this.immediate<T>(action, ...args);
    const call = <T>(action: RuntimeViewAction["action"], ...args: unknown[]): Promise<T> => this.call<T>(action, ...args);
    const subscribe = (listener: () => void) => this.subscribe("contributions", listener);
    this.runtime = {
      prepareCommand: prepareCommand && ((id, options) => {
        try {
          if (!this.isPluginCommand(id)) return () => this.runtime.invokeCommand(id, options);
          if (!this.initialized) throw this.startupFailure ?? new Error("Plugin runtime host is starting. Try the plugin command again when it is ready.");
          return prepareCommand(id, options);
        } catch (error) { return () => Promise.reject(error); }
      }),
      host: {
        getPlugin: id => { const manifest = this.state.plugins.find(plugin => plugin.id === id); return manifest && { manifest }; },
        listPlugins: () => [...this.state.plugins], subscribe,
        commands: { get: id => this.state.commands.find(command => command.id === id) },
        listProposedPatches: status => this.state.proposals.filter(proposal => !status || proposal.status === status),
        recognitionScreenCaptureOf: id => this.asynchronous ? call<boolean>("screenCaptureOf", id) : immediate("screenCaptureOf", id),
        acceptProposedPatch: (id, document, options = {}) => {
          if (this.asynchronous) throw new Error("Use the captured asynchronous proposal commit.");
          const proposal = this.state.proposals.find(proposal => proposal.id === id);
          if (!proposal) throw new Error("That proposal is no longer pending.");
          // Keep the prepared document and its commit callback local, including large image data.
          // A synchronous owner acknowledgement preserves the pending check immediately at commit.
          if (!options.apply) throw new Error("The document must prepare the accepted proposal before committing it.");
          const prepared = options.apply(document, proposal.proposal, options);
          immediate("acceptProposal", id);
          return prepared;
        },
        rejectProposedPatch: id => this.asynchronous ? call<QueuedProposedPatch>("rejectProposal", id) : immediate("rejectProposal", id)
      },
      panels: {
        getOpenPanel: () => this.state.openPanel, getDetachedPanels: () => this.state.detachedPanels,
        subscribe: listener => this.subscribe("panels", listener),
        closeDetachedPanel: (pluginId, panelId) => { immediate("closeDetachedPanel", pluginId, panelId); },
        detachPanel: (pluginId, panelId) => { immediate("detachPanel", pluginId, panelId); },
        reattachPanel: (pluginId, panelId) => immediate("reattachPanel", pluginId, panelId),
        reportDiagnostic: (code, message) => { immediate("reportDiagnostic", code, message); }
      },
      naming: {
        cancelNaming: id => { void call("namingCancelActivity", id).catch(() => undefined); },
        getActivity: () => this.topic<{ activity?: ReturnType<StructureNamingController["getActivity"]> }>("naming")?.activity,
        getStatus: () => this.topic<{ status?: ReturnType<StructureNamingController["getStatus"]> }>("naming")?.status,
        getInstallRun: () => this.topic<{ run?: ReturnType<StructureNamingController["getInstallRun"]> }>("naming")?.run,
        subscribe: listener => this.subscribe("naming", listener), refreshStatus: () => call("namingRefresh"),
        installEngine: () => call("namingInstall"), cancelEngineInstall: () => call("namingCancel"), uninstall: () => call("namingUninstall")
      },
      recognition: {
        getActiveRecognition: () => this.topic("activity"), subscribeActivity: listener => this.subscribe("activity", listener),
        getInstallRun: () => this.topic("progress"), subscribe: listener => this.subscribe("progress", listener)
      },
      externalTools: { consentList: () => call("consentList"), consentRevoke: (tool, pluginId) => call("consentRevoke", tool, pluginId) },
      proposalDocumentTab: id => this.asynchronous ? new Map(this.state.proposalTabs).get(id) : immediate("proposalDocumentTab", id),
      closeProposalDocumentTab: (id, title) => { immediate("closeProposalDocumentTab", id, title); },
      invokeCommand: (id, options) => {
        if (!this.isPluginCommand(id)) return this.commandRegistry
          ? this.commandRegistry.invoke(id, { input: options?.input })
          : Promise.reject(new Error("The document command registry is unavailable."));
        if (!this.initialized) return Promise.reject(this.startupFailure ?? new Error("Plugin runtime host is starting. Try the plugin command again when it is ready."));
        return invokeCommand ? invokeCommand(id, options) : call<{ result?: unknown; error?: Extract<Reply, { ok: false }>["error"]; warnings: string[] }>("invokePluginCommand", id, options?.input, !!options?.selectionWarnings).then(({ result, warnings, error }) => {
          options?.selectionWarnings?.push(...warnings);
          if (error) throw this.makeError(error);
          return result;
        });
      },
      listCanvasOverlays: () => this.asynchronous ? [...this.state.canvasOverlays] : immediate("listCanvasOverlays"),
      readCanvasOverlays: () => call("listCanvasOverlays"),
      getCanvasOverlayStatuses: () => new Map(this.topic("overlayStatus")),
      subscribeCanvasOverlayStatus: listener => this.subscribe("overlayStatus", listener),
      getCanvasOverlayTranscripts: () => new Map(this.topic("overlayTranscript")),
      subscribeCanvasOverlayTranscript: listener => this.subscribe("overlayTranscript", listener),
      getCanvasOverlayContents: () => new Map(this.topic<{ contents: [] }>("overlayContent")?.contents),
      getCanvasOverlayDraftRestore: id => new Map(this.topic<{ restores: Array<[string, { text: string; token: number }]> }>("overlayContent")?.restores).get(id),
      clearCanvasOverlayDraftRestore: (id, expected) => {
        const token = (expected as { token?: number } | undefined)?.token;
        if (expected && token === undefined) return false;
        return immediate("clearDraftRestore", id, token);
      },
      subscribeCanvasOverlayContent: listener => this.subscribe("overlayContent", listener),
      getCanvasOverlayOpenRequests: () => new Map(this.topic("overlayOpen")),
      subscribeCanvasOverlayOpen: listener => this.subscribe("overlayOpen", listener),
      listPluginToolsets: () => this.state.toolsets, onDidChange: subscribe,
      applyEnabledPluginIds: ids => { immediate("applyEnabled", ids); },
      registerFixture: () => { immediate("registerFixture"); }, unregisterFixture: () => { immediate("unregisterFixture"); },
      discardPreparedPackages: () => { immediate("discardPreparedPackages"); },
      acceptPreparedProposal: async (proposalId, target, documentKey, commit) => {
        const request = { proposalId, target: { ...target }, documentKey, preparationId: crypto.randomUUID() };
        this.preparations.set(request.preparationId, { request, commit });
        try {
          await broker.call(RUNTIME_HOST_LABEL, "acceptPreparedProposal", request);
          this.retireProposalCommits(proposalId);
        }
        finally { this.preparations.delete(request.preparationId); }
      }
    };
  }

  subscribe(topic: string, listener: () => void): () => void {
    const listeners = this.listeners.get(topic) ?? new Set();
    listeners.add(listener); this.listeners.set(topic, listeners);
    return () => { listeners.delete(listener); };
  }

  read(): BrokerPluginRuntimeView {
    if (this.bundledSource !== this.state.bundledPlugins) {
      this.bundledSource = this.state.bundledPlugins;
      this.bundledView = this.state.bundledPlugins.map(({ manifest }) => ({ manifest, options: { commandHandlers: {} } }));
    }
    const view = { ...this.state, runtime: this.runtime,
      bundledPlugins: this.bundledView,
      isPluginCommand: this.isPluginCommand,
      invokePluginCommand: this.runtime.invokeCommand
    } as unknown as BrokerPluginRuntimeView;
    for (const action of this.state.availableActions) {
      if (action === "invokePluginCommand") continue;
      if (!this.actions.has(action)) this.actions.set(action, (...args: unknown[]) => this.call(action, ...args));
      Object.assign(view, { [action]: this.actions.get(action) });
    }
    return view;
  }

  /** Called on provider updates, including inactive-tab closure/replacement, and before delivery. */
  refreshProposalDocuments(): void {
    if (!this.documentPort) return;
    const requests = [...this.preparations.values(), ...this.proposalReceipts.values(),
      ...[...this.committedProposals.values()].map(request => ({ request }))];
    for (const { request } of requests) {
      if (this.documentPort.read(request.target.tabId)?.documentKey !== request.documentKey) {
        this.retireProposalCommits(request.proposalId);
      }
    }
  }

  private retireProposalCommits(proposalId: string, preparationId?: string): void {
    for (const [id, { request }] of this.preparations) {
      if (request.proposalId === proposalId && (!preparationId || id === preparationId)) this.preparations.delete(id);
    }
    for (const [id, { request }] of this.proposalReceipts) {
      if (request.proposalId === proposalId && (!preparationId || id === preparationId)) this.proposalReceipts.delete(id);
    }
    if (!preparationId) this.committedProposals.delete(proposalId);
  }

  dispose(): void { this.disposed = true; this.stop(); this.stopProposalCommit(); this.stopProposalRetirement(); this.preparations.clear(); this.proposalReceipts.clear(); this.committedProposals.clear(); this.listeners.clear(); this.previews.clear(); this.pendingPreviews.clear(); this.livePreviewTokens.clear(); }

  private topic<T>(key: string): T | undefined { return this.topics.get(key) as T | undefined; }
  private immediate<T>(action: RuntimeViewAction["action"], ...args: unknown[]): T {
    if (this.asynchronous) {
      if (action === "reattachPanel") {
        const available = !this.state.openPanel && this.state.detachedPanels.some(panel => panel.pluginId === args[0] && panel.panelId === args[1]);
        if (available) void this.call(action, ...args).catch(() => undefined);
        return available as T;
      }
      if (action === "clearDraftRestore") {
        const content = this.topic<{ restores: Array<[string, { token: number } | undefined]> }>("overlayContent");
        const current = content?.restores.find(([id]) => id === args[0])?.[1];
        if (!current || (args[1] !== undefined && current.token !== args[1])) return false as T;
        if (content) content.restores = content.restores.filter(([id]) => id !== args[0]);
        void this.call(action, ...args).catch(() => undefined);
        return true as T;
      }
      void this.call(action, ...args).catch(() => undefined);
      return undefined as T;
    }
    return this.unwrap<T>(this.broker.callImmediate(RUNTIME_HOST_LABEL, "runtimeViewAction", { action, args: encodeRuntimeView(args) as unknown[] }));
  }
  private applyState(next: RuntimeViewState): void {
    const previous = this.state;
    // Stable values preserve menu, panel and useSyncExternalStore identities across data deliveries.
    for (const key of Object.keys(next) as Array<keyof RuntimeViewState>) {
      if (JSON.stringify(previous[key]) === JSON.stringify(next[key])) Object.assign(next, { [key]: previous[key] });
    }
    this.state = next;
    if (previous.plugins !== next.plugins || previous.commands !== next.commands || previous.toolsets !== next.toolsets) this.notify("contributions");
    if (previous.openPanel !== next.openPanel || previous.detachedPanels !== next.detachedPanels || previous.diagnostics !== next.diagnostics) this.notify("panels");
    this.notify("state");
  }
  private hasPreviewReferences(state: RuntimeViewState): boolean {
    return state.proposals.some(proposal => proposal.proposal.recognition?.sourceImageRef.startsWith("runtime-preview:"));
  }
  private prunePreviews(state: RuntimeViewState): void {
    this.livePreviewTokens = new Set(state.proposals.flatMap(proposal => {
      const reference = proposal.proposal.recognition?.sourceImageRef.match(/^runtime-preview:([a-f0-9-]+):(\d+)$/);
      return reference ? [reference[1]!] : [];
    }));
    for (const token of this.previews.keys()) if (!this.livePreviewTokens.has(token)) this.previews.delete(token);
    for (const token of this.pendingPreviews.keys()) if (!this.livePreviewTokens.has(token)) this.pendingPreviews.delete(token);
  }
  private async resolvePreviewsAsync(state: RuntimeViewState): Promise<RuntimeViewState> {
    if (!this.hasPreviewReferences(state)) return state;
    const next = structuredClone(state);
    for (const proposal of next.proposals) {
      const recognition = proposal.proposal.recognition;
      const reference = recognition?.sourceImageRef.match(/^runtime-preview:([a-f0-9-]+):(\d+)$/);
      if (!recognition || !reference) continue;
      const [, token, length] = reference;
      if (this.disposed || !this.livePreviewTokens.has(token!)) throw new Error("This recognition preview is no longer pending.");
      let pending = this.pendingPreviews.get(token!);
      if (!pending) {
        pending = (async () => {
          const cached = this.previews.get(token!);
          if (cached) return cached;
          const chunks: string[] = [];
          for (let offset = 0; offset < Number(length);) {
            const chunk = await this.call<string>("previewImageChunk", token, offset);
            // Pruning revokes this fetch even if the token is reintroduced by a newer state.
            if (this.disposed || this.pendingPreviews.get(token!) !== pending) throw new Error("This recognition preview is no longer pending.");
            if (!chunk || chunk.length > 256 * 1024 || offset + chunk.length > Number(length)) throw new Error("Invalid recognition preview chunk.");
            chunks.push(chunk); offset += chunk.length;
          }
          const source = chunks.join("");
          this.previews.set(token!, source);
          return source;
        })();
        this.pendingPreviews.set(token!, pending);
        void pending.finally(() => {
          if (this.pendingPreviews.get(token!) === pending) this.pendingPreviews.delete(token!);
        }).catch(() => undefined);
      }
      recognition.sourceImageRef = await pending;
    }
    return next;
  }
  private resolvePreviews(state: RuntimeViewState): RuntimeViewState {
    this.prunePreviews(state);
    for (const proposal of state.proposals) {
      const recognition = proposal.proposal.recognition;
      const reference = recognition?.sourceImageRef.match(/^runtime-preview:([a-f0-9-]+):(\d+)$/);
      if (!recognition || !reference) continue;
      const [, token, length] = reference;
      let source = this.previews.get(token!);
      if (!source) {
        const chunks: string[] = [];
        for (let offset = 0; offset < Number(length);) {
          const chunk = this.immediate<string>("previewImageChunk", token, offset);
          if (!chunk || chunk.length > 256 * 1024 || offset + chunk.length > Number(length)) throw new Error("Invalid recognition preview chunk.");
          chunks.push(chunk); offset += chunk.length;
        }
        source = chunks.join(""); this.previews.set(token!, source);
      }
      recognition.sourceImageRef = source;
    }
    return state;
  }
  private notify(topic: string): void { for (const listener of this.listeners.get(topic) ?? []) listener(); }
  private call<T>(action: RuntimeViewAction["action"], ...args: unknown[]): Promise<T> {
    const invoke = () => this.broker.call(RUNTIME_HOST_LABEL, "runtimeViewAction", {
      action, args: encodeRuntimeView(runtimeViewActionArguments(action, args)) as unknown[]
    }).then(reply => this.unwrap<T>(reply));
    return this.asynchronous ? this.startup.then(invoke) : invoke();
  }
  private unwrap<T>(raw: unknown): T {
    const reply = raw as Reply;
    if (reply.ok) return decodeRuntimeView<T>(reply.value);
    throw this.makeError(reply.error);
  }
  private makeError(error: Extract<Reply, { ok: false }>["error"]): Error {
    if (error.installCode) return new PluginInstallError(error.installCode, error.message);
    if (error.metadataKind) return new PluginReleaseMetadataUnavailableError(error.message, error.metadataKind);
    return new Error(error.message);
  }
}
