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
import { WIDGET_CONTROL_ID_PREFIX } from "./toolbars/toolbarWidgets";
import type { CommandSpec } from "./commands";
import type { IconName } from "./icons";
import type { ToolbarAssetName } from "./toolbarAssets";

export type DesktopToolsetDefinition = ToolsetDefinition<IconName, ToolbarAssetName>;
export type DesktopToolsetRegistry = ToolsetRegistry<IconName, ToolbarAssetName>;

export interface ToolbarPaletteItemModel {
  id: string;
  kind: "button" | "toggle" | "control" | "separator" | "spacer";
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

export function createDesktopToolsetRegistry(
  layoutState?: unknown,
  additionalCommandIds?: ReadonlySet<string>
): DesktopToolsetRegistry {
  const toolsets = layoutState === undefined || layoutState === null
    ? desktopToolsets
    // Prune (not throw) so persisted customization referencing a since-removed command degrades
    // gracefully instead of discarding the whole layout; `additionalCommandIds` lets in-place-added
    // shell commands (e.g. edit.undo) count as valid targets so they aren't pruned as "unknown".
    : applyToolsetLayoutState<IconName, ToolbarAssetName>(desktopToolsets, migrateLegacyMainToolbarLayoutState(layoutState), {
        additionalCommandIds,
        onUnknownCommand: "prune"
      });

  return new ToolsetRegistry<IconName, ToolbarAssetName>(toolsets);
}

/** The Main toolbar's original manifest groups, in display order — kept only so persisted state from
 *  before the flatten (commit that merged core.main into one "core.main.items" group) keeps applying. */
const LEGACY_MAIN_GROUP_IDS = [
  "core.main.selection",
  "core.main.structure",
  "core.main.arrows",
  "core.main.annotations",
  "core.main.orbitals-style",
  "core.main.layout",
  "core.main.style"
];

const MAIN_ITEMS_GROUP_ID = "core.main.items";

/**
 * Remap a persisted layout state written against the old 7-group Main toolbar onto the flattened
 * single-group manifest: item additions re-home to the one group, per-group item orders fold into a
 * single list (in old section order, so relative positions survive), and the now-meaningless
 * groupOrder drops. Anything unrecognized passes through untouched; hides are id-based and need no
 * migration. Pure and idempotent — safe to run on every load.
 */
export function migrateLegacyMainToolbarLayoutState(state: unknown): unknown {
  if (typeof state !== "object" || state === null) {
    return state;
  }
  const record = state as { toolsetOverrides?: unknown };
  if (!Array.isArray(record.toolsetOverrides)) {
    return state;
  }
  let changed = false;
  const toolsetOverrides = record.toolsetOverrides.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return entry;
    }
    const override = entry as Record<string, unknown>;
    if (override.toolsetId !== "core.main") {
      return entry;
    }
    const next: Record<string, unknown> = { ...override };
    if (Array.isArray(override.itemAdditions)) {
      next.itemAdditions = override.itemAdditions.map((additionEntry) => {
        if (typeof additionEntry !== "object" || additionEntry === null) {
          return additionEntry;
        }
        const addition = additionEntry as Record<string, unknown>;
        if (typeof addition.groupId === "string" && LEGACY_MAIN_GROUP_IDS.includes(addition.groupId)) {
          changed = true;
          return { ...addition, groupId: MAIN_ITEMS_GROUP_ID };
        }
        return additionEntry;
      });
    }
    const itemOrder = override.itemOrder;
    if (typeof itemOrder === "object" && itemOrder !== null && !Array.isArray(itemOrder)) {
      const orderRecord = itemOrder as Record<string, unknown>;
      const legacyKeys = LEGACY_MAIN_GROUP_IDS.filter((key) => Array.isArray(orderRecord[key]));
      if (legacyKeys.length > 0) {
        changed = true;
        const merged: unknown[] = Array.isArray(orderRecord[MAIN_ITEMS_GROUP_ID])
          ? [...(orderRecord[MAIN_ITEMS_GROUP_ID] as unknown[])]
          : [];
        for (const key of legacyKeys) {
          merged.push(...(orderRecord[key] as unknown[]));
        }
        const remaining = Object.fromEntries(
          Object.entries(orderRecord).filter(([key]) => !LEGACY_MAIN_GROUP_IDS.includes(key))
        );
        next.itemOrder = { ...remaining, [MAIN_ITEMS_GROUP_ID]: merged };
      }
    }
    if (Array.isArray(override.groupOrder)) {
      changed = true;
      delete next.groupOrder;
    }
    return next;
  });
  return changed ? { ...record, toolsetOverrides } : state;
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
  return paletteCommandGroupsFromItemGroups(getToolsetItemGroups(toolsetId, registry, commandOverrides));
}

/**
 * Project palette item-groups down to their primary command specs. Callers that already hold
 * `itemGroups` should use this instead of calling `getToolsetCommandGroups`, which would normalize
 * the whole toolset a second time.
 */
export function paletteCommandGroupsFromItemGroups(
  itemGroups: readonly (readonly ToolbarPaletteItemModel[])[]
): CommandSpec[][] {
  return itemGroups.map((group) =>
    group.flatMap((item) => (item.primary.type === "command" ? [item.primary.command] : []))
  );
}

