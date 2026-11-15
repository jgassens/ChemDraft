import { nameToStructureForPlugin } from "./pluginChemistry";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type {
  AppliedPatchReceipt,
  PluginCommandInput,
  PluginImageSource,
  PluginManifest,
  PluginSelectionSnapshot,
  PluginStorage
} from "@chemdraft/plugin-api";
import type { CommandRegistry, PluginPatchApplicationRequest } from "@chemdraft/plugin-host";
import type { RegisteredCanvasOverlay } from "./types";

import type { PluginAppMenuItem } from "../appMenu";
import { safeLocalStorage } from "../appUpdates";
import { loadAutomaticPluginUpdates, listenForPluginUpdateSettings } from "../pluginUpdateSettings";
import {
  createPluginUpdateChecker, hasOfficialInstalledPlugin, installedPluginCatalogKey,
  schedulePluginUpdateAutoCheck, type CachedPluginUpdateResults, type TimedPluginUpdateCheckResult
} from "./pluginUpdateAutoCheck";
import { createPluginRuntime, type DesktopPluginRuntime, type ProposalDocumentTab } from "./createPluginRuntime";
import {
  PluginInstallError,
  PluginInstallErrorCodes,
  installPluginPackage,
  loadInstalledPlugins,
  uninstallPlugin,
  updateInstalledPluginPackage,
  type InstalledPluginCatalogEntry,
  type PluginPackageInspection
} from "./installPluginPackage";
import { pickPluginPackage, type PickedPluginPackage } from "./pickPluginPackage";
import { buildPluginMenuItems } from "./pluginMenuModel";
import { buildOfficialPluginMenuItems } from "./officialPluginMenus";
import { loadDisabledPluginIds, saveDisabledPluginIds } from "./pluginPreferences";
import { createTauriPluginStagingFs, isTauriHost, type PluginStagingFs } from "./pluginStagingFs";
import {
  checkForPluginUpdates,
  prepareOfficialPluginInstall,
  preparePluginUpdate,
  type PreparedOfficialPluginInstall,
  type PluginUpdateCheckResult,
  type PluginUpdateOffer,
  type PreparedPluginUpdate
} from "./pluginUpdates";
import { applyEnabledPlugins, registerBundledPlugins, type BundledPluginDescriptor } from "./registerBundledPlugins";
import type { OpenPluginPanel, PluginDiagnostic } from "./types";
import type { OpenPluginTextPrompt } from "./PluginPromptTextController";
import type { OpenPluginImageRequest } from "./PluginImageRequestController";
import type {
  OpenStructureRecognitionInstall,
  StructureRecognitionController,
  StructureRecognitionInstallRun
} from "./StructureRecognitionController";
import type { StructureRecognitionEngineStatus } from "./structureRecognitionEngine";
import { recognitionInstallProgressStore } from "./structureRecognitionInstallProgress";
import { mountStructureNamingHost, presentStructureNamingInstall } from "./StructureNamingInstallDialog";
import { presentExternalToolInstall } from "../externalTools/presentExternalToolInstall";
import type { RuntimeDialogPort } from "./runtimeDialogs";
import type { RuntimeDialogTarget } from "./runtimeDialogProtocol";

export { pluginCommandFailure } from "./pluginCommandFailure";

