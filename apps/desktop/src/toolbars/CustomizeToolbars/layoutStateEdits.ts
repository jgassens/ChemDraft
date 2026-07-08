import type {
  ToolsetDefinition,
  ToolsetGroupDefinition,
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
 * Invariant: **structural** edits (add/remove/move items, add groups) apply only to `user.*` toolsets;
 * core and plugin toolsets can only be *overridden* (visibility, title, order, hide, reorder) — cloning
 * a built-in toolset first (see {@link cloneToolset}) is how you get a structurally-editable copy.
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

/** Hide or show a single item (command or `widget.*` control id) within a toolset. */
export function setItemHidden<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string,
  itemId: string,
  hidden: boolean
): ToolsetLayoutState<I, A> {
  return withOverride(state, toolsetId, (draft) => {
    const current = new Set(draft.hiddenCommandIds ?? []);
    if (hidden) {
      current.add(itemId);
    } else {
      current.delete(itemId);
    }
    draft.hiddenCommandIds = current.size > 0 ? [...current] : undefined;
  });
}

/** Drop all overrides for one toolset (Reset Toolbar Layout), leaving user toolsets intact. */
export function resetToolsetLayout<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string
): ToolsetLayoutState<I, A> {
  return {
    ...state,
    toolsetOverrides: state.toolsetOverrides.filter((override) => override.toolsetId !== toolsetId)
  };
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
    ...group,
    id: group.id ?? `${id}.group.${index}`,
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
    clonedFromToolsetId: source.id,
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
  const next: ToolsetLayoutState<I, A> = {
    ...state,
    userToolsets: state.userToolsets.filter((toolset) => toolset.id !== toolsetId),
    toolsetOverrides: state.toolsetOverrides.filter((override) => override.toolsetId !== toolsetId)
  };
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
