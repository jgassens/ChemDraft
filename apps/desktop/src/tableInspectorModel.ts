import { TABLE_LIMITS } from "@chemdraft/chem-core";
import { tableColumnAlignCommandId, tableStyleCommandId, type tableInspectorSnapshot } from "./tableCommands";

/** What the main window publishes for a selected table (`tableInspectorSnapshot`). */
export type TableInspectorSnapshot = NonNullable<ReturnType<typeof tableInspectorSnapshot>>;

/** Live availability of a registered command, as the palette window holds it (`CommandSpec`). */
export interface TableInspectorCommandAvailability {
  enabled?: boolean;
  disabledReason?: string;
}

export type TableInspectorCommandLookup = (commandId: string) => TableInspectorCommandAvailability | undefined;

interface ControlBase {
  id: string;
  label: string;
  /** Present only when the control cannot be used right now; the reason is shown, never invented. */
  disabledReason?: string;
}

export interface TableInspectorChoice {
  id: string;
  label: string;
  commandId: string;
  selected: boolean;
  disabledReason?: string;
}

export type TableInspectorControl =
  | (ControlBase & { kind: "segmented"; choices: TableInspectorChoice[] })
  | (ControlBase & { kind: "toggle"; commandId: string; pressed: boolean })
  | (ControlBase & { kind: "button"; commandId: string })
  /** A value with no registered command behind it yet: shown, never editable. */
  | (ControlBase & { kind: "readout"; value: string });

export interface TableInspectorSection {
  id: "style" | "rules" | "header" | "font" | "column" | "caption" | "footnotes" | "cell";
  title: string;
  controls: TableInspectorControl[];
}

export interface TableInspectorModel {
  tableId: string;
  sections: TableInspectorSection[];
}

const ALIGNMENTS = [
  { align: "left", label: "Left" },
  { align: "center", label: "Centre" },
  { align: "right", label: "Right" },
  { align: "decimal", label: "Decimal" }
] as const;

const FORMULA_LABELS: Record<string, string> = { auto: "Auto", off: "Off" };

function pt(value: number): string {
  return `${Number(value.toFixed(2))} pt`;
}

/** Snapshot → sections of controls. Pure: no table in the snapshot means no model at all. */
export function createTableInspectorModel(
  snapshot: TableInspectorSnapshot | undefined,
  commandAvailability: TableInspectorCommandLookup = () => undefined
): TableInspectorModel | undefined {
  if (!snapshot) return undefined;
  const reasonFor = (commandId: string): string | undefined => {
    const availability = commandAvailability(commandId);
    if (!availability || availability.enabled !== false) return undefined;
    return availability.disabledReason ?? "Unavailable right now";
  };
  const choice = (id: string, label: string, commandId: string, selected: boolean, extra?: string): TableInspectorChoice => {
    const disabledReason = extra ?? reasonFor(commandId);
    return { id, label, commandId, selected, ...(disabledReason ? { disabledReason } : {}) };
  };
  const withReason = <T extends ControlBase>(control: T, reason?: string): T =>
    reason ? { ...control, disabledReason: reason } : control;

  const style: TableInspectorSection = {
    id: "style",
    title: "Style",
    controls: [{
      kind: "segmented", id: "preset", label: "Table style",
      choices: (["three-line", "grid"] as const).map(preset =>
        choice(preset, preset === "three-line" ? "Three-line" : "Grid", tableStyleCommandId(preset), snapshot.preset === preset))
    }]
  };

  // No command sets a rule width yet (only the preset commands exist), so rules are values, not controls.
  const rules: TableInspectorSection = {
    id: "rules",
    title: "Rules",
    controls: snapshot.preset === "three-line"
      ? [
        { kind: "readout", id: "topRule", label: "Top rule", value: pt(snapshot.topRulePt) },
        { kind: "readout", id: "headerRule", label: "Header rule", value: pt(snapshot.headerRulePt) },
        { kind: "readout", id: "bottomRule", label: "Bottom rule", value: pt(snapshot.bottomRulePt) }
      ]
      : [{ kind: "readout", id: "gridRule", label: "Grid line width", value: pt(snapshot.gridRulePt) }]
  };

  const header: TableInspectorSection = {
    id: "header",
    title: "Header",
    controls: [withReason({
      kind: "toggle", id: "headerBold", label: "Bold header", commandId: "table.header.bold.toggle", pressed: snapshot.headerBold
    }, reasonFor("table.header.bold.toggle"))]
  };

  // Font commands (`text.font.*`) act on text objects only; a selected table has none, so read-only.
  const font: TableInspectorSection = {
    id: "font",
    title: "Font",
    controls: [
      { kind: "readout", id: "fontFamily", label: "Family", value: snapshot.fontFamily },
      { kind: "readout", id: "fontSize", label: "Size", value: `${Number(snapshot.fontSizePx.toFixed(2))} px` }
    ]
  };

  const column = snapshot.activeColumn;
  const noColumn = "Click a cell to choose a column";
  const columnControls: TableInspectorControl[] = [{
    kind: "segmented", id: "align", label: "Alignment",
    ...(column ? {} : { disabledReason: noColumn }),
    choices: ALIGNMENTS.map(({ align, label }) =>
      choice(align, label, tableColumnAlignCommandId(align), column?.align === align, column ? undefined : noColumn))
  }];
  // Column formula auto/off has no column-level command (the cell commands below set a cell rule), so read-only.
  columnControls.push({
    kind: "readout", id: "formula", label: "Formulae",
    value: column ? (FORMULA_LABELS[column.formula] ?? String(column.formula)) : "—",
    ...(column ? {} : { disabledReason: noColumn })
  });
  const columnSection: TableInspectorSection = { id: "column", title: "Column", controls: columnControls };

  const caption: TableInspectorSection = {
    id: "caption",
    title: "Caption",
    controls: [withReason({
      kind: "toggle", id: "caption", label: "Caption", commandId: "table.caption.toggle", pressed: snapshot.hasCaption
    }, reasonFor("table.caption.toggle"))]
  };

  const footnoteReason = snapshot.footnoteCount >= TABLE_LIMITS.maxFootnotes
    ? "Table has the maximum number of footnotes"
    : reasonFor("table.footnote.add");
  const footnotes: TableInspectorSection = {
    id: "footnotes",
    title: "Footnotes",
    controls: [
      { kind: "readout", id: "footnoteCount", label: "Footnotes", value: String(snapshot.footnoteCount) },
      withReason({ kind: "button", id: "addFootnote", label: "Add footnote", commandId: "table.footnote.add" }, footnoteReason)
    ]
  };

  const cell: TableInspectorSection = {
    id: "cell",
    title: "Cell",
    controls: [
      withReason({ kind: "button", id: "formatFormula", label: "Format as formula", commandId: "table.cell.formatFormula" },
        reasonFor("table.cell.formatFormula")),
      withReason({ kind: "button", id: "plainText", label: "Plain text", commandId: "table.cell.plainText" },
        reasonFor("table.cell.plainText"))
    ]
  };

  return { tableId: snapshot.tableId, sections: [style, rules, header, font, columnSection, caption, footnotes, cell] };
}
