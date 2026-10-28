import { validTableDimensions, type TableInsertDimensions } from "./dialogs/insertTableOptions";
export { validTableDimensions, type TableInsertDimensions } from "./dialogs/insertTableOptions";
import { TABLE_LIMITS, applyPatches, nativeTextStyleFromObjectStyle, type ChemDraftDocument, type TableObject } from "@chemdraft/chem-core";
import { deleteTableColumns, deleteTableRows, formatTableCellFormula, insertTableColumns, insertTableRows,
  setTableCaption, setTableCell, setTableCellFormulaRule, setTableColumnAlign, setTableColumnWidth,
  setTableFootnotes, setTableStyle } from "@chemdraft/document-workflow-core";
import type { CommandSpec } from "./commands";

export interface ActiveTableCell { tableId: string; rowId: string; columnId: string }
export function tableInsertCommandId(rows: number, columns: number, headerRows: number): string {
  if (!validTableDimensions({ rows, columns, headerRows })) throw new Error("Invalid table dimensions");
  return `table.insert.r${rows}c${columns}h${headerRows}`;
}
export function parseTableInsertCommandId(id: string): TableInsertDimensions | undefined {
  const match = /^table\.insert\.r([1-9]\d*)c([1-9]\d*)h(0|[1-9]\d*)$/.exec(id);
  if (!match) return undefined;
  const value = { rows: Number(match[1]), columns: Number(match[2]), headerRows: Number(match[3]) };
  return validTableDimensions(value) ? value : undefined;
}
export const tableColumnAlignCommandId = (align: "left" | "center" | "right" | "decimal") => `table.column.align.${align}`;
export const tableStyleCommandId = (preset: "three-line" | "grid") => `table.style.${preset === "three-line" ? "threeLine" : "grid"}`;
export function selectedTable(document: ChemDraftDocument): TableObject | undefined {
  if (document.selection.objectIds.length !== 1) return undefined;
  const page = document.selection.pageId
    ? document.pages.find(item => item.id === document.selection.pageId)
    : document.pages.find(item => item.objects.some(object => object.id === document.selection.objectIds[0]));
  const object = page?.objects.find(item => item.id === document.selection.objectIds[0]);
  return object?.type === "table" ? object : undefined;
}
/** Editor state only; stale cell ids resolve to the first body cell. */
export function resolveActiveTableCell(table: TableObject | undefined, active?: ActiveTableCell): ActiveTableCell | undefined {
  if (!table) return undefined;
  if (active?.tableId === table.id && table.rows.some(row => row.id === active.rowId) && table.columns.some(column => column.id === active.columnId)) return active;
  return { tableId: table.id, rowId: (table.rows[table.headerRowCount] ?? table.rows[0]).id, columnId: table.columns[0].id };
}
const editTitles = {
  "table.row.insertAbove": "Insert Row Above", "table.row.insertBelow": "Insert Row Below", "table.row.delete": "Delete Row",
  "table.column.insertLeft": "Insert Column Left", "table.column.insertRight": "Insert Column Right", "table.column.delete": "Delete Column",
  "table.column.align.left": "Align Column Left", "table.column.align.center": "Align Column Center",
  "table.column.align.right": "Align Column Right", "table.column.align.decimal": "Align Column on Decimal",
  "table.column.autoFit": "Auto-fit Column", "table.style.threeLine": "Three-line Table", "table.style.grid": "Grid Table",
  "table.header.bold.toggle": "Toggle Bold Headers", "table.caption.toggle": "Toggle Caption", "table.footnote.add": "Add Footnote",
  "table.cell.formatFormula": "Format Cell as Formula", "table.cell.plainText": "Plain Text Cell"
} as const;
export function tableCommandDisabledReason(id: string, table?: TableObject, active?: ActiveTableCell): string | undefined {
  if (id === "table.insertDialog" || parseTableInsertCommandId(id)) return undefined;
  if (!table) return "Select a table first";
  if (id.startsWith("table.row.insert") && table.rows.length >= TABLE_LIMITS.maxRows) return "Table has the maximum number of rows";
  if (id.startsWith("table.column.insert") && table.columns.length >= TABLE_LIMITS.maxColumns) return "Table has the maximum number of columns";
  if (id === "table.row.delete" && table.rows.length === 1) return "Keep at least one row";
  if (id === "table.column.delete" && table.columns.length === 1) return "Keep at least one column";
  if (id === "table.footnote.add" && table.footnotes.length >= TABLE_LIMITS.maxFootnotes) return "Table has the maximum number of footnotes";
  const cell = resolveActiveTableCell(table, active)!;
  if (id === "table.cell.formatFormula" && !formatTableCellFormula(table, cell.rowId, cell.columnId)) return "This cell has no formula to format";
  return undefined;
}
export function createTableInsertAction(rows: number, columns: number, headerRows: number): CommandSpec {
  return { id: tableInsertCommandId(rows, columns, headerRows), title: "Insert table", icon: "text", source: "core", enabled: true };
}
export function createTableCommands(document: ChemDraftDocument, active?: ActiveTableCell): CommandSpec[] {
  const table = selectedTable(document);
  return [{ id: "table.insertDialog", title: "Table…", icon: "text", source: "core", enabled: true },
    ...Object.entries(editTitles).map(([id, title]): CommandSpec => {
      const disabledReason = tableCommandDisabledReason(id, table, active);
      return { id, title, icon: "text", source: "core", enabled: !disabledReason, disabledReason };
    })];
}
export function applyTableCommand(document: ChemDraftDocument, id: string, active: ActiveTableCell | undefined,
  newId: (prefix: string) => string): { document: ChemDraftDocument; label: string } | undefined {
  const table = selectedTable(document);
  if (!table || tableCommandDisabledReason(id, table, active)) return undefined;
  const cell = resolveActiveTableCell(table, active)!;
  const row = table.rows.findIndex(item => item.id === cell.rowId);
  const column = table.columns.findIndex(item => item.id === cell.columnId);
  let result: { table: TableObject; label: string } | undefined;
  switch (id) {
    case "table.row.insertAbove": result = insertTableRows(table, row, 1, newId); break;
    case "table.row.insertBelow": result = insertTableRows(table, row + 1, 1, newId); break;
    case "table.row.delete": result = deleteTableRows(table, [cell.rowId]); break;
    case "table.column.insertLeft": result = insertTableColumns(table, column, 1, newId); break;
    case "table.column.insertRight": result = insertTableColumns(table, column + 1, 1, newId); break;
    case "table.column.delete": result = deleteTableColumns(table, [cell.columnId]); break;
    case "table.column.align.left": case "table.column.align.center": case "table.column.align.right": case "table.column.align.decimal":
      result = setTableColumnAlign(table, cell.columnId, id.split(".").at(-1) as TableObject["columns"][number]["align"]); break;
    case "table.column.autoFit": result = setTableColumnWidth(table, cell.columnId, { mode: "auto" }); break;
    case "table.style.threeLine": result = setTableStyle(table, { preset: "three-line" }); break;
    case "table.style.grid": result = setTableStyle(table, { preset: "grid" }); break;
    case "table.header.bold.toggle": result = setTableStyle(table, { headerBold: !table.tableStyle.headerBold }); break;
    case "table.caption.toggle": result = setTableCaption(table, table.caption ? undefined : { text: "Table 1.", spans: [] }); break;
    case "table.footnote.add": result = setTableFootnotes(table, [...table.footnotes, { text: "", spans: [] }]); break;
    case "table.cell.formatFormula": result = formatTableCellFormula(table, cell.rowId, cell.columnId); break;
    case "table.cell.plainText": {
      const ruled = setTableCellFormulaRule(table, cell.rowId, cell.columnId, "off");
      const value = ruled.table.rows[row].cells[column];
      result = setTableCell(ruled.table, cell.rowId, cell.columnId, { text: value.text, spans: value.spans.map(span => ({ ...span, script: "normal" })) });
      result.label = ruled.label;
      break;
    }
  }
  if (!result) return undefined;
  return { label: result.label, document: applyTableObjectEdit(document, result.table) };
}
/** Cell edits, column drags and registered commands share the same patch and selection path. */
export function applyTableObjectEdit(document: ChemDraftDocument, table: TableObject): ChemDraftDocument {
  return applyPatches(document, [
    { op: "updateObject", objectId: table.id, changes: table },
    { op: "setSelection", pageId: document.pages.find(page => page.objects.some(object => object.id === table.id))!.id, objectIds: [table.id] }
  ]);
}
export function tableInspectorSnapshot(document: ChemDraftDocument, active?: ActiveTableCell) {
  const table = selectedTable(document);
  if (!table) return undefined;
  const cell = resolveActiveTableCell(table, active);
  const column = table.columns.find(item => item.id === cell?.columnId);
  const { fontFamily, fontSizePx } = nativeTextStyleFromObjectStyle(table.style);
  const { preset, topRulePt, headerRulePt, bottomRulePt, gridRulePt, headerBold } = table.tableStyle;
  return { tableId: table.id, preset, topRulePt, headerRulePt, bottomRulePt, gridRulePt, headerBold, fontFamily, fontSizePx,
    hasCaption: table.caption !== undefined, footnoteCount: table.footnotes.length,
    activeColumn: column ? { id: column.id, align: column.align, formula: column.formula } : undefined };
}
