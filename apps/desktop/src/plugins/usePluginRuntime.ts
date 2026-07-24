import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { PluginManifest, PluginSelectionSnapshot, PluginStorage } from "@chemdraft/plugin-api";
import type { CommandRegistry } from "@chemdraft/plugin-host";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { PluginAppMenuItem } from "../appMenu";
import { createPluginRuntime, type DesktopPluginRuntime } from "./createPluginRuntime";
import {
  installPluginPackage,
  loadInstalledPlugins,
  uninstallPlugin,
  type InstalledPluginCatalogEntry,
  type PluginPackageInspection
} from "./installPluginPackage";
import { pickPluginPackage, type PickedPluginPackage } from "./pickPluginPackage";
import { buildPluginMenuItems } from "./pluginMenuModel";
import { loadDisabledPluginIds, saveDisabledPluginIds } from "./pluginPreferences";
import { createTauriPluginStagingFs, isTauriHost, type PluginStagingFs } from "./pluginStagingFs";
import { registerBundledPlugins, type BundledPluginDescriptor } from "./registerBundledPlugins";
import type { OpenPluginPanel, PluginDiagnostic } from "./types";

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
}

export interface PluginRuntimeView {
  runtime: DesktopPluginRuntime;
  bundledPlugins: readonly BundledPluginDescriptor[];
  /** Plugins installed from a package (M36). Empty until the startup reload resolves, and always empty
   *  where installing is unsupported (no Tauri host). */
  installedPlugins: readonly InstalledPluginCatalogEntry[];
  /** Show the native picker and describe the chosen package; `undefined` when this build cannot install. */
  pickPackage: (() => Promise<PickedPluginPackage | undefined>) | undefined;
  installPackage: ((inspection: PluginPackageInspection) => Promise<void>) | undefined;
  uninstallInstalledPlugin: ((pluginId: string) => Promise<void>) | undefined;
  plugins: readonly PluginManifest[];
  pluginMenuItems: readonly PluginAppMenuItem[];
  openPanel: OpenPluginPanel | undefined;
  /** Panels popped out into floating windows (ADR-0030): per-panelId, several may float at once. */
  detachedPanels: readonly OpenPluginPanel[];
  diagnostics: readonly PluginDiagnostic[];
  isPluginCommand: (commandId: string) => boolean;
  invokePluginCommand: (commandId: string) => Promise<unknown>;
  closePanel: () => void;
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
      onProposedPatchesChanged: () => providersRef.current.onProposedPatchesChanged?.()
    });
    const bundledPlugins = registerBundledPlugins(runtime);
    ownerRef.current = { runtime, bundledPlugins };
  }
  const { runtime, bundledPlugins } = ownerRef.current;

  const [version, bumpVersion] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const unsubscribeHost = runtime.host.subscribe(bumpVersion);
    const unsubscribePanels = runtime.panels.subscribe(bumpVersion);
    return () => {
      unsubscribeHost();
      unsubscribePanels();
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

  useEffect(() => {
    if (!stagingFs) {
      return;
    }
    let cancelled = false;
    const abortController = new AbortController();
    let loaded: readonly InstalledPluginCatalogEntry[] = [];
    void (async () => {
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
        for (const entry of installed) {
          if (runtime.host.getPlugin(entry.record.id)) {
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

  return {
    runtime,
    bundledPlugins,
    installedPlugins,
    // Absent (not merely inert) where staging is unsupported, so the manager can disable its control
    // rather than offer an install that would fail on click.
    pickPackage: stagingFs ? pickPackage : undefined,
    installPackage: stagingFs ? installPackage : undefined,
    uninstallInstalledPlugin: stagingFs ? uninstallInstalledPlugin : undefined,
    plugins,
    pluginMenuItems,
    openPanel,
    detachedPanels,
    diagnostics,
    isPluginCommand,
    invokePluginCommand,
    closePanel
  };
}
