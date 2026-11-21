import { hiddenToolsetItemIds, toolsetItemCustomizationId } from "@chemdraft/toolset-registry";
import type {
  ToolsetDefinition,
  ToolsetGroupDefinition,
  ToolsetItemDefinition,
  ToolsetLayoutState,
  UserToolsetDefinition,
  UserToolsetOverride
} from "@chemdraft/toolset-registry";

/**
 * Pure, side-effect-free edits over {@link ToolsetLayoutState}. Every function returns a NEW state
 * (never mutates its input) so the Customize Toolbars dialog can keep an undoable draft and only
 * commit (setLayoutState + save) on Apply. `applyToolsetLayoutState` in `@chemdraft/toolset-registry`
 * interprets the state these produce; keeping the two in lockstep is the invariant under test.
 *
 * Invariant: **full** structural edits (replace groups, add/remove groups) apply only to `user.*`
 * toolsets; core and plugin toolsets can only be *overridden* (visibility, title, order, hide,
 * reorder). The ONE exception is an add-only item *addition* ({@link addToolsetItemAddition}) — a
 * core toolset may gain a new command/spacer via `toolsetOverrides[].itemAdditions`, but its
 * manifest items are never mutated. Cloning a built-in toolset (see {@link cloneToolset}) is still
 * how you get a fully structurally-editable copy.
 *
 * Removing a manifest (built-in) item is an override too: it is hidden (`hiddenCommandIds`) and marked
 * in the top-level `removedToolsetItemIds`, so the dialog lists it under "Add command…" instead of
 * as an unchecked row. Its command is untouched — layout state never edits the command registry.
 */

export const USER_TOOLSET_ID_PREFIX = "user.";

export function emptyLayoutState<I extends string = string, A extends string = string>(): ToolsetLayoutState<I, A> {
  return { version: 1, toolsetOverrides: [], userToolsets: [] };
}

// ————————————————————————————————————————————————————————————————————————————————————————————————
// Override-based edits (apply to any toolset: core, plugin, or user)
// ————————————————————————————————————————————————————————————————————————————————————————————————

/** True when an override carries no actual customization (only its `toolsetId`), so it can be dropped. */
function isEmptyOverride(override: UserToolsetOverride): boolean {
  return (
    override.title === undefined &&
    override.visible === undefined &&
    override.mode === undefined &&
    override.preferredWindowSize === undefined &&
    override.gridLayout === undefined &&
    (override.groupOrder?.length ?? 0) === 0 &&
    (override.hiddenCommandIds?.length ?? 0) === 0 &&
    (override.itemOverrides?.length ?? 0) === 0 &&
    (override.itemAdditions?.length ?? 0) === 0 &&
    Object.keys(override.itemOrder ?? {}).length === 0
  );
}

/** Upsert the override for `toolsetId` by applying `mutate` to a copy of the current (or a fresh) one;
 *  an override that ends up empty is removed so the state stays minimal. */
function withOverride<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string,
  mutate: (draft: UserToolsetOverride) => void
): ToolsetLayoutState<I, A> {
  const current = state.toolsetOverrides.find((override) => override.toolsetId === toolsetId);
  const draft: UserToolsetOverride = current ? { ...current } : { toolsetId };
  mutate(draft);
  const others = state.toolsetOverrides.filter((override) => override.toolsetId !== toolsetId);
  return {
    ...state,
    toolsetOverrides: isEmptyOverride(draft) ? others : [...others, draft]
  };
}

/** Show or hide a toolset (persisted as `toolsetOverrides[].visible`). */
export function setToolsetVisible<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string,
  visible: boolean
): ToolsetLayoutState<I, A> {
  return withOverride(state, toolsetId, (draft) => {
    draft.visible = visible;
  });
}

/** Rename a toolset. An empty/blank title clears the override back to the manifest title. */
export function renameToolset<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string,
  title: string
): ToolsetLayoutState<I, A> {
  const trimmed = title.trim();
  return withOverride(state, toolsetId, (draft) => {
    draft.title = trimmed.length > 0 ? trimmed : undefined;
  });
}

/** Set the top-level toolset order (persisted as `toolsetOrder`). Empty clears it. */
export function reorderToolsets<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  orderedToolsetIds: readonly string[]
): ToolsetLayoutState<I, A> {
  const toolsetOrder = orderedToolsetIds.length > 0 ? [...orderedToolsetIds] : undefined;
  const next = { ...state };
  if (toolsetOrder) {
    next.toolsetOrder = toolsetOrder;
  } else {
    delete next.toolsetOrder;
  }
  return next;
}

