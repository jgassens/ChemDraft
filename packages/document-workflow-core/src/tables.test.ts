import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument, TableObjectSchema, type TableObject, type TableRichText } from "@chemdraft/chem-core";
import { planTableLayout } from "@chemdraft/layout-engine";
import {
  buildTableObject,
  deleteTableColumns,
  deleteTableRows,
  formatTableCellFormula,
  insertTableColumns,
  insertTableRows,
  setTableCaption,
  setTableCell,
  setTableCellFormulaRule,
  setTableColumnAlign,
  setTableColumnWidth,
  setTableFootnotes,
  setTableHeaderRowCount,
  setTableStyle
} from "./tables";

const fixtureUrl = new URL("../../fixtures/tables/sharpless-reagent-table.json", import.meta.url);
const fixtureDocument = parseDocument(JSON.parse(readFileSync(fixtureUrl, "utf8")));
const fixtureTable = fixtureDocument.pages[0].objects[0] as TableObject;
const tableId = fixtureTable.id;
const firstRowId = "row-header";
const firstColumnId = "col-material";

let nextId = 0;
const newId = (prefix: string): string => `${prefix}-new-${nextId++}`;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

function expectFramed(table: TableObject): void {
  const layout = planTableLayout(table);
  expect(table.width).toBe(layout.width);
  expect(table.height).toBe(layout.height);
  expect(TableObjectSchema.parse(table)).toEqual(table);
}

/** Run an edit on a deeply frozen copy of the fixture; the input must be untouched and the result framed. */
function edit<T extends { table: TableObject } | undefined>(operation: (table: TableObject) => T): T {
  const input = deepFreeze(structuredClone(fixtureTable));
  const snapshot = structuredClone(input);
  const outcome = operation(input);
  expect(input).toEqual(snapshot);
  if (outcome) {
    expectFramed(outcome.table);
  }
  return outcome;
}

function cellOf(table: TableObject, rowId: string, columnId: string): TableObject["rows"][number]["cells"][number] {
  const row = table.rows.find((item) => item.id === rowId)!;
  return row.cells[table.columns.findIndex((column) => column.id === columnId)];
}

function stripIds(table: TableObject): unknown {
  return {
    columns: table.columns.map((column) => ({
      align: column.align,
      width: column.width,
      formula: column.formula
    })),
    rows: table.rows.map((row) => row.cells),
    headerRowCount: table.headerRowCount,
    caption: table.caption,
    footnotes: table.footnotes
  };
}

const buildOptions = { id: "table-built", x: 80, y: 80, newId };
const superscriptA = { text: "a", script: "superscript" as const };

function sharplessSpec() {
  return {
    columns: [
      { align: "left" as const },
      { align: "decimal" as const },
      { align: "decimal" as const },
      { align: "decimal" as const },
      { align: "decimal" as const },
      { align: "decimal" as const },
      { align: "decimal" as const }
    ],
    headerRows: [["Material", "MW (g/mol)", "Density (g/mL)", "Equiv.", "mmol", "Mass (g)", "Volume (mL)"]],
    rows: [
      ["allyl alcohol", "58.08", "0.854", "1.00", "17.22", "1.00", "1.17"],
      ["Ti(OiPr)4", "284.22", "0.96", "0.05", "0.861", "0.245", "0.255"],
      ["(+)-DET", "206.19", "1.204", "0.06", "1.033", "0.213", "0.177"],
      [
        { text: "TBHPa", spans: [{ text: "TBHP" }, superscriptA] },
        "90.12",
        "—",
        "2.0",
        "34.44",
        "—",
        "6.26"
      ],
      ["CH2Cl2", "84.93", "1.33", "—", "—", "—", "86"]
    ],
    caption: {
      text: "Table 1. Sharpless epoxidation of allyl alcohol (1.00 g basis).",
      spans: [
        { text: "Table 1.", bold: true },
        { text: " Sharpless epoxidation of allyl alcohol (1.00 g basis)." }
      ]
    },
    footnotes: [{ text: "a 5.5 M in decane.", spans: [superscriptA, { text: " 5.5 M in decane." }] }]
  };
}

