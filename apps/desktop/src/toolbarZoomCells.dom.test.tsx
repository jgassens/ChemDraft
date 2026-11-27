// @vitest-environment jsdom
// The Document Zoom widget on Main sits on the tool grid as four cells — Zoom Out (1), the percentage
// menu (2), Zoom In (1) — live and in Customize Toolbar, and layouts saved with the old six-cell span
// load in the four-cell form.
//
// jsdom has no layout engine, so the geometry here is computed, not measured: App.css is loaded into
// the document so the cascade is the real one, the cell and gap come from the tool grid's own computed
// grid-auto-columns / column-gap (resolved through :root), the zoom parts' widths from the widget's
// computed grid tracks, and the row below from CSS grid's column-flow auto-placement of the rendered
// slots. A layout-engine check of the same thing is in docs/manual-stress-checklist.md.
import { readFileSync } from "node:fs";
import { DndContext } from "@dnd-kit/core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolPalette } from "./ToolPalette";
import {
  DOCUMENT_ZOOM_GRID_SPAN,
  createDesktopToolsetRegistry,
  desktopToolsetRegistry,
  getToolsetItemGroups,
  getToolsetPaletteGroups,
  toolbarWidgetGridSpan,
  type DesktopToolsetRegistry
} from "./toolsets";
import { TOOLBAR_WIDGET_GRID_SPANS, TOOLBAR_WIDGET_IDS } from "./toolbars/toolbarWidgets";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ZOOM = TOOLBAR_WIDGET_IDS.documentZoom;
const appCssText = readFileSync("apps/desktop/src/App.css", "utf8");

let container: HTMLDivElement;
let root: Root;
let appCss: HTMLStyleElement;

beforeEach(() => {
  appCss = document.createElement("style");
  appCss.textContent = appCssText;
  document.head.append(appCss);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  appCss.remove();
});

/** Resolve a computed length expression (`var()` / `calc()` over px) against :root's tokens. */
function px(expression: string): number {
  const rootStyle = getComputedStyle(document.documentElement);
  let resolved = expression;
  for (let guard = 0; resolved.includes("var(") && guard < 10; guard += 1) {
    resolved = resolved.replace(/var\((--[\w-]+)\)/g, (_match, name: string) => {
      const value = rootStyle.getPropertyValue(name).trim();
      if (!value) throw new Error(`Unresolved token ${name} in ${expression}`);
      return value;
    });
  }
  const arithmetic = resolved.replace(/calc\(/g, "(").replace(/px/g, "").trim();
  if (!/^[\d\s.+\-*/()]+$/.test(arithmetic)) throw new Error(`Not a px expression: ${expression}`);
  return Function(`"use strict"; return (${arithmetic});`)() as number;
}

/** Split a grid-template-columns value into its top-level tracks. */
function tracks(value: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of value.trim()) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (/\s/.test(character) && depth === 0) {
      if (current) result.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current) result.push(current);
  return result;
}

/** CSS grid auto-placement for `grid-auto-flow: column` (sparse) with a fixed row count. */
function placeColumnFlow(
  slots: readonly { id: string; colSpan: number; rowSpan: number }[],
  rows: number
): Map<string, { column: number; row: number; colSpan: number; rowSpan: number }> {
  const taken = new Set<string>();
  const placed = new Map<string, { column: number; row: number; colSpan: number; rowSpan: number }>();
  let column = 0;
  let row = 0;
  for (const slot of slots) {
    for (;;) {
      if (row + slot.rowSpan > rows) {
        column += 1;
        row = 0;
        continue;
      }
      const cells: string[] = [];
      for (let c = column; c < column + slot.colSpan; c += 1) {
        for (let r = row; r < row + slot.rowSpan; r += 1) cells.push(`${c},${r}`);
      }
      if (cells.every(cell => !taken.has(cell))) {
        cells.forEach(cell => taken.add(cell));
        placed.set(slot.id, { column, row, colSpan: slot.colSpan, rowSpan: slot.rowSpan });
        row += slot.rowSpan;
        break;
      }
      row += 1;
    }
  }
  return placed;
}

