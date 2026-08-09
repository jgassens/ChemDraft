import {
  ToolsetRegistry,
  applyToolsetLayoutState,
  createToolbarsMenuModel,
  createToolsetToggleCommandDefinitions,
  mergeToolsetItemAdditions,
  normalizeToolsetDefinition,
  parseToolsetManifest,
  toolsetItemCustomizationId,
  type NormalizedToolsetItem,
  type NormalizedToolsetSubmenuItem,
  type ToolbarsMenuItem,
  type ToolsetDefinition,
  type ToolsetGroupDefinition,
  type ToolsetItemAddition,
  type ToolsetItemDefinition
} from "@chemdraft/toolset-registry";
import manifest from "./toolsets/desktop-toolsets.json";
import { isGridWidgetItem, isToolbarWidgetItem } from "./toolbars/toolbarWidgets";
import type { CommandSpec } from "./commands";
import { renamedCommandId } from "./renamedCommands";
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
  additionalCommandIds?: ReadonlySet<string>,
  // Plugin toolsets are contributed at runtime and are NOT baked into the static manifest. A detached
  // palette webview learns about them over the definitions IPC channel and passes them here so its
  // registry can resolve a plugin toolset window (instead of falling back to the Main toolbar). Empty
  // for the core-only case and every existing caller.
  pluginToolsets: readonly DesktopToolsetDefinition[] = []
): DesktopToolsetRegistry {
  const base = pluginToolsets.length > 0 ? [...desktopToolsets, ...pluginToolsets] : desktopToolsets;
  const toolsets = layoutState === undefined || layoutState === null
    ? base
    // Prune (not throw) so persisted customization referencing a since-removed command degrades
    // gracefully instead of discarding the whole layout; `additionalCommandIds` lets in-place-added
    // shell commands (e.g. edit.undo) count as valid targets so they aren't pruned as "unknown".
    : applyToolsetLayoutState<IconName, ToolbarAssetName>(
        base,
        migrateLegacyMainToolbarLayoutState(migrateRenamedCommandIdsInLayoutState(layoutState)),
        {
          additionalCommandIds,
          onUnknownCommand: "prune"
        }
      );

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

const LEGACY_MAIN_DIVIDER_IDS = LEGACY_MAIN_GROUP_IDS.map((_, index) => `core.main.divider.${index + 1}`);

/** Reconstruct the old seven manifest groups from the flattened manifest's explicit divider
 *  boundaries. This keeps the migration aligned if a base item is added inside one section later. */
function legacyMainGroupsFromFlattenedManifest(): ToolsetGroupDefinition<IconName, ToolbarAssetName>[] {
  const mainItems = desktopToolsets
    .find((toolset) => toolset.id === "core.main")
    ?.groups.find((group) => group.id === MAIN_ITEMS_GROUP_ID)
    ?.items ?? [];
  let start = 0;
  return LEGACY_MAIN_GROUP_IDS.map((groupId, sectionIndex) => {
    const dividerId = LEGACY_MAIN_DIVIDER_IDS[sectionIndex];
    const dividerIndex = mainItems.findIndex(
      (item, itemIndex) => itemIndex >= start && toolsetItemCustomizationId(item) === dividerId
    );
    const end = dividerIndex >= 0 ? dividerIndex : mainItems.length;
    const group = { id: groupId, items: mainItems.slice(start, end) };
    start = dividerIndex >= 0 ? dividerIndex + 1 : end;
    return group;
  });
}

const LEGACY_MAIN_GROUPS = legacyMainGroupsFromFlattenedManifest();

/** `reorderById` semantics over ids: listed ids lead, then every unlisted id keeps source order. */
function reorderToolbarIds(ids: readonly string[], preferredOrder: unknown): string[] {
  if (!Array.isArray(preferredOrder)) {
    return [...ids];
  }
  const remaining = [...ids];
  const ordered: string[] = [];
  for (const candidate of preferredOrder) {
    if (typeof candidate !== "string") {
      continue;
    }
    const index = remaining.indexOf(candidate);
    if (index >= 0) {
      ordered.push(remaining.splice(index, 1)[0]);
    }
  }
  return [...ordered, ...remaining];
}

function legacyMainAddition(value: unknown): value is ToolsetItemAddition<string, string> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const addition = value as { groupId?: unknown; item?: unknown };
  return (
    typeof addition.groupId === "string" &&
    LEGACY_MAIN_GROUP_IDS.includes(addition.groupId) &&
    typeof addition.item === "object" &&
    addition.item !== null &&
    toolsetItemCustomizationId(addition.item as ToolsetItemDefinition<string, string>) !== undefined
  );
}