export interface PluginRuntimeProviders {
  pickPackage?: () => Promise<PickedPluginPackage | undefined>;
  imageSourceRegistry?: import("./ImageSourceProvider").ImageSourceRegistry;
  /** The document-local authority; the bootstrap binds it to messages, never to owner state. */
  documentPort?: import("./runtimeBrokerDocument").RuntimeDocumentPort;
  forwardUnboundCommand?: DesktopPluginRuntime["invokeCommand"];
  dataOnly?: boolean;
  captureAssistantRequest?: import("../assistant/AssistantToolsController").AssistantToolsControllerOptions["captureRequest"];
  assistantMcpEngine?: import("../assistant/assistantMcpEngine").AssistantMcpEngine;
  getActiveDocument: () => ChemDraftDocument | undefined;
  /** Identifies the working document for a plugin's `documents.applyPatch` (see
   *  `DesktopPluginRuntimeOptions.getActiveDocumentKey`). Without one, two documents created by
   *  File > New in one session are indistinguishable to the write-binding check. */
  getActiveDocumentKey?: () => string | undefined;
  getActiveDocumentTab?: () => Pick<ProposalDocumentTab, "id">;
  /** MainWindow's native dialog authority, when this is a desktop document window. */
  dialogPort?: (target?: RuntimeDialogTarget) => RuntimeDialogPort | undefined;
  getDocumentTabTitle?: (tabId: string) => string | undefined;
  /** `warnings`: the asking invocation's collector, or undefined for a read that should stay silent. */
  getSelection: (warnings?: string[]) => PluginSelectionSnapshot;
  /** The app's stable CommandRegistry: plugin commands register into the SAME registry core commands
   *  use (commands/coreCommandRegistrar), so one dispatch serves both. Must be referentially stable
   *  for the component's lifetime — the runtime is created exactly once from the first render. */
  commandRegistry?: CommandRegistry;
  /** Storage backend factory (the desktop passes the disk-backed one); defaults to in-memory. */
  createStorage?: (pluginId: string) => PluginStorage;
  /** Names the source of a successful name conversion in the document status line. */
  onNameResolutionStatus?: (text: string | undefined) => void;
  /** Quiet update notices use the document window status line. */
  onPluginUpdateStatus?: (text: string) => void;
  /** Fired whenever the proposed-patch queue changes (new, accepted, rejected). */
  onProposedPatchesChanged?: () => void;
  /** Commits a command-scoped `document.write` patch through the desktop document/history path. */
  applyDocumentPatch?: (
    request: PluginPatchApplicationRequest
  ) => AppliedPatchReceipt | Promise<AppliedPatchReceipt>;
}

export interface PluginRuntimeView {
  runtime: DesktopPluginRuntime;
  bundledPlugins: readonly BundledPluginDescriptor[];
  /** Plugins installed from a package (M36). Empty until the startup reload resolves, and always empty
   *  where installing is unsupported (no Tauri host). */
  installedPlugins: readonly InstalledPluginCatalogEntry[];
  /** True once the desktop's on-disk install catalog has finished its startup reload. Non-Tauri builds
   *  have no on-disk catalog and are ready immediately. */
  installedPluginCatalogReady: boolean;
  /** Show the native picker and describe the chosen package; `undefined` when this build cannot install. */
  pickPackage: (() => Promise<PickedPluginPackage | undefined>) | undefined;
  installPackage: ((inspection: PluginPackageInspection) => Promise<void>) | undefined;
  prepareOfficialPluginInstall: ((pluginId: string) => Promise<PreparedOfficialPluginInstall>) | undefined;
  uninstallInstalledPlugin: ((pluginId: string) => Promise<void>) | undefined;
  cachedPluginUpdateResults: readonly TimedPluginUpdateCheckResult[];
  checkInstalledPluginUpdates: (() => Promise<readonly PluginUpdateCheckResult[]>) | undefined;
  prepareInstalledPluginUpdate: ((offer: PluginUpdateOffer) => Promise<PreparedPluginUpdate>) | undefined;
  updateInstalledPlugin: ((prepared: PreparedPluginUpdate) => Promise<void>) | undefined;
  plugins: readonly PluginManifest[];
  pluginMenuItems: readonly PluginAppMenuItem[];
  canvasOverlays: readonly RegisteredCanvasOverlay[];
  openPanel: OpenPluginPanel | undefined;
  /** Desktop-native report windows: per plugin+panel id, several may float at once. */
  detachedPanels: readonly OpenPluginPanel[];
  openTextPrompt: OpenPluginTextPrompt | undefined;
  openImageRequest: OpenPluginImageRequest | undefined;
  openRecognitionInstall: OpenStructureRecognitionInstall | undefined;
  recognitionEngineStatus: StructureRecognitionEngineStatus | undefined;
  /** The running engine install, or the last one that stopped without installing. */
  recognitionEngineInstall: StructureRecognitionInstallRun | undefined;
  diagnostics: readonly PluginDiagnostic[];
  isPluginCommand: (commandId: string) => boolean;
  /** `selectionWarnings` collects the selection warnings of this invocation alone. */
  invokePluginCommand: (commandId: string, options?: { selectionWarnings?: string[]; input?: PluginCommandInput }) => Promise<unknown>;
  closePanel: () => void;
  submitTextPrompt: (id: number, value: string) => void;
  cancelTextPrompt: (id: number) => void;
  acquireImage: (id: number, source: PluginImageSource) => void;
  openImagePermissionSettings: (id: number) => void;
  refreshImagePermission: (id: number) => void;
  relaunchForImagePermission: (id: number) => void;
  cancelImageRequest: (id: number) => void;
  installRecognitionEngine: (id: number) => void;
  cancelRecognitionEngineInstall: (id: number) => void;
  declineRecognitionEngineInstall: (id: number) => void;
  refreshRecognitionEngineStatus: () => Promise<void>;
  /** Installs the engine in place, with progress in the plugin manager (no separate dialog). */
  startRecognitionEngineInstall: () => Promise<boolean>;
  cancelRunningRecognitionEngineInstall: () => Promise<void>;
  uninstallRecognitionEngine: () => Promise<void>;
  /** Cancel on the recognition progress indicator, which reads `runtime.recognition` itself. */
  cancelRecognition: (id: number) => void;
}


