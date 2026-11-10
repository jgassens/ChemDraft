import {
  MAIN_TOOLBAR_GROUP_IDS,
  ToolsetLayoutStateSchema,
  mergeToolsetItemAdditions,
  toolsetItemCustomizationId,
  type ToolsetItemAddition,
  type ToolsetItemDefinition,
  type ToolsetLayoutState,
  type ToolbarGroupId,
  type UserToolsetOverride
} from "@chemdraft/toolset-registry";
import {
  currentMainToolbarDefinition,
  isMainToolbarGroupId,
  isToolbarSpacingItem,
  mainToolbarDefinition,
  mainToolbarHomeGroupId,
  mainToolbarItems
} from "./mainToolbarGroups";

const EMPTY_LAYOUT_STATE: ToolsetLayoutState = { version: 1, toolsetOverrides: [], userToolsets: [] };

const LEGACY_GROUP_IDS = [
  "core.main.selection", "core.main.structure", "core.main.arrows", "core.main.annotations",
  "core.main.orbitals-style", "core.main.layout", "core.main.style"
];
const FLAT_GROUP_ID = "core.main.items";

/** Rehome only live plugin buttons. Absent plugins retain their saved slots and visibility.
 * The returned save is idempotent; rendering may prune unavailable commands without editing it. */
export function reconcileMainToolbarPluginHomes(state: unknown, definition = currentMainToolbarDefinition()): unknown {
  if (!ToolsetLayoutStateSchema.safeParse(state).success) return state;
  const saved = state as ToolsetLayoutState;
  const homes = new Map<string, string>();
  definition.groups.forEach(group => group.items.forEach(item => {
    const id = toolsetItemCustomizationId(item);
    if (id?.startsWith("plugin.") && group.id) homes.set(id, group.id);
  }));
  let changed = false;
  const toolsetOverrides = saved.toolsetOverrides.map(override => {
    if (override.toolsetId !== "core.main") return override;
    const itemOrder: Record<string, string[]> = {};
    const moves: [string, string][] = [];
    for (const [groupId, ids] of Object.entries(override.itemOrder ?? {})) {
      itemOrder[groupId] = ids.filter(id => {
        const home = homes.get(id);
        if (!home || home === groupId) return true;
        moves.push([id, home]);
        changed = true;
        return false;
      });
    }
    for (const [id, home] of moves) {
      const ids = itemOrder[home] ??= [];
      if (!ids.includes(id)) ids.push(id);
    }
    const itemAdditions = override.itemAdditions?.map(addition => {
      const home = homes.get(toolsetItemCustomizationId(addition.item) ?? "");
      if (!home || home === addition.groupId) return addition;
      changed = true;
      // The old index addressed a different group. Append once in the new home.
      return { ...addition, groupId: home, index: undefined };
    });
    const itemOverrides = override.itemOverrides?.map(item => {
      const home = homes.get(item.commandId);
      if (!home || !item.placement || home === item.placement.groupId) return item;
      changed = true;
      return { ...item, placement: { ...item.placement, groupId: home } };
    });
    return { ...override, itemOrder: override.itemOrder ? itemOrder : undefined, itemAdditions, itemOverrides };
  });
  return changed ? { ...saved, toolsetOverrides } : state;
}

function ordered<T>(items: readonly T[], ids: readonly string[] | undefined, idOf: (item: T) => string): T[] {
  const remaining = [...items];
  const result: T[] = [];
  for (const id of ids ?? []) {
    const index = remaining.findIndex(item => idOf(item) === id);
    if (index >= 0) result.push(remaining.splice(index, 1)[0]);
  }
  return [...result, ...remaining];
}

/** Reconstruct the two historical authored shapes to replay section-relative addition indices. */
function legacyGroups(flat: boolean) {
  const groups = mainToolbarDefinition.groups.map((group, index) => ({
    ...group, id: LEGACY_GROUP_IDS[index], items: [...group.items]
  }));
  const formula = mainToolbarItems.get("style.formulaText")!;
  const widget = mainToolbarItems.get("widget.core.mainStyleControls")!;
  groups[6].items = groups[6].items.filter(item => item !== formula && item !== widget);
  groups[6].items.push(widget);
  groups[4].items.push(formula);
  if (!flat) {
    // Arrange Selection was added after the historical seven-group layout.
    groups[5].items = groups[5].items.filter(item => !item.commandId?.startsWith("layout.arrange."));
    return groups;
  }
  return [{ id: FLAT_GROUP_ID, items: groups.flatMap((group, index) => [
    ...group.items,
    { id: `core.main.divider.${index + 1}`, kind: "separator" as const, primary: { type: "none" as const } }
  ]) }];
}