/** A palette group model that keeps the group id (which `getToolsetItemGroups` drops). Customize
 *  mode needs the id because item-reorder edits are per-group. */
export interface ToolbarPaletteGroupModel {
  id?: string;
  items: ToolbarPaletteItemModel[];
}

export function getToolsetPaletteGroups(
  toolsetId: string,
  registry: DesktopToolsetRegistry = desktopToolsetRegistry,
  commandOverrides: ReadonlyMap<string, CommandSpec> = new Map()
): ToolbarPaletteGroupModel[] {
  return normalizeToolsetDefinition(registry.require(toolsetId)).groups.map((group) => ({
    id: group.id,
    items: group.items.map((item) => toolsetItemToPaletteItem(item, commandOverrides))
  }));
}

export function getToolsetItemGroups(
  toolsetId: string,
  registry: DesktopToolsetRegistry = desktopToolsetRegistry,
  commandOverrides: ReadonlyMap<string, CommandSpec> = new Map()
): ToolbarPaletteItemModel[][] {
  return getToolsetPaletteGroups(toolsetId, registry, commandOverrides).map((group) => group.items);
}

/**
 * Default cell/gap/padding metrics for a grid toolset, shared by the CSS grid style
 * (`toolPaletteGridStyle`) and the window auto-sizer (`computePaletteGridSize`) so the two can't
 * drift apart and mis-size the window against the rendered grid.
 */
export const PALETTE_GRID_METRIC_DEFAULTS = {
  cellWidth: 28,
  cellHeight: 28,
  gap: 2,
  padding: 4
} as const;

export function computePaletteGridSize(
  gridLayout: DesktopToolsetDefinition["gridLayout"] | undefined,
  itemGroups: readonly (readonly ToolbarPaletteItemModel[])[]
): { width: number; height: number } | undefined {
  if (!gridLayout) {
    return undefined;
  }

  const cellWidth = gridLayout.cellWidth ?? PALETTE_GRID_METRIC_DEFAULTS.cellWidth;
  const cellHeight = gridLayout.cellHeight ?? PALETTE_GRID_METRIC_DEFAULTS.cellHeight;
  const gap = gridLayout.gap ?? PALETTE_GRID_METRIC_DEFAULTS.gap;
  const padding = gridLayout.padding ?? PALETTE_GRID_METRIC_DEFAULTS.padding;
  // Section-widget items (`widget.`-prefixed `control` items) render as their own sections, not grid
  // slots, so they must not inflate the grid's column/row count (see ToolPalette's gridItemGroups
  // filter). Inline controls (other `control` items) DO occupy a slot and are sized normally.
  const placedItems = itemGroups
    .flat()
    .filter((item) => !(item.primary.type === "control" && item.primary.controlId.startsWith(WIDGET_CONTROL_ID_PREFIX)));
  const placedColumnCount = Math.max(
    0,
    ...placedItems
      .filter((item) => item.layout.column !== undefined)
      .map((item) => (item.layout.column ?? 0) + item.layout.colSpan)
  );
  const placedRowCount = Math.max(
    0,
    ...placedItems
      .filter((item) => item.layout.row !== undefined)
      .map((item) => (item.layout.row ?? 0) + item.layout.rowSpan)
  );
  const autoFlowCellCount = placedItems
    .filter((item) => item.layout.row === undefined || item.layout.column === undefined)
    .reduce((total, item) => total + item.layout.colSpan * item.layout.rowSpan, 0);

  // Columns: explicit, else derived from per-item placements, else derived from a fixed row count +
  // the auto-flow item count. That last case is what shipped toolsets use (rows set, no columns) —
  // without it this returned undefined and never sized anything.
  const columns = gridLayout.columns
    ?? (placedColumnCount > 0
      ? placedColumnCount
      : gridLayout.rows && autoFlowCellCount > 0
        ? Math.ceil(autoFlowCellCount / gridLayout.rows)
        : 0);
  if (columns <= 0) {
    return undefined;
  }

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
  const primaryCommands: CommandSpec[] = [];
  const submenuCommands: CommandSpec[] = [];
  for (const toolset of registry.listToolsets()) {
    for (const group of normalizeToolsetDefinition(toolset).groups) {
      for (const item of group.items) {
        const paletteItem = toolsetItemToPaletteItem(item);
        if (paletteItem.primary.type === "command") {
          primaryCommands.push(paletteItem.primary.command);
        }
        if (paletteItem.submenu) {
          submenuCommands.push(...paletteItem.submenu.items);
        }
      }
    }
  }
  // Primary specs first: under first-wins dedupe this stops a command's submenu occurrence (which
  // carries no category and no disabledReason/enabled=false) from shadowing its richer primary spec.
  return dedupeCommands([...primaryCommands, ...submenuCommands]);
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
    shortcut: item.tooltip?.shortcut ?? undefined,
    description: item.tooltip?.description ?? undefined
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
    description: item.tooltip.description ?? undefined,
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
  description,
  disabledReason,
  category
}: {
  commandId: string;
  title: string;
  icon?: string;
  assetName?: string;
  shortcut?: string | null;
  description?: string | null;
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
    description: description ?? undefined,
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