/** Application-lifetime owner. View subscriptions never own registrations, workers or controllers. */
export interface PluginRuntimeOwner {
  readonly runtime: DesktopPluginRuntime;
  read(): PluginRuntimeView;
  updateProviders(providers: PluginRuntimeProviders): void;
  subscribe(listener: () => void): () => void;
  start(): void;
  attachProgress(): () => void;
  dispose(): void;
  applyEnabled(disabledIds: readonly string[]): void;
  acknowledgePreparedProposal(proposalId: string): void;
}

export function createPluginRuntimeOwner(providers: PluginRuntimeProviders): PluginRuntimeOwner {
  const providersRef = { current: providers };
  const runtime = createPluginRuntime({
    convertNameToStructure: async request => {
      const result = await nameToStructureForPlugin(request);
      if (result.available && result.parsed) {
        const match = result.matchedName ?? result.matchedCas;
        providersRef.current.onNameResolutionStatus?.(`Name to Structure: ${result.source === "dictionary" ? `Wikidata dictionary (${match})` : result.engine.id === "chemdraft-templates" ? "built-in template" : "OPSIN"}.`);
      } else providersRef.current.onNameResolutionStatus?.(undefined);
      return result;
    },
    getActiveDocument: () => providersRef.current.getActiveDocument(),
    getActiveDocumentKey: providers.getActiveDocumentKey
      ? () => providersRef.current.getActiveDocumentKey?.()
      : undefined,
    getActiveDocumentTab: providers.getActiveDocumentTab
      ? () => providersRef.current.getActiveDocumentTab!()
      : undefined,
    getDocumentTabTitle: (tabId) => providersRef.current.getDocumentTabTitle?.(tabId),
    getSelection: (warnings) => providersRef.current.getSelection(warnings),
    // Read once at creation: the registry (and the other integration options) must be stable —
    // MainWindow creates the registry in a one-time memo, matching the runtime's lifetime.
    commandRegistry: providers.commandRegistry,
    createStorage: providers.createStorage,
    imageSourceRegistry: providers.imageSourceRegistry,
    onProposedPatchesChanged: () => { providersRef.current.onProposedPatchesChanged?.(); notify(); },
    applyDocumentPatch: (request) => {
      const apply = providersRef.current.applyDocumentPatch;
      if (!apply) {
        throw new Error("This desktop provides no direct plugin document-write path.");
      }
      return apply(request);
    },
    defaultPanelSurface: isTauriHost() ? "window" : "inApp",
    forwardUnboundCommand: providers.forwardUnboundCommand,
    captureAssistantRequest: providers.captureAssistantRequest,
    assistantMcpEngine: providers.assistantMcpEngine
  });
  const bundledPlugins = registerBundledPlugins(runtime);

  const listeners = new Set<() => void>();
  const stops: Array<() => void> = [];
  let started = false;
  let disposed = false;
  let installedPlugins: readonly InstalledPluginCatalogEntry[] = [];
  const stagingFs: PluginStagingFs | undefined = isTauriHost() ? createTauriPluginStagingFs() : undefined;
  let installedPluginCatalogReady = stagingFs === undefined;
  let updateCache: CachedPluginUpdateResults | undefined;
  let automaticUpdates = loadAutomaticPluginUpdates();
  let cancelAutomatic: (() => void) | undefined;
  const abort = new AbortController();
  const notify = () => { if (!disposed) for (const listener of listeners) listener(); };
  const updateChecker = createPluginUpdateChecker({
    check: checkForPluginUpdates, storage: safeLocalStorage(),
    onResults: cache => { updateCache = cache; notify(); },
    setStatus: text => providersRef.current.onPluginUpdateStatus?.(text)
  });
  const scheduleAutomatic = () => {
    cancelAutomatic?.();
    cancelAutomatic = undefined;
    if (!stagingFs || !installedPluginCatalogReady || !automaticUpdates || !hasOfficialInstalledPlugin(installedPlugins)) return;
    const catalog = installedPlugins;
    cancelAutomatic = schedulePluginUpdateAutoCheck(() => updateChecker.automatic({
      isDesktop: isTauriHost(), enabled: automaticUpdates && loadAutomaticPluginUpdates(),
      catalogReady: installedPluginCatalogReady, installed: catalog
    }, () => !disposed && automaticUpdates && loadAutomaticPluginUpdates() && installedPluginCatalogReady &&
      installedPluginCatalogKey(installedPlugins) === installedPluginCatalogKey(catalog)),
    () => updateChecker.nextAutomaticCheckDelay(catalog));
  };
  const setInstalledPlugins = (next: readonly InstalledPluginCatalogEntry[] | ((current: readonly InstalledPluginCatalogEntry[]) => readonly InstalledPluginCatalogEntry[])) => {
    installedPlugins = typeof next === "function" ? next(installedPlugins) : next;
    if (installedPluginCatalogReady) updateChecker.restore(installedPlugins);
    scheduleAutomatic();
    notify();
  };
  const pickPackage = providers.pickPackage ?? (() => pickPluginPackage());
  const prepareCatalogPluginInstall = (pluginId: string) => prepareOfficialPluginInstall(pluginId);
  const prepareInstalledPluginUpdate = (offer: PluginUpdateOffer) => preparePluginUpdate(offer);
  const checkInstalledPluginUpdates = () => updateChecker.check(installedPlugins);
  const installPackage = async (inspection: PluginPackageInspection): Promise<void> => {
    if (!stagingFs) return;
    const { record, descriptor } = await installPluginPackage({
      runtime,
      fs: stagingFs,
      inspection,
      replaces: bundledPlugins.find((candidate) => candidate.manifest.id === inspection.manifest.id)
    });
    // A fresh install (from the catalog or a package) is the user asking for this plugin, so it must
    // not inherit a disabled preference left by something that once had its id — the removed bundled
    // MolScribe canary shared org.chemdraft.ocsr.molscribe with the catalog plugin, and a user who had
    // disabled the canary got the new plugin back disabled after restart. Uninstall already clears it.
    // An update is different: that plugin is installed and its toggle is on screen, so its disabled
    // state is the user's current choice and `updateInstalledPlugin` preserves it.
    const disabled = loadDisabledPluginIds();
    if (disabled.delete(record.id)) {
      saveDisabledPluginIds(disabled);
    }
    setInstalledPlugins((current) => [
      ...current.filter((entry) => entry.record.id !== record.id),
      { record, manifest: descriptor.manifest, descriptor }
    ]);
  };
  const uninstallInstalledPlugin = async (pluginId: string): Promise<void> => {
    if (!stagingFs) return;
    const entry = installedPlugins.find((candidate) => candidate.record.id === pluginId);
    let cleanupError: PluginInstallError | undefined;
    try {
      await uninstallPlugin({
        runtime,
        fs: stagingFs,
        pluginId,
        record: entry?.record,
        descriptor: entry?.descriptor,
        // If this install had taken its id from a bundled plugin, give it back.
        restores: bundledPlugins.find((candidate) => candidate.manifest.id === pluginId),
        bundledPlugins,
        disabledIds: loadDisabledPluginIds()
      });
    } catch (error) {
      if (!(error instanceof PluginInstallError) || error.code !== PluginInstallErrorCodes.UninstallStorageDeleteFailed) {
        throw error;
      }
      // The runtime and disk catalog are already uninstalled; finish the UI cleanup as well.
      cleanupError = error;
    }
    // A plugin can be uninstalled while disabled; clear its preference too, so a later reinstall does
    // not silently arrive already-disabled from a stale id.
    const disabled = loadDisabledPluginIds();
    if (disabled.delete(pluginId)) {
      saveDisabledPluginIds(disabled);
    }
    setInstalledPlugins((current) => current.filter((candidate) => candidate.record.id !== pluginId));
    if (cleanupError) throw cleanupError;
  };
  const updateInstalledPlugin = async (prepared: PreparedPluginUpdate): Promise<void> => {
    if (!stagingFs) return;
    const current = installedPlugins.find((entry) => entry.record.id === prepared.offer.pluginId);
    if (!current) {
      throw new Error(`Plugin "${prepared.offer.pluginId}" is no longer installed. Check for updates again.`);
    }
    if (current.record.version !== prepared.offer.installedVersion) {
      throw new Error(
        `Plugin "${prepared.offer.pluginId}" changed from version ${prepared.offer.installedVersion} to ` +
          `${current.record.version}. Check for updates again.`
      );
    }
    const { record, descriptor } = await updateInstalledPluginPackage({
      runtime,
      fs: stagingFs,
      current,
      inspection: prepared.inspection,
      disabled: loadDisabledPluginIds().has(current.record.id),
      replaces: bundledPlugins.find((candidate) => candidate.manifest.id === current.record.id)
    });
    setInstalledPlugins((catalog) => [
      ...catalog.filter((entry) => entry.record.id !== record.id),
      { record, manifest: descriptor.manifest, descriptor }
    ]);
  };
  const isPluginCommand = (commandId: string) => runtime.host.commands.get(commandId)?.pluginId !== undefined;
  const invokePluginCommand = (commandId: string, options?: { selectionWarnings?: string[]; input?: PluginCommandInput }): Promise<unknown> =>
    providers.forwardUnboundCommand && runtime.host.commands.get(commandId)?.pluginId
      ? providers.forwardUnboundCommand(commandId, options) : runtime.invokeCommand(commandId, options);
  const closePanel = () => runtime.panels.closePanel();
  const submitTextPrompt = (id: number, value: string) => runtime.prompts.submit(id, value);
  const cancelTextPrompt = (id: number) => runtime.prompts.cancel(id);
  const acquireImage = (id: number, source: PluginImageSource) => void runtime.images.acquire(id, source);
  const openImagePermissionSettings = (id: number) => void runtime.images.openPermissionSettings(id);
  const refreshImagePermission = (id: number) => void runtime.images.refreshPermission(id);
  const relaunchForImagePermission = (id: number) => void runtime.images.relaunch(id);
  const cancelImageRequest = (id: number) => runtime.images.cancel(id);
  const installRecognitionEngine = (id: number) => void runtime.recognition.install(id);
  const cancelRecognitionEngineInstall = (id: number) => void runtime.recognition.cancel(id);
  const declineRecognitionEngineInstall = (id: number) => runtime.recognition.decline(id);
  const refreshRecognitionEngineStatus = async () => {
    await runtime.recognition.refreshStatus();
  };
  const startRecognitionEngineInstall = () => runtime.recognition.installEngine();
  const cancelRunningRecognitionEngineInstall = () => runtime.recognition.cancelEngineInstall();
  const uninstallRecognitionEngine = async () => {
    await runtime.recognition.uninstall();
  };
  const cancelRecognition = (id: number) => runtime.recognition.cancelRecognition(id);
  function read(): PluginRuntimeView {
    const plugins = runtime.host.listPlugins();
    const pluginMenuItems = [
      ...buildPluginMenuItems(runtime.host.listMenuContributions(), id => runtime.host.commands.get(id)?.enabled === true),
      ...buildOfficialPluginMenuItems(id => runtime.host.commands.get(id))
    ];
    const cache = updateCache;
    const cachedPluginUpdateResults = cache?.catalogKey === installedPluginCatalogKey(installedPlugins)
      ? cache.results.map(result => ({ ...result, checkedAt: cache.checkedAt })) : [];
    const openPanel = runtime.panels.getOpenPanel();
    const detachedPanels = runtime.panels.getDetachedPanels();
    const diagnostics = runtime.panels.getDiagnostics();
    const openTextPrompt = runtime.prompts.getOpenPrompt();
    const openImageRequest = runtime.images.getOpenRequest();
    const openRecognitionInstall = runtime.recognition.getOpenInstall();
    const recognitionEngineStatus = runtime.recognition.getStatus();
    const recognitionEngineInstall = runtime.recognition.getInstallRun();
    return {
      runtime,
      bundledPlugins,
      installedPlugins,
      installedPluginCatalogReady,
      // Absent (not merely inert) where staging is unsupported, so the manager can disable its control
      // rather than offer an install that would fail on click.
      pickPackage: stagingFs ? pickPackage : undefined,
      installPackage: stagingFs ? installPackage : undefined,
      prepareOfficialPluginInstall:
        stagingFs && installedPluginCatalogReady ? prepareCatalogPluginInstall : undefined,
      uninstallInstalledPlugin: stagingFs ? uninstallInstalledPlugin : undefined,
      cachedPluginUpdateResults,
      checkInstalledPluginUpdates:
        stagingFs && installedPluginCatalogReady ? checkInstalledPluginUpdates : undefined,
      prepareInstalledPluginUpdate:
        stagingFs && installedPluginCatalogReady ? prepareInstalledPluginUpdate : undefined,
      updateInstalledPlugin:
        stagingFs && installedPluginCatalogReady ? updateInstalledPlugin : undefined,
      plugins,
      pluginMenuItems,
      canvasOverlays: runtime.listCanvasOverlays(),
      openPanel,
      detachedPanels,
      openTextPrompt,
      openImageRequest,
      openRecognitionInstall,
      recognitionEngineStatus,
      recognitionEngineInstall,
      diagnostics,
      isPluginCommand,
      invokePluginCommand,
      closePanel,
      submitTextPrompt,
      cancelTextPrompt,
      acquireImage,
      openImagePermissionSettings,
      refreshImagePermission,
      relaunchForImagePermission,
      cancelImageRequest,
      installRecognitionEngine,
      cancelRecognitionEngineInstall,
      declineRecognitionEngineInstall,
      refreshRecognitionEngineStatus,
      startRecognitionEngineInstall,
      cancelRunningRecognitionEngineInstall,
      uninstallRecognitionEngine,
      cancelRecognition
    };
  }

  return {
    runtime, read,
    updateProviders: next => { providersRef.current = next; },
    acknowledgePreparedProposal(proposalId) {
      const token = runtime.host.reserveProposedPatchAcceptance(proposalId);
      runtime.host.settleProposedPatchAcceptance(proposalId, token, true);
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    applyEnabled: disabledIds => applyEnabledPlugins(runtime, new Set(disabledIds), [
      ...bundledPlugins.filter(b => !installedPlugins.some(i => i.record.id === b.manifest.id)),
      ...installedPlugins.map(i => i.descriptor ?? { manifest: i.manifest, options: { commandHandlers: {} } })
    ]),
    attachProgress: () => recognitionInstallProgressStore.connect(runtime.recognition),
    start() {
      if (started) return;
      if (disposed) throw new Error("The plugin runtime owner is closed.");
      started = true;
      stops.push(
        (providers.dataOnly ? presentStructureNamingInstall : mountStructureNamingHost)(runtime.naming, { coordinator: target => providersRef.current.dialogPort?.(target), documentTabId: () => providersRef.current.getActiveDocumentTab?.().id }),
        presentExternalToolInstall(runtime.externalTools, { coordinator: target => providersRef.current.dialogPort?.(target), documentTabId: () => providersRef.current.getActiveDocumentTab?.().id }),
        runtime.onDidChange(notify), runtime.panels.subscribe(notify),
        runtime.prompts.subscribe(notify), runtime.images.subscribe(notify),
        runtime.recognition.attachInstallPresenter()
      );
      let recognitionKey = recognitionViewKey(runtime.recognition);
      stops.push(runtime.recognition.subscribe(() => {
        const next = recognitionViewKey(runtime.recognition);
        if (next === recognitionKey) return;
        recognitionKey = next; notify();
      }));
      void listenForPluginUpdateSettings(enabled => {
        if (disposed) return;
        automaticUpdates = enabled; scheduleAutomatic();
      }).then(stop => { if (disposed) stop(); else stops.push(stop); })
        .catch(error => console.warn("Could not listen for plugin update preferences:", error));
      if (!stagingFs) return;
      void loadInstalledPlugins({ runtime, fs: stagingFs, disabledIds: loadDisabledPluginIds(), replacements: bundledPlugins, signal: abort.signal })
        .then(({ installed, failures }) => {
          if (disposed) {
            for (const entry of installed) {
              if (runtime.host.getPlugin(entry.record.id)) runtime.unregisterPlugin(entry.record.id);
              entry.descriptor?.deactivate?.();
            }
            return;
          }
          for (const failure of failures) runtime.panels.reportDiagnostic("installed-plugin-load-failed",
            'Installed plugin "'+failure.record.id+'" could not be loaded: '+failure.message);
          setInstalledPlugins(installed);
        }).catch(cause => {
          if (!disposed) runtime.panels.reportDiagnostic("installed-plugin-catalog-load-failed",
            'The installed-plugin catalog could not be loaded: '+(cause instanceof Error ? cause.message : String(cause)));
        }).finally(() => {
          if (disposed) return;
          installedPluginCatalogReady = true;
          updateChecker.restore(installedPlugins); scheduleAutomatic(); notify();
        });
    },
    dispose() {
      if (disposed) return;
      disposed = true; abort.abort(); cancelAutomatic?.();
      for (const stop of stops.splice(0)) stop();
      for (const entry of installedPlugins) entry.descriptor?.deactivate?.();
      for (const descriptor of bundledPlugins) descriptor.deactivate?.();
      for (const plugin of runtime.host.listPlugins()) runtime.unregisterPlugin(plugin.id);
      listeners.clear();
    }
  };
}
/**
 * Everything about recognition the UI renders from the shared version, minus what changes with every
 * progress event: the progress itself, phase timings, and the host's elapsed time and free-space
 * reading while it installs (the install is what consumes that space).
 */
function recognitionViewKey(recognition: StructureRecognitionController): string {
  const open = recognition.getOpenInstall();
  const status = recognition.getStatus();
  const run = recognition.getInstallRun();
  return JSON.stringify([
    open && {
      ...open,
      progress: undefined,
      startedAt: undefined,
      phaseStartedAt: undefined,
      status: statusKey(open.status)
    },
    status && statusKey(status),
    run && { running: run.running, startedAt: run.startedAt, error: run.error }
  ]);
}

function statusKey(status: StructureRecognitionEngineStatus): Partial<StructureRecognitionEngineStatus> {
  const { progress: _progress, installElapsedMs: _elapsed, ...rest } = status;
  return rest.state === "installing" ? { ...rest, freeDiskBytes: undefined } : rest;
}