/** Pure, one-time migration. Persist the returned marker with the layout, including dismissal. */
export function migrateMainToolbarGroups(state: unknown): unknown {
  if (typeof state !== "object" || state === null) return state;
  const record = state as Partial<ToolsetLayoutState>;
  if (!Array.isArray(record.toolsetOverrides) || record.mainToolbarGroupsMigration?.version === 1) return state;
  // Leave invalid saves to the loader's schema error path rather than partially rewriting them.
  if (!ToolsetLayoutStateSchema.safeParse(state).success) return state;
  let noticePending = false;
  const toolsetOverrides = record.toolsetOverrides.map(override => {
    if (override?.toolsetId !== "core.main") return override;
    const orders = override.itemOrder ?? {};
    const oldShape = Object.keys(orders).some(id => !isMainToolbarGroupId(id)) ||
      override.groupOrder?.some(id => !isMainToolbarGroupId(id)) ||
      override.itemAdditions?.some(addition => !isMainToolbarGroupId(addition.groupId));
    const customized = oldShape || !!(override.hiddenCommandIds?.length || override.itemOverrides?.length ||
      override.itemAdditions?.length || Object.keys(orders).length || override.groupOrder?.length);
    // New grouped edits already have home-group keys; a visibility/title-only save needs no notice.
    const grouped = !oldShape && (Object.keys(orders).length > 0 || !!override.groupOrder?.length ||
      !!override.itemAdditions?.length || !!override.hiddenGroupIds?.length);
    if (!customized || grouped) return override;
    noticePending = true;
    const additions = override.itemAdditions ?? [];
    const spacingIds = new Set(additions.filter(addition => isToolbarSpacingItem(addition.item)).map(addition =>
      toolsetItemCustomizationId(addition.item)!
    ));
    const isSpacing = (id: string) => spacingIds.has(id) || /^core\.main\.divider\./.test(id) || /^user\.(spacer|separator)\./.test(id);
    const flat = Object.hasOwn(orders, FLAT_GROUP_ID) || additions.some(addition => addition.groupId === FLAT_GROUP_ID);
    const sources = ordered(mergeToolsetItemAdditions(legacyGroups(!!flat), additions), override.groupOrder, group => group.id ?? "");
    const ids: string[] = [];
    for (const group of sources) {
      const defaults = group.items.map(item => toolsetItemCustomizationId(item)!).filter(Boolean);
      const preferred = orders[group.id ?? ""] ?? [];
      // Unknown/plugin ids are retained even if their plugin is currently absent.
      ids.push(...ordered([...new Set([...defaults, ...preferred])], preferred, id => id));
    }
    ids.push(...Object.values(orders).flat(), ...(override.hiddenCommandIds ?? []),
      ...(override.itemOverrides ?? []).map(item => item.commandId),
      ...additions.map(addition => toolsetItemCustomizationId(addition.item)!).filter(Boolean));
    const uniqueIds = [...new Set(ids)].filter(id => !isSpacing(id));
    const itemOrder: Record<string, string[]> = {};
    for (const id of uniqueIds) (itemOrder[mainToolbarHomeGroupId(id)] ??= []).push(id);
    const itemAdditions: ToolsetItemAddition[] = [];
    for (const id of uniqueIds) {
      if (mainToolbarItems.has(id)) continue;
      const saved = additions.find(addition => toolsetItemCustomizationId(addition.item) === id);
      const item: ToolsetItemDefinition = saved?.item ?? { commandId: id };
      if (!isToolbarSpacingItem(item)) itemAdditions.push({
        groupId: mainToolbarHomeGroupId(id), index: itemOrder[mainToolbarHomeGroupId(id)].indexOf(id), item
      });
    }
    const itemOverrides = (override.itemOverrides ?? []).filter(item => !isSpacing(item.commandId)).map(item => ({
      ...item, placement: item.placement ? { ...item.placement, groupId: mainToolbarHomeGroupId(item.commandId) } : undefined
    }));
    // All 19 Arrange buttons were shown before grouping. Preserve that unless the user hid one.
    const hidden = new Set(override.hiddenCommandIds ?? []);
    for (const [id, item] of mainToolbarItems) {
      const existing = itemOverrides.find(entry => entry.commandId === id);
      if (item.defaultHidden && !hidden.has(id) && existing?.hidden !== true) {
        if (existing) existing.hidden = false;
        else itemOverrides.push({ commandId: id, hidden: false, placement: undefined });
      }
    }
    const firstHomes = sources.map(group => LEGACY_GROUP_IDS.indexOf(group.id ?? ""))
      .filter(index => index >= 0).map(index => MAIN_TOOLBAR_GROUP_IDS[index]);
    const groupOrder = [...new Set([...firstHomes, ...MAIN_TOOLBAR_GROUP_IDS])];
    return {
      ...override, groupOrder, itemOrder, itemAdditions, itemOverrides,
      hiddenCommandIds: (override.hiddenCommandIds ?? []).filter(id => !isSpacing(id))
    };
  });
  return { ...record, toolsetOverrides, mainToolbarGroupsMigration: { version: 1, noticePending } };
}

