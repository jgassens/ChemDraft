import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { AssistantCapabilityPermissions, AppliedPatchReceiptSchema, type AppliedPatchReceipt, type PluginCommandInput, type PluginSelectionSnapshot } from "@chemdraft/plugin-api";
import {
  assertPluginPatchWriteScope, CommandRegistry, DirectWritePatchOps, validateTrustedPluginManifest,
  writePatchOps, type PluginPatchApplicationRequest
} from "@chemdraft/plugin-host";
import { bindRuntimeAssistantDocument, type RuntimeAssistantDocumentPort } from "./runtimeAssistantDocument";
import { RuntimeBroker } from "./runtimeBroker";
import {
  invocationReference, RUNTIME_HOST_LABEL, RuntimeContributionsSchema, RuntimeInvocationSchema,
  type RuntimeContributions, type RuntimeInvocation, type RuntimeInvocationReference, type RuntimeRequest
} from "./runtimeBrokerProtocol";

export interface RuntimeDocumentState { document: ChemDraftDocument; documentKey: string }
export interface RuntimeDocumentPort {
  assistant?: RuntimeAssistantDocumentPort;
  windowId: string;
  commandRegistry: CommandRegistry;
  activeTabId(): string;
  /** Key survives activation, ordinary edits and undo, but changes on drawing replacement/handoff. */
  read(tabId: string): RuntimeDocumentState | undefined;
  /** The collector stays local to this document and invocation; it never crosses IPC. */
  selection(tabId: string, warnings?: string[]): PluginSelectionSnapshot;
  viewportRect?(tabId: string): { x: number; y: number; width: number; height: number } | undefined;
  /** The existing gesture gate and any page-fit question. Preparation receives the application so
   * it can keep the existing consent/history policy. Call commit only after every asynchronous wait;
   * the callback reruns scope/identity/lifetime checks on this window's thread. */
  runWrite<T>(tabId: string, commit: () => T, application: PluginPatchApplicationRequest): Promise<T>;
  /** Synchronous history commit: no await may separate the broker's recheck and the commit. Any
   * async page-fit preparation belongs before this call and must cause another broker recheck. */
  commit(tabId: string, before: ChemDraftDocument, application: PluginPatchApplicationRequest,
    invocation: RuntimeInvocationReference): AppliedPatchReceipt;
}
interface Binding {
  invocation: RuntimeInvocation;
  scope: Set<string>;
  stop: AbortController;
  transactions: Map<string, () => boolean>;
  selectionWarnings?: string[];
}

/** The committing window owns all authority. Incoming scope can narrow its grant, never widen it.
 * No PluginHost, workers, installed-plugin loader or controller is constructed by this client. */
export class RuntimeBrokerDocument {
  private readonly bindings = new Map<string, Binding>();
  private readonly unbind: Array<() => void> = [];
  private ownedCommands = new Map<string, string>();
  private snapshot?: RuntimeContributions;
  private disposed = false;
  private armedSelectionWarnings?: string[];
  private readonly assistant: ReturnType<typeof bindRuntimeAssistantDocument>;

