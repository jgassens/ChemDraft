import { mountStructureNamingActivity } from "./StructureNamingInstallDialog";
import type { DialogCoordinator } from "../dialogs/DialogCoordinator";
import { bindRuntimeDialogs, createRuntimeDialogClient } from "./runtimeDialogs";
import { createRuntimeAssistantClient } from "./runtimeAssistantClient";
import { CommandRegistry, type PluginPatchApplicationRequest } from "@chemdraft/plugin-host";
import { documentWindowId } from "../documentIdentity";
import { createPluginRuntimeOwner, type PluginRuntimeProviders } from "./pluginRuntimeOwner";
import { RuntimeBroker } from "./runtimeBroker";
import { RuntimeInProcessChannels } from "./runtimeInProcessChannels";
import { bindRuntimeViewOwner } from "./runtimeViewOwner";
import { RuntimeViewClient } from "./runtimeViewClient";
import { decodeRuntimeView, encodeRuntimeView } from "./runtimeViewProtocol";
import { RuntimeBrokerHost } from "./runtimeBrokerHost";
import { RuntimeBrokerDocument, type RuntimeDocumentPort } from "./runtimeBrokerDocument";
import { bindRuntimeCoreCommands, RuntimeCoreCommandRegistry } from "./runtimeCoreCommands";

export interface RuntimeDocumentProviders extends Omit<PluginRuntimeProviders, "getActiveDocument" | "getSelection"> {
  getActiveDocument?: PluginRuntimeProviders["getActiveDocument"];
  getSelection?: PluginRuntimeProviders["getSelection"];
  getDialogCoordinator?: () => DialogCoordinator | undefined;
  documentTabs?: readonly { id: string; title: string }[];
}

/** Explicit browser/local embedding only. Native documents use runtimeDocumentSession and never
 * fall back here if their hidden host fails. The stable registry identifies this embedding. */
