import type { ToolsetItemDefinition, ToolsetLayoutState } from "@chemdraft/toolset-registry";
import type { ToolsetLayoutEditPayload } from "../../window-manager";
import {
  addToolsetItemAddition,
  nextSeparatorItemId,
  nextSpacerItemId,
  removeToolsetItem,
  reorderItems,
  resetToolsetLayout
} from "../CustomizeToolbars/layoutStateEdits";

export interface ApplyToolsetLayoutEditContext {
  /** Customization ids currently present in the toolset — used to no-op a duplicate add. */
  presentItemIds: ReadonlySet<string>;
  /** Resolve a command id to its title (from the command catalog). Returns undefined for an unknown
   *  command, which makes an addCommand a no-op — the gallery only surfaces real commands. */
  commandTitle: (commandId: string) => string | undefined;
  /** Resolve a command id to its icon name / toolbar asset, so an added command renders with its real
   *  glyph instead of the generic fallback. Optional — a missing icon just falls back. */
  commandIcon?: (commandId: string) => string | undefined;
  commandAssetName?: (commandId: string) => string | undefined;
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
      const item = {
        id: edit.commandId,
        kind: "button",
        label: title,
        icon: context.commandIcon?.(edit.commandId),
        assetName: context.commandAssetName?.(edit.commandId),
        primary: { type: "command", commandId: edit.commandId },
        submenu: null
      } as ToolsetItemDefinition<I, A>;
      return addToolsetItemAddition(
        state,
        toolsetId,
        { groupId: edit.groupId, index: edit.index, item },
        { presentItemIds: context.presentItemIds }
      );
    }
    case "addSpacer": {
      const item = {
        id: nextSpacerItemId(state, toolsetId),
        kind: "spacer",
        label: "Spacer",
        primary: { type: "none" },
        layout: { rowSpan: context.gridRows ?? 1 }
      } as ToolsetItemDefinition<I, A>;
      return addToolsetItemAddition(
        state,
        toolsetId,
        { groupId: edit.groupId, index: edit.index, item },
        { presentItemIds: context.presentItemIds }
      );
    }
    case "addSeparator": {
      const item = {
        id: nextSeparatorItemId(state, toolsetId),
        kind: "separator",
        label: "Divider",
        primary: { type: "none" },
        layout: { rowSpan: context.gridRows ?? 1 }
      } as ToolsetItemDefinition<I, A>;
      return addToolsetItemAddition(
        state,
        toolsetId,
        { groupId: edit.groupId, index: edit.index, item },
        { presentItemIds: context.presentItemIds }
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
