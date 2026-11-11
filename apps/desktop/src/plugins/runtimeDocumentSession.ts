import type { CommandRegistry } from "@chemdraft/plugin-host";
import type { RuntimeDocumentProviders } from "./localPluginRuntime";
import { RuntimeBroker } from "./runtimeBroker";
import { RuntimeBrokerDocument } from "./runtimeBrokerDocument";
import { connectNativeRuntimeTransport } from "./runtimeBrokerTransport";
import { bindRuntimeCoreCommands } from "./runtimeCoreCommands";
import { bindRuntimeDialogs } from "./runtimeDialogs";
import { decodeRuntimeView } from "./runtimeViewProtocol";
import { RuntimeViewClient } from "./runtimeViewClient";
import { deferredRuntimeTransport, initializeRuntimeHost, runtimeStartupError } from "./runtimeStartup";
import { mountStructureNamingActivity } from "./StructureNamingInstallDialog";
import { open } from "../nativeFileDialog";
import type { RuntimeTransport } from "./runtimeBrokerProtocol";

/** Document-only service. No runtime factory, plugin loader, worker or controller lives here. */
export function createRuntimeDocumentSession(providers: RuntimeDocumentProviders,
  connect: (label: string) => Promise<RuntimeTransport> = connectNativeRuntimeTransport) {
  const port = providers.documentPort;
  if (!port) throw new Error("The desktop runtime view requires its document commit port.");
  let current = providers;
  const broker = new RuntimeBroker(port.windowId, deferredRuntimeTransport(connect(port.windowId)));
  const document = new RuntimeBrokerDocument(broker, port);
  const stopCore = bindRuntimeCoreCommands(broker, port.commandRegistry);
  const stopDialogs = bindRuntimeDialogs(broker, port, () => current.getDialogCoordinator?.());
  const stopPicker = broker.handle("chooseRuntimeFile", async ({ kind }) => {
    const path = await open(kind === "pluginPackage" ? {
      multiple: false, directory: false, title: "Install ChemDraft plugin package",
      filters: [{ name: "ChemDraft plugin package", extensions: ["zip"] }]
    } : {
      multiple: false, directory: false, title: "Choose an image",
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "tif", "tiff", "webp"] }]
    });
    return typeof path === "string" ? path : null;
  });
  const stopNotifications = broker.subscribeView((topic, encoded) => {
    if (topic !== "nameResolutionStatus" && topic !== "pluginUpdateStatus" && topic !== "proposalsChanged") return;
    const value = decodeRuntimeView<unknown>(encoded);
    if (topic === "nameResolutionStatus" && (value === undefined || typeof value === "string")) current.onNameResolutionStatus?.(value);
    if (topic === "pluginUpdateStatus" && typeof value === "string") current.onPluginUpdateStatus?.(value);
    if (topic === "proposalsChanged" && value === null) current.onProposedPatchesChanged?.();
  });
  let metadata = "";
  let initialized = false;
  const publishMetadata = () => {
    if (!initialized) return;
    const tabId = port.activeTabId(), state = port.read(tabId);
    if (!state) return;
    const request = { target: { windowId: port.windowId, tabId }, documentKey: state.documentKey,
      titles: [...current.documentTabs ?? []] };
    const value = JSON.stringify(request);
    if (value === metadata) return;
    metadata = value;
    void broker.call("runtime", "setDocumentMetadata", request).catch(error => current.onPluginUpdateStatus?.(String(error)));
  };
  const startup = initializeRuntimeHost(broker).then(async () => {
    await document.refreshContributions();
    initialized = true;
    publishMetadata();
  }).catch(error => {
    if (error instanceof Error && error.message.startsWith("Plugin runtime host failed to start:")) throw error;
    throw runtimeStartupError(error);
  });
  const client = new RuntimeViewClient(broker, (id, options) => document.invokeCommand(id, options?.input, options), true, startup,
    (id, options) => document.prepareCommand(id, options?.input, options));
  void client.ready.catch(error => current.onPluginUpdateStatus?.(error instanceof Error ? error.message : String(error)));
  let stopActivity: (() => void) | undefined;
  let started = false;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("pagehide", dispose);
    stopActivity?.(); client.dispose(); document.dispose(); stopCore(); stopDialogs(); stopPicker(); stopNotifications(); broker.dispose();
  };
  return {
    client,
    updateDocumentProviders(next: RuntimeDocumentProviders) { current = next; publishMetadata(); },
    start() {
      if (started) return;
      started = true;
      stopActivity = mountStructureNamingActivity(client.runtime.naming);
      window.addEventListener("pagehide", dispose, { once: true });
    },
    dispose
  };
}

const sessions = new WeakMap<CommandRegistry, ReturnType<typeof createRuntimeDocumentSession>>();
export function runtimeDocumentSession(providers: RuntimeDocumentProviders) {
  if (!providers.commandRegistry) throw new Error("The document runtime view requires its stable command registry.");
  let session = sessions.get(providers.commandRegistry);
  if (!session) { session = createRuntimeDocumentSession(providers); sessions.set(providers.commandRegistry, session); }
  session.updateDocumentProviders(providers);
  return session;
}
