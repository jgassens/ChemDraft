import {
  ToolsetRegistry,
  applyToolsetLayoutState,
  createToolbarsMenuModel,
  createToolsetToggleCommandDefinitions,
  normalizeToolsetDefinition,
  parseToolsetManifest,
  toolsetItemCustomizationId,
  type NormalizedToolsetItem,
  type NormalizedToolsetSubmenuItem,
  type ToolbarsMenuItem,
  type ToolsetDefinition,
  type ToolsetItemDefinition
} from "@chemdraft/toolset-registry";
import { detectShortcutPlatform, parseShortcutDisplay, type ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { isCompoundLayoutCommand, loadCompoundLayoutSettings } from "./compoundLayoutSettings";
import manifest from "./toolsets/desktop-toolsets.json";
import { migrateMainToolbarGroups, reconcileMainToolbarPluginHomes } from "./toolbars/toolbarLayoutState";
import { isMainToolbarGroupId, mainToolbarGroupMetadata, setMainToolbarPluginDefinition } from "./toolbars/mainToolbarGroups";
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

/** Filter only the displayed catalog; saved customization keeps disabled feature entries intact. */
export function compoundLayoutRegistry(registry: DesktopToolsetRegistry, enabled: boolean): DesktopToolsetRegistry {
  if (enabled) return registry;
  return new ToolsetRegistry<IconName, ToolbarAssetName>(registry.listToolsets().map((toolset): DesktopToolsetDefinition => ({
    ...toolset,
    groups: toolset.groups.map(group => ({
      ...group,
      items: group.items.filter(item => {
        const id = item.primary?.type === "command" ? item.primary.commandId : item.commandId ?? item.id;
        return !id || !isCompoundLayoutCommand(id);
      }).map(item => {
        const items = item.submenu?.items.filter(entry => !isCompoundLayoutCommand(entry.commandId));
        return { ...item, submenu: item.submenu && items?.length ? { ...item.submenu, items } : null };
      })
    }))
  })));
}

export function createDesktopToolsetRegistry(
  layoutState?: unknown,
  additionalCommandIds?: ReadonlySet<string>,
  // Plugin toolsets are contributed at runtime and are NOT baked into the static manifest. A detached
  // palette webview learns about them over the definitions IPC channel and passes them here so its
  // registry can resolve a plugin toolset window (instead of falling back to the Main toolbar). Empty
  // for the core-only case and every existing caller.
  pluginToolsets: readonly DesktopToolsetDefinition[] = []
): DesktopToolsetRegistry {
  const base = composeDesktopToolsets(pluginToolsets);
  const toolsets = layoutState === undefined || layoutState === null
    ? applyToolsetLayoutState(base, { version: 1, toolsetOverrides: [], userToolsets: [] })
    // Prune (not throw) so persisted customization referencing a since-removed command degrades
    // gracefully instead of discarding the whole layout; `additionalCommandIds` lets in-place-added
    // shell commands (e.g. edit.undo) count as valid targets so they aren't pruned as "unknown".
    : applyToolsetLayoutState<IconName, ToolbarAssetName>(
        base,
        reconcileMainToolbarPluginHomes(migrateLegacyMainToolbarLayoutState(layoutState), base.find(toolset => toolset.id === "core.main")!),
        {
          additionalCommandIds,
          onUnknownCommand: "prune"
        }
      );

  return new ToolsetRegistry<IconName, ToolbarAssetName>(toolsets);
}

/** Merge runtime main-button fragments before layout application; explicit plugin palettes stay intact. */
export function composeDesktopToolsets(pluginToolsets: readonly DesktopToolsetDefinition[]): DesktopToolsetDefinition[] {
  const main = desktopToolsets.find(toolset => toolset.id === "core.main")!;
  const groups = main.groups.map(group => ({ ...group, items: [...group.items] }));
  const seen = new Set(groups.flatMap(group => group.items.map(toolsetItemCustomizationId)));
  for (const fragment of pluginToolsets.filter(toolset => toolset.id === "core.main")) {
    for (const contribution of fragment.groups) {
      const id = contribution.id;
      if (!id || !isMainToolbarGroupId(id)) continue;
      let group = groups.find(candidate => candidate.id === id);
      for (const item of contribution.items) {
        const itemId = toolsetItemCustomizationId(item);
        if (!itemId || seen.has(itemId)) continue;
        seen.add(itemId);
        if (!group) {
          group = { ...mainToolbarGroupMetadata(id), items: [] };
          groups.push(group);
        }
        group.items.push(item);
      }
    }
  }
  const combinedMain = { ...main, groups };
  setMainToolbarPluginDefinition(combinedMain);
  return [...desktopToolsets.map(toolset => toolset.id === "core.main" ? combinedMain : toolset),
    ...pluginToolsets.filter(toolset => toolset.id !== "core.main")];
}

/** Compatibility entry point used by the persisted-layout loader. */
export function migrateLegacyMainToolbarLayoutState(state: unknown): unknown {
  return migrateMainToolbarGroups(migrateRenamedCommandIdsInLayoutState(state));
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
  label?: string;
  foldIcon?: string;
  foldCommandId?: string;
  foldRank?: number | null;
  items: ToolbarPaletteItemModel[];
}

export function getToolsetPaletteGroups(
  toolsetId: string,
  registry: DesktopToolsetRegistry = desktopToolsetRegistry,
  commandOverrides: ReadonlyMap<string, CommandSpec> = new Map(),
  layoutsEnabled = loadCompoundLayoutSettings().enabled
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
    label: group.label,
    foldIcon: group.foldIcon,
    foldCommandId: group.foldCommandId,
    foldRank: group.foldRank,
    items: group.items.filter(item => layoutsEnabled || (item.primary.type !== "command" || !isCompoundLayoutCommand(item.primary.commandId))).map((item) => {
      const commandId = item.primary.type === "command" ? item.primary.commandId : undefined;
      const isGeneratedLauncher = commandId?.startsWith("view.toolset.toggle.") === true;
      const isCustomCoreAddition = Boolean(shippedToolset) && !shippedItemIds.has(item.id);
      const model = toolsetItemToPaletteItem(
        item,
        commandOverrides,
        isGeneratedLauncher || isCustomCoreAddition
      );
      if (!layoutsEnabled && model.submenu) model.submenu.items = model.submenu.items.filter(command => !isCompoundLayoutCommand(command.id));
      return model;
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

/** Default cell/gap/padding metrics for the rendered tool palette grid. */
export const PALETTE_GRID_METRIC_DEFAULTS = {
  cellWidth: 28,
  cellHeight: 28,
  gap: 2,
  padding: 4
} as const;

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
  // The merged command wins over the manifest tooltip text: a keybinding-scheme remap (or a
  // plugin override) rewrites the command's shortcut while the manifest still carries the
  // ChemDraft-native key. An empty-string shortcut is the scheme's "unbound" sentinel — it
  // survives the `override ?? base` merges above, and normalizes to null here so tooltips show
  // no shortcut at all.
  const tooltipShortcut = (liveCommand
    ? liveCommand.shortcut ?? liveCommand.defaultShortcut ?? null
    : (primary.type === "command" ? primary.command.shortcut ?? primary.command.defaultShortcut ?? null : null)
      ?? item.tooltip.shortcut
      ?? null) || null;

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
      shortcutLabel:
        platformShortcutLabel(liveCommand?.shortcutLabel)
        ?? (primary.type === "command" ? platformShortcutLabel(primary.command.shortcutLabel) : null)
        ?? formatShortcutLabel(tooltipShortcut ?? undefined)
        ?? null
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
    shortcutLabel: formatShortcutLabel(shortcutText),
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

const MAC_SHORTCUT_GLYPHS = /[⌘⌥⇧⌃]/;

/**
 * Display label for a shortcut on the given platform. macOS keeps the compact glyph form
 * (`compactMacShortcutLabel`, unchanged); elsewhere shortcuts read "Ctrl+Alt+Shift+Key", with the
 * Mac-authored Cmd/Meta shown as Ctrl — the key the shortcut engine actually binds there.
 */
export function formatShortcutLabel(
  shortcut: string | undefined,
  platform: ShortcutPlatform = detectShortcutPlatform()
): string | undefined {
  if (platform === "macos") {
    return compactMacShortcutLabel(shortcut);
  }
  const parsed = parseShortcutLabelParts(shortcut);
  if (!parsed || parsed === "plain") {
    return parsed === "plain" ? shortcut?.trim() : undefined;
  }
  const { modifiers, key } = parsed;
  const labels = [
    modifiers.has("ctrl") || modifiers.has("cmd") ? "Ctrl" : "",
    modifiers.has("alt") ? "Alt" : "",
    modifiers.has("shift") ? "Shift" : ""
  ].filter((modifier) => modifier.length > 0);

  return labels.length > 0 ? [...labels, key].join("+") : shortcut?.trim();
}

const SHORTCUT_MODIFIER_ALIASES: Readonly<Record<string, "ctrl" | "cmd" | "alt" | "shift">> = {
  ctrl: "ctrl",
  control: "ctrl",
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  // The engine binds these to Command on macOS and Ctrl elsewhere (normalizeModifier).
  cmdorctrl: "cmd",
  mod: "cmd",
  alt: "alt",
  option: "alt",
  shift: "shift"
};

/**
 * A shortcut split the way the shortcut engine reads it (`parseShortcutDisplay`), so "Cmd++" is Cmd
 * plus the `+` key rather than a bare "Cmd". "plain" is a lone key, or text with no modifier and
 * one key, which both label functions show as written.
 */
function parseShortcutLabelParts(
  shortcut: string | undefined
): { modifiers: Set<"ctrl" | "cmd" | "alt" | "shift">; key: string } | "plain" | undefined {
  if (!shortcut || !shortcut.trim()) {
    return undefined;
  }
  const parts = parseShortcutDisplay(shortcut).map((part) => part.trim()).filter((part) => part.length > 0);
  const modifiers = new Set<"ctrl" | "cmd" | "alt" | "shift">();
  const keys: string[] = [];
  for (const part of parts) {
    const modifier = SHORTCUT_MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
    } else {
      keys.push(part);
    }
  }
  return modifiers.size > 0 && keys.length === 1 ? { modifiers, key: keys[0] } : "plain";
}

/**
 * An authored `shortcutLabel` as the platform should show it: macOS shows it as written; elsewhere a
 * hand-written Mac glyph label ("⌥⇧⌘L") is dropped so the caller falls back to a label formatted
 * from the shortcut itself.
 */
export function platformShortcutLabel(
  label: string | null | undefined,
  platform: ShortcutPlatform = detectShortcutPlatform()
): string | null {
  if (!label) {
    return null;
  }
  return platform !== "macos" && MAC_SHORTCUT_GLYPHS.test(label) ? null : label;
}

/**
 * The shortcut text to show for a command, wherever a command is displayed: its authored label when
 * the platform can show it, else its shortcut formatted for the platform. macOS keeps the raw
 * shortcut as its fallback, as it always has. `||` rather than `??`: an empty string is the
 * keybinding scheme's "unbound" sentinel and must fall through.
 */
export function commandShortcutDisplay(
  command: { shortcutLabel?: string | null; shortcut?: string | null; defaultShortcut?: string | null },
  platform: ShortcutPlatform = detectShortcutPlatform()
): string | undefined {
  const label = platformShortcutLabel(command.shortcutLabel || null, platform);
  if (label) {
    return label;
  }
  const raw = command.shortcut || command.defaultShortcut || undefined;
  return (platform === "macos" ? raw : formatShortcutLabel(raw, platform)) || undefined;
}

export function compactMacShortcutLabel(shortcut: string | undefined): string | undefined {
  const parsed = parseShortcutLabelParts(shortcut);
  if (!parsed || parsed === "plain") {
    return parsed === "plain" ? shortcut?.trim() : undefined;
  }
  const { modifiers, key } = parsed;
  // Mac convention orders modifiers ⌃⌥⇧⌘.
  const modifierLabel = [
    modifiers.has("ctrl") ? "⌃" : "",
    modifiers.has("alt") ? "⌥" : "",
    modifiers.has("shift") ? "⇧" : "",
    modifiers.has("cmd") ? "⌘" : ""
  ].join("");

  return `${modifierLabel}${key}`;
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