export function createLocalPluginRuntimeSession(providers: RuntimeDocumentProviders,
  createOwner = createPluginRuntimeOwner, channels = new RuntimeInProcessChannels(), windowId = documentWindowId()) {
  const documentProviders = { current: providers };
  const fallbackTab = crypto.randomUUID();
  // Local embeddings without MainWindow's history port still keep their callbacks in the
  // document adapter. The owner sees the same captured provider messages in either embedding.
  const port: RuntimeDocumentPort = providers.documentPort ?? {
    windowId, commandRegistry: providers.commandRegistry ?? new CommandRegistry(),
    activeTabId: () => documentProviders.current.getActiveDocumentTab?.().id ?? fallbackTab,
    read: tabId => {
      const source = documentProviders.current;
      if (tabId !== (source.getActiveDocumentTab?.().id ?? fallbackTab)) return undefined;
      const document = source.getActiveDocument?.();
      return document ? { document, documentKey: source.getActiveDocumentKey?.() ?? `${document.id}:${document.createdAt}` } : undefined;
    },
    selection: (_tab, warnings) => documentProviders.current.getSelection?.(warnings) ?? { objectIds: [], molecules: [] },
    async runWrite<T>(_tab: string, _commit: () => T, application: PluginPatchApplicationRequest) {
      const apply = documentProviders.current.applyDocumentPatch;
      if (!apply) throw new Error("This embedding provides no direct plugin document-write path.");
      return await apply(application) as T;
    },
    commit: () => { throw new Error("This embedding owns its document commit callback."); }
  };
  // Logical peers only: this step creates no additional native window.
  const hostBroker = new RuntimeBroker("runtime", channels.transport("runtime"));
  const documentBroker = new RuntimeBroker(windowId, channels.transport(windowId));
  const coreRegistry = new RuntimeCoreCommandRegistry(hostBroker, windowId);
  const stopCoreCommands = bindRuntimeCoreCommands(documentBroker, port.commandRegistry);
  const publish = (topic: string, value: unknown) => { void hostBroker.broadcastView([windowId], topic, encodeRuntimeView(value)).catch(() => undefined); };
  const stopNotifications = documentBroker.subscribeView((topic, encoded) => {
    if (topic !== "nameResolutionStatus" && topic !== "pluginUpdateStatus" && topic !== "proposalsChanged") return;
    const value = decodeRuntimeView<unknown>(encoded);
    if (topic === "nameResolutionStatus" && (value === undefined || typeof value === "string")) documentProviders.current.onNameResolutionStatus?.(value);
    if (topic === "pluginUpdateStatus" && typeof value === "string") documentProviders.current.onPluginUpdateStatus?.(value);
    if (topic === "proposalsChanged" && value === null) documentProviders.current.onProposedPatchesChanged?.();
  });
  const assistant = createRuntimeAssistantClient(hostBroker);
  const dialogs = createRuntimeDialogClient(hostBroker);
  const stopDialogs = bindRuntimeDialogs(documentBroker, port, () => documentProviders.current.getDialogCoordinator?.());
  const remote = !!providers.documentPort;
  const owner = createOwner({
    dataOnly: remote,
    createStorage: providers.createStorage,
    assistantMcpEngine: providers.assistantMcpEngine,
    captureAssistantRequest: assistant.begin,
    forwardUnboundCommand: async (commandId, options) => {
      const captured = await hostBroker.call(windowId, "captureDocumentTarget", { windowId });
      const reply = await hostBroker.call(windowId, "invokeDocumentPlugin", { ...captured, commandId, input: options?.input,
        collectWarnings: !!options?.selectionWarnings }) as { result?: unknown; error?: string; warnings: string[] };
      options?.selectionWarnings?.push(...reply.warnings);
      if (reply.error) throw new Error(reply.error);
      return reply.result;
    },
    dialogPort: target => target ? dialogs.forTarget(target) : undefined,
    // Core commands stay in the document. The owner gets its own plugin registry; the document
    // installs contributions as proxies after the runtime's permission/rollback gates complete.
    documentPort: undefined,
    commandRegistry: coreRegistry,
    getActiveDocument: () => undefined,
    getSelection: () => ({ objectIds: [], molecules: [] }),
    onNameResolutionStatus: text => publish("nameResolutionStatus", text),
    onPluginUpdateStatus: text => publish("pluginUpdateStatus", text),
    onProposedPatchesChanged: () => publish("proposalsChanged", null)
  });
  const host = new RuntimeBrokerHost(hostBroker, () => owner.runtime, () => [windowId]);
  const document = new RuntimeBrokerDocument(documentBroker, port);
  void host.broadcastContributions().catch(() => undefined);
  const unbind = bindRuntimeViewOwner(owner, hostBroker, () => [windowId]);
  const client = new RuntimeViewClient(documentBroker, remote ? ((id, options) => document.invokeCommand(id, options?.input, options)) : undefined, remote,
    Promise.resolve(), remote ? ((id, options) => document.prepareCommand(id, options?.input, options)) : undefined);
  if (remote) unbind.publish();
  const initialTab = port.activeTabId(), initialState = port.read(initialTab);
  if (initialState) void documentBroker.call("runtime", "setDocumentMetadata", {
    target: { windowId, tabId: initialTab }, documentKey: initialState.documentKey,
    titles: [...providers.documentTabs ?? (providers.getDocumentTabTitle?.(initialTab) ? [{ id: initialTab, title: providers.getDocumentTabTitle!(initialTab)! }] : [])]
  }).catch(() => undefined);
  let metadata = "";
  let stopNamingActivity: (() => void) | undefined;
  return {
    client,
    updateDocumentProviders: (next: RuntimeDocumentProviders) => {
      documentProviders.current = next;
      const tabId = port.activeTabId();
      const state = port.read(tabId);
      if (state) {
        const request = { target: { windowId, tabId }, documentKey: state.documentKey,
          titles: [...next.documentTabs ?? (next.getDocumentTabTitle?.(tabId) ? [{ id: tabId, title: next.getDocumentTabTitle!(tabId)! }] : [])] };
        const value = JSON.stringify(request);
        if (value !== metadata) {
          metadata = value;
          void documentBroker.call("runtime", "setDocumentMetadata", request).catch(() => undefined);
        }
      }
    },
    start: () => { if (remote) stopNamingActivity ??= mountStructureNamingActivity(client.runtime.naming); owner.start(); },
    dispose() { stopNamingActivity?.(); client.dispose(); unbind(); document.dispose(); host.dispose(); assistant.dispose(); dialogs.dispose(); stopDialogs(); stopCoreCommands(); coreRegistry.dispose(); stopNotifications(); documentBroker.dispose(); hostBroker.dispose(); owner.dispose(); }
  };
}

const sessions = new WeakMap<CommandRegistry, ReturnType<typeof createLocalPluginRuntimeSession>>();
export function localPluginRuntimeSession(providers: RuntimeDocumentProviders) {
  if (!providers.commandRegistry) throw new Error("The document runtime view requires its stable command registry.");
  let session = sessions.get(providers.commandRegistry);
  if (!session) {
    session = createLocalPluginRuntimeSession(providers);
    sessions.set(providers.commandRegistry, session);
  }
  session.updateDocumentProviders(providers);
  return session;
}
