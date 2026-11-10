import {
  MAIN_TOOLBAR_GROUP_IDS,
  toolsetItemCustomizationId,
  type ToolsetLayoutState,
  type ToolbarGroupId
} from "@chemdraft/toolset-registry";
import { currentMainToolbarDefinition, mainToolbarGroupMetadata, mainToolbarHomeGroupId } from "../mainToolbarGroups";
import { reconcileMainToolbarPluginHomes } from "../toolbarLayoutState";

export interface MainToolbarCustomizeGroup {
  id: ToolbarGroupId;
  label: string;
  hidden: boolean;
  items: { id: string; label: string; hidden: boolean }[];
}

function reorder<T>(items: T[], order: readonly string[], idOf: (item: T) => string): T[] {
  const ranks = new Map(order.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (ranks.get(idOf(a)) ?? order.length) - (ranks.get(idOf(b)) ?? order.length));
}

/** Includes hidden groups and buttons; Undeclared is offered only while it contains saved items. */
export function buildMainToolbarCustomizeGroups(state: ToolsetLayoutState): MainToolbarCustomizeGroup[] {
  state = reconcileMainToolbarPluginHomes(state) as ToolsetLayoutState;
  const override = state.toolsetOverrides.find(entry => entry.toolsetId === "core.main");
  const items = currentMainToolbarDefinition().groups.flatMap(group => group.items);
  const taken = new Set(items.map(item => toolsetItemCustomizationId(item)));
  for (const addition of override?.itemAdditions ?? []) {
    const id = toolsetItemCustomizationId(addition.item);
    if (id && !taken.has(id) && addition.item.kind !== "spacer" && addition.item.kind !== "separator") {
      items.push(addition.item);
      taken.add(id);
    }
  }
  const groups = MAIN_TOOLBAR_GROUP_IDS.map(id => ({
    id, label: mainToolbarGroupMetadata(id).label, hidden: override?.hiddenGroupIds?.includes(id) ?? false,
    items: reorder(items.filter(item => mainToolbarHomeGroupId(toolsetItemCustomizationId(item)!) === id),
      override?.itemOrder?.[id] ?? [], item => toolsetItemCustomizationId(item)!).map(item => {
        const itemId = toolsetItemCustomizationId(item)!;
        const explicit = override?.itemOverrides?.find(entry => entry.commandId === itemId)?.hidden;
        return { id: itemId, label: item.label ?? item.title ?? itemId,
          hidden: explicit ?? ((override?.hiddenCommandIds?.includes(itemId) ?? false) || !!item.defaultHidden) };
      })
  })).filter(group => group.id !== "undeclared" || group.items.length > 0);
  return reorder(groups, override?.groupOrder ?? [], group => group.id);
}
