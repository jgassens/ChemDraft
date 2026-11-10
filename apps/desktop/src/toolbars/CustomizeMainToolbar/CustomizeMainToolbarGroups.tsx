import type { MainToolbarLayoutEdit } from "./applyLayoutEdit";
import type { MainToolbarCustomizeGroup } from "./groupModel";

function moved<T>(items: readonly T[], index: number, delta: number): T[] {
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(index + delta, 0, item);
  return next;
}

/** Content for the existing floating Customize dialog, also reusable by the Main palette. */
export function CustomizeMainToolbarGroups({ groups, onEdit }: {
  groups: readonly MainToolbarCustomizeGroup[];
  onEdit: (edit: MainToolbarLayoutEdit) => void;
}) {
  return <section aria-label="Main toolbar groups" data-palette-control="true">
    {groups.map((group, groupIndex) => <fieldset key={group.id} data-group-id={group.id}>
      <legend>{group.label}</legend>
      <label><input type="checkbox" aria-label={`Show ${group.label} group`} checked={!group.hidden}
        onChange={event => onEdit({ kind: "setGroupHidden", groupId: group.id, hidden: !event.currentTarget.checked })} /> Show group</label>
      {([-1, 1] as const).map(delta => <button key={delta} type="button"
        aria-label={`Move ${group.label} group ${delta < 0 ? "earlier" : "later"}`}
        disabled={groupIndex + delta < 0 || groupIndex + delta >= groups.length}
        onClick={() => onEdit({ kind: "reorderGroups", orderedGroupIds: moved(groups.map(entry => entry.id), groupIndex, delta) })}
      >{delta < 0 ? "↑" : "↓"}</button>)}
      <ol>{group.items.map((item, itemIndex) => <li key={item.id} className="customize-item-row" data-item-id={item.id}>
        <label><input type="checkbox" className="customize-item-visible" aria-label={`Show ${item.label}`} checked={!item.hidden}
          onChange={event => onEdit({ kind: "setItemHidden", itemId: item.id, hidden: !event.currentTarget.checked })} /> {item.label}</label>
        {([-1, 1] as const).map(delta => <button key={delta} type="button"
          aria-label={`Move ${item.label} ${delta < 0 ? "earlier" : "later"} in ${group.label}`}
          disabled={itemIndex + delta < 0 || itemIndex + delta >= group.items.length}
          onClick={() => onEdit({ kind: "reorderItems", groupId: group.id,
            orderedItemIds: moved(group.items.map(entry => entry.id), itemIndex, delta) })}
        >{delta < 0 ? "↑" : "↓"}</button>)}
      </li>)}</ol>
    </fieldset>)}
  </section>;
}
