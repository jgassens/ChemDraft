import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { PluginManifest, PluginSelectionSnapshot } from "@chemdraft/plugin-api";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import type { PluginAppMenuItem } from "../appMenu";
import { createPluginRuntime, type DesktopPluginRuntime } from "./createPluginRuntime";
import { buildPluginMenuItems } from "./pluginMenuModel";
import { registerBundledPlugins } from "./registerBundledPlugins";
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

  const runtimeRef = useRef<DesktopPluginRuntime | null>(null);
  if (runtimeRef.current === null) {
    const runtime = createPluginRuntime({
      getActiveDocument: () => providersRef.current.getActiveDocument(),
      getSelection: () => providersRef.current.getSelection()
    });
    registerBundledPlugins(runtime);
    runtimeRef.current = runtime;
  }
  const runtime = runtimeRef.current;

  const [version, bumpVersion] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const unsubscribeHost = runtime.host.subscribe(bumpVersion);
    const unsubscribePanels = runtime.panels.subscribe(bumpVersion);
    return () => {
      unsubscribeHost();
      unsubscribePanels();
    };
  }, [runtime]);

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
    plugins,
    pluginMenuItems,
    openPanel,
    diagnostics,
    isPluginCommand,
    invokePluginCommand,
    closePanel
  };
}