  constructor(private readonly broker: RuntimeBroker, private readonly port: RuntimeDocumentPort) {
    if (broker.label !== port.windowId || broker.label === RUNTIME_HOST_LABEL) throw new Error("Plugin broker document owner mismatch.");
    this.assistant = bindRuntimeAssistantDocument(broker, port, ref => {
      this.current(ref);
      const manifest = this.snapshot?.plugins.find(plugin => plugin.id === ref.pluginId);
      if (!manifest || !AssistantCapabilityPermissions.every(permission => manifest.permissions.includes(permission))) {
        throw new Error("The plugin did not declare all assistant permissions.");
      }
      return this.binding(ref).invocation.writeScopeObjectIds;
    });
    this.unbind.push(this.assistant,
      broker.handle("assistantOpenInvocation", ({ session, commandId, writeScopeObjectIds }) => {
        const grant = new Set(this.assistant.scope(session));
        if (writeScopeObjectIds.some(id => !grant.has(id))) throw new Error("The assistant tool cannot widen its Send scope.");
        const invocation = RuntimeInvocationSchema.parse({ id: crypto.randomUUID(), target: session.target, documentKey: session.documentKey,
          pluginId: session.pluginId, commandId, writeScopeObjectIds });
        this.bindings.set(invocation.id, { invocation, scope: new Set(writeScopeObjectIds), stop: new AbortController(), transactions: new Map() });
        return invocation;
      }),
      broker.handle("captureDocumentTarget", ({ windowId }) => {
        if (windowId !== port.windowId) throw new Error("Wrong document window.");
        const tabId = port.activeTabId(), state = port.read(tabId);
        if (!state) throw new Error("The document tab is closed.");
        return { target: { windowId, tabId }, documentKey: state.documentKey };
      }),
      broker.handle("invokeDocumentPlugin", async ({ target, documentKey, commandId, input, collectWarnings }) => {
        const pluginId = this.ownedCommands.get(commandId);
        const command = port.commandRegistry.get(commandId);
        if (target.windowId !== port.windowId || !pluginId || !command?.enabled ||
          port.read(target.tabId)?.documentKey !== documentKey) throw new Error("The captured plugin command is unavailable.");
        const warnings: string[] = [];
        try { return { result: await this.dispatch(pluginId, commandId, input, target.tabId, collectWarnings ? warnings : undefined), warnings }; }
        catch (error) { return { error: error instanceof Error ? error.message : String(error), warnings }; }
      }),
      broker.handle("getDocument", ref => this.current(ref).document),
      broker.handle("getSelection", ref => {
        this.current(ref);
        const snapshot = port.selection(ref.target.tabId, ref.collectWarnings === false ? undefined : this.binding(ref).selectionWarnings);
        return { objectIds: [...snapshot.objectIds], molecules: [...snapshot.molecules] };
      }),
      broker.handle("getViewportRect", ref => { this.current(ref); return port.viewportRect?.(ref.target.tabId); }),
      broker.handle("applyPatch", request => this.apply(request)),
      broker.handle("undoOwnTransaction", ({ invocation, transactionId }) => {
        this.current(invocation);
        const binding = this.binding(invocation);
        const undo = binding.transactions.get(transactionId);
        if (!undo) throw new Error("This transaction does not belong to the plugin invocation; undo refused.");
        const undone = undo();
        if (undone) binding.transactions.delete(transactionId);
        return undone;
      }),
      broker.handle("endInvocation", ref => { this.binding(ref); this.finish(ref.id); return null; }),
      broker.subscribeContributions(snapshot => this.registerContributions(snapshot))
    );
  }

  async refreshContributions(): Promise<void> {
    this.registerContributions(await this.broker.call(RUNTIME_HOST_LABEL, "getContributions", {}));
  }

  getContributions(): RuntimeContributions | undefined { return this.snapshot && structuredClone(this.snapshot); }