describe("buildTableObject", () => {
  it("builds the Sharpless fixture table from a spec", () => {
    const { object, warnings } = buildTableObject(sharplessSpec(), buildOptions);
    expect(warnings).toEqual([]);
    expect(object.id).toBe("table-built");
    expect(object.type).toBe("table");
    expect(stripIds(object)).toEqual(stripIds(fixtureTable));
    expectFramed(object);
  });

  it("subscripts formulas in auto columns and leaves other text plain", () => {
    const { object } = buildTableObject(sharplessSpec(), buildOptions);
    const material = (rowIndex: number) => object.rows[rowIndex].cells[0];
    expect(material(2).spans.map((span) => [span.text, span.script])).toEqual([
      ["Ti(OiPr)", "normal"],
      ["4", "subscript"]
    ]);
    expect(material(5).spans.map((span) => [span.text, span.script])).toEqual([
      ["CH", "normal"],
      ["2", "subscript"],
      ["Cl", "normal"],
      ["2", "subscript"]
    ]);
    expect(material(1).spans).toEqual([]);
    expect(material(3).spans).toEqual([]);
  });

  it("never formats decimal columns as formulas", () => {
    const { object } = buildTableObject(sharplessSpec(), buildOptions);
    for (const column of object.columns.slice(1)) {
      expect(column.formula).toBe("off");
    }
    for (const text of ["1.00", "0.861", "86"]) {
      const cells = object.rows.flatMap((row) => row.cells).filter((cell) => cell.text === text);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.every((cell) => cell.spans.length === 0)).toBe(true);
    }
  });

  it("builds a header row from column headers and applies fixed widths and style", () => {
    const { object } = buildTableObject({
      columns: [{ header: "Name", widthPx: 120 }, { header: "Mass" }],
      rows: [["a", "b"]],
      style: { preset: "grid", headerBold: true, fontFamily: "Arial", fontSizePx: 14 }
    }, buildOptions);
    expect(object.headerRowCount).toBe(1);
    expect(object.rows[0].cells.map((cell) => cell.text)).toEqual(["Name", "Mass"]);
    expect(object.columns[0].width).toEqual({ mode: "fixed", px: 120 });
    expect(object.columns[1].width).toEqual({ mode: "auto" });
    expect(object.tableStyle.preset).toBe("grid");
    expect(object.tableStyle.headerBold).toBe(true);
    expect(object.style).toMatchObject({ fontFamily: "Arial", fontSizePx: 14 });
    expectFramed(object);
  });

  it("rejects a ragged body row, naming the row", () => {
    expect(() => buildTableObject({ columns: [{}, {}], rows: [["a", "b"], ["a"]] }, buildOptions))
      .toThrow("Row 2 must have 2 columns");
  });

  it("rejects a ragged header row, naming the row", () => {
    expect(() => buildTableObject({ columns: [{}], headerRows: [["a", "b"]], rows: [["a"]] }, buildOptions))
      .toThrow("Header row 1 must have 1 columns");
  });

  it("rejects spans that do not match the cell text", () => {
    expect(() => buildTableObject({
      columns: [{}],
      rows: [[{ text: "a", spans: [{ text: "b" }] }]]
    }, buildOptions)).toThrow("Span text must match cell text");
  });

  it("rejects too many rows, columns, and footnotes", () => {
    const tooManyRows = Array.from({ length: 501 }, () => [""]);
    expect(() => buildTableObject({ columns: [{}], rows: tooManyRows }, buildOptions))
      .toThrow(/at most 500[\s\S]*"rows"/);
    const tooManyColumns = Array.from({ length: 65 }, () => ({}));
    expect(() => buildTableObject({ columns: tooManyColumns, rows: [] }, buildOptions))
      .toThrow(/at most 64[\s\S]*"columns"/);
    expect(() => buildTableObject({ columns: [{}], rows: [[""]], footnotes: Array(51).fill("note") }, buildOptions))
      .toThrow(/at most 50[\s\S]*"footnotes"/);
  });

  it("rejects a table with no rows at all", () => {
    expect(() => buildTableObject({ columns: [{}], rows: [] }, buildOptions))
      .toThrow("Table must have 1 to 500 rows including headers");
  });

  it("rejects a cell over 2000 characters, naming its position", () => {
    expect(() => buildTableObject({ columns: [{}, {}], rows: [["a", "b"], ["a", "x".repeat(2001)]] }, buildOptions))
      .toThrow(/at most 2000[\s\S]*"rows"[\s\S]*1[\s\S]*1/);
  });
});