/** Set the group order within a toolset. */
export function reorderGroups<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string,
  orderedGroupIds: readonly string[]
): ToolsetLayoutState<I, A> {
  return withOverride(state, toolsetId, (draft) => {
    draft.groupOrder = orderedGroupIds.length > 0 ? [...orderedGroupIds] : undefined;
  });
}

/** Set the item order within a group (item ids are command ids or `widget.*` control ids). */
export function reorderItems<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string,
  groupId: string,
  orderedItemIds: readonly string[]
): ToolsetLayoutState<I, A> {
  // applyUserToolsetOverride only honors itemOrder for groups with an id, so persisting an order for
  // an id-less group would write a dead, un-clearable override — no-op instead.
  if (groupId.length === 0) {
    return state;
  }
  return withOverride(state, toolsetId, (draft) => {
    const itemOrder = { ...(draft.itemOrder ?? {}) };
    if (orderedItemIds.length > 0) {
      itemOrder[groupId] = [...orderedItemIds];
    } else {
      delete itemOrder[groupId];
    }
    draft.itemOrder = Object.keys(itemOrder).length > 0 ? itemOrder : undefined;
  });
}

/** Add or drop `itemId` in the top-level removal marker for `toolsetId`, keeping the record minimal. */
function withRemovalMarker<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string,
  itemId: string,
  removed: boolean
): ToolsetLayoutState<I, A> {
  const current = state.removedToolsetItemIds?.[toolsetId] ?? [];
  if (current.includes(itemId) === removed) {
    return state;
  }
  const ids = removed ? [...current, itemId] : current.filter((id) => id !== itemId);
  const record = { ...(state.removedToolsetItemIds ?? {}) };
  if (ids.length > 0) {
    record[toolsetId] = ids;
  } else {
    delete record[toolsetId];
  }
  return withRemovedRecord(state, record);
}

function withRemovedRecord<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  record: Record<string, string[]>
): ToolsetLayoutState<I, A> {
  const next = { ...state };
  if (Object.keys(record).length > 0) {
    next.removedToolsetItemIds = record;
  } else {
    delete next.removedToolsetItemIds;
  }
  return next;
}

/** The built-in items the user removed from `toolsetId`. A marker counts only while its item is still
 *  hidden; a stale one (e.g. an older build re-showed the item) is ignored, so the item is listed. */
export function removedToolsetItemIds<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string
): Set<string> {
  const marked = state.removedToolsetItemIds?.[toolsetId] ?? [];
  if (marked.length === 0) {
    return new Set();
  }
  const hidden = hiddenToolsetItemIds(state.toolsetOverrides.find((override) => override.toolsetId === toolsetId));
  return new Set(marked.filter((id) => hidden.has(id)));
}

/** Hide or show a single item (command or `widget.*` control id) within a toolset. Showing an item
 *  also clears any removal marker, so a removed built-in item comes back as an ordinary row. */
export function setItemHidden<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string,
  itemId: string,
  hidden: boolean
): ToolsetLayoutState<I, A> {
  const base = hidden ? state : withRemovalMarker(state, toolsetId, itemId, false);
  return withOverride(base, toolsetId, (draft) => {
    const current = new Set(draft.hiddenCommandIds ?? []);
    if (hidden) {
      current.add(itemId);
    } else {
      current.delete(itemId);
    }
    draft.hiddenCommandIds = current.size > 0 ? [...current] : undefined;
    if (draft.itemOverrides?.some(override => override.commandId === itemId && override.hidden !== undefined)) {
      const overrides = draft.itemOverrides.flatMap(override => {
        if (override.commandId !== itemId) return [override];
        const { hidden: _, ...placementOverride } = override;
        return placementOverride.placement || placementOverride.layout ? [placementOverride] : [];
      });
      draft.itemOverrides = overrides.length > 0 ? overrides : undefined;
    }
  });
}

const SPACER_ID_PREFIX = "user.spacer.";
const SEPARATOR_ID_PREFIX = "user.separator.";

export function createCommandToolbarItem<I extends string, A extends string>({
  id,
  title,
  icon,
  assetName
}: { id: string; title: string; icon?: I; assetName?: A }): ToolsetItemDefinition<I, A> {
  return {
    id,
    kind: "button",
    label: title,
    icon,
    assetName,
    primary: { type: "command", commandId: id },
    submenu: null
  };
}

/** Add a new item (a gallery command, or a spacer) to ANY toolset — the one add-only structural
 *  edit permitted on core/plugin toolsets, persisted as `toolsetOverrides[].itemAdditions`. No-op
 *  when the item yields no customization id, the id is already present in the toolset
 *  (`options.presentItemIds`), or the id already sits among this override's additions. */
