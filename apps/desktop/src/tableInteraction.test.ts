import { describe, expect, it } from "vitest";
import { TABLE_LIMITS } from "@chemdraft/chem-core";
import { buildTableObject } from "@chemdraft/document-workflow-core";
import { planTableLayout, transformPointForObject } from "@chemdraft/layout-engine";
import { tableCellAtPoint, tableTextAtPoint, tableEditingKeyAction } from "./tableInteraction";

let id = 0;
const table = buildTableObject({ columns: [{ widthPx: 80 }, { widthPx: 90 }], rows: [["", ""], ["", ""]] },
  { id: "table", x: 30, y: 50, newId: prefix => `${prefix}-${++id}` }).object;
const cell = (row: number, column: number) => ({ tableId: table.id, rowId: table.rows[row].id, columnId: table.columns[column].id });
const move = (row: number, column: number) => ({ kind: "commit", next: cell(row, column) });
const decide = (key: string, row = 0, column = 0, text = "abc", start = 1, end = start,
  modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean } = {}) =>
  tableEditingKeyAction(table, cell(row, column), { key, ...modifiers }, text, start, end);

describe("table cell editing decisions (shared by macOS and Windows)", () => {
  it("finds captions and empty footnotes across the table width, including rotation", () => {
    const withNotes = { ...table, rotation: 30, caption: { text: "Caption", spans: [] },
      footnotes: [{ text: "", spans: [] }, { text: "Last", spans: [] }] };
    const layout = planTableLayout(withNotes);
    for (const [box, target] of [[layout.captionBox!, { tableId: table.id, kind: "caption" }],
      ...layout.footnoteBoxes.map((box, index) =>
        [box, { tableId: table.id, kind: "footnote", index }] as const)] as const) {
      const point = transformPointForObject(withNotes, { x: box.x + layout.width / 2,
        y: box.y + box.height / 2 });
      expect(tableTextAtPoint(withNotes, point)).toEqual(target);
      expect(tableCellAtPoint(withNotes, point)).toBeUndefined();
    }
  });
  it("commits notes on Enter, cancels Escape and leaves Tab/arrows as ordinary text keys", () => {
    for (const target of [{ tableId: table.id, kind: "caption" },
      { tableId: table.id, kind: "footnote", index: 0 }] as const) {
      expect(tableEditingKeyAction(table, target, { key: "Enter" }, "", 0)).toEqual({ kind: "commit" });
      expect(tableEditingKeyAction(table, target, { key: "Escape" }, "", 0)).toEqual({ kind: "cancel" });
      for (const key of ["Tab", "ArrowLeft", "ArrowDown"]) {
        expect(tableEditingKeyAction(table, target, { key }, "", 0)).toEqual({ kind: "caret" });
      }
    }
  });
  it("Tabs in row-major order and inserts a row only after the final cell", () => {
    expect(decide("Tab")).toEqual(move(0, 1));
    expect(decide("Tab", 0, 1)).toEqual(move(1, 0));
    expect(decide("Tab", 1, 1)).toEqual({ kind: "commit", insertRow: true });
    expect(decide("Tab", 1, 0, "abc", 1, 1, { shiftKey: true })).toEqual(move(0, 1));
    expect(decide("Tab", 0, 0, "abc", 1, 1, { shiftKey: true })).toEqual({ kind: "commit" });
  });
  it("does not request rows beyond the native limit", () => {
    const full = { ...table, rows: Array.from({ length: TABLE_LIMITS.maxRows }, (_, index) => ({ ...table.rows[0], id: `r${index}` })) };
    expect(tableEditingKeyAction(full, { ...cell(0, 1), rowId: full.rows.at(-1)!.id }, { key: "Tab" }, "", 0))
      .toEqual({ kind: "commit", insertRow: false });
  });
  it("Enter moves down or stops at the last row; Shift+Enter inserts a line break", () => {
    expect(decide("Enter", 0, 1)).toEqual(move(1, 1));
    expect(decide("Enter", 1, 1)).toEqual({ kind: "commit" });
    expect(decide("Enter", 1, 1, "abc", 1, 1, { shiftKey: true })).toEqual({ kind: "lineBreak" });
    expect(decide("Escape")).toEqual({ kind: "cancel" });
  });
  it("horizontal arrows cross a boundary only at a collapsed start/end", () => {
    expect(decide("ArrowLeft", 0, 1, "abc", 0)).toEqual(move(0, 0));
    expect(decide("ArrowRight", 0, 0, "abc", 3)).toEqual(move(0, 1));
    expect(decide("ArrowLeft", 0, 0, "abc", 0)).toEqual({ kind: "commit" });
    expect(decide("ArrowRight", 0, 1, "abc", 3)).toEqual({ kind: "commit" });
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      expect(decide(key)).toEqual({ kind: "caret" });
      expect(decide(key, 0, 0, "abc", 0, 3)).toEqual({ kind: "caret" });
    }
  });
  it("vertical arrows cross only from the first/last unwrapped line", () => {
    expect(decide("ArrowUp", 1, 1, "abc\ndef\nghi", 2)).toEqual(move(0, 1));
    expect(decide("ArrowDown", 0, 1, "abc\ndef\nghi", 9)).toEqual(move(1, 1));
    expect(decide("ArrowUp", 1, 1, "abc\ndef\nghi", 4)).toEqual({ kind: "caret" });
    expect(decide("ArrowDown", 0, 1, "abc\ndef\nghi", 6)).toEqual({ kind: "caret" });
    expect(decide("ArrowUp", 0, 0)).toEqual({ kind: "commit" });
    expect(decide("ArrowDown", 1, 0)).toEqual({ kind: "commit" });
  });
  it("leaves selection, word-navigation, composition and ordinary typing with the textarea", () => {
    for (const modifiers of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
      expect(decide("ArrowLeft", 0, 1, "abc", 0, 0, modifiers)).toEqual({ kind: "caret" });
    }
    expect(decide("Enter", 0, 1, "", 0, 0, { isComposing: true })).toEqual({ kind: "caret" });
    expect(decide("x")).toEqual({ kind: "caret" });
  });
  it("hit-tests the layout's actual cells, including stored-frame rotation", () => {
    const rotated = { ...table, rotation: 37 };
    const box = planTableLayout(rotated).cells[3].box;
    const point = transformPointForObject(rotated, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(tableCellAtPoint(rotated, point)).toEqual(cell(1, 1));
    expect(tableCellAtPoint(table, { x: 0, y: 0 })).toBeUndefined();
  });
});