describe("row edits", () => {
  it("inserts rows inside the header block and grows headerRowCount", () => {
    const { table, label } = edit((input) => insertTableRows(input, 0, 2, newId));
    expect(label).toBe("Insert 2 rows");
    expect(table.rows).toHaveLength(fixtureTable.rows.length + 2);
    expect(table.headerRowCount).toBe(fixtureTable.headerRowCount + 2);
    expect(table.rows[0].cells).toHaveLength(fixtureTable.columns.length);
    expect(table.rows[0].cells.every((cell) => cell.text === "" && cell.spans.length === 0)).toBe(true);
    expect(table.rows[2].id).toBe(firstRowId);
  });

  it("inserts rows outside the header block without changing headerRowCount", () => {
    const single = edit((input) => insertTableRows(input, fixtureTable.headerRowCount, 1, newId));
    expect(single.label).toBe("Insert row");
    expect(single.table.headerRowCount).toBe(fixtureTable.headerRowCount);
    expect(single.table.rows[0].id).toBe(firstRowId);
    expect(single.table.rows[1].cells.every((cell) => cell.text === "")).toBe(true);
    const atEnd = edit((input) => insertTableRows(input, input.rows.length, 3, newId));
    expect(atEnd.label).toBe("Insert 3 rows");
    expect(atEnd.table.headerRowCount).toBe(fixtureTable.headerRowCount);
    expect(atEnd.table.rows.slice(0, fixtureTable.rows.length)).toEqual(fixtureTable.rows);
  });

  it("deletes body rows and keeps headerRowCount", () => {
    const one = edit((input) => deleteTableRows(input, ["row-det"]));
    expect(one.label).toBe("Delete row");
    expect(one.table.rows.map((row) => row.id)).not.toContain("row-det");
    expect(one.table.headerRowCount).toBe(fixtureTable.headerRowCount);
    const two = edit((input) => deleteTableRows(input, ["row-det", "row-tbhp"]));
    expect(two.label).toBe("Delete 2 rows");
    expect(two.table.rows).toHaveLength(fixtureTable.rows.length - 2);
  });

  it("deletes header rows and reduces headerRowCount", () => {
    const { table, label } = edit((input) => deleteTableRows(input, [firstRowId, "row-det"]));
    expect(label).toBe("Delete 2 rows");
    expect(table.headerRowCount).toBe(0);
    expect(table.rows.map((row) => row.id)).toEqual([
      "row-allyl-alcohol",
      "row-titanium",
      "row-tbhp",
      "row-dichloromethane"
    ]);
  });
});

describe("column edits", () => {
  it("inserts columns with blank cells in every row", () => {
    const { table, label } = edit((input) => insertTableColumns(input, 1, 2, newId));
    expect(label).toBe("Insert 2 columns");
    expect(table.columns).toHaveLength(fixtureTable.columns.length + 2);
    expect(table.columns.slice(1, 3).map((column) => [column.align, column.width, column.formula])).toEqual([
      ["left", { mode: "auto" }, "auto"],
      ["left", { mode: "auto" }, "auto"]
    ]);
    for (const [index, row] of table.rows.entries()) {
      const original = fixtureTable.rows[index].cells;
      expect(row.cells).toHaveLength(original.length + 2);
      expect(row.cells[0]).toEqual(original[0]);
      expect(row.cells.slice(1, 3)).toEqual([{ text: "", spans: [] }, { text: "", spans: [] }]);
      expect(row.cells.slice(3)).toEqual(original.slice(1));
    }
    const single = edit((input) => insertTableColumns(input, input.columns.length, 1, newId));
    expect(single.label).toBe("Insert column");
    expect(single.table.columns).toHaveLength(fixtureTable.columns.length + 1);
  });

  it("deletes columns and their cells", () => {
    const { table, label } = edit((input) => deleteTableColumns(input, ["col-mw", "col-mass"]));
    expect(label).toBe("Delete 2 columns");
    expect(table.columns.map((column) => column.id)).toEqual([
      "col-material",
      "col-density",
      "col-equiv",
      "col-mmol",
      "col-volume"
    ]);
    expect(table.rows[1].cells.map((cell) => cell.text)).toEqual(["allyl alcohol", "0.854", "1.00", "17.22", "1.17"]);
    const single = edit((input) => deleteTableColumns(input, [firstColumnId]));
    expect(single.label).toBe("Delete column");
    expect(single.table.rows[0].cells[0].text).toBe("MW (g/mol)");
  });
});