export function addToolsetItemAddition<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string,
  addition: { groupId: string; index?: number; item: ToolsetItemDefinition<I, A> },
  options: { presentItemIds?: ReadonlySet<string> } = {}
): ToolsetLayoutState<I, A> {
  const id = toolsetItemCustomizationId(addition.item);
  if (id === undefined || options.presentItemIds?.has(id)) {
    return state;
  }
  const current = state.toolsetOverrides.find((override) => override.toolsetId === toolsetId);
  const alreadyAdded = (current?.itemAdditions ?? []).some(
    (existing) => toolsetItemCustomizationId(existing.item as ToolsetItemDefinition<I, A>) === id
  );
  if (alreadyAdded) {
    return state;
  }
  return withOverride(state, toolsetId, (draft) => {
    draft.itemAdditions = [
      ...(draft.itemAdditions ?? []),
      { groupId: addition.groupId, index: addition.index, item: addition.item }
    ];
  });
}

/** Remove an item from a toolset. An id belonging to an addition is deleted outright (and scrubbed
 *  from itemOrder / hiddenCommandIds / itemOverrides so no dangling reference survives). A manifest
 *  (base) item is hidden and marked removed ({@link removedToolsetItemIds}); the manifest and the
 *  command registry are never changed, so Reset or "Add command…" brings it back. */
export function removeToolsetItem<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string,
  itemId: string
): ToolsetLayoutState<I, A> {
  const current = state.toolsetOverrides.find((override) => override.toolsetId === toolsetId);
  const isAddition = (current?.itemAdditions ?? []).some(
    (existing) => toolsetItemCustomizationId(existing.item as ToolsetItemDefinition<I, A>) === itemId
  );
  if (!isAddition) {
    return withRemovalMarker(setItemHidden(state, toolsetId, itemId, true), toolsetId, itemId, true);
  }
  return withOverride(state, toolsetId, (draft) => {
    const additions = (draft.itemAdditions ?? []).filter(
      (existing) => toolsetItemCustomizationId(existing.item as ToolsetItemDefinition<I, A>) !== itemId
    );
    draft.itemAdditions = additions.length > 0 ? additions : undefined;
    if (draft.hiddenCommandIds) {
      const hidden = draft.hiddenCommandIds.filter((id) => id !== itemId);
      draft.hiddenCommandIds = hidden.length > 0 ? hidden : undefined;
    }
    if (draft.itemOverrides) {
      const overrides = draft.itemOverrides.filter((itemOverride) => itemOverride.commandId !== itemId);
      draft.itemOverrides = overrides.length > 0 ? overrides : undefined;
    }
    if (draft.itemOrder) {
      const itemOrder: Record<string, string[]> = {};
      for (const [groupId, ids] of Object.entries(draft.itemOrder)) {
        const filtered = ids.filter((id) => id !== itemId);
        if (filtered.length > 0) {
          itemOrder[groupId] = filtered;
        }
      }
      draft.itemOrder = Object.keys(itemOrder).length > 0 ? itemOrder : undefined;
    }
  });
}

/** The next unused `<prefix><n>` id for a toolset, scanning both its existing additions and any
 *  itemOrder mentions so an id survives a remove-then-re-add without colliding with a live one. */
export function nextAdditionItemId<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string,
  prefix: string
): string {
  const override = state.toolsetOverrides.find((entry) => entry.toolsetId === toolsetId);
  let max = 0;
  const consider = (id: string | undefined) => {
    if (id && id.startsWith(prefix)) {
      const n = Number.parseInt(id.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) {
        max = n;
      }
    }
  };
  for (const addition of override?.itemAdditions ?? []) {
    consider(toolsetItemCustomizationId(addition.item as ToolsetItemDefinition<I, A>));
  }
  for (const ids of Object.values(override?.itemOrder ?? {})) {
    for (const id of ids) {
      consider(id);
    }
  }
  return `${prefix}${max + 1}`;
}

/** The next unused `user.spacer.<n>` id. */
export function nextSpacerItemId<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string
): string {
  return nextAdditionItemId(state, toolsetId, SPACER_ID_PREFIX);
}

/** The next unused `user.separator.<n>` id (a divider line). */
export function nextSeparatorItemId<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string
): string {
  return nextAdditionItemId(state, toolsetId, SEPARATOR_ID_PREFIX);
}

/** Drop all overrides for one toolset (Reset to Defaults): removed and hidden items return, additions
 *  go, and order, name and visibility revert to the manifest. Other toolsets and user toolsets'
 *  own groups are left intact. */
export function resetToolsetLayout<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string
): ToolsetLayoutState<I, A> {
  const { [toolsetId]: _removed, ...removed } = state.removedToolsetItemIds ?? {};
  return withRemovedRecord({
    ...state,
    toolsetOverrides: state.toolsetOverrides.filter((override) => override.toolsetId !== toolsetId)
  }, removed);
}

