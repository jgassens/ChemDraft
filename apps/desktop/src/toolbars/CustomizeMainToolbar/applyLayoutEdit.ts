import type { ToolsetItemDefinition, ToolsetLayoutState } from "@chemdraft/toolset-registry";
import type { ToolsetLayoutEditPayload } from "../../window-manager";
import {
  addToolsetItemAddition,
  nextSeparatorItemId,
  nextSpacerItemId,
  removeToolsetItem,
  reorderItems,
  resetToolsetLayout,
  setItemHidden
} from "../CustomizeToolbars/layoutStateEdits";

/** True when the toolset's override currently hides this id (so re-adding it should un-hide rather
 *  than create a duplicate addition — a removed base command/widget was only hidden, not deleted). */
function isHiddenByOverride<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string,
  id: string
): boolean {
  const override = state.toolsetOverrides.find((entry) => entry.toolsetId === toolsetId);
  return (override?.hiddenCommandIds ?? []).includes(id);
}

/** Persist the drop position as a complete order over the authoritative, currently rendered group.
 *  Addition indices are replay metadata; an explicit itemOrder keeps a new or re-shown item at the
 *  exact requested slot even when the group had already been reordered. */
function placeItemAtIndex<I extends string, A extends string>(
  state: ToolsetLayoutState<I, A>,
  toolsetId: string,
  groupId: string,
  itemId: string,
  index: number,
  orderedItemIdsByGroup: ReadonlyMap<string, readonly string[]> | undefined
): ToolsetLayoutState<I, A> {
  const currentIds = orderedItemIdsByGroup?.get(groupId);
  if (!currentIds) {
    return state;
  }
  const withoutItem = currentIds.filter((id) => id !== itemId);
  const clampedIndex = Math.max(0, Math.min(index, withoutItem.length));
  const orderedItemIds = [...withoutItem];
  orderedItemIds.splice(clampedIndex, 0, itemId);
  return reorderItems(state, toolsetId, groupId, orderedItemIds);
}

export interface ApplyToolsetLayoutEditContext {
  /** Customization ids currently present in the toolset — used to no-op a duplicate add. */
  presentItemIds: ReadonlySet<string>;
  /** Authoritative visible item order for each group before this edit. Used to persist an add/re-add
   *  at its requested drop position instead of letting an older itemOrder append or relocate it. */
  orderedItemIdsByGroup?: ReadonlyMap<string, readonly string[]>;
  /** Resolve a command id to its title (from the command catalog). Returns undefined for an unknown
   *  command, which makes an addCommand a no-op — the gallery only surfaces real commands. */
  commandTitle: (commandId: string) => string | undefined;
  /** Resolve a command id to its icon name / toolbar asset, so an added command renders with its real
   *  glyph instead of the generic fallback. Optional — a missing icon just falls back. */
  commandIcon?: (commandId: string) => string | undefined;
  commandAssetName?: (commandId: string) => string | undefined;
  /** Resolve a widget id to its human title (for the control item's label / dialog rows). Optional. */
  widgetTitle?: (widgetId: string) => string | undefined;
  /** Grid spans for a widget being (re)added as a grid citizen; undefined → appended section. */
  widgetLayout?: (widgetId: string) => { colSpan: number; rowSpan: number } | undefined;
  /** Rows in the toolset's grid (core.main = 2), so a spacer spans a full column. */
  gridRows?: number;
}

/**
 * Apply one in-place customize edit to the layout state. The single funnel MainWindow runs against
 * `layoutStateRef.current` for every op the Main palette sends. Pure — returns a new state (or the
 * same reference for no-ops). `exitCustomize` returns state unchanged; the caller owns mode state.
 */