describe("cell and formula edits", () => {
  it("sets a cell", () => {
    const rich: TableRichText = { text: "X2", spans: [{ text: "X", script: "normal", style: {} }, { text: "2", script: "subscript", style: {} }] };
    const { table, label } = edit((input) => setTableCell(input, "row-titanium", firstColumnId, rich));
    expect(label).toBe("Edit cell");
    expect(cellOf(table, "row-titanium", firstColumnId)).toEqual(rich);
    expect(cellOf(table, "row-titanium", "col-mw")).toEqual({ text: "284.22", spans: [] });
  });

  it("keeps a cell's formula rule when its text changes", () => {
    const ruled = edit((input) => setTableCellFormulaRule(input, "row-det", "col-mw", "auto")).table;
    const { table } = setTableCell(ruled, "row-det", "col-mw", { text: "1", spans: [] });
    expect(cellOf(table, "row-det", "col-mw")).toEqual({ text: "1", spans: [], formula: "auto" });
  });

  it("formats a cell formula and returns undefined when nothing changes", () => {
    const edited = edit((input) => setTableCell(input, "row-det", firstColumnId, { text: "H2O", spans: [] })).table;
    const formatted = formatTableCellFormula(deepFreeze(structuredClone(edited)), "row-det", firstColumnId);
    expect(formatted?.label).toBe("Format formula");
    expect(cellOf(formatted!.table, "row-det", firstColumnId).spans.map((span) => [span.text, span.script])).toEqual([
      ["H", "normal"],
      ["2", "subscript"],
      ["O", "normal"]
    ]);
    expectFramed(formatted!.table);
    expect(edit((input) => formatTableCellFormula(input, firstRowId, firstColumnId))).toBeUndefined();
    expect(edit((input) => formatTableCellFormula(input, "row-allyl-alcohol", firstColumnId))).toBeUndefined();
  });

  it("sets a cell formula rule", () => {
    const { table, label } = edit((input) => setTableCellFormulaRule(input, "row-det", firstColumnId, "off"));
    expect(label).toBe("Set formula rule");
    expect(cellOf(table, "row-det", firstColumnId)).toEqual({ text: "(+)-DET", spans: [], formula: "off" });
  });
});

describe("column and table settings", () => {
  it("sets column alignment", () => {
    const { table, label } = edit((input) => setTableColumnAlign(input, "col-mw", "right"));
    expect(label).toBe("Align column");
    expect(table.columns.map((column) => column.align)).toEqual([
      "left",
      "right",
      "decimal",
      "decimal",
      "decimal",
      "decimal",
      "decimal"
    ]);
  });

  it("sets column width to fixed and back to auto", () => {
    const fixed = edit((input) => setTableColumnWidth(input, firstColumnId, { mode: "fixed", px: 90 }));
    expect(fixed.label).toBe("Resize column");
    expect(fixed.table.columns[0].width).toEqual({ mode: "fixed", px: 90 });
    const auto = setTableColumnWidth(fixed.table, firstColumnId, { mode: "auto" });
    expect(auto.label).toBe("Resize column");
    expect(auto.table.columns[0].width).toEqual({ mode: "auto" });
    expectFramed(auto.table);
  });

  it("sets the header row count across its whole range", () => {
    const none = edit((input) => setTableHeaderRowCount(input, 0));
    expect(none.label).toBe("Set header rows");
    expect(none.table.headerRowCount).toBe(0);
    const all = edit((input) => setTableHeaderRowCount(input, input.rows.length));
    expect(all.table.headerRowCount).toBe(fixtureTable.rows.length);
  });

  it("sets the table style, merging with the existing style", () => {
    const { table, label } = edit((input) => setTableStyle(input, { preset: "grid", headerBold: true }));
    expect(label).toBe("Style table");
    expect(table.tableStyle).toEqual({ ...fixtureTable.tableStyle, preset: "grid", headerBold: true });
  });

  it("sets and clears the caption", () => {
    const caption: TableRichText = { text: "New caption", spans: [] };
    const set = edit((input) => setTableCaption(input, caption));
    expect(set.label).toBe("Edit caption");
    expect(set.table.caption).toEqual(caption);
    const cleared = edit((input) => setTableCaption(input, undefined));
    expect(cleared.label).toBe("Edit caption");
    expect(cleared.table.caption).toBeUndefined();
  });

  it("sets footnotes", () => {
    const notes: TableRichText[] = [{ text: "One", spans: [] }, { text: "Two", spans: [] }];
    const { table, label } = edit((input) => setTableFootnotes(input, notes));
    expect(label).toBe("Edit footnotes");
    expect(table.footnotes).toEqual(notes);
    expect(edit((input) => setTableFootnotes(input, [])).table.footnotes).toEqual([]);
  });
});

