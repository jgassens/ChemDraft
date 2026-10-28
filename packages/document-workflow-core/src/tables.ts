// Native table builder and pure edit operations, shared by the app, CLI, and MCP.

import { z } from "zod";
import {
  TABLE_LIMITS,
  TableObjectSchema,
  TableRichTextSchema,
  type TableObject,
  type TableRichText,
  type TableStyle
} from "@chemdraft/chem-core";
import { planTableLayout } from "@chemdraft/layout-engine";
import { formulaSpansForMixedText } from "./formulaText";

const TableFormulaRuleSchema = z.enum(["auto", "off"]);

const TableSpanInputSchema = z.object({
  text: z.string(),
  script: z.enum(["normal", "subscript", "superscript"]).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional()
}).strict();

const TableRichCellInputSchema = z.object({
  text: z.string().max(TABLE_LIMITS.maxCellCharacters),
  spans: z.array(TableSpanInputSchema).optional(),
  formula: TableFormulaRuleSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (value.spans && value.spans.map((item) => item.text).join("") !== value.text) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Span text must match cell text" });
  }
});

const TableCellInputSchema = z.union([
  z.string().max(TABLE_LIMITS.maxCellCharacters),
  TableRichCellInputSchema
]);

const TableColumnInputSchema = z.object({
  header: TableCellInputSchema.optional(),
  align: z.enum(["left", "center", "right", "decimal"]).optional(),
  widthPx: z.number().finite().positive().max(4000).optional(),
  formula: TableFormulaRuleSchema.optional()
}).strict();

const TableStyleInputSchema = z.object({
  preset: z.enum(["three-line", "grid"]).optional(),
  headerBold: z.boolean().optional(),
  fontFamily: z.string().optional(),
  fontSizePx: z.number().finite().positive().optional()
}).strict();

type TableSpecShape = {
  columns: Array<{ header?: CellInput }>;
  headerRows?: CellInput[][];
};

/** Header rows of a spec: the explicit ones, else one row from the column headers, else none. */
function specHeaderRows(spec: TableSpecShape): CellInput[][] {
  if (spec.headerRows) {
    return spec.headerRows;
  }
  if (spec.columns.some((column) => column.header !== undefined)) {
    return [spec.columns.map((column) => column.header ?? "")];
  }
  return [];
}

/** Validate a table specification, rejecting ragged rows, bad spans, and over-limit sizes. */
export const TableSpecSchema = z.object({
  columns: z.array(TableColumnInputSchema).min(1).max(TABLE_LIMITS.maxColumns),
  rows: z.array(z.array(TableCellInputSchema)).max(TABLE_LIMITS.maxRows),
  headerRows: z.array(z.array(TableCellInputSchema)).optional(),
  caption: TableCellInputSchema.optional(),
  footnotes: z.array(TableCellInputSchema).max(TABLE_LIMITS.maxFootnotes).optional(),
  style: TableStyleInputSchema.optional()
}).strict().superRefine((value, ctx) => {
  const headers = specHeaderRows(value);
  const groups = [["headerRows", headers], ["rows", value.rows]] as const;
  for (const [kind, rows] of groups) {
    const noun = kind === "rows" ? "Row" : "Header row";
    rows.forEach((row, index) => {
      if (row.length !== value.columns.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [kind, index],
          message: `${noun} ${index + 1} must have ${value.columns.length} columns`
        });
      }
    });
  }
  const rowCount = headers.length + value.rows.length;
  if (rowCount < 1 || rowCount > TABLE_LIMITS.maxRows) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rows"],
      message: `Table must have 1 to ${TABLE_LIMITS.maxRows} rows including headers`
    });
  }
});

type CellInput = z.infer<typeof TableCellInputSchema>;
type IdFactory = (prefix: string) => string;
type TableCellValue = TableObject["rows"][number]["cells"][number];
type TableColumnValue = TableObject["columns"][number];
type TableEditResult = { table: TableObject; label: string };

