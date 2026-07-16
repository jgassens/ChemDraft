import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type {
  PluginManifest,
  PluginSelectionSnapshot,
  PluginStorage,
  PluginToolsetContribution
} from "@chemdraft/plugin-api";
import { PluginHost, type CommandRegistry, type RegisterPluginOptions } from "@chemdraft/plugin-host";

import type { DesktopToolsetDefinition } from "../toolsets";
import { PluginPanelController } from "./PluginPanelController";

export interface DesktopPluginRuntimeOptions {
  /** Reads the current active document. Called on demand; must reflect the latest state. */
  getActiveDocument: () => ChemDraftDocument | undefined;
  /** Builds an immutable selection snapshot from current desktop state. */
  getSelection?: () => PluginSelectionSnapshot | undefined;
  /**
   * The app's stable CommandRegistry (see commands/coreCommandRegistrar). When supplied, plugin
   * commands register into the SAME registry core commands live in, so one `host.invokeCommand`
   * dispatches both — with the plugin's permission context when the command is plugin-owned.
   * Defaults to a host-private registry (tests, headless use).
   */
  commandRegistry?: CommandRegistry;
  /** Storage backend factory (the desktop passes the disk-backed one); defaults to in-memory. */
  createStorage?: (pluginId: string) => PluginStorage;
  /** Fired whenever the proposed-patch queue changes (new, accepted, rejected). */
  onProposedPatchesChanged?: () => void;
  /** Injectable clock (tests pass a fixed value); defaults to wall-clock. */
  now?: () => Date | string;
}

/**
 * The persistent desktop plugin runtime: one {@link PluginHost}, the panel controller that renders
 * its reports, and the toolset-contribution stage that turns `contributes.toolsets` into desktop
 * toolbar definitions. Create it once (see `usePluginRuntime`) and feed current document/selection
 * through the provider callbacks — never rebuild it when the document, selection, page, viewport, or
 * undo history changes.
 *
 * All desktop registration paths (bundled, installed, fixture) go through {@link registerPlugin} /
 * {@link unregisterPlugin} rather than the host directly, so toolset provenance stays accurate and
 * a bad contribution rolls the whole plugin back no matter how it arrived.
 */
export interface DesktopPluginRuntime {
  host: PluginHost;
  panels: PluginPanelController;
  /**
   * Register a plugin and stage its toolset contributions: `ui.toolbar` is enforced before any
   * toolbar surface exists, duplicate toolset ids across plugins are rejected, and any failure
   * unregisters the whole plugin so half-registered state can never leak into the catalog.
   * Provenance is tracked by explicit maps, never by sniffing id prefixes.
   */
  registerPlugin(candidate: unknown, options?: RegisterPluginOptions): PluginManifest;
  unregisterPlugin(pluginId: string): void;
  listPluginToolsets(): DesktopToolsetDefinition[];
  pluginIdForToolset(toolsetId: string): string | undefined;
  /** Notified when the plugin toolset set changes (register/unregister). Returns unsubscribe. */
  onDidChange(listener: () => void): () => void;
}

export function createPluginRuntime(options: DesktopPluginRuntimeOptions): DesktopPluginRuntime {
  const now = options.now ?? (() => new Date());
  const nowIso = (): string => {
    const value = now();
    return typeof value === "string" ? value : value.toISOString();
  };

  // The host and controller reference each other: the host forwards validated reports to the
  // controller, and the controller reads manifests back off the host. Close the loop with a
  // late-bound reference so neither construction depends on the other existing first.
  let controller: PluginPanelController | undefined;
  const host = new PluginHost({
    commandRegistry: options.commandRegistry,
    getActiveDocument: options.getActiveDocument,
    getSelection: options.getSelection,
    createStorage: options.createStorage,
    onProposedPatchesChanged: options.onProposedPatchesChanged,
    showPanelReport: (pluginId, panelId, report) => {
      controller?.showReport(pluginId, panelId, report);
    },
    now
  });
  controller = new PluginPanelController(host, nowIso);

  const toolsetsByPluginId = new Map<string, DesktopToolsetDefinition[]>();
  const pluginIdByToolsetId = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  return {
    host,
    panels: controller,
    registerPlugin(candidate, registerOptions = {}) {
      const { manifest } = host.registerPlugin(candidate, registerOptions);
      try {
        const contributed = manifest.contributes.toolsets;
        if (contributed.length > 0) {
          host.requirePermission(manifest.id, "ui.toolbar");
          for (const toolset of contributed) {
            if (pluginIdByToolsetId.has(toolset.id)) {
              throw new Error(`Plugin toolset "${toolset.id}" is already contributed by another plugin.`);
            }
          }
          const mapped = contributed.map(pluginToolsetToDefinition);
          toolsetsByPluginId.set(manifest.id, mapped);
          mapped.forEach((toolset) => pluginIdByToolsetId.set(toolset.id, manifest.id));
        }
      } catch (error) {
        // A bad toolset contribution rolls the WHOLE plugin back (commands included), so the
        // catalog can never observe a plugin that half-registered.
        host.unregisterPlugin(manifest.id);
        throw error;
      }
      notify();
      return manifest;
    },
    unregisterPlugin(pluginId) {
      host.unregisterPlugin(pluginId);
      (toolsetsByPluginId.get(pluginId) ?? []).forEach((toolset) => pluginIdByToolsetId.delete(toolset.id));
      toolsetsByPluginId.delete(pluginId);
      notify();
    },
    listPluginToolsets: () => [...toolsetsByPluginId.values()].flat(),
    pluginIdForToolset: (toolsetId) => pluginIdByToolsetId.get(toolsetId),
    onDidChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

function pluginToolsetToDefinition(contribution: PluginToolsetContribution): DesktopToolsetDefinition {
  return {
    id: contribution.id,
    title: contribution.title,
    source: "plugin",
    defaultVisible: contribution.defaultVisible,
    defaultMode: "floating",
    groups: contribution.groups.map((group) => ({
      id: group.id,
      title: group.title,
      items: group.items.map((item) => ({
        commandId: item.commandId,
        title: item.title,
        // Named fallback keeps the type honest; the real icon rides on iconDataUri.
        icon: "palette",
        iconDataUri: item.iconDataUri,
        shortcutDisplay: item.shortcutDisplay,
        category: "plugin"
      }))
    })),
    preferredWindowSize: contribution.preferredWindowSize
  };
}