async function renderMain({ customize = false, registry = desktopToolsetRegistry }: {
  customize?: boolean;
  registry?: DesktopToolsetRegistry;
} = {}) {
  const main = registry.require("core.main");
  const groups = getToolsetPaletteGroups("core.main", registry);
  const palette = createElement(ToolPalette, {
    itemGroups: groups.map(group => group.items),
    gridLayout: main.gridLayout,
    mode: "floating",
    orientation: "horizontal",
    title: "Main",
    contentGrip: false,
    platform: "macos",
    onInvoke: () => undefined,
    customize: customize ? { groupIds: groups.map(group => group.id) } : undefined
  });
  await act(async () => root.render(customize ? createElement(DndContext, null, palette) : palette));
  const group = container.querySelector<HTMLElement>(".tool-palette.horizontal .tool-group")!;
  expect(group).not.toBeNull();
  return { group, rows: main.gridLayout?.rows ?? 2 };
}

/** The grid's cell and gap, read from the tool group's own computed column template. */
function gridMetrics(group: HTMLElement) {
  const style = getComputedStyle(group);
  expect(style.getPropertyValue("grid-auto-flow")).toBe("column");
  return { cell: px(style.getPropertyValue("grid-auto-columns")), gap: px(style.getPropertyValue("column-gap")) };
}

function zoomParts(slot: HTMLElement) {
  const controls = slot.querySelector<HTMLElement>(".document-zoom-controls")!;
  expect(controls).not.toBeNull();
  const parts = Array.from(controls.children) as HTMLElement[];
  expect(parts.map(part => part.getAttribute("aria-label"))).toEqual([
    "Zoom Out", "Document zoom percentage", "Zoom In"
  ]);
  const style = getComputedStyle(controls);
  expect(style.display).toBe("grid");
  const widths = tracks(style.getPropertyValue("grid-template-columns")).map(px);
  const gap = px(style.getPropertyValue("column-gap"));
  const lefts = widths.map((_width, index) =>
    widths.slice(0, index).reduce((total, width) => total + width + gap, 0));
  return { controls, parts, widths, lefts, gap, totalWidth: px(style.width) };
}

function slotGeometry(group: HTMLElement, rows: number) {
  const slots = Array.from(group.querySelectorAll<HTMLElement>(":scope > [data-toolbar-item-id]")).map(slot => ({
    id: slot.dataset.toolbarItemId!,
    colSpan: Number(slot.dataset.toolbarLayoutColSpan),
    rowSpan: Number(slot.dataset.toolbarLayoutRowSpan)
  }));
  return placeColumnFlow(slots, rows);
}