  /** For the existing menu/toolbar/panel/overlay renderers. A5b can project this per window without
   * moving registration, dispatch or write authority back out of the runtime host. */
  registerContributions(raw: RuntimeContributions): void {
    if (this.disposed) return;
    const snapshot = RuntimeContributionsSchema.parse(raw);
    if (this.snapshot && snapshot.revision <= this.snapshot.revision) return;
    const definitions = new Map<string, { pluginId: string; command: typeof snapshot.plugins[number]["contributes"]["commands"][number] }>();
    const pluginIds = new Set<string>();
    const toolsetIds = new Set<string>();
    for (const candidate of snapshot.plugins) {
      const plugin = validateTrustedPluginManifest(candidate);
      if (pluginIds.has(plugin.id)) throw new Error(`Duplicate plugin contribution: ${plugin.id}.`);
      pluginIds.add(plugin.id);
      if ((plugin.contributes.toolsets.length || plugin.contributes.toolbarButtons.length) && !plugin.permissions.includes("ui.toolbar")) {
        throw new Error(`Plugin "${plugin.id}" requires permission "ui.toolbar".`);
      }
      for (const toolset of plugin.contributes.toolsets) {
        if (toolsetIds.has(toolset.id)) throw new Error(`Duplicate plugin toolset contribution: ${toolset.id}.`);
        toolsetIds.add(toolset.id);
      }
      for (const command of plugin.contributes.commands) {
        if (command.requiredPermissions.some(permission => !plugin.permissions.includes(permission))) {
          throw new Error(`Plugin "${plugin.id}" command requires an undeclared permission.`);
        }
        const existing = this.port.commandRegistry.get(command.id);
        const wasOurs = existing?.source === "plugin" && this.ownedCommands.get(command.id) === existing.pluginId;
        if (definitions.has(command.id) || (existing && !wasOurs)) throw new Error(`Command "${command.id}" is already registered.`);
        definitions.set(command.id, { pluginId: plugin.id, command });
      }
    }
    const enabled = new Set(snapshot.enabledCommandIds);
    if ([...enabled].some(id => !definitions.has(id))) throw new Error("Enabled plugin command has no contribution.");
    const previous = this.snapshot;
    const install = (entries: typeof definitions, enabledIds: ReadonlySet<string>) => {
      for (const { pluginId, command } of entries.values()) {
        this.ownedCommands.set(command.id, pluginId);
        this.port.commandRegistry.register({ ...command, pluginId, source: "plugin", enabled: command.enabled && enabledIds.has(command.id) },
          context => this.dispatch(pluginId, command.id, context.input));
      }
    };
    this.removeProxies();
    try { install(definitions, enabled); }
    catch (cause) {
      this.removeProxies();
      // Roll the complete previous snapshot back if an injected registry fails mid-registration.
      this.snapshot = undefined;
      if (previous) this.registerContributions(previous);
      throw cause;
    }
    this.snapshot = structuredClone(snapshot);
  }

  async invokeCommand(commandId: string, input?: PluginCommandInput, options?: { selectionWarnings?: string[] }): Promise<unknown> {
    const pluginId = this.ownedCommands.get(commandId);
    const manifest = this.snapshot?.plugins.find(plugin => plugin.id === pluginId);
    if (!manifest) throw new Error(`Plugin command "${commandId}" is unavailable.`);
    // Registry dispatch enters the proxy synchronously. Claim the collector before its first await;
    // later selection reads use the retained binding, never a mutable current-invocation slot.
    const previous = this.armedSelectionWarnings;
    this.armedSelectionWarnings = options?.selectionWarnings;
    try { return this.port.commandRegistry.invoke(commandId, { input, pluginId, permissions: new Set(manifest.permissions) }); }
    finally { this.armedSelectionWarnings = previous; }
  }

  /** Host-owned undo entry registration; no wire method can register or replace an undo callback. */
  recordOwnTransaction(invocationId: string, transactionId: string, undo: () => boolean): void {
    const binding = this.bindings.get(invocationId);
    if (!binding || binding.stop.signal.aborted) throw new Error("The plugin command ended; undo refused.");
    if (binding.transactions.has(transactionId)) throw new Error("The plugin transaction is already recorded.");
    binding.transactions.set(transactionId, undo);
  }

  invalidateTab(tabId: string): void {
    for (const [id, binding] of this.bindings) if (binding.invocation.target.tabId === tabId) this.finish(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.bindings.keys()) this.finish(id);
    for (const unbind of this.unbind) unbind();
    this.removeProxies();
  }