describe("refusals", () => {
  const rowCount = fixtureTable.rows.length;
  const columnCount = fixtureTable.columns.length;

  it("refuses bad row insert indices and counts", () => {
    expect(() => insertTableRows(fixtureTable, -1, 1, newId))
      .toThrow(`Row index -1 is outside 0..${rowCount} for table "${tableId}".`);
    expect(() => insertTableRows(fixtureTable, rowCount + 1, 1, newId))
      .toThrow(`Row index ${rowCount + 1} is outside 0..${rowCount} for table "${tableId}".`);
    expect(() => insertTableRows(fixtureTable, 1.5, 1, newId))
      .toThrow(`Row index 1.5 is outside 0..${rowCount} for table "${tableId}".`);
    expect(() => insertTableRows(fixtureTable, 0, 0, newId))
      .toThrow(`Row count 0 must be a positive integer for table "${tableId}".`);
    expect(() => insertTableRows(fixtureTable, 0, 1.5, newId))
      .toThrow(`Row count 1.5 must be a positive integer for table "${tableId}".`);
  });

  it("refuses bad column insert indices and counts", () => {
    expect(() => insertTableColumns(fixtureTable, -1, 1, newId))
      .toThrow(`Column index -1 is outside 0..${columnCount} for table "${tableId}".`);
    expect(() => insertTableColumns(fixtureTable, columnCount + 1, 1, newId))
      .toThrow(`Column index ${columnCount + 1} is outside 0..${columnCount} for table "${tableId}".`);
    expect(() => insertTableColumns(fixtureTable, 0, 0, newId))
      .toThrow(`Column count 0 must be a positive integer for table "${tableId}".`);
    expect(() => insertTableColumns(fixtureTable, 0, -2, newId))
      .toThrow(`Column count -2 must be a positive integer for table "${tableId}".`);
  });

  it("refuses to pass the row and column limits", () => {
    expect(() => insertTableRows(fixtureTable, 0, 495, newId))
      .toThrow(`Table "${tableId}" would have 501 rows; the limit is 500.`);
    expect(() => insertTableColumns(fixtureTable, 0, 58, newId))
      .toThrow(`Table "${tableId}" would have 65 columns; the limit is 64.`);
    expect(insertTableRows(fixtureTable, 0, 494, newId).table.rows).toHaveLength(500);
    expect(insertTableColumns(fixtureTable, 0, 57, newId).table.columns).toHaveLength(64);
  });

  it("refuses unknown rows and columns", () => {
    expect(() => deleteTableRows(fixtureTable, [firstRowId, "nope"])).toThrow(`Table "${tableId}" has no row "nope".`);
    expect(() => deleteTableColumns(fixtureTable, ["nope"])).toThrow(`Table "${tableId}" has no column "nope".`);
    expect(() => setTableCell(fixtureTable, "nope", firstColumnId, { text: "", spans: [] }))
      .toThrow(`Table "${tableId}" has no row "nope".`);
    expect(() => setTableCell(fixtureTable, firstRowId, "nope", { text: "", spans: [] }))
      .toThrow(`Table "${tableId}" has no column "nope".`);
    expect(() => formatTableCellFormula(fixtureTable, "nope", firstColumnId))
      .toThrow(`Table "${tableId}" has no row "nope".`);
    expect(() => setTableCellFormulaRule(fixtureTable, firstRowId, "nope", "off"))
      .toThrow(`Table "${tableId}" has no column "nope".`);
    expect(() => setTableColumnAlign(fixtureTable, "nope", "left")).toThrow(`Table "${tableId}" has no column "nope".`);
    expect(() => setTableColumnWidth(fixtureTable, "nope", { mode: "auto" }))
      .toThrow(`Table "${tableId}" has no column "nope".`);
  });

  it("refuses deleting every row or every column", () => {
    expect(() => deleteTableRows(fixtureTable, fixtureTable.rows.map((row) => row.id)))
      .toThrow(`Cannot delete every row of table "${tableId}".`);
    expect(() => deleteTableColumns(fixtureTable, fixtureTable.columns.map((column) => column.id)))
      .toThrow(`Cannot delete every column of table "${tableId}".`);
  });

  it("refuses a header row count outside the table", () => {
    expect(() => setTableHeaderRowCount(fixtureTable, rowCount + 1))
      .toThrow(`Header row count ${rowCount + 1} is outside 0..${rowCount} for table "${tableId}".`);
    expect(() => setTableHeaderRowCount(fixtureTable, -1))
      .toThrow(`Header row count -1 is outside 0..${rowCount} for table "${tableId}".`);
  });

  it("refuses spans that do not match a cell's text", () => {
    expect(() => setTableCell(fixtureTable, firstRowId, firstColumnId, {
      text: "a",
      spans: [{ text: "b", script: "normal", style: {} }]
    })).toThrow(`Spans do not match cell text in row "${firstRowId}", column "${firstColumnId}" of table "${tableId}".`);
  });
});