describe("Document Zoom on the Main tool grid", () => {
  it.each([false, true])("is four cells — 1, 2 and 1 — on the row-below cells (customize=%s)", async customize => {
    const { group, rows } = await renderMain({ customize });
    const { cell, gap } = gridMetrics(group);
    expect({ cell, gap }).toEqual({ cell: 24, gap: 4 });
    const slot = group.querySelector<HTMLElement>(`:scope > [data-toolbar-item-id="${ZOOM}"]`)!;
    expect(slot.dataset.toolbarLayoutColSpan).toBe("4");
    expect(slot.dataset.toolbarLayoutRowSpan).toBe("1");
    expect(slot.style.gridColumn).toBe("span 4");

    const { widths, lefts, gap: partGap, totalWidth } = zoomParts(slot);
    expect(partGap).toBe(gap);
    expect(widths).toEqual([cell, 2 * cell + gap, cell]);
    expect(totalWidth).toBe(4 * cell + 3 * gap);

    // Where the grid puts everything: zoom across columns 0–3 of the top row, the selection tools in
    // the row below, and the group divider in the next column spanning both rows.
    const placement = slotGeometry(group, rows);
    expect(placement.get(ZOOM)).toEqual({ column: 0, row: 0, colSpan: 4, rowSpan: 1 });
    const below = ["tool.select", "tool.lasso", "tool.eraser", "tool.text"];
    expect(below.map(id => placement.get(id))).toEqual(
      below.map((_id, column) => ({ column, row: 1, colSpan: 1, rowSpan: 1 })));
    expect(placement.get("core.main.divider.1")).toEqual({ column: 4, row: 0, colSpan: 1, rowSpan: 2 });

    const columnLeft = (column: number) => column * (cell + gap);
    const zoomLeft = columnLeft(placement.get(ZOOM)!.column);
    // Zoom Out over Select, the menu over Lasso + Eraser, Zoom In over Text: left and right edges.
    expect(lefts.map(left => zoomLeft + left)).toEqual([columnLeft(0), columnLeft(1), columnLeft(3)]);
    expect(lefts.map((left, index) => zoomLeft + left + widths[index]!)).toEqual([
      columnLeft(0) + cell, columnLeft(2) + cell, columnLeft(3) + cell
    ]);
  });

  it("reads as the parts' boxes in Customize Toolbar, not one box around the span", async () => {
    const { group } = await renderMain({ customize: true });
    const { cell, gap } = gridMetrics(group);
    const slot = group.querySelector<HTMLElement>(`:scope > [data-toolbar-item-id="${ZOOM}"]`)!;
    expect(slot.classList.contains("customize-slot")).toBe(true);
    expect(slot.classList.contains("customize-slot-cell-parts")).toBe(true);
    // The whole-span outline is gone (a tool slot keeps its 1px dashed border)…
    expect(getComputedStyle(slot).getPropertyValue("border-top-width")).toBe("0px");
    const tool = group.querySelector<HTMLElement>(':scope > [data-toolbar-item-id="tool.select"]')!;
    expect(tool.classList.contains("customize-slot")).toBe(true);
    expect(tool.classList.contains("customize-slot-cell-parts")).toBe(false);
    // …and each part carries a dashed outline drawn inside its own box, like a tool slot's border.
    const { parts, widths } = zoomParts(slot);
    expect(parts.map(part => getComputedStyle(part).getPropertyValue("outline-offset"))).toEqual(["-1px", "-1px", "-1px"]);
    expect(parts.map(part => getComputedStyle(part).getPropertyValue("outline-style"))).toEqual([
      "dashed", "dashed", "dashed"
    ]);
    // Boxes of one, two and one cells: four cells in all.
    expect(widths.map(width => (width + gap) / (cell + gap))).toEqual([1, 2, 1]);
    // The parts are inert while customizing; the slot owns the drag.
    expect(slot.querySelector(".customize-widget-grid-content")).not.toBeNull();
  });

  it("keeps the percentage legible at two cells with its dropdown arrow", async () => {
    const { group } = await renderMain();
    const slot = group.querySelector<HTMLElement>(`:scope > [data-toolbar-item-id="${ZOOM}"]`)!;
    const select = slot.querySelector<HTMLSelectElement>("select.toolbar-select")!;
    const style = getComputedStyle(select);
    const textWidth = px(tracks(getComputedStyle(slot.querySelector(".document-zoom-controls")!)
      .getPropertyValue("grid-template-columns"))[1]!)
      - px(style.paddingLeft) - px(style.paddingRight) - 2;
    // "100%"–"850%" are four characters; at 11px that is under 30px in SF Pro and Segoe UI.
    expect(px(style.fontSize)).toBe(11);
    expect(textWidth).toBeGreaterThanOrEqual(34);
    // The arrow is the shared select's two-triangle background (jsdom cannot cascade a background
    // longhand over that shorthand, so read the rules): both 5px triangles, moved in to end 4px from
    // the edge, fit inside the trimmed right padding.
    expect(style.getPropertyValue("background")).toMatch(/linear-gradient\(45deg[^]*linear-gradient\(135deg/);
    const zoomSelectRule = /\.document-zoom-controls > \.toolbar-select \{([^}]*)\}/.exec(appCssText)?.[1] ?? "";
    expect(zoomSelectRule).toContain("background-position: calc(100% - 8px) 50%, calc(100% - 4px) 50%;");
    expect(px(style.paddingRight)).toBeGreaterThanOrEqual(8 + 5 - 1);
  });
});

describe("Document Zoom grid span", () => {
  it("is four cells for the shipped Main, the gallery's re-add, and every palette item", () => {
    expect(DOCUMENT_ZOOM_GRID_SPAN).toEqual({ colSpan: 4, rowSpan: 1 });
    expect(toolbarWidgetGridSpan(ZOOM)).toEqual({ colSpan: 4, rowSpan: 1 });
    // Other widgets keep their declared spans.
    expect(toolbarWidgetGridSpan(TOOLBAR_WIDGET_IDS.mainStyleControls))
      .toEqual(TOOLBAR_WIDGET_GRID_SPANS[TOOLBAR_WIDGET_IDS.mainStyleControls]);
    expect(getToolsetItemGroups("core.main").flat().find(item => item.id === ZOOM)?.layout)
      .toMatchObject({ colSpan: 4, rowSpan: 1 });
  });

  it("loads 1.2.2/RC5 layouts that saved the six-cell zoom item in the four-cell form", async () => {
    const sixCells = { colSpan: 6, rowSpan: 1 };
    const zoomItem = {
      id: ZOOM, kind: "control", label: "Document Zoom",
      primary: { type: "control", controlId: ZOOM }, submenu: null, layout: sixCells
    };
    const registry = createDesktopToolsetRegistry({
      version: 1,
      mainToolbarDefaultsRevision: 2,
      toolsetOverrides: [{
        toolsetId: "core.main",
        // An RC5 Main customization: zoom moved after the selection tools, its span written out.
        itemOrder: { "core.main.items": ["tool.select", "tool.lasso", ZOOM] },
        itemOverrides: [{ commandId: ZOOM, layout: sixCells }]
      }],
      userToolsets: [{
        id: "user.zoomBar", title: "Zoom Bar", source: "user", defaultVisible: true, defaultMode: "floating",
        gridLayout: { orientation: "horizontal", rows: 2, cellWidth: 24, cellHeight: 24 },
        groups: [{ id: "user.zoomBar.items", items: [zoomItem, { commandId: "tool.select", title: "Selection Tool" }] }]
      }]
    }, undefined, [], () => undefined);

    const mainZoom = getToolsetItemGroups("core.main", registry).flat().find(item => item.id === ZOOM);
    expect(mainZoom?.layout).toMatchObject({ colSpan: 4, rowSpan: 1 });
    const userItems = getToolsetItemGroups("user.zoomBar", registry).flat();
    expect(userItems.map(item => item.id)).toEqual([ZOOM, "tool.select"]);
    expect(userItems[0]!.layout).toMatchObject({ colSpan: 4, rowSpan: 1 });

    // And it renders as the four-cell form in the saved order.
    const { group } = await renderMain({ registry });
    const slot = group.querySelector<HTMLElement>(`:scope > [data-toolbar-item-id="${ZOOM}"]`)!;
    expect(slot.dataset.toolbarLayoutColSpan).toBe("4");
    expect(zoomParts(slot).widths).toEqual([24, 52, 24]);
    expect(Array.from(group.querySelectorAll(":scope > [data-toolbar-item-id]"), slot => slot.getAttribute("data-toolbar-item-id"))
      .slice(0, 3)).toEqual(["tool.select", "tool.lasso", ZOOM]);
  });

  it("fills the zoom block before Main's first divider, two columns narrower than the six-cell span", () => {
    const main = desktopToolsetRegistry.require("core.main");
    const rows = main.gridLayout!.rows!;
    const items = getToolsetItemGroups("core.main")[0]!
      .map(item => ({ id: item.id, colSpan: item.layout.colSpan, rowSpan: item.layout.rowSpan }));
    const blockBeforeDivider = (spanOfZoom: number) => {
      const placement = placeColumnFlow(items.map(item => item.id === ZOOM ? { ...item, colSpan: spanOfZoom } : item), rows);
      const dividerColumn = placement.get("core.main.divider.1")!.column;
      const cells = items.slice(0, items.findIndex(item => item.id === "core.main.divider.1"))
        .reduce((total, item) => total + (item.id === ZOOM ? spanOfZoom : item.colSpan) * item.rowSpan, 0);
      return { dividerColumn, emptyCells: dividerColumn * rows - cells };
    };
    expect(blockBeforeDivider(4)).toEqual({ dividerColumn: 4, emptyCells: 0 });
    // The old span left two empty cells beside Text and pushed the divider two columns right.
    expect(blockBeforeDivider(6)).toEqual({ dividerColumn: 6, emptyCells: 2 });
  });
});