  private async dispatch(pluginId: string, commandId: string, input?: PluginCommandInput, capturedTabId?: string, selectionWarnings?: string[]): Promise<unknown> {
    if (this.disposed) throw new Error("The document window closed; plugin invocation refused.");
    const tabId = capturedTabId ?? this.port.activeTabId();
    const state = this.port.read(tabId);
    if (!state) throw new Error("The plugin command's document tab was closed; nothing was inserted.");
    const invocation = RuntimeInvocationSchema.parse({ id: crypto.randomUUID(), target: { windowId: this.port.windowId, tabId },
      documentKey: state.documentKey, pluginId, commandId, writeScopeObjectIds: [...state.document.selection.objectIds] });
    this.bindings.set(invocation.id, { invocation: structuredClone(invocation), scope: new Set(invocation.writeScopeObjectIds),
      stop: new AbortController(), transactions: new Map(), selectionWarnings: selectionWarnings ?? this.armedSelectionWarnings });
    try { return await this.broker.call(RUNTIME_HOST_LABEL, "invokeCommand", { invocation, input }); }
    finally { this.finish(invocation.id); }
  }

  private binding(ref: RuntimeInvocationReference): Binding {
    const binding = this.bindings.get(ref.id);
    const expected = binding?.invocation;
    if (!expected || binding.stop.signal.aborted || ref.target.windowId !== this.port.windowId ||
      ref.target.tabId !== expected.target.tabId || ref.documentKey !== expected.documentKey ||
      ref.commandId !== expected.commandId || ref.pluginId !== expected.pluginId) {
      throw new Error("The plugin command's document binding is no longer available; nothing was inserted.");
    }
    return binding;
  }

  private current(ref: RuntimeInvocationReference): RuntimeDocumentState {
    this.binding(ref);
    const state = this.port.read(ref.target.tabId);
    if (!state) throw new Error("The plugin command's document tab was closed; nothing was inserted.");
    if (state.documentKey !== ref.documentKey) throw new Error("The document changed while the plugin was running; nothing was inserted.");
    return state;
  }

  private async apply({ invocation, application }: RuntimeRequest<"applyPatch">): Promise<AppliedPatchReceipt> {
    const binding = this.binding(invocation);
    if (application.plugin.id !== invocation.pluginId || application.command.id !== invocation.commandId) {
      throw new Error("The plugin write does not belong to its command invocation.");
    }
    const check = () => {
      binding.stop.signal.throwIfAborted();
      const { document } = this.current(invocation);
      for (const id of application.writeScopeObjectIds) {
        if (!binding.scope.has(id)) throw new Error(`${id} was not selected when the command started`);
      }
      for (const op of writePatchOps(application.patch.patch)) {
        if (!(DirectWritePatchOps as readonly string[]).includes(op.op)) throw new Error(`Unsupported plugin direct-write patch: ${op.op}.`);
      }
      assertPluginPatchWriteScope(document, application.patch, application.writeScopeObjectIds);
      return document;
    };
    check(); // Document-side preflight, before waiting for a gesture.
    const request = { ...application, signal: binding.stop.signal };
    const receipt = AppliedPatchReceiptSchema.parse(await this.port.runWrite(invocation.target.tabId, () => {
      const before = check(); // Commit-time target, command lifetime AND #364 scope recheck.
      const receipt = AppliedPatchReceiptSchema.parse(this.port.commit(invocation.target.tabId, before, request, invocation));
      return receipt;
    }, request));
    for (const id of receipt.objectIds) binding.scope.add(id);
    this.assistant.recordApplied(invocation, receipt.objectIds);
    return receipt;
  }

  private finish(id: string): void {
    this.bindings.get(id)?.stop.abort(new Error("The plugin command ended; nothing was inserted."));
    this.bindings.delete(id);
  }

  private removeProxies(): void {
    for (const [id, pluginId] of this.ownedCommands) this.port.commandRegistry.unregisterOwnedByPlugin(id, pluginId);
    this.ownedCommands = new Map();
  }
}
