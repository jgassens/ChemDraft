import { copyAsMenuItems, type CommandSpec } from "./commands";

export type CanvasMenuItem =
  | { kind: "separator" }
  | { kind: "title"; label: string }
  | { kind: "command"; commandId: string; label: string; enabled: boolean; disabledReason?: string; checked?: boolean }
  | { kind: "submenu"; id: string; label: string; ariaLabel: string; enabled: boolean; items: readonly CanvasMenuItem[] };

export interface ObjectCanvasMenuInput {
  arrowActions?: readonly CommandSpec[];
  bracketActions?: readonly CommandSpec[];
  layoutActions?: readonly CommandSpec[];
  tableActions?: readonly CommandSpec[];
  bondStereoActions?: readonly CommandSpec[];
  objectIndex: number;
  objectCount: number;
  targetKind: string;
  bondDepthContext?: { relevantCrossings: readonly unknown[]; targetBondRefs: readonly unknown[]; hasOverrides: boolean };
  atomWarning?: { suppressed: boolean; count: number; problemCommandId?: string };
  arrowStyleSource?: { title: string };
}

export const SET_DEFAULT_ARROW_STYLE_COMMAND_ID = "arrow.setDefaultStyle";
const separator: CanvasMenuItem = { kind: "separator" };
const command = (commandId: string, label: string, enabled = true, disabledReason?: string, checked?: boolean): CanvasMenuItem =>
  ({ kind: "command", commandId, label, enabled, disabledReason, checked });
// Context menus have never displayed CommandSpec shortcuts; do not introduce native accelerators.
const actionItem = (action: CommandSpec, label = action.title, enabled = action.enabled !== false): CanvasMenuItem =>
  command(action.id, label, enabled, action.disabledReason);
const submenu = (id: string, label: string, ariaLabel: string, items: readonly CanvasMenuItem[],
  enabled = items.some(item => item.kind === "command" && item.enabled)): CanvasMenuItem =>
  ({ kind: "submenu", id, label, ariaLabel, enabled, items });

/** The sole presentation model for both native desktop and HTML canvas menus. */
export function buildObjectCanvasMenu(input: ObjectCanvasMenuInput): readonly CanvasMenuItem[] {
  const { arrowActions = [], bracketActions = [], layoutActions = [], tableActions = [], bondStereoActions = [] } = input;
  const rowColumnIds = ["table.row.insertAbove", "table.row.insertBelow", "table.row.delete",
    "table.column.insertLeft", "table.column.insertRight", "table.column.delete"];
  const align = tableActions.filter(action => action.id.startsWith("table.column.align."));
  const items: CanvasMenuItem[] = [
    ...bracketActions.map(action => actionItem(action)),
    ...tableActions.filter(action => rowColumnIds.includes(action.id)).map(action => actionItem(action))
  ];
  if (align.length) items.push(submenu("table-align", "Align Column", "Align Column", align.map(action => actionItem(action,
    ({ left: "Left", center: "Centre", right: "Right", decimal: "Decimal" } as Record<string, string>)[action.id.split(".").at(-1)!] ?? action.title))), separator);
  items.push(...arrowActions.map(action => actionItem(action)));
  if (arrowActions.length) items.push(separator);
  if (layoutActions.length) {
    const layouts = layoutActions.filter(action => action.id !== "layout.adjustArrangementSpacing")
      .map(action => actionItem(action, action.title.replace(/^Arrange in (?:a|an) /, ""), Boolean(action.enabled)));
    for (const action of layoutActions.filter(action => action.id === "layout.adjustArrangementSpacing")) {
      layouts.push(separator, actionItem(action, "Adjust spacing…", Boolean(action.enabled)));
    }
    items.push(submenu("arrange", "Arrange", "Arrange layouts", layouts, true));
  }
  items.push(command("clipboard.cut", "Cut"), command("clipboard.copy", "Copy"), command("clipboard.paste", "Paste"),
    submenu("copy-as", "Copy As", "Copy As formats", copyAsMenuItems.map(item => command(item.commandId, item.label))), separator);
  if (input.atomWarning) {
    const { problemCommandId, suppressed, count } = input.atomWarning;
    if (problemCommandId) items.push(command(problemCommandId, "Atom problem…"));
    items.push(command("atom.toggleWarningSuppression", `${suppressed ? "Restore" : "Clear"} Warning${count === 1 ? "" : "s"}`), separator);
  }
  if (input.arrowStyleSource) items.push({ kind: "title", label: input.arrowStyleSource.title },
    command(SET_DEFAULT_ARROW_STYLE_COMMAND_ID, "Set as Default Arrow Style"), separator);
  if (bondStereoActions.length) items.push(...bondStereoActions.map(action => actionItem(action, action.title, Boolean(action.enabled))), separator);
  if (input.bondDepthContext?.relevantCrossings.length) {
    const selected = input.bondDepthContext.targetBondRefs.length > 1;
    items.push({ kind: "title", label: "Bond depth" },
      command("bondDepth.bringInFront", selected ? "Bring Selected Bonds In Front" : "Bring Bond In Front"),
      command("bondDepth.sendBehind", selected ? "Send Selected Bonds Behind" : "Send Bond Behind"));
    if (input.bondDepthContext.hasOverrides) items.push(command("bondDepth.useDefault", "Use Default Bond Depth"));
    items.push(separator);
  }
  items.push({ kind: "title", label: ["atom", "bond", "parts"].includes(input.targetKind) ? "Molecule layer"
    : input.objectIndex >= 0 ? `Layer ${input.objectIndex + 1} of ${input.objectCount}` : "Layer options" },
  command("layout.bringForward", "Move Object Forward"), command("layout.bringToFront", "Move Object to Front"),
  command("layout.sendBackward", "Move Object Backward"), command("layout.sendToBack", "Move Object to Back"));
  return items;
}

export const pageCanvasMenu: readonly CanvasMenuItem[] = [command("clipboard.paste", "Paste"), command("edit.selectAll", "Select All")];

export type NativeCanvasMenuItem =
  | { kind: "separator" }
  | { kind: "item"; id: string; label: string; enabled: boolean; disabledReason?: string; checked?: boolean }
  | { kind: "submenu"; label: string; enabled: boolean; items: readonly NativeCanvasMenuItem[] };

/** Opaque IDs isolate popup clicks from the application's global native-menu dispatcher. */
export function toNativeCanvasMenu(items: readonly CanvasMenuItem[], requestId: string) {
  const commands = new Map<string, string>();
  let index = 0;
  const convert = (entries: readonly CanvasMenuItem[], parentEnabled = true): NativeCanvasMenuItem[] => entries.map(item => {
    if (item.kind === "separator") return item;
    if (item.kind === "submenu") return { kind: "submenu", label: item.label, enabled: item.enabled,
      items: convert(item.items, parentEnabled && item.enabled) };
    const id = `canvas-context:${requestId}:${index++}`;
    if (item.kind === "title") return { kind: "item", id, label: item.label, enabled: false };
    if (parentEnabled && item.enabled) commands.set(id, item.commandId);
    return { kind: "item", id, label: item.label, enabled: item.enabled,
      disabledReason: item.disabledReason, checked: item.checked };
  });
  const spec = convert(items);
  let settled = false;
  return {
    items: spec,
    select(id: string | null, invoke: (commandId: string) => void): boolean {
      if (settled) return false;
      settled = true;
      const commandId = id === null ? undefined : commands.get(id);
      if (!commandId) return false;
      invoke(commandId);
      return true;
    }
  };
}
