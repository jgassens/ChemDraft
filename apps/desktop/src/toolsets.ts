import {
  ToolsetRegistry,
  applyToolsetLayoutState,
  createToolbarsMenuModel,
  createToolsetToggleCommandDefinitions,
  normalizeToolsetDefinition,
  parseToolsetManifest,
  type NormalizedToolsetItem,
  type NormalizedToolsetSubmenuItem,
  type ToolbarsMenuItem,
  type ToolsetDefinition
} from "@chemdraft/toolset-registry";
import manifest from "./toolsets/desktop-toolsets.json";
import type { CommandSpec } from "./commands";
import type { IconName } from "./icons";
import type { ToolbarAssetName } from "./toolbarAssets";

export type DesktopToolsetDefinition = ToolsetDefinition<IconName, ToolbarAssetName>;
export type DesktopToolsetRegistry = ToolsetRegistry<IconName, ToolbarAssetName>;

export interface ToolbarPaletteItemModel {
  id: string;
  kind: "button" | "toggle" | "control" | "separator";
  label: string;
  icon?: IconName;
  assetName?: ToolbarAssetName;
  iconDataUri?: string;
  primary:
    | { type: "command"; command: CommandSpec }
    | { type: "control"; controlId: string }
    | { type: "none" };
  submenu: {
    type: "command-grid";
    id: string;
    title?: string;
    columns?: number;
    items: CommandSpec[];
  } | null;
  tooltip: {
    title: string;
    description?: string | null;
    shortcut?: string | null;
    shortcutLabel?: string | null;
  };
  layout: {
    groupId?: string;
    row?: number;
    column?: number;
    order?: number;
    colSpan: number;
    rowSpan: number;
  };
  disabledReason?: string;
  category?: string;
}

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
  registry: DesktopToolsetRegistry = desktopToolsetRegistry,
  commandOverrides: ReadonlyMap<string, CommandSpec> = new Map()
): CommandSpec[][] {
  return getToolsetItemGroups(toolsetId, registry, commandOverrides).map((group) =>
    group.flatMap((item) => item.primary.type === "command" ? [item.primary.command] : [])
  );
}

export function getToolsetItemGroups(
  toolsetId: string,
  registry: DesktopToolsetRegistry = desktopToolsetRegistry,
  commandOverrides: ReadonlyMap<string, CommandSpec> = new Map()
): ToolbarPaletteItemModel[][] {
  return normalizeToolsetDefinition(registry.require(toolsetId)).groups.map((group) =>
    group.items.map((item) => toolsetItemToPaletteItem(item, commandOverrides))
  );
}

export function computePaletteGridSize(
  gridLayout: DesktopToolsetDefinition["gridLayout"] | undefined,
  itemGroups: readonly (readonly ToolbarPaletteItemModel[])[]
): { width: number; height: number } | undefined {
  if (!gridLayout) {
    return undefined;
  }

  const cellWidth = gridLayout.cellWidth ?? 28;
  const cellHeight = gridLayout.cellHeight ?? 28;
  const gap = gridLayout.gap ?? 2;
  const padding = gridLayout.padding ?? 4;
  const placedItems = itemGroups.flat();
  const placedColumnCount = Math.max(
    0,
    ...placedItems
      .filter((item) => item.layout.column !== undefined)
      .map((item) => (item.layout.column ?? 0) + item.layout.colSpan)
  );
  const columns = gridLayout.columns ?? placedColumnCount;
  if (columns <= 0) {
    return undefined;
  }

  const placedRowCount = Math.max(
    0,
    ...placedItems
      .filter((item) => item.layout.row !== undefined)
      .map((item) => (item.layout.row ?? 0) + item.layout.rowSpan)
  );
  const autoFlowCellCount = placedItems
    .filter((item) => item.layout.row === undefined || item.layout.column === undefined)
    .reduce((total, item) => total + item.layout.colSpan * item.layout.rowSpan, 0);
  const autoFlowRows = autoFlowCellCount > 0 ? Math.ceil(autoFlowCellCount / columns) : 0;
  const rows = gridLayout.rows ?? Math.max(placedRowCount, autoFlowRows);
  if (rows <= 0) {
    return undefined;
  }

  return {
    width: padding * 2 + columns * cellWidth + Math.max(0, columns - 1) * gap,
    height: padding * 2 + rows * cellHeight + Math.max(0, rows - 1) * gap
  };
}