export function mainToolbarMigrationNoticePending(state: ToolsetLayoutState): boolean {
  return state.mainToolbarGroupsMigration?.noticePending === true;
}

export function dismissMainToolbarMigrationNotice<I extends string, A extends string>(state: ToolsetLayoutState<I, A>): ToolsetLayoutState<I, A> {
  return { ...state, mainToolbarGroupsMigration: { version: 1, noticePending: false } };
}

/** Reset affects Main only; keep the marker so an old layout is never migrated a second time. */
export function resetMainToolbarGroups<I extends string, A extends string>(state: ToolsetLayoutState<I, A>): ToolsetLayoutState<I, A> {
  return dismissMainToolbarMigrationNotice({ ...state, toolsetOverrides: state.toolsetOverrides.filter(entry => entry.toolsetId !== "core.main") });
}

export function setMainToolbarGroupHidden<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>, groupId: ToolbarGroupId, hidden: boolean
): ToolsetLayoutState<I, A> {
  const existing = state.toolsetOverrides.find(entry => entry.toolsetId === "core.main");
  const hiddenGroups = new Set(existing?.hiddenGroupIds ?? []);
  if (hidden) hiddenGroups.add(groupId); else hiddenGroups.delete(groupId);
  const next: UserToolsetOverride = { ...existing, toolsetId: "core.main", hiddenGroupIds: [...hiddenGroups] };
  return { ...state, toolsetOverrides: [...state.toolsetOverrides.filter(entry => entry.toolsetId !== "core.main"), next] };
}

/**
 * Record the current palette visibility as `toolsetOverrides[].visible`, merged onto any existing
 * layout state so opening/closing a palette doesn't clobber other customization (order, user
 * toolsets) that a later phase will store in the same file. Overrides for toolsets that aren't
 * currently known (e.g. a plugin toolset that isn't loaded right now) are preserved untouched.
 */
export function mergeVisibilityIntoLayoutState(
  existing: ToolsetLayoutState | undefined,
  allToolsetIds: readonly string[],
  visibleToolsetIds: ReadonlySet<string>
): ToolsetLayoutState {
  const base = existing ?? EMPTY_LAYOUT_STATE;
  const known = new Set(allToolsetIds);
  const overridesById = new Map(base.toolsetOverrides.map((override) => [override.toolsetId, override]));

  const updated = allToolsetIds.map((toolsetId) => ({
    ...overridesById.get(toolsetId),
    toolsetId,
    visible: visibleToolsetIds.has(toolsetId)
  }));
  const preserved = base.toolsetOverrides.filter((override) => !known.has(override.toolsetId));

  // Copy userToolsets rather than spread `base` by reference: when `existing` is undefined, `base`
  // is the module-level EMPTY_LAYOUT_STATE and spreading it would return its array, so a later
  // mutation of the result would corrupt the shared constant for every subsequent merge.
  return {
    ...base,
    version: 1,
    toolsetOverrides: [...preserved, ...updated],
    userToolsets: [...base.userToolsets],
    ...(base.toolsetOrder ? { toolsetOrder: [...base.toolsetOrder] } : {})
  };
}