/**
 * Remap a persisted layout state written against the old 7-group Main toolbar onto the flattened
 * single-group manifest. The old effective section order (including a saved groupOrder), each
 * section's fully padded item order, explicit divider boundaries, and accepted additions are folded
 * into one complete order. Addition indices become absolute flattened positions. Anything
 * unrecognized passes through untouched; hides are id-based and need no migration. Pure and
 * idempotent — safe to run on every load.
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
    const rawAdditions = Array.isArray(override.itemAdditions) ? override.itemAdditions : [];
    const additions = rawAdditions.filter(legacyMainAddition);
    const itemOrder =
      typeof override.itemOrder === "object" && override.itemOrder !== null && !Array.isArray(override.itemOrder)
        ? (override.itemOrder as Record<string, unknown>)
        : {};
    const hasLegacyItemOrder = LEGACY_MAIN_GROUP_IDS.some((groupId) => Array.isArray(itemOrder[groupId]));
    const hasLegacyGroupOrder =
      Array.isArray(override.groupOrder) &&
      override.groupOrder.some((groupId) => typeof groupId === "string" && LEGACY_MAIN_GROUP_IDS.includes(groupId));
    if (additions.length === 0 && !hasLegacyItemOrder && !hasLegacyGroupOrder) {
      return entry;
    }

    changed = true;
    const next: Record<string, unknown> = { ...override };
    const groupsWithAdditions = mergeToolsetItemAdditions<string, string>(LEGACY_MAIN_GROUPS, additions);
    const orderedIdsByGroup = new Map(
      groupsWithAdditions.map((group) => [
        group.id ?? "",
        reorderToolbarIds(
          group.items
            .map((item) => toolsetItemCustomizationId(item))
            .filter((id): id is string => id !== undefined),
          group.id ? itemOrder[group.id] : undefined
        )
      ])
    );
    const orderedGroupIds = reorderToolbarIds(LEGACY_MAIN_GROUP_IDS, override.groupOrder);
    let flattenedOrder = orderedGroupIds.flatMap((groupId) => [
      ...(orderedIdsByGroup.get(groupId) ?? []),
      LEGACY_MAIN_DIVIDER_IDS[LEGACY_MAIN_GROUP_IDS.indexOf(groupId)]
    ]);
    // A mixed state may already carry a flattened preference alongside legacy keys. It is a global
    // order and therefore takes precedence after the legacy sections have been reconstructed.
    flattenedOrder = reorderToolbarIds(flattenedOrder, itemOrder[MAIN_ITEMS_GROUP_ID]);

    if (rawAdditions.length > 0) {
      next.itemAdditions = rawAdditions.map((additionEntry) => {
        if (!legacyMainAddition(additionEntry)) {
          return additionEntry;
        }
        const itemId = toolsetItemCustomizationId(additionEntry.item);
        const absoluteIndex = itemId === undefined ? -1 : flattenedOrder.indexOf(itemId);
        return {
          ...additionEntry,
          groupId: MAIN_ITEMS_GROUP_ID,
          ...(absoluteIndex >= 0 ? { index: absoluteIndex } : {})
        };
      });
    }
    const remainingItemOrder = Object.fromEntries(
      Object.entries(itemOrder).filter(([key]) => !LEGACY_MAIN_GROUP_IDS.includes(key) && key !== MAIN_ITEMS_GROUP_ID)
    );
    next.itemOrder = { ...remainingItemOrder, [MAIN_ITEMS_GROUP_ID]: flattenedOrder };
    delete next.groupOrder;
    return next;
  });
  return changed ? { ...record, toolsetOverrides } : state;
}

/**
 * Rewrite renamed command ids everywhere a persisted layout can address one: item order, hides,
 * per-item overrides, and additions (whose `item` carries its own command id). Pure and idempotent
 * — a state already using new ids is returned unchanged, and unknown ids pass through so the
 * existing prune-on-unknown behaviour still applies to genuinely removed commands.
 */
