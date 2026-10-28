import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEmptyDocument, deserializeDocument, migrateDocument, parseDocument, serializeDocument } from "./document";
import { applyPatch, DocumentPatchError } from "./patches";
import { TABLE_LIMITS, TableObjectSchema, type TableObject } from "./schemas";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/tables/sharpless-reagent-table.json", import.meta.url), "utf8")) as unknown;
const document = parseDocument(fixture);
const table = document.pages[0]!.objects[0] as TableObject;

describe("table objects", () => {
  it("enforces the new content and font limits at their boundaries", () => {
    const cell = { text: "x", spans: Array(200).fill({ text: "x", style: {}, script: "normal" }) };
    const base = { ...table, columns: [table.columns[0]], rows: [{ id: "r", cells: [cell] }],
      caption: undefined, footnotes: [], headerRowCount: 0,
      style: { fontFamily: "x".repeat(200), fontSizePx: 400 } };
    expect(TableObjectSchema.safeParse(base).success).toBe(true);
    expect(() => TableObjectSchema.parse({ ...base, rows: [{ id: "r", cells: [{ ...cell,
      spans: [...cell.spans, cell.spans[0]] }] }] })).toThrow(/maxSpansPerCell.*200.*201/);
    expect(() => TableObjectSchema.parse({ ...base, style: { fontFamily: "x".repeat(201) } }))
      .toThrow(/maxFontFamilyLength.*200.*201/);
    for (const size of [0, 401]) {
      expect(() => TableObjectSchema.parse({ ...base, style: { fontSizePx: size } }))
        .toThrow(new RegExp(`fontSizePx.*400.*${size}`));
    }
    const rows = Array.from({ length: 100 }, (_, i) =>
      ({ id: `r${i}`, cells: [{ text: "x".repeat(2000) }] }));
    expect(TableObjectSchema.safeParse({ ...base, rows }).success).toBe(true);
    expect(() => TableObjectSchema.parse({ ...base, rows, caption: { text: "x" } }))
      .toThrow(/maxTableCharacters.*200000.*200001/);
  });
  it("parses and round-trips the complete fixture", () => {
    expect(document).toEqual(fixture);
    expect(deserializeDocument(serializeDocument(document))).toEqual(fixture);
  });

  it("identifies malformed rows and columns", () => {
    expect(() => TableObjectSchema.parse({ ...table, rows: [{ ...table.rows[0], cells: [] }] })).toThrow(/row-header/i);
    expect(() => TableObjectSchema.parse({ ...table, rows: [table.rows[0], table.rows[0]] })).toThrow(/row-header/i);
    expect(() => TableObjectSchema.parse({ ...table, columns: [table.columns[0], table.columns[0]] })).toThrow(/col-material/i);
    expect(() => TableObjectSchema.parse({ ...table, headerRowCount: 7 })).toThrow(/header row/i);
  });

  it("enforces limits and finite style and width bounds", () => {
    const column = table.columns[0]!;
    const cell = table.rows[0]!.cells[0]!;
    const columns = Array.from({ length: TABLE_LIMITS.maxColumns }, (_, i) => ({ ...column, id: `c${i}` }));
    const rows = Array.from({ length: TABLE_LIMITS.maxRows }, (_, i) =>
      ({ id: `r${i}`, cells: columns.map(() => ({ ...cell, text: "", spans: [] })) }));
    const maximum = { ...table, columns, rows, caption: { text: "x".repeat(2000), spans: [] }, footnotes: Array.from({ length: 50 }, () => ({ text: "x", spans: [] })) };
    expect(TableObjectSchema.safeParse(maximum).success).toBe(true);
    expect(TableObjectSchema.safeParse({ ...maximum, columns: [...columns, { ...column, id: "extra" }] }).success).toBe(false);
    expect(TableObjectSchema.safeParse({ ...maximum, rows: [...rows, { ...rows[0], id: "extra" }] }).success).toBe(false);
    expect(TableObjectSchema.safeParse({ ...table, columns: [] }).success).toBe(false);
    expect(TableObjectSchema.safeParse({ ...table, rows: [] }).success).toBe(false);
    expect(TableObjectSchema.safeParse({ ...table, rows: [{ id: "r", cells: table.columns.map(() => ({ text: "x".repeat(2001) })) }] }).success).toBe(false);
    expect(TableObjectSchema.safeParse({ ...table, caption: { text: "x".repeat(2001) } }).success).toBe(false);
    expect(TableObjectSchema.safeParse({ ...maximum, footnotes: [...maximum.footnotes, { text: "x" }] }).success).toBe(false);
    for (const px of [0, 4001, Infinity]) expect(TableObjectSchema.safeParse({ ...table, columns: [{ ...column, width: { mode: "fixed", px } }] }).success).toBe(false);
    for (const topRulePt of [-1, 7, Infinity]) expect(TableObjectSchema.safeParse({ ...table, tableStyle: { topRulePt } }).success).toBe(false);
  });

  it("fills defaults and degrades unknown alignment", () => {
    const parsed = TableObjectSchema.parse({ ...table, columns: table.columns.map((column, i) => i ? column : { ...column, align: "future", formula: undefined }), rows: table.rows.map(row => ({ ...row, cells: row.cells.map(cell => ({ text: cell.text })) })), footnotes: undefined, tableStyle: {} });
    expect(parsed.columns[0]).toMatchObject({ align: "unknown", formula: "auto" });
    expect(parsed.rows[0]!.cells[0]!.spans).toEqual([]);
    expect(parsed.footnotes).toEqual([]);
    expect(parsed.tableStyle).toEqual({ preset: "three-line", topRulePt: 1, headerRulePt: 0.5, bottomRulePt: 1, gridRulePt: 0.5, headerBold: false, cellPaddingPx: { x: 6, y: 2 } });
    expect(parseDocument({ ...document, pages: [{ ...document.pages[0], objects: [parsed] }] }).pages[0]!.objects[0]).toEqual(parsed);
  });

  it("hints at newer versions for unknown object types and table versions", () => {
    for (const object of [{ ...table, type: "future-object" }, { ...table, tableVersion: 2 }]) {
      expect(() => migrateDocument({ ...document, pages: [{ ...document.pages[0], objects: [object] }] })).toThrow(/The file may have been saved by a newer version of ChemDraft\.$/);
    }
  });

  it("validates table additions and updates through patches", () => {
    const empty = createEmptyDocument({ now: "2026-01-01T00:00:00.000Z" });
    const added = applyPatch(empty, { op: "addObject", pageId: empty.pages[0]!.id, object: table });
    expect(parseDocument(added).pages[0]!.objects[0]).toEqual(table);
    expect(() => applyPatch(added, { op: "updateObject", objectId: table.id, changes: { rows: [{ ...table.rows[0]!, cells: [] }] } })).toThrow(DocumentPatchError);
  });
});