export function applyToolsetLayoutEdit<I extends string = string, A extends string = string>(
  state: ToolsetLayoutState<I, A>,
  payload: ToolsetLayoutEditPayload,
  context: ApplyToolsetLayoutEditContext
): ToolsetLayoutState<I, A> {
  const { toolsetId, edit } = payload;
  switch (edit.kind) {
    case "reorderItems":
      return reorderItems(state, toolsetId, edit.groupId, edit.orderedItemIds);
    case "addCommand": {
      const title = context.commandTitle(edit.commandId);
      if (title === undefined) {
        // Unknown command — never add an item that would prune away or render dead.
        return state;
      }
      // A removed base command was only hidden; re-adding it should un-hide, not add a duplicate id
      // (which the hidden filter would then strip anyway).
      if (isHiddenByOverride(state, toolsetId, edit.commandId)) {
        const unhidden = setItemHidden(state, toolsetId, edit.commandId, false);
        return placeItemAtIndex(
          unhidden,
          toolsetId,
          edit.groupId,
          edit.commandId,
          edit.index,
          context.orderedItemIdsByGroup
        );
      }
      const item = {
        id: edit.commandId,
        kind: "button",
        label: title,
        icon: context.commandIcon?.(edit.commandId),
        assetName: context.commandAssetName?.(edit.commandId),
        primary: { type: "command", commandId: edit.commandId },
        submenu: null
      } as ToolsetItemDefinition<I, A>;
      const added = addToolsetItemAddition(
        state,
        toolsetId,
        { groupId: edit.groupId, index: edit.index, item },
        { presentItemIds: context.presentItemIds }
      );
      return added === state
        ? state
        : placeItemAtIndex(
            added,
            toolsetId,
            edit.groupId,
            edit.commandId,
            edit.index,
            context.orderedItemIdsByGroup
          );
    }
    case "addWidget": {
      // Widgets (style controls, inspectors) are base manifest items; removing one hides it. Re-adding
      // from the gallery un-hides it. (A control addition is only built for the rare case of dropping a
      // widget onto a toolset that never declared it.)
      if (isHiddenByOverride(state, toolsetId, edit.widgetId)) {
        const unhidden = setItemHidden(state, toolsetId, edit.widgetId, false);
        return placeItemAtIndex(
          unhidden,
          toolsetId,
          edit.groupId,
          edit.widgetId,
          edit.index,
          context.orderedItemIdsByGroup
        );
      }
      const item = {
        id: edit.widgetId,
        kind: "control",
        label: context.widgetTitle?.(edit.widgetId) ?? edit.widgetId,
        primary: { type: "control", controlId: edit.widgetId },
        submenu: null,
        layout: context.widgetLayout?.(edit.widgetId)
      } as ToolsetItemDefinition<I, A>;
      const added = addToolsetItemAddition(
        state,
        toolsetId,
        { groupId: edit.groupId, index: edit.index, item },
        { presentItemIds: context.presentItemIds }
      );
      return added === state
        ? state
        : placeItemAtIndex(
            added,
            toolsetId,
            edit.groupId,
            edit.widgetId,
            edit.index,
            context.orderedItemIdsByGroup
          );
    }
    case "addSpacer": {
      const itemId = nextSpacerItemId(state, toolsetId);
      const item = {
        id: itemId,
        kind: "spacer",
        label: "Spacer",
        primary: { type: "none" },
        layout: { rowSpan: context.gridRows ?? 1 }
      } as ToolsetItemDefinition<I, A>;
      const added = addToolsetItemAddition(
        state,
        toolsetId,
        { groupId: edit.groupId, index: edit.index, item },
        { presentItemIds: context.presentItemIds }
      );
      return added === state
        ? state
        : placeItemAtIndex(
            added,
            toolsetId,
            edit.groupId,
            itemId,
            edit.index,
            context.orderedItemIdsByGroup
          );
    }
    case "addSeparator": {
      const itemId = nextSeparatorItemId(state, toolsetId);
      const item = {
        id: itemId,
        kind: "separator",
        label: "Divider",
        primary: { type: "none" },
        layout: { rowSpan: context.gridRows ?? 1 }
      } as ToolsetItemDefinition<I, A>;
      const added = addToolsetItemAddition(
        state,
        toolsetId,
        { groupId: edit.groupId, index: edit.index, item },
        { presentItemIds: context.presentItemIds }
      );
      return added === state
        ? state
        : placeItemAtIndex(
            added,
            toolsetId,
            edit.groupId,
            itemId,
            edit.index,
            context.orderedItemIdsByGroup
          );
    }
    case "removeItem":
      return removeToolsetItem(state, toolsetId, edit.itemId);
    case "resetToolset":
      return resetToolsetLayout(state, toolsetId);
    case "exitCustomize":
    default:
      return state;
  }
}