function richTextFromInput(input: CellInput): TableRichText {
  if (typeof input === "string") {
    return { text: input, spans: [] };
  }
  const spans = (input.spans ?? []).map((item) => ({
    text: item.text,
    script: item.script ?? "normal",
    style: {
      ...(item.bold ? { fontWeight: 700 } : {}),
      ...(item.italic ? { fontStyle: "italic" } : {})
    }
  }));
  return { text: input.text, spans };
}

function frameTable(value: TableObject): TableObject {
  const table = TableObjectSchema.parse(value);
  const layout = planTableLayout(table);
  return TableObjectSchema.parse({ ...table, width: layout.width, height: layout.height });
}

function cellFromInput(value: CellInput, column: TableColumnValue): TableCellValue {
  const data = richTextFromInput(value);
  if (typeof value === "string" && column.formula === "auto") {
    data.spans = formulaSpansForMixedText(data.text, data.spans) ?? data.spans;
  }
  if (typeof value === "string" || value.formula === undefined) {
    return data;
  }
  return { ...data, formula: value.formula };
}

/** Build and size a table from an untrusted spec, rejecting invalid dimensions or cell content. */
export function buildTableObject(
  input: unknown,
  options: { id: string; x: number; y: number; newId: IdFactory; style?: TableObject["style"] }
): { object: TableObject; warnings: string[] } {
  const spec = TableSpecSchema.parse(input);
  const columns = spec.columns.map((column) => ({
    id: options.newId("column"),
    align: column.align ?? "left",
    width: column.widthPx === undefined
      ? { mode: "auto" as const }
      : { mode: "fixed" as const, px: column.widthPx },
    formula: column.formula ?? (column.align === "decimal" ? "off" as const : "auto" as const)
  }));
  const headers = specHeaderRows(spec);
  const rows = [...headers, ...spec.rows].map((row) => ({
    id: options.newId("row"),
    cells: row.map((value, index) => cellFromInput(value, columns[index]))
  }));
  const object = TableObjectSchema.parse({
    id: options.id,
    x: options.x,
    y: options.y,
    width: 0,
    height: 0,
    type: "table",
    tableVersion: 1,
    columns,
    rows,
    headerRowCount: headers.length,
    caption: spec.caption === undefined ? undefined : richTextFromInput(spec.caption),
    footnotes: (spec.footnotes ?? []).map(richTextFromInput),
    tableStyle: { preset: spec.style?.preset, headerBold: spec.style?.headerBold },
    style: {
      ...options.style,
      ...(spec.style?.fontFamily ? { fontFamily: spec.style.fontFamily } : {}),
      ...(spec.style?.fontSizePx !== undefined ? { fontSizePx: spec.style.fontSizePx } : {})
    }
  });
  return { object: frameTable(object), warnings: [] };
}

function editResult(table: TableObject, label: string): TableEditResult {
  return { table: frameTable(table), label };
}

function requireIndex(index: number, max: number, table: TableObject, kind: string): void {
  if (!Number.isInteger(index) || index < 0 || index > max) {
    throw new Error(`${kind} ${index} is outside 0..${max} for table "${table.id}".`);
  }
}

function requireCount(count: number, table: TableObject, kind: string): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`${kind} count ${count} must be a positive integer for table "${table.id}".`);
  }
}

function editLabel(action: string, count: number, item: string): string {
  return `${action} ${count === 1 ? "" : `${count} `}${item}${count === 1 ? "" : "s"}`;
}

/** Insert blank rows at an index; refuses a bad index or count, or more rows than the limit. */
export function insertTableRows(
  table: TableObject,
  index: number,
  count: number,
  newId: IdFactory
): TableEditResult {
  requireIndex(index, table.rows.length, table, "Row index");
  requireCount(count, table, "Row");
  const rowTotal = table.rows.length + count;
  if (rowTotal > TABLE_LIMITS.maxRows) {
    throw new Error(`Table "${table.id}" would have ${rowTotal} rows; the limit is ${TABLE_LIMITS.maxRows}.`);
  }
  const inserted = Array.from({ length: count }, () => ({
    id: newId("row"),
    cells: table.columns.map(() => ({ text: "", spans: [] }))
  }));
  const insideHeader = index < table.headerRowCount;
  return editResult({
    ...table,
    rows: [...table.rows.slice(0, index), ...inserted, ...table.rows.slice(index)],
    headerRowCount: table.headerRowCount + (insideHeader ? count : 0)
  }, editLabel("Insert", count, "row"));
}

