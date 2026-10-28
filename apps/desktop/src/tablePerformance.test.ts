// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TableObjectSchema, type TableObject } from "@chemdraft/chem-core";
import * as workflow from "@chemdraft/document-workflow-core";
import {
  planTableLayout, planTableObjectSvg, tableVisualBoundsForArrangement
} from "@chemdraft/layout-engine";
import { TableColumnResizers } from "./tableCellEditor";
import {
  arrangeSelectedDocumentObjects, createPhase4Document, documentObjectInteractionBounds,
  documentObjectVisualBounds, selectionBounds
} from "./documentWorkflow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = JSON.parse(readFileSync(resolve(
  "packages/fixtures/tables/sharpless-reagent-table.json"
), "utf8")).pages[0].objects[0] as TableObject;
const columns = Array.from({ length: 64 }, (_, index) => ({
  ...fixture.columns[0], id: `c${index}`, width: { mode: "fixed" as const, px: 80 }
}));
const largeTable = TableObjectSchema.parse({ ...fixture, caption: undefined, footnotes: [], columns,
  rows: Array.from({ length: 500 }, (_, row) => ({ id: `r${row}`,
    cells: columns.map((_, column) => ({ text: `${row}.${column}`, spans: [] })) })) });

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("table performance", () => {
  it("reuses layout and SVG identity for a 500 by 64 snapshot, never for another object", () => {
    const layout = planTableLayout(largeTable), svg = planTableObjectSvg(largeTable, 0);
    expect(layout.cells).toHaveLength(500 * 64);
    expect(planTableLayout(largeTable)).toBe(layout);
    expect(planTableObjectSvg(largeTable, 0)).toBe(svg);
    const replacement = { ...largeTable, columns: largeTable.columns.map((column, index) =>
      index === 0 ? { ...column, width: { mode: "fixed" as const, px: 120 } } : column) };
    expect(planTableLayout(replacement)).not.toBe(layout);
    expect(planTableLayout(replacement).columns[0].width).toBe(120);
    expect(layout.columns[0].width).toBe(80);
    expect(planTableObjectSvg(replacement, 0)).not.toBe(svg);
    expect(planTableObjectSvg({ ...largeTable }, 0)).not.toBe(svg);
  }, 20000);

  it("coalesces 20 drag steps without validation and validates only the final commit", async () => {
    const parse = vi.spyOn(TableObjectSchema, "parse");
    const setWidth = vi.spyOn(workflow, "setTableColumnWidth");
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div"), root = createRoot(container);
    document.body.append(container);
    const preview = vi.fn(), commit = vi.fn();
    function Harness() {
      const [table, setTable] = useState(largeTable);
      return createElement(TableColumnResizers, { table, scale: 1, onCommit: commit,
        onPreview: value => { preview(value); setTable(value ?? largeTable); } });
    }
    const pointer = async (target: EventTarget, type: string, x: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
      Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true } });
      await act(async () => { target.dispatchEvent(event); });
    };
    try {
      await act(async () => root.render(createElement(Harness)));
      const handle = container.querySelector<HTMLElement>("[data-table-column-resizer]")!;
      handle.setPointerCapture = vi.fn();
      await pointer(handle, "pointerdown", 100);
      for (let step = 1; step <= 20; step++) {
        await pointer(window, "pointermove", 100 + step);
        expect(parse).not.toHaveBeenCalled();
        expect(setWidth).not.toHaveBeenCalled();
        expect(preview).toHaveBeenCalledTimes(Math.floor((step - 1) / 4));
        if (step % 4 === 0) await act(async () => vi.advanceTimersToNextFrame());
      }
      expect(preview).toHaveBeenCalledTimes(5);
      const last = preview.mock.lastCall![0] as TableObject;
      expect(last.rows).toBe(largeTable.rows);
      expect(last.columns[1]).toBe(largeTable.columns[1]);
      expect(planTableLayout(last).columns[0].width).toBe(100);
      // Pointer-up supplies a final position even when its frame has not run.
      await pointer(window, "pointerup", 125);
      expect(setWidth).toHaveBeenCalledExactlyOnceWith(largeTable, columns[0].id,
        { mode: "fixed", px: 105 });
      expect(parse).toHaveBeenCalledTimes(2);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit.mock.calls[0][0].columns[0].width).toEqual({ mode: "fixed", px: 105 });
      expect(commit.mock.calls[0][1]).toBe("Resize column");
      const calls = preview.mock.calls.length;
      await act(async () => vi.advanceTimersToNextFrame());
      expect(preview).toHaveBeenCalledTimes(calls);
    } finally {
      await act(async () => root.unmount()); container.remove();
    }
  }, 20000);

  it("shares rotated visual bounds with interaction, selection and arrangement", () => {
    const table = { ...fixture, rotation: 90 }, objects = [table];
    const flat = tableVisualBoundsForArrangement({ ...table, rotation: 0 });
    const bounds = tableVisualBoundsForArrangement(table);
    expect(bounds.width).toBeCloseTo(flat.height);
    expect(bounds.height).toBeCloseTo(flat.width);
    const pivot = { x: table.x + table.width / 2, y: table.y + table.height / 2 };
    expect(bounds.x).toBeCloseTo(pivot.x - (flat.y + flat.height - pivot.y));
    expect(bounds.y).toBeCloseTo(pivot.y + flat.x - pivot.x);
    expect(documentObjectInteractionBounds(table, objects)).toBe(bounds);
    expect(documentObjectVisualBounds(table, objects)).toBe(bounds);
    expect(selectionBounds(objects, [table.id])).toMatchObject(bounds);
    const empty = createPhase4Document("Rotated tables");
    const second = { ...table, id: "second-table", x: table.x + 200 };
    const document = { ...empty, pages: [{ ...empty.pages[0], objects: [table, second] }],
      selection: { pageId: empty.pages[0].id, objectIds: [table.id, second.id] } };
    const arranged = arrangeSelectedDocumentObjects(document, "row", { gap: 24 }).document;
    expect(arranged).not.toBe(document);
    const placed = arranged.pages[0].objects.map(object =>
      documentObjectInteractionBounds(object, arranged.pages[0].objects)).sort((a, b) => a.x - b.x);
    expect(placed[1].x - placed[0].x - placed[0].width).toBeCloseTo(24);
    expect(placed[0].width).toBeCloseTo(bounds.width);
    expect(placed[0].height).toBeCloseTo(bounds.height);
  });
});
