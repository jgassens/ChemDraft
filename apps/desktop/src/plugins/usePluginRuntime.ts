import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { PluginManifest, PluginSelectionSnapshot } from "@chemdraft/plugin-api";
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
      getSelection: () => providersRef.current.getSelection()
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
    void (async () => {
      // Installs are reloaded asynchronously *after* the bundled plugins are already registered, so a
      // slow or broken install can never delay or block app startup.
      const { installed, failures } = await loadInstalledPlugins({
        runtime,
        fs: stagingFs,
        disabledIds: loadDisabledPluginIds()
      });
      if (cancelled) {
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
    };
  }, [runtime, stagingFs]);

  const pickPackage = useCallback(() => pickPluginPackage(), []);

  const installPackage = useCallback(
    async (inspection: PluginPackageInspection): Promise<void> => {
      if (!stagingFs) return;
      const { record, descriptor } = await installPluginPackage({ runtime, fs: stagingFs, inspection });
      setInstalledPlugins((current) => [
        ...current.filter((entry) => entry.record.id !== record.id),
        { record, manifest: descriptor.manifest, descriptor }
      ]);
    },
    [runtime, stagingFs]
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
    () => buildPluginMenuItems(runtime.host.listMenuContributions()),
    [runtime, version]
  );
  const openPanel = useMemo(() => runtime.panels.getOpenPanel(), [runtime, version]);
  const diagnostics = useMemo(() => runtime.panels.getDiagnostics(), [runtime, version]);

  const isPluginCommand = useCallback((commandId: string) => runtime.host.commands.has(commandId), [runtime]);
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
    diagnostics,
    isPluginCommand,
    invokePluginCommand,
    closePanel
  };
}