/** Delete rows by id; refuses an unknown row or deleting every row. */
export function deleteTableRows(table: TableObject, rowIds: readonly string[]): TableEditResult {
  const ids = new Set(rowIds);
  const missing = rowIds.find((id) => !table.rows.some((row) => row.id === id));
  if (missing !== undefined) {
    throw new Error(`Table "${table.id}" has no row "${missing}".`);
  }
  const rows = table.rows.filter((row) => !ids.has(row.id));
  if (!rows.length) {
    throw new Error(`Cannot delete every row of table "${table.id}".`);
  }
  const removedHeaders = table.rows.slice(0, table.headerRowCount).filter((row) => ids.has(row.id)).length;
  return editResult({
    ...table,
    rows,
    headerRowCount: table.headerRowCount - removedHeaders
  }, editLabel("Delete", ids.size, "row"));
}

/** Insert blank columns at an index; refuses a bad index or count, or more columns than the limit. */
export function insertTableColumns(
  table: TableObject,
  index: number,
  count: number,
  newId: IdFactory
): TableEditResult {
  requireIndex(index, table.columns.length, table, "Column index");
  requireCount(count, table, "Column");
  const columnTotal = table.columns.length + count;
  if (columnTotal > TABLE_LIMITS.maxColumns) {
    throw new Error(
      `Table "${table.id}" would have ${columnTotal} columns; the limit is ${TABLE_LIMITS.maxColumns}.`
    );
  }
  const inserted = Array.from({ length: count }, () => ({
    id: newId("column"),
    align: "left" as const,
    width: { mode: "auto" as const },
    formula: "auto" as const
  }));
  const blankCells = (): TableCellValue[] => inserted.map(() => ({ text: "", spans: [] }));
  return editResult({
    ...table,
    columns: [...table.columns.slice(0, index), ...inserted, ...table.columns.slice(index)],
    rows: table.rows.map((row) => ({
      ...row,
      cells: [...row.cells.slice(0, index), ...blankCells(), ...row.cells.slice(index)]
    }))
  }, editLabel("Insert", count, "column"));
}

/** Delete columns by id, with their cells; refuses an unknown column or deleting every column. */
export function deleteTableColumns(table: TableObject, columnIds: readonly string[]): TableEditResult {
  const ids = new Set(columnIds);
  const missing = columnIds.find((id) => !table.columns.some((column) => column.id === id));
  if (missing !== undefined) {
    throw new Error(`Table "${table.id}" has no column "${missing}".`);
  }
  const columns = table.columns.filter((column) => !ids.has(column.id));
  if (!columns.length) {
    throw new Error(`Cannot delete every column of table "${table.id}".`);
  }
  return editResult({
    ...table,
    columns,
    rows: table.rows.map((row) => ({
      ...row,
      cells: row.cells.filter((_, index) => !ids.has(table.columns[index].id))
    }))
  }, editLabel("Delete", ids.size, "column"));
}

function cellPosition(table: TableObject, rowId: string, columnId: string): [number, number] {
  const row = table.rows.findIndex((item) => item.id === rowId);
  const column = table.columns.findIndex((item) => item.id === columnId);
  if (row < 0) {
    throw new Error(`Table "${table.id}" has no row "${rowId}".`);
  }
  if (column < 0) {
    throw new Error(`Table "${table.id}" has no column "${columnId}".`);
  }
  return [row, column];
}