/** Drop ALL customization — overrides, order, and user toolsets (Reset All Toolbar Layouts). */
export function resetAllLayouts<I extends string, A extends string>(): ToolsetLayoutState<I, A> {
  return emptyLayoutState<I, A>();
}

// ————————————————————————————————————————————————————————————————————————————————————————————————
// User-toolset edits (structural — only `user.*` toolsets)
// ————————————————————————————————————————————————————————————————————————————————————————————————

/** Deterministic, unique `user.<slug>` id derived from a title, avoiding collisions with existing ids. */
export function userToolsetId(title: string, takenIds: ReadonlySet<string>): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = `${USER_TOOLSET_ID_PREFIX}${slug.length > 0 ? slug : "toolbar"}`;
  if (!takenIds.has(base)) {
    return base;
  }
  let suffix = 2;
  while (takenIds.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

/** Create an empty user toolset. */
export function createUserToolset<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  options: { title: string; id?: string }
): { state: ToolsetLayoutState<I, A>; toolsetId: string } {
  const takenIds = new Set([...state.userToolsets.map((toolset) => toolset.id)]);
  const id = options.id ?? userToolsetId(options.title, takenIds);
  const toolset: UserToolsetDefinition<I, A> = {
    id,
    title: options.title,
    source: "user",
    defaultVisible: true,
    defaultMode: "floating",
    groups: [{ id: `${id}.group`, items: [] }]
  };
  return { state: { ...state, userToolsets: [...state.userToolsets, toolset] }, toolsetId: id };
}

/** Clone any toolset definition into a structurally-editable `user.*` copy. */
export function cloneToolset<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  source: ToolsetDefinition<I, A>,
  options: { title?: string } = {}
): { state: ToolsetLayoutState<I, A>; toolsetId: string } {
  const title = options.title ?? `${source.title} Copy`;
  const takenIds = new Set([...state.userToolsets.map((toolset) => toolset.id)]);
  const id = userToolsetId(title, takenIds);
  const clonedGroups: ToolsetGroupDefinition<I, A>[] = source.groups.map((group, index) => ({
    id: group.id ?? `${id}.group.${index}`,
    title: group.title,
    items: group.items.map((item) => ({ ...item }))
  }));
  // A user toolset must have >=1 group (UserToolsetDefinitionSchema). Cloning a fully-emptied toolset
  // (e.g. all items hidden) would otherwise yield groups:[] and fail to parse; seed an empty group.
  const groups = clonedGroups.length > 0 ? clonedGroups : [{ id: `${id}.group`, items: [] }];
  const toolset: UserToolsetDefinition<I, A> = {
    id,
    title,
    source: "user",
    defaultVisible: true,
    defaultMode: source.defaultMode,
    preferredWindowSize: source.preferredWindowSize,
    gridLayout: source.gridLayout,
    category: source.category,
    // Keep the original definition available for rendering copies of a customized copy.
    clonedFromToolsetId: source.clonedFromToolsetId ?? source.id,
    groups
  };
  return { state: { ...state, userToolsets: [...state.userToolsets, toolset] }, toolsetId: id };
}

/** Delete a user toolset and scrub every reference to it (override, toolset order). No-op for a
 *  non-user id (core/plugin toolsets can't be deleted). */
export function deleteUserToolset<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string
): ToolsetLayoutState<I, A> {
  if (!state.userToolsets.some((toolset) => toolset.id === toolsetId)) {
    return state;
  }
  const { [toolsetId]: _removed, ...removed } = state.removedToolsetItemIds ?? {};
  const next = withRemovedRecord({
    ...state,
    userToolsets: state.userToolsets.filter((toolset) => toolset.id !== toolsetId),
    toolsetOverrides: state.toolsetOverrides.filter((override) => override.toolsetId !== toolsetId)
  }, removed);
  if (next.toolsetOrder) {
    const order = next.toolsetOrder.filter((id) => id !== toolsetId);
    if (order.length > 0) {
      next.toolsetOrder = order;
    } else {
      delete next.toolsetOrder;
    }
  }
  return next;
}

/** Replace a user toolset's groups (structural edits from the dialog build these). No-op for a
 *  non-user id — core/plugin toolsets take overrides only, never structural edits. */
export function setUserToolsetGroups<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string,
  groups: readonly ToolsetGroupDefinition<I, A>[]
): ToolsetLayoutState<I, A> {
  if (!toolsetId.startsWith(USER_TOOLSET_ID_PREFIX)) {
    return state;
  }
  return {
    ...state,
    userToolsets: state.userToolsets.map((toolset) =>
      toolset.id === toolsetId ? { ...toolset, groups: groups.map((group) => ({ ...group })) } : toolset
    )
  };
}