export function migrateRenamedCommandIdsInLayoutState(state: unknown): unknown {
  if (typeof state !== "object" || state === null) {
    return state;
  }
  const record = state as { toolsetOverrides?: unknown };
  if (!Array.isArray(record.toolsetOverrides)) {
    return state;
  }

  let changed = false;
  const remapId = (id: unknown): unknown => {
    const next = renamedCommandId(id);
    if (next === undefined) {
      return id;
    }
    changed = true;
    return next;
  };
  const remapIdList = (ids: unknown): unknown =>
    Array.isArray(ids) ? ids.map(remapId) : ids;

  const toolsetOverrides = record.toolsetOverrides.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return entry;
    }
    const override = entry as Record<string, unknown>;
    const next: Record<string, unknown> = { ...override };

    if (typeof override.itemOrder === "object" && override.itemOrder !== null && !Array.isArray(override.itemOrder)) {
      next.itemOrder = Object.fromEntries(
        Object.entries(override.itemOrder as Record<string, unknown>).map(([groupId, ids]) => [groupId, remapIdList(ids)])
      );
    }
    next.hiddenCommandIds = remapIdList(override.hiddenCommandIds);
    if (Array.isArray(override.itemOverrides)) {
      next.itemOverrides = override.itemOverrides.map((itemOverride) => {
        if (typeof itemOverride !== "object" || itemOverride === null) {
          return itemOverride;
        }
        const record = itemOverride as Record<string, unknown>;
        return { ...record, commandId: remapId(record.commandId) };
      });
    }
    if (Array.isArray(override.itemAdditions)) {
      next.itemAdditions = override.itemAdditions.map((addition) => {
        if (typeof addition !== "object" || addition === null) {
          return addition;
        }
        const record = addition as Record<string, unknown>;
        const item = record.item;
        if (typeof item !== "object" || item === null) {
          return addition;
        }
        const itemRecord = item as Record<string, unknown>;
        const nextItem: Record<string, unknown> = { ...itemRecord };
        // A toolset item can name its command directly and/or through its primary action.
        if (itemRecord.commandId !== undefined) {
          nextItem.commandId = remapId(itemRecord.commandId);
        }
        const primary = itemRecord.primary;
        if (typeof primary === "object" && primary !== null) {
          const primaryRecord = primary as Record<string, unknown>;
          if (primaryRecord.commandId !== undefined) {
            nextItem.primary = { ...primaryRecord, commandId: remapId(primaryRecord.commandId) };
          }
        }
        return { ...record, item: nextItem };
      });
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
  // Items absent from this core toolset's shipped definition are persisted custom additions. Their
  // stored item shell is placement only; visual/interactive command semantics must follow the live
  // CommandSpec (for example a renamed user-toolbar launcher or changing Undo availability).
  const shippedToolset = desktopToolsetRegistry.get(toolsetId);
  const shippedItemIds = new Set(
    shippedToolset
      ? normalizeToolsetDefinition(shippedToolset).groups
          .flatMap((group) => group.items.map((item) => item.id))
      : []
  );
  return normalizeToolsetDefinition(registry.require(toolsetId)).groups.map((group) => ({
    id: group.id,
    items: group.items.map((item) => {
      const commandId = item.primary.type === "command" ? item.primary.commandId : undefined;
      const isGeneratedLauncher = commandId?.startsWith("view.toolset.toggle.") === true;
      const isCustomCoreAddition = Boolean(shippedToolset) && !shippedItemIds.has(item.id);
      return toolsetItemToPaletteItem(
        item,
        commandOverrides,
        isGeneratedLauncher || isCustomCoreAddition
      );
    })
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
    // Span-less widgets render as appended sections (excluded from the grid math); a widget with
    // declared grid spans is a grid citizen and its cells count like any other item's.
    .filter((item) => !isToolbarWidgetItem(item) || isGridWidgetItem(item));
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
  commandOverrides: ReadonlyMap<string, CommandSpec> = new Map(),
  preferCommandPresentation = false
): ToolbarPaletteItemModel {
  const primary = item.primary.type === "command"
    ? {
        type: "command" as const,
        command: commandSpecForNormalizedItem(item, commandOverrides, preferCommandPresentation)
      }
    : item.primary.type === "control"
      ? { type: "control" as const, controlId: item.primary.controlId }
      : { type: "none" as const };
  const liveCommand = preferCommandPresentation && primary.type === "command"
    ? primary.command
    : undefined;
  const tooltipShortcut = liveCommand
    ? liveCommand.shortcut ?? liveCommand.defaultShortcut ?? null
    : item.tooltip.shortcut ?? (primary.type === "command" ? primary.command.shortcut : null) ?? null;

  return {
    id: item.id,
    kind: item.kind,
    label: liveCommand?.title ?? item.label,
    icon: liveCommand?.icon ?? item.icon as IconName | undefined,
    assetName: liveCommand ? liveCommand.assetName : item.assetName as ToolbarAssetName | undefined,
    iconDataUri: liveCommand ? undefined : item.iconDataUri,
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
      title: liveCommand?.title ?? item.tooltip.title,
      description: liveCommand ? liveCommand.description ?? null : item.tooltip.description ?? null,
      shortcut: tooltipShortcut,
      shortcutLabel: liveCommand?.shortcutLabel ?? compactMacShortcutLabel(tooltipShortcut ?? undefined) ?? null
    },
    layout: item.layout,
    disabledReason: liveCommand ? liveCommand.disabledReason : item.disabledReason,
    category: liveCommand ? liveCommand.category : item.category
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
  commandOverrides: ReadonlyMap<string, CommandSpec>,
  preferCommandPresentation = false
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
  return mergeToolsetCommandSpec(base, commandOverrides.get(item.primary.commandId), preferCommandPresentation);
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

function mergeToolsetCommandSpec(
  base: CommandSpec,
  override: CommandSpec | undefined,
  preferCommandPresentation = false
): CommandSpec {
  if (!override) {
    return base;
  }

  return {
    ...base,
    title: preferCommandPresentation ? override.title : base.title,
    icon: preferCommandPresentation ? override.icon : base.icon,
    // Asset choice is contextual presentation just like title/icon (the same layer command uses
    // different glyphs in Main vs Art). Only custom/generated launcher items opt into replacement.
    assetName: preferCommandPresentation ? override.assetName : base.assetName,
    enabled: override.enabled,
    disabledReason: override.disabledReason,
    description: preferCommandPresentation ? override.description : override.description ?? base.description,
    shortcut: preferCommandPresentation ? override.shortcut : override.shortcut ?? base.shortcut,
    shortcutLabel: preferCommandPresentation ? override.shortcutLabel : override.shortcutLabel ?? base.shortcutLabel,
    defaultShortcut: preferCommandPresentation ? override.defaultShortcut : override.defaultShortcut ?? base.defaultShortcut,
    source: override.source,
    category: preferCommandPresentation ? override.category : override.category ?? base.category
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