function replaceCell(table: TableObject, row: number, column: number, value: TableCellValue): TableObject {
  return {
    ...table,
    rows: table.rows.map((item, rowIndex) => {
      if (rowIndex !== row) {
        return item;
      }
      return {
        ...item,
        cells: item.cells.map((cell, columnIndex) => (columnIndex === column ? value : cell))
      };
    })
  };
}

/** Replace a cell's text and spans; refuses an unknown row or column, or spans that do not match. */
export function setTableCell(
  table: TableObject,
  rowId: string,
  columnId: string,
  richText: TableRichText
): TableEditResult {
  const [row, column] = cellPosition(table, rowId, columnId);
  const value = TableRichTextSchema.parse(richText);
  if (value.spans.length && value.spans.map((span) => span.text).join("") !== value.text) {
    throw new Error(
      `Spans do not match cell text in row "${rowId}", column "${columnId}" of table "${table.id}".`
    );
  }
  const merged = { ...table.rows[row].cells[column], ...value };
  return editResult(replaceCell(table, row, column, merged), "Edit cell");
}

/** Format a cell's chemical formula; refuses an unknown row or column, undefined when nothing changes. */
export function formatTableCellFormula(
  table: TableObject,
  rowId: string,
  columnId: string
): TableEditResult | undefined {
  const [row, column] = cellPosition(table, rowId, columnId);
  const value = table.rows[row].cells[column];
  const spans = formulaSpansForMixedText(value.text, value.spans);
  if (!spans) {
    return undefined;
  }
  return editResult(replaceCell(table, row, column, { ...value, spans }), "Format formula");
}

/** Set one cell's formula rule to auto or off; refuses an unknown row or column. */
export function setTableCellFormulaRule(
  table: TableObject,
  rowId: string,
  columnId: string,
  value: "auto" | "off"
): TableEditResult {
  const [row, column] = cellPosition(table, rowId, columnId);
  return editResult(
    replaceCell(table, row, column, { ...table.rows[row].cells[column], formula: value }),
    "Set formula rule"
  );
}

function updateColumn(
  table: TableObject,
  id: string,
  update: Partial<TableColumnValue>,
  label: string
): TableEditResult {
  if (!table.columns.some((column) => column.id === id)) {
    throw new Error(`Table "${table.id}" has no column "${id}".`);
  }
  return editResult({
    ...table,
    columns: table.columns.map((column) => (column.id === id ? { ...column, ...update } : column))
  }, label);
}

/** Set a column's alignment; refuses an unknown column. */
export function setTableColumnAlign(
  table: TableObject,
  id: string,
  align: "left" | "center" | "right" | "decimal"
): TableEditResult {
  return updateColumn(table, id, { align }, "Align column");
}

/** Set a column's width to auto or a fixed pixel size; refuses an unknown column or invalid width. */
export function setTableColumnWidth(
  table: TableObject,
  id: string,
  width: { mode: "auto" } | { mode: "fixed"; px: number }
): TableEditResult {
  return updateColumn(table, id, { width }, "Resize column");
}

/** Set how many leading rows are headers; refuses a count outside 0..row count. */
export function setTableHeaderRowCount(table: TableObject, count: number): TableEditResult {
  requireIndex(count, table.rows.length, table, "Header row count");
  return editResult({ ...table, headerRowCount: count }, "Set header rows");
}

/** Merge style changes into the table style; refuses invalid style values. */
export function setTableStyle(table: TableObject, style: Partial<TableStyle>): TableEditResult {
  return editResult({ ...table, tableStyle: { ...table.tableStyle, ...style } }, "Style table");
}

/** Set or clear the caption; refuses invalid text. */
export function setTableCaption(table: TableObject, caption: TableRichText | undefined): TableEditResult {
  return editResult({ ...table, caption }, "Edit caption");
}

/** Replace all footnotes; refuses invalid text or more footnotes than the limit. */
export function setTableFootnotes(table: TableObject, footnotes: TableRichText[]): TableEditResult {
  return editResult({ ...table, footnotes }, "Edit footnotes");
}
