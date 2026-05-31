import {
  ToolsetRegistry,
  applyToolsetLayoutState,
  createToolbarsMenuModel,
  createToolsetToggleCommandDefinitions,
  parseToolsetManifest,
  type ToolbarsMenuItem,
  type ToolsetDefinition
} from "@chemdraft/toolset-registry";
import manifest from "./toolsets/desktop-toolsets.json";
import type { CommandSpec } from "./commands";
import type { IconName } from "./icons";
import type { ToolbarAssetName } from "./toolbarAssets";

export type DesktopToolsetDefinition = ToolsetDefinition<IconName, ToolbarAssetName>;
export type DesktopToolsetRegistry = ToolsetRegistry<IconName, ToolbarAssetName>;

export const desktopToolsets = parseToolsetManifest<IconName, ToolbarAssetName>(manifest);
export const desktopToolsetRegistry = createDesktopToolsetRegistry();
export const defaultVisibleToolsetIds = createDefaultVisibleToolsetIds(desktopToolsetRegistry);

export function createDesktopToolsetRegistry(layoutState?: unknown): DesktopToolsetRegistry {
  const toolsets = layoutState === undefined || layoutState === null
    ? desktopToolsets
    : applyToolsetLayoutState<IconName, ToolbarAssetName>(desktopToolsets, layoutState);

  return new ToolsetRegistry<IconName, ToolbarAssetName>(toolsets);
}

export function createDefaultVisibleToolsetIds(
  registry: DesktopToolsetRegistry = desktopToolsetRegistry
): Set<string> {
  return new Set(registry.listDefaultVisibleToolsets().map((toolset) => toolset.id));
}

export function getToolsetCommandGroups(
  toolsetId: string,
  registry: DesktopToolsetRegistry = desktopToolsetRegistry
): CommandSpec[][] {
  return registry.require(toolsetId).groups.map((group) => group.items.map(toolsetItemToCommandSpec));
}

export function getToolsetCommandSpecs(
  registry: DesktopToolsetRegistry = desktopToolsetRegistry
): CommandSpec[] {
  return dedupeCommands(
    registry
      .listToolsets()
      .flatMap((toolset) => toolset.groups.flatMap((group) => group.items.map(toolsetItemToCommandSpec)))
  );
}

export function getToolsetToggleActions(
  registry: DesktopToolsetRegistry = desktopToolsetRegistry
): CommandSpec[] {
  return createToolsetToggleCommandDefinitions(registry.listToolsets()).map((command) => ({
    id: command.id,
    title: command.title,
    icon: "palette",
    source: command.source === "plugin" ? "plugin" : "core",
    category: command.category,
    description: `Show or hide ${command.title.replace(/^Toggle /, "")}`
  }));
}

export function getToolbarsMenuModel(
  visibleToolsetIds: ReadonlySet<string> = defaultVisibleToolsetIds,
  registry: DesktopToolsetRegistry = desktopToolsetRegistry
): ToolbarsMenuItem[] {
  return createToolbarsMenuModel(registry.listToolsets(), visibleToolsetIds);
}

export function isDisabledPlaceholderCommand(command: CommandSpec): boolean {
  return command.enabled === false && Boolean(command.disabledReason);
}

function toolsetItemToCommandSpec(item: DesktopToolsetDefinition["groups"][number]["items"][number]): CommandSpec {
  return {
    id: item.commandId,
    title: item.title ?? item.commandId,
    icon: item.icon ?? "palette",
    assetName: item.assetName,
    shortcut: item.shortcutDisplay,
    defaultShortcut: item.shortcutDisplay,
    disabledReason: item.disabledReason,
    category: item.category,
    description: `${item.title ?? item.commandId} toolset action`,
    source: item.commandId.startsWith("plugin.") ? "plugin" : "core",
    enabled: item.disabledReason ? false : true
  };
}

function dedupeCommands(commands: CommandSpec[]): CommandSpec[] {
  const byId = new Map<string, CommandSpec>();
  commands.forEach((command) => {
    if (!byId.has(command.id)) {
      byId.set(command.id, command);
    }
  });

  return [...byId.values()];
}
