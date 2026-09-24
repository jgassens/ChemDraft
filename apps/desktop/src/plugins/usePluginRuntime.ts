import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type {
  AppliedPatchReceipt,
  PluginImageSource,
  PluginManifest,
  PluginSelectionSnapshot,
  PluginStorage
} from "@chemdraft/plugin-api";
import type { CommandRegistry, PluginPatchApplicationRequest } from "@chemdraft/plugin-host";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { PluginAppMenuItem } from "../appMenu";
import { createPluginRuntime, type DesktopPluginRuntime } from "./createPluginRuntime";
import {
  installPluginPackage,
  loadInstalledPlugins,
  uninstallPlugin,
  updateInstalledPluginPackage,
  type InstalledPluginCatalogEntry,
  type PluginPackageInspection
} from "./installPluginPackage";
import { pickPluginPackage, type PickedPluginPackage } from "./pickPluginPackage";
import { buildPluginMenuItems } from "./pluginMenuModel";
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
import { registerBundledPlugins, type BundledPluginDescriptor } from "./registerBundledPlugins";
import type { OpenPluginPanel, PluginDiagnostic } from "./types";
import type { OpenPluginTextPrompt } from "./PluginPromptTextController";
import type { OpenPluginImageRequest } from "./PluginImageRequestController";

/**
 * Extract a user-facing message from a resolved plugin-command value that is a `{ ok: false }`
 * PluginCommandResult (ADR-0010). Returns undefined for success/void results.
 */
export function pluginCommandFailure(result: unknown): string | undefined {
  if (result !== null && typeof result === "object" && "ok" in result && (result as { ok: unknown }).ok === false) {
    const error = (result as { error?: { message?: string; code?: string } }).error;
    return error?.message ?? error?.code ?? "unknown error";
  }
  return undefined;
}

export interface PluginRuntimeProviders {
  getActiveDocument: () => ChemDraftDocument | undefined;
  getSelection: () => PluginSelectionSnapshot;
  /** The app's stable CommandRegistry: plugin commands register into the SAME registry core commands
   *  use (commands/coreCommandRegistrar), so one dispatch serves both. Must be referentially stable
   *  for the component's lifetime — the runtime is created exactly once from the first render. */
  commandRegistry?: CommandRegistry;
  /** Storage backend factory (the desktop passes the disk-backed one); defaults to in-memory. */
  createStorage?: (pluginId: string) => PluginStorage;
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
  checkInstalledPluginUpdates: (() => Promise<readonly PluginUpdateCheckResult[]>) | undefined;
  prepareInstalledPluginUpdate: ((offer: PluginUpdateOffer) => Promise<PreparedPluginUpdate>) | undefined;
  updateInstalledPlugin: ((prepared: PreparedPluginUpdate) => Promise<void>) | undefined;
  plugins: readonly PluginManifest[];
  pluginMenuItems: readonly PluginAppMenuItem[];
  openPanel: OpenPluginPanel | undefined;
  /** Desktop-native report windows: per plugin+panel id, several may float at once. */
  detachedPanels: readonly OpenPluginPanel[];
  openTextPrompt: OpenPluginTextPrompt | undefined;
  openImageRequest: OpenPluginImageRequest | undefined;
  diagnostics: readonly PluginDiagnostic[];
  isPluginCommand: (commandId: string) => boolean;
  invokePluginCommand: (commandId: string) => Promise<unknown>;
  closePanel: () => void;
  submitTextPrompt: (id: number, value: string) => void;
  cancelTextPrompt: (id: number) => void;
  acquireImage: (id: number, source: PluginImageSource) => void;
  openImagePermissionSettings: (id: number) => void;
  refreshImagePermission: (id: number) => void;
  relaunchForImagePermission: (id: number) => void;
  cancelImageRequest: (id: number) => void;
}

/**
 * Owns the one persistent {@link DesktopPluginRuntime} for the desktop. The host is created (and its
 * bundled plugins registered) exactly once via a lazy ref; document/selection reach it through the
 * provider callbacks, so it is never rebuilt when the document, selection, page, viewport, or undo
 * history changes. React re-renders on host/panel changes via a subscription.
 */
