import { ToolsetRegistry, applyToolsetLayoutState } from "@chemdraft/toolset-registry";
import { desktopToolsets, type DesktopToolsetDefinition, type DesktopToolsetRegistry } from "../toolsets";
import type { IconName } from "../icons";
import type { ToolbarAssetName } from "../toolbarAssets";

/**
 * The data brain for toolbars: it composes the effective toolset set from three inputs —
 * the core manifest, live plugin contributions, and the user's saved layout state — into
 * immutable ToolsetRegistry snapshots. Consumers (MainWindow's toolsetRegistry state, the
 * palettes, the menu model) follow `onDidChange` and read the latest `registry()`.
 *
 * Unknown commands in persisted layout state are pruned rather than thrown, so a layout
 * that references a since-removed plugin command degrades with a warning instead of
 * crashing startup.
 */
export interface ToolbarCatalog {
  registry(): DesktopToolsetRegistry;
  setPluginToolsets(toolsets: readonly DesktopToolsetDefinition[]): void;
  setLayoutState(state: unknown): void;
  warnings(): readonly string[];
  onDidChange(listener: () => void): () => void;
}

export function createToolbarCatalog(): ToolbarCatalog {
  let pluginToolsets: readonly DesktopToolsetDefinition[] = [];
  let layoutState: unknown;
  let warningList: readonly string[] = [];
  const listeners = new Set<() => void>();

  const build = (): DesktopToolsetRegistry => {
    const combined = [...desktopToolsets, ...pluginToolsets];
    if (layoutState === undefined || layoutState === null) {
      warningList = [];
      return new ToolsetRegistry<IconName, ToolbarAssetName>(combined);
    }

    const warnings: string[] = [];
    const applied = applyToolsetLayoutState<IconName, ToolbarAssetName>(combined, layoutState, {
      onUnknownCommand: "prune",
      onWarning: (warning) => warnings.push(warning)
    });
    warningList = warnings;
    return new ToolsetRegistry<IconName, ToolbarAssetName>(applied);
  };

  let snapshot = build();

  const rebuild = () => {
    snapshot = build();
    listeners.forEach((listener) => listener());
  };

  return {
    registry: () => snapshot,
    setPluginToolsets(toolsets) {
      pluginToolsets = [...toolsets];
      rebuild();
    },
    setLayoutState(state) {
      layoutState = state;
      rebuild();
    },
    warnings: () => warningList,
    onDidChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
