import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type {
  PluginManifest,
  PluginPanelReport,
  PluginSelectionSnapshot,
  PluginStorage,
  PluginToolsetContribution
} from "@chemdraft/plugin-api";
import { PluginHost, type CommandRegistry, type RegisterPluginOptions } from "@chemdraft/plugin-host";
import type { DesktopToolsetDefinition } from "../toolsets";

/**
 * Desktop wrapper around PluginHost. Plugins register commands into the SAME stable
 * CommandRegistry the app uses (see commands/coreCommandRegistrar) and contribute whole
 * toolsets that render exactly like core ones. Provenance is tracked by an explicit map,
 * never by sniffing id prefixes, and `ui.toolbar` is enforced before any toolbar surface
 * is created. A bad contribution rolls the whole plugin back so half-registered state can
 * never leak into the catalog.
 */
export interface DesktopPluginRuntime {
  host: PluginHost;
  registerPlugin(candidate: unknown, options?: RegisterPluginOptions): PluginManifest;
  unregisterPlugin(pluginId: string): void;
  listPluginToolsets(): DesktopToolsetDefinition[];
  pluginIdForToolset(toolsetId: string): string | undefined;
  onDidChange(listener: () => void): () => void;
}

export function createDesktopPluginRuntime(options: {
  commandRegistry: CommandRegistry;
  getActiveDocument(): ChemDraftDocument | undefined;
  getSelection?(): PluginSelectionSnapshot | undefined;
  createStorage?(pluginId: string): PluginStorage;
  showPanelReport?(pluginId: string, panelId: string, report: PluginPanelReport): void | Promise<void>;
  onProposedPatchesChanged?(): void;
}): DesktopPluginRuntime {
  const host = new PluginHost({
    commandRegistry: options.commandRegistry,
    getActiveDocument: options.getActiveDocument,
    getSelection: options.getSelection,
    createStorage: options.createStorage,
    showPanelReport: options.showPanelReport,
    onProposedPatchesChanged: options.onProposedPatchesChanged
  });
  const toolsetsByPluginId = new Map<string, DesktopToolsetDefinition[]>();
  const pluginIdByToolsetId = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  return {
    host,
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