export function getToolsetCommandSpecs(
  registry: DesktopToolsetRegistry = desktopToolsetRegistry
): CommandSpec[] {
  return dedupeCommands(
    registry
      .listToolsets()
      .flatMap((toolset) =>
        normalizeToolsetDefinition(toolset).groups.flatMap((group) =>
          group.items.flatMap((item) => {
            const paletteItem = toolsetItemToPaletteItem(item);
            return [
              ...(paletteItem.primary.type === "command" ? [paletteItem.primary.command] : []),
              ...(paletteItem.submenu?.items ?? [])
            ];
          })
        )
      )
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
  return commandSpecFromManifest({
    commandId: item.commandId,
    title: item.title ?? item.label ?? item.commandId,
    icon: item.icon,
    assetName: item.assetName,
    shortcut: item.shortcutDisplay,
    disabledReason: item.disabledReason,
    category: item.category
  });
}

export function toolsetItemToPaletteItem(
  item: NormalizedToolsetItem,
  commandOverrides: ReadonlyMap<string, CommandSpec> = new Map()
): ToolbarPaletteItemModel {
  const primary = item.primary.type === "command"
    ? {
        type: "command" as const,
        command: commandSpecForNormalizedItem(item, commandOverrides)
      }
    : item.primary.type === "control"
      ? { type: "control" as const, controlId: item.primary.controlId }
      : { type: "none" as const };
  const tooltipShortcut = item.tooltip.shortcut ?? (primary.type === "command" ? primary.command.shortcut : null) ?? null;

  return {
    id: item.id,
    kind: item.kind,
    label: item.label,
    icon: item.icon as IconName | undefined,
    assetName: item.assetName as ToolbarAssetName | undefined,
    iconDataUri: item.iconDataUri,
    primary,
    submenu: item.submenu
      ? {
          type: item.submenu.type,
          id: item.submenu.id ?? `${item.id}.submenu`,
          title: item.submenu.title,
          columns: item.submenu.columns,
          items: item.submenu.items.map((submenuItem) => submenuItemToCommandSpec(submenuItem, commandOverrides))
        }
      : null,
    tooltip: {
      title: item.tooltip.title,
      description: item.tooltip.description ?? null,
      shortcut: tooltipShortcut,
      shortcutLabel: compactMacShortcutLabel(tooltipShortcut ?? undefined) ?? null
    },
    layout: item.layout,
    disabledReason: item.disabledReason,
    category: item.category
  };
}

export function submenuItemToCommandSpec(
  item: NormalizedToolsetSubmenuItem,
  commandOverrides: ReadonlyMap<string, CommandSpec> = new Map()
): CommandSpec {
  const base = commandSpecFromManifest({
    commandId: item.commandId,
    title: item.label,
    icon: item.icon,
    assetName: item.assetName,
    shortcut: item.tooltip?.shortcut ?? undefined
  });
  return mergeToolsetCommandSpec(base, commandOverrides.get(item.commandId));
}

function commandSpecForNormalizedItem(
  item: NormalizedToolsetItem,
  commandOverrides: ReadonlyMap<string, CommandSpec>
): CommandSpec {
  if (item.primary.type !== "command") {
    throw new Error(`Toolset item "${item.id}" has no command primary.`);
  }
  const base = commandSpecFromManifest({
    commandId: item.primary.commandId,
    title: item.title ?? item.label,
    icon: item.icon,
    assetName: item.assetName,
    shortcut: item.shortcutDisplay ?? item.tooltip.shortcut ?? undefined,
    disabledReason: item.disabledReason,
    category: item.category
  });
  return mergeToolsetCommandSpec(base, commandOverrides.get(item.primary.commandId));
}

function commandSpecFromManifest({
  commandId,
  title,
  icon,
  assetName,
  shortcut,
  disabledReason,
  category
}: {
  commandId: string;
  title: string;
  icon?: string;
  assetName?: string;
  shortcut?: string | null;
  disabledReason?: string;
  category?: string;
}): CommandSpec {
  const shortcutText = shortcut ?? undefined;
  return {
    id: commandId,
    title,
    icon: (icon ?? "palette") as IconName,
    assetName: assetName as ToolbarAssetName | undefined,
    shortcut: shortcutText,
    shortcutLabel: compactMacShortcutLabel(shortcutText),
    defaultShortcut: shortcutText,
    disabledReason,
    category,
    description: `${title} toolset action`,
    source: commandId.startsWith("plugin.") ? "plugin" : "core",
    enabled: disabledReason ? false : true
  };
}

function mergeToolsetCommandSpec(base: CommandSpec, override: CommandSpec | undefined): CommandSpec {
  if (!override) {
    return base;
  }

  return {
    ...base,
    assetName: override.assetName ?? base.assetName,
    enabled: override.enabled,
    disabledReason: override.disabledReason,
    description: override.description ?? base.description,
    shortcut: override.shortcut ?? base.shortcut,
    shortcutLabel: override.shortcutLabel ?? base.shortcutLabel,
    defaultShortcut: override.defaultShortcut ?? base.defaultShortcut,
    source: override.source,
    category: override.category ?? base.category
  };
}

function compactMacShortcutLabel(shortcut: string | undefined): string | undefined {
  if (!shortcut) {
    return undefined;
  }

  const trimmed = shortcut.trim();
  if (!trimmed.includes("+") || trimmed === "+") {
    return trimmed;
  }

  const parts = trimmed.split("+").map((part) => part.trim()).filter((part) => part.length > 0);
  const lowerParts = new Set(parts.map((part) => part.toLowerCase()));
  const key = parts.find((part) => !["cmd", "command", "ctrl", "control", "shift", "alt", "option", "meta"].includes(part.toLowerCase()));
  const modifierLabel = [
    lowerParts.has("alt") || lowerParts.has("option") ? "⌥" : "",
    lowerParts.has("shift") ? "⇧" : "",
    lowerParts.has("cmd") || lowerParts.has("command") || lowerParts.has("meta") ? "⌘" : "",
    lowerParts.has("ctrl") || lowerParts.has("control") ? "⌃" : ""
  ].join("");

  return modifierLabel.length > 0 && key ? `${modifierLabel}${key}` : trimmed;
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