export function usePluginRuntime(providers: PluginRuntimeProviders): PluginRuntimeView {
  const providersRef = useRef(providers);
  providersRef.current = providers;

  const ownerRef = useRef<{
    runtime: DesktopPluginRuntime;
    bundledPlugins: readonly BundledPluginDescriptor[];
  } | null>(null);
  if (ownerRef.current === null) {
    const runtime = createPluginRuntime({
      getActiveDocument: () => providersRef.current.getActiveDocument(),
      getSelection: () => providersRef.current.getSelection(),
      // Read once at creation: the registry (and the other integration options) must be stable —
      // MainWindow creates the registry in a one-time memo, matching the runtime's lifetime.
      commandRegistry: providers.commandRegistry,
      createStorage: providers.createStorage,
      onProposedPatchesChanged: () => providersRef.current.onProposedPatchesChanged?.(),
      applyDocumentPatch: (request) => {
        const apply = providersRef.current.applyDocumentPatch;
        if (!apply) {
          throw new Error("This desktop provides no direct plugin document-write path.");
        }
        return apply(request);
      },
      defaultPanelSurface: isTauriHost() ? "window" : "inApp"
    });
    const bundledPlugins = registerBundledPlugins(runtime);
    ownerRef.current = { runtime, bundledPlugins };
  }
  const { runtime, bundledPlugins } = ownerRef.current;

  const [version, bumpVersion] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const unsubscribeHost = runtime.host.subscribe(bumpVersion);
    const unsubscribePanels = runtime.panels.subscribe(bumpVersion);
    const unsubscribePrompts = runtime.prompts.subscribe(bumpVersion);
    const unsubscribeImages = runtime.images.subscribe(bumpVersion);
    return () => {
      unsubscribeHost();
      unsubscribePanels();
      unsubscribePrompts();
      unsubscribeImages();
    };
  }, [runtime]);

  // Installed plugins (M36). Staging is only reachable inside the Tauri webview, so a non-Tauri host
  // (the browser build, tests) simply has no staging filesystem and no install actions — which is what
  // leaves the manager's package control honestly disabled rather than failing when pressed.
  const stagingFs = useMemo<PluginStagingFs | undefined>(
    () => (isTauriHost() ? createTauriPluginStagingFs() : undefined),
    []
  );
  const [installedPlugins, setInstalledPlugins] = useState<readonly InstalledPluginCatalogEntry[]>([]);
  const [installedPluginCatalogReady, setInstalledPluginCatalogReady] = useState(stagingFs === undefined);
  /** Which effect invocation currently owns the installed-plugin registrations in the shared host.
   *  The host and runtime are created once and outlive every invocation, so under StrictMode two
   *  invocations register the *same ids* into the *same* host. Ownership is tracked explicitly
   *  because the registered plugin cannot be compared by identity (the host re-parses the manifest). */
  const installOwnerGenerationRef = useRef(0);

  useEffect(() => {
    if (!stagingFs) {
      return;
    }
    const generation = ++installOwnerGenerationRef.current;
    let cancelled = false;
    const abortController = new AbortController();
    let loaded: readonly InstalledPluginCatalogEntry[] = [];
    void (async () => {
      try {
        // Installs are reloaded asynchronously *after* the bundled plugins are already registered, so a
        // slow or broken install can never delay or block app startup.
        const { installed, failures } = await loadInstalledPlugins({
          runtime,
          fs: stagingFs,
          disabledIds: loadDisabledPluginIds(),
          replacements: bundledPlugins,
          signal: abortController.signal
        });
        loaded = installed;
        if (cancelled) {
          // Unregister by id ONLY while this invocation is still the owner. A later invocation
          // (StrictMode's second mount) registers the same ids into the same host, so an id match
          // alone would tear down *its* live registration and leave the plugin silently missing.
          // The worker this invocation started is always ours, so it is always deactivated.
          const superseded = installOwnerGenerationRef.current !== generation;
          for (const entry of installed) {
            if (!superseded && runtime.host.getPlugin(entry.record.id)) {
              runtime.unregisterPlugin(entry.record.id);
            }
            entry.descriptor?.deactivate?.();
          }
          return;
        }
        for (const failure of failures) {
          runtime.panels.reportDiagnostic(
            "installed-plugin-load-failed",
            `Installed plugin "${failure.record.id}" could not be loaded: ${failure.message}`
          );
        }
        setInstalledPlugins(installed);
      } catch (cause: unknown) {
        if (cancelled) return;
        runtime.panels.reportDiagnostic(
          "installed-plugin-catalog-load-failed",
          `The installed-plugin catalog could not be loaded: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        );
        setInstalledPlugins([]);
      } finally {
        if (!cancelled) {
          setInstalledPluginCatalogReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      abortController.abort();
      // Workers that completed startup before the cancellation are owned by this effect. Tear them
      // down so StrictMode cleanup or a real unmount cannot leave an orphan plugin running.
      for (const entry of loaded) {
        entry.descriptor?.deactivate?.();
      }
    };
  }, [bundledPlugins, runtime, stagingFs]);

  const pickPackage = useCallback(() => pickPluginPackage(), []);

  const installPackage = useCallback(
    async (inspection: PluginPackageInspection): Promise<void> => {
      if (!stagingFs) return;
      const { record, descriptor } = await installPluginPackage({
        runtime,
        fs: stagingFs,
        inspection,
        replaces: bundledPlugins.find((candidate) => candidate.manifest.id === inspection.manifest.id)
      });
      setInstalledPlugins((current) => [
        ...current.filter((entry) => entry.record.id !== record.id),
        { record, manifest: descriptor.manifest, descriptor }
      ]);
    },
    [bundledPlugins, runtime, stagingFs]
  );

  const uninstallInstalledPlugin = useCallback(
    async (pluginId: string): Promise<void> => {
      if (!stagingFs) return;
      const entry = installedPlugins.find((candidate) => candidate.record.id === pluginId);
      await uninstallPlugin({
        runtime,
        fs: stagingFs,
        pluginId,
        record: entry?.record,
        descriptor: entry?.descriptor,
        // If this install had taken its id from a bundled plugin, give it back.
        restores: bundledPlugins.find((candidate) => candidate.manifest.id === pluginId),
        disabledIds: loadDisabledPluginIds()
      });
      // A plugin can be uninstalled while disabled; clear its preference too, so a later reinstall does
      // not silently arrive already-disabled from a stale id.
      const disabled = loadDisabledPluginIds();
      if (disabled.delete(pluginId)) {
        saveDisabledPluginIds(disabled);
      }
      setInstalledPlugins((current) => current.filter((candidate) => candidate.record.id !== pluginId));
    },
    [bundledPlugins, installedPlugins, runtime, stagingFs]
  );

  const checkInstalledPluginUpdates = useCallback(
    (): Promise<readonly PluginUpdateCheckResult[]> => checkForPluginUpdates(installedPlugins),
    [installedPlugins]
  );

  const prepareInstalledPluginUpdate = useCallback(
    (offer: PluginUpdateOffer): Promise<PreparedPluginUpdate> => preparePluginUpdate(offer),
    []
  );

  const prepareCatalogPluginInstall = useCallback(
    (pluginId: string): Promise<PreparedOfficialPluginInstall> => prepareOfficialPluginInstall(pluginId),
    []
  );

  const updateInstalledPlugin = useCallback(
    async (prepared: PreparedPluginUpdate): Promise<void> => {
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
    },
    [bundledPlugins, installedPlugins, runtime, stagingFs]
  );

  const plugins = useMemo(() => runtime.host.listPlugins(), [runtime, version]);
  const pluginMenuItems = useMemo(
    () =>
      buildPluginMenuItems(
        runtime.host.listMenuContributions(),
        (commandId) => runtime.host.commands.get(commandId)?.enabled === true
      ),
    [runtime, version]
  );
  const openPanel = useMemo(() => runtime.panels.getOpenPanel(), [runtime, version]);
  const detachedPanels = useMemo(() => runtime.panels.getDetachedPanels(), [runtime, version]);
  const diagnostics = useMemo(() => runtime.panels.getDiagnostics(), [runtime, version]);
  const openTextPrompt = useMemo(() => runtime.prompts.getOpenPrompt(), [runtime, version]);
  const openImageRequest = useMemo(() => runtime.images.getOpenRequest(), [runtime, version]);

  // Ownership, not mere presence: the registry is SHARED with core commands now, so `has(id)` would
  // claim every core command too. A command is a plugin command iff a plugin registered it (the host
  // stamps `pluginId` onto definitions it registers from manifests).
  const isPluginCommand = useCallback(
    (commandId: string) => runtime.host.commands.get(commandId)?.pluginId !== undefined,
    [runtime]
  );
  const invokePluginCommand = useCallback(
    (commandId: string): Promise<unknown> => runtime.host.invokeCommand(commandId),
    [runtime]
  );
  const closePanel = useCallback(() => runtime.panels.closePanel(), [runtime]);
  const submitTextPrompt = useCallback((id: number, value: string) => runtime.prompts.submit(id, value), [runtime]);
  const cancelTextPrompt = useCallback((id: number) => runtime.prompts.cancel(id), [runtime]);
  const acquireImage = useCallback(
    (id: number, source: PluginImageSource) => void runtime.images.acquire(id, source),
    [runtime]
  );
  const openImagePermissionSettings = useCallback(
    (id: number) => void runtime.images.openPermissionSettings(id),
    [runtime]
  );
  const refreshImagePermission = useCallback(
    (id: number) => void runtime.images.refreshPermission(id),
    [runtime]
  );
  const relaunchForImagePermission = useCallback(
    (id: number) => void runtime.images.relaunch(id),
    [runtime]
  );
  const cancelImageRequest = useCallback((id: number) => runtime.images.cancel(id), [runtime]);

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
    checkInstalledPluginUpdates:
      stagingFs && installedPluginCatalogReady ? checkInstalledPluginUpdates : undefined,
    prepareInstalledPluginUpdate:
      stagingFs && installedPluginCatalogReady ? prepareInstalledPluginUpdate : undefined,
    updateInstalledPlugin:
      stagingFs && installedPluginCatalogReady ? updateInstalledPlugin : undefined,
    plugins,
    pluginMenuItems,
    openPanel,
    detachedPanels,
    openTextPrompt,
    openImageRequest,
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
    cancelImageRequest
  };
}
