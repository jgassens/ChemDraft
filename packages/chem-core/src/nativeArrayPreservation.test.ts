import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, parseDocument, readDocument, serializeDocument, serializeDocumentWithWarnings } from "./document";
import type { GraphicObject, ReactionObject, TableObject, TextObject } from "./schemas";

const base = { x: 0, y: 0, width: 100, height: 30, rotation: 0, style: {} };

function sourceDocument() {
  return JSON.parse(JSON.stringify({ ...createEmptyDocument(), formatVersion: "1.3.0", minAppVersion: "1.3.0",
    ignorableFields: ["pages.*.objects.*[type=reaction].components.*.visualDecoration"] }));
}

function tableSource() {
  const source = sourceDocument();
  source.pages[0].objects.push({ ...base, id: "table", type: "table", tableVersion: 1, headerRowCount: 0,
    columns: ["a", "b", "c"].map(id => ({ id, align: "left", width: { mode: "auto" }, futureColumn: id })),
    rows: [{ id: "row", cells: ["a", "b", "c"].map(text => ({ text, futureCell: text })) }] });
  return source;
}

afterEach(() => vi.restoreAllMocks());

describe("preservation by stable identity", () => {
  it.each(["insert", "delete", "reorder"])("keeps future column fields with their IDs on %s and warns when their cells cannot be restored", edit => {
    const source = tableSource();
    const document = readDocument(source).document;
    const table = document.pages[0]!.objects[0] as TableObject;
    if (edit === "insert") {
      table.columns.unshift({ id: "new", align: "right", width: { mode: "auto" }, formula: "auto" });
      table.rows[0]!.cells.unshift({ text: "new", spans: [] });
    } else if (edit === "delete") {
      table.columns.splice(1, 1);
      table.rows[0]!.cells.splice(1, 1);
    } else {
      table.columns.reverse();
      table.rows[0]!.cells.reverse();
    }
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = serializeDocumentWithWarnings(parseDocument(document));
    const saved = JSON.parse(result.contents).pages[0].objects[0];
    for (const column of saved.columns) {
      if (column.id === "new") expect(column).not.toHaveProperty("futureColumn");
      else expect(column.futureColumn).toBe(column.id);
    }
    expect(saved.rows[0].cells.every((cell: object) => !Object.hasOwn(cell, "futureCell"))).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "NATIVE_EXTENSION_DATA_DROPPED",
      path: ["pages", document.pages[0]!.id, "objects", "table", "rows", "row", "cells"] }));
    expect(log.mock.calls.map(call => call[1])).toEqual(result.warnings);
    if (edit === "delete") {
      expect(saved.columns.some((column: { id: string }) => column.id === "b")).toBe(false);
      expect(result.warnings.some(warning => warning.path.at(-1) === "columns")).toBe(true);
    }
  });

  it("preserves unchanged columns and cells, including defaults added during reading", () => {
    const source = tableSource();
    const document = readDocument(source).document;
    const result = serializeDocumentWithWarnings(document);
    expect(result.warnings).toEqual([]);
    expect(JSON.parse(result.contents).pages[0].objects[0]).toMatchObject(source.pages[0].objects[0]);
    expect(JSON.parse(serializeDocument(readDocument(JSON.parse(result.contents)).document)))
      .toEqual(JSON.parse(result.contents));
  });

  it("drops cell extensions if only the column order changed, even when cell content is identical", () => {
    const source = tableSource();
    source.pages[0].objects[0].rows[0].cells.forEach((cell: { text: string }) => { cell.text = "same"; });
    const document = readDocument(source).document;
    (document.pages[0]!.objects[0] as TableObject).columns.reverse();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = serializeDocumentWithWarnings(document);
    const saved = JSON.parse(result.contents).pages[0].objects[0];
    expect(saved.columns.map((column: { futureColumn: string }) => column.futureColumn)).toEqual(["c", "b", "a"]);
    expect(saved.rows[0].cells.every((cell: object) => !Object.hasOwn(cell, "futureCell"))).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("guarded identity-free arrays", () => {
  it.each(["text spans", "reaction components", "visual effects", "table cell spans"])("round-trips unchanged %s", kind => {
    const source = sourceDocument();
    source.pages[0].objects = [arrayObject(kind)];
    const result = serializeDocumentWithWarnings(readDocument(source).document);
    expect(result.warnings).toEqual([]);
    expect(JSON.parse(result.contents).pages[0].objects[0]).toMatchObject(source.pages[0].objects[0]);
  });

  it.each(["text spans", "reaction components", "visual effects", "table cell spans"].flatMap(kind =>
    ["insert", "delete", "reorder"].map(edit => ({ kind, edit }))))("drops future $kind data on $edit without attaching it elsewhere", ({ kind, edit }) => {
    const source = sourceDocument();
    source.pages[0].objects = [arrayObject(kind)];
    const document = readDocument(source).document;
    const object = document.pages[0]!.objects[0]!;
    const array = kind === "text spans" ? (object as TextObject).spans
      : kind === "reaction components" ? (object as ReactionObject).components
        : kind === "visual effects" ? (object as GraphicObject).style.visualEffects!
          : (object as TableObject).rows[0]!.cells[0]!.spans;
    if (edit === "insert") array.unshift({ ...array[0]! } as never);
    else if (edit === "delete") array.splice(0, 1);
    else array.reverse();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = serializeDocumentWithWarnings(parseDocument(document));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: "NATIVE_EXTENSION_DATA_DROPPED" });
    expect(result.warnings[0]!.message).toMatch(/Newer-version data.*was dropped because this array was edited/);
    expect(log).toHaveBeenCalledWith("Native document compatibility", result.warnings[0]);
    const saved = JSON.parse(result.contents);
    expect(result.contents).not.toContain("visualDecoration");
    expect(result.contents).not.toContain("sparkles");
    expect(saved.pages[0].objects[0].id).toBe(object.id);
  });

  it("does not invalidate later guards while restoring multiple fields in the same array", () => {
    const source = sourceDocument();
    source.pages[0].objects = [arrayObject("text spans")];
    source.pages[0].objects[0].spans[0].futureFont = "font";
    const result = serializeDocumentWithWarnings(readDocument(source).document);
    expect(result.warnings).toEqual([]);
    expect(JSON.parse(result.contents).pages[0].objects[0]).toMatchObject(source.pages[0].objects[0]);
  });

  it("ignores property ordering when comparing known content", () => {
    const source = sourceDocument();
    source.pages[0].objects = [arrayObject("text spans")];
    const document = readDocument(source).document;
    const text = document.pages[0]!.objects[0] as TextObject;
    text.spans = text.spans.map(span => ({ style: span.style, script: span.script, text: span.text }));
    const result = serializeDocumentWithWarnings(document);
    expect(result.warnings).toEqual([]);
    expect(JSON.parse(result.contents).pages[0].objects[0]).toMatchObject(source.pages[0].objects[0]);
  });
});

function arrayObject(kind: string) {
  const spans = ["first", "second"].map(text => ({ text, visualDecoration: { color: text } }));
  if (kind === "text spans") return { ...base, id: "text", type: "text", text: "firstsecond", spans };
  if (kind === "reaction components") return { ...base, id: "reaction", type: "reaction",
    components: ["reactant", "product"].map((role, index) => ({ role, objectId: `m${index}`, visualDecoration: { color: role } })) };
  if (kind === "visual effects") return { ...base, id: "graphic", type: "graphic", graphicKind: "rect", data: {},
    style: { visualEffects: [{ kind: "sparkles", strength: 2 }, { kind: "glow", opacity: 0.5, visualDecoration: "blue" }] } };
  return { ...base, id: "table", type: "table", tableVersion: 1, headerRowCount: 0,
    columns: [{ id: "c", align: "left", width: { mode: "auto" } }],
    rows: [{ id: "r", cells: [{ text: "firstsecond", spans }] }] };
}
