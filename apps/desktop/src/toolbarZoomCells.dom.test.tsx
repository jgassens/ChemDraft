// @vitest-environment jsdom
// The Document Zoom widget on Main sits on the tool grid as four cells — Zoom Out (1), the percentage
// menu (2), Zoom In (1) — live and in Customize Toolbar, and layouts saved with the old six-cell span
// load in the four-cell form. Its buttons and menu run their commands from real pointer and change
// events, on macOS and Windows, and keep doing so after Customize Toolbar reorders it, drags it out,
// re-adds it from the gallery and restores defaults (driven through dnd-kit's real pointer sensor).
//
// jsdom has no layout engine, so the geometry here is computed, not measured: App.css is loaded into
// the document so the cascade is the real one, the cell and gap come from the tool grid's own computed
// grid-auto-columns / column-gap (resolved through :root), the zoom parts' widths from the widget's
// computed grid tracks, and the row below from CSS grid's column-flow auto-placement of the rendered
// slots. A layout-engine check of the same thing is in docs/manual-stress-checklist.md.
import { readFileSync } from "node:fs";
import { DndContext } from "@dnd-kit/core";
import { act, createElement, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { DOCUMENT_ZOOM_PRESETS, documentZoomCommandId } from "./documentZoom";
import { APPENDABLE_TOOLBAR_WIDGETS, TOOLBAR_WIDGET_TITLES, ToolPalette } from "./ToolPalette";
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
import manifest from "./toolsets/desktop-toolsets.json";
import { ToolbarCustomizeController } from "./toolbars/CustomizeMainToolbar/ToolbarCustomizeController";
import { CustomizeBar } from "./toolbars/CustomizeMainToolbar/CustomizeBar";
import { GalleryTray } from "./toolbars/CustomizeMainToolbar/GalleryTray";
import { applyToolsetLayoutEdit } from "./toolbars/CustomizeMainToolbar/applyLayoutEdit";
import { emptyLayoutState } from "./toolbars/CustomizeToolbars/layoutStateEdits";
import { MAIN_TOOLBAR_DEFAULTS_REVISION } from "./toolbars/toolbarLayoutState";
import type { ToolsetLayoutEdit } from "./window-manager";

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
    // One value everywhere it is declared: the widget table and Main's raw manifest (read before any
    // read-time override), so the override is only ever needed for layouts saved before 1.2.3.
    expect(TOOLBAR_WIDGET_GRID_SPANS[ZOOM]).toEqual(DOCUMENT_ZOOM_GRID_SPAN);
    const manifestZoom = (manifest as unknown as { toolsets: { id: string; groups: { items: { id?: string; layout?: unknown }[] }[] }[] })
      .toolsets.find(toolset => toolset.id === "core.main")!.groups.flatMap(group => group.items).find(item => item.id === ZOOM);
    expect(manifestZoom?.layout).toEqual(DOCUMENT_ZOOM_GRID_SPAN);
    // Widgets without an override keep their declared spans.
    expect(toolbarWidgetGridSpan(TOOLBAR_WIDGET_IDS.customColorSwatch1))
      .toEqual(TOOLBAR_WIDGET_GRID_SPANS[TOOLBAR_WIDGET_IDS.customColorSwatch1]);
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

/** Every cell each slot covers, by id; throws when two slots claim the same cell. */
function assertNoOverlap(placement: ReturnType<typeof placeColumnFlow>) {
  const owner = new Map<string, string>();
  for (const [id, { column, row, colSpan, rowSpan }] of placement) {
    for (let c = column; c < column + colSpan; c += 1) {
      for (let r = row; r < row + rowSpan; r += 1) {
        const cell = `${c},${r}`;
        expect(owner.get(cell), `${id} overlaps ${owner.get(cell)} at ${cell}`).toBeUndefined();
        owner.set(cell, id);
      }
    }
  }
}

describe("Document Zoom saved with six cells", () => {
  const sixCells = { colSpan: 6, rowSpan: 1 };
  const zoomItem = {
    id: ZOOM, kind: "control", label: "Document Zoom",
    primary: { type: "control", controlId: ZOOM }, submenu: null, layout: sixCells
  };

  it("keeps every Main item, in its saved order, with no two on one cell", async () => {
    const shippedIds = getToolsetItemGroups("core.main").flat().map(item => item.id);
    const saved = JSON.parse(JSON.stringify({
      version: 1,
      mainToolbarDefaultsRevision: MAIN_TOOLBAR_DEFAULTS_REVISION,
      toolsetOverrides: [{
        toolsetId: "core.main",
        itemOrder: { "core.main.items": ["tool.select", "tool.lasso", ZOOM] },
        itemOverrides: [{ commandId: ZOOM, layout: sixCells }]
      }],
      userToolsets: []
    }));
    const registry = createDesktopToolsetRegistry(saved, undefined, [], () => undefined);
    const loadedIds = getToolsetItemGroups("core.main", registry).flat().map(item => item.id);
    expect([...loadedIds].sort()).toEqual([...shippedIds].sort());
    expect(loadedIds.slice(0, 3)).toEqual(["tool.select", "tool.lasso", ZOOM]);

    const { group, rows } = await renderMain({ registry });
    const rendered = Array.from(group.querySelectorAll<HTMLElement>(":scope > [data-toolbar-item-id]"), slot => slot.dataset.toolbarItemId!);
    const placement = slotGeometry(group, rows);
    assertNoOverlap(placement);
    expect(placement.get(ZOOM)).toMatchObject({ colSpan: 4, rowSpan: 1 });
    // Every grid slot the six-cell save rendered is still rendered (the widget is not dropped).
    expect(rendered).toContain(ZOOM);
    expect(rendered.slice(0, 3)).toEqual(["tool.select", "tool.lasso", ZOOM]);
  });

  it("loads a six-cell gallery addition on a user toolbar as four cells beside its neighbours", async () => {
    const saved = JSON.parse(JSON.stringify({
      version: 1,
      mainToolbarDefaultsRevision: MAIN_TOOLBAR_DEFAULTS_REVISION,
      toolsetOverrides: [{
        toolsetId: "user.zoomBar",
        itemAdditions: [{ groupId: "user.zoomBar.items", index: 1, item: zoomItem }]
      }],
      userToolsets: [{
        id: "user.zoomBar", title: "Zoom Bar", source: "user", defaultVisible: true, defaultMode: "floating",
        gridLayout: { orientation: "horizontal", rows: 2, cellWidth: 24, cellHeight: 24 },
        groups: [{ id: "user.zoomBar.items", items: [
          { commandId: "tool.select", title: "Selection Tool" },
          { commandId: "tool.lasso", title: "Lasso Tool" },
          { commandId: "tool.text", title: "Text Tool" }
        ] }]
      }]
    }));
    const registry = createDesktopToolsetRegistry(saved, undefined, [], () => undefined);
    const items = getToolsetItemGroups("user.zoomBar", registry).flat();
    expect(items.map(item => item.id)).toEqual(["tool.select", ZOOM, "tool.lasso", "tool.text"]);
    expect(items[1]!.layout).toMatchObject({ colSpan: 4, rowSpan: 1 });

    const toolset = registry.require("user.zoomBar");
    await act(async () => root.render(createElement(ToolPalette, {
      itemGroups: getToolsetPaletteGroups("user.zoomBar", registry).map(group => group.items),
      gridLayout: toolset.gridLayout,
      mode: "floating",
      orientation: "horizontal",
      title: "Zoom Bar",
      contentGrip: false,
      platform: "macos",
      onInvoke: () => undefined
    })));
    const group = container.querySelector<HTMLElement>(".tool-palette.horizontal .tool-group")!;
    const placement = slotGeometry(group, 2);
    assertNoOverlap(placement);
    expect([...placement.keys()]).toEqual(["tool.select", ZOOM, "tool.lasso", "tool.text"]);
    expect(placement.get(ZOOM)).toMatchObject({ colSpan: 4, rowSpan: 1 });
  });
});

// ——— Real events: the widget's buttons and menu, live and through Customize Toolbar ———————————————

const PLATFORMS: readonly ShortcutPlatform[] = ["macos", "windows"];
const CELL = 24;
const GAP = 4;
const PALETTE_RECT = { left: 0, top: 0, width: 4000, height: 60 };
const TRAY_RECT = { left: 0, top: 100, width: 4000, height: 300 };
const TILE_RECT = { width: 80, height: 40 };

function rect({ left, top, width, height }: { left: number; top: number; width: number; height: number }): DOMRect {
  return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}

/**
 * jsdom has no layout, but dnd-kit decides drops from client rects. Give the elements a drag reads
 * the rects the grid would give them: each slot its column-flow cell box (same placement as above),
 * the palette and gallery tray fixed boxes one above the other, and each gallery tile a box in the
 * tray. Everything else keeps jsdom's empty rect.
 */
function installLayoutRects() {
  const original = HTMLElement.prototype.getBoundingClientRect;
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.matches(".tool-palette")) return rect(PALETTE_RECT);
    if (this.matches(".customize-gallery-tray")) return rect(TRAY_RECT);
    if (this.matches(".gallery-tile")) {
      const index = Array.from(document.querySelectorAll(".gallery-tile")).indexOf(this);
      return rect({ left: 10 + index * (TILE_RECT.width + 10), top: TRAY_RECT.top + 40, ...TILE_RECT });
    }
    const group = this.parentElement;
    if (this.dataset.toolbarItemId && group?.matches(".tool-group")) {
      const groups = Array.from(document.querySelectorAll(".tool-palette .tool-group"));
      const placement = slotGeometry(group as HTMLElement, 2).get(this.dataset.toolbarItemId);
      if (placement) {
        // Groups sit side by side; only the first is ever a drop target here.
        const left = groups.indexOf(group) * 2000 + placement.column * (CELL + GAP);
        return rect({
          left, top: placement.row * (CELL + GAP),
          width: placement.colSpan * CELL + (placement.colSpan - 1) * GAP,
          height: placement.rowSpan * CELL + (placement.rowSpan - 1) * GAP
        });
      }
    }
    return original.call(this);
  });
}

function center(element: Element) {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

function pointer(type: string, point: { x: number; y: number }) {
  return new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, isPrimary: true, pointerId: 1, pointerType: "mouse",
    button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y
  });
}

/** A mouse drag through dnd-kit's PointerSensor: press on `source`, move past its 5px activation
 *  distance, move to `to`, release there. */
async function drag(source: Element, to: { x: number; y: number }) {
  const from = center(source);
  await act(async () => { source.dispatchEvent(pointer("pointerdown", from)); });
  await act(async () => { document.dispatchEvent(pointer("pointermove", { x: from.x + 8, y: from.y + 8 })); });
  await act(async () => { document.dispatchEvent(pointer("pointermove", to)); });
  await act(async () => { document.dispatchEvent(pointer("pointermove", to)); });
  await act(async () => { document.dispatchEvent(pointer("pointerup", to)); });
}

/** A mouse click as the webview delivers it: pointerdown, mousedown, pointerup, mouseup, click. */
async function click(element: Element, point = center(element)) {
  const mouse = (type: string) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: point.x, clientY: point.y });
  await act(async () => {
    element.dispatchEvent(pointer("pointerdown", point));
    element.dispatchEvent(mouse("mousedown"));
    element.dispatchEvent(pointer("pointerup", point));
    element.dispatchEvent(mouse("mouseup"));
    element.dispatchEvent(mouse("click"));
  });
}

/** Choose an option the way a select delivers it: the value changes, then `input` and `change`. */
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

let setCustomizing: ((customizing: boolean) => void) | undefined;

/**
 * Main as the app wires it in Customize Toolbar (MainWindow / PaletteWindow): ToolbarCustomizeController
 * around the palette, the Done / Restore Defaults bar and the gallery tray; each edit goes through
 * applyToolsetLayoutEdit with the app's context (gallery re-adds use toolbarWidgetGridSpan), and the
 * result is saved and reloaded (a JSON round trip into createDesktopToolsetRegistry) before it renders.
 * Done leaves Customize and shows the live palette from the same layout.
 */
function MainWithCustomize({ platform, onInvoke, onEdit }: {
  platform: ShortcutPlatform;
  onInvoke: (commandId: string) => void;
  onEdit: (edit: ToolsetLayoutEdit) => void;
}) {
  const [layoutState, setLayoutState] = useState(() => ({ ...emptyLayoutState(), mainToolbarDefaultsRevision: MAIN_TOOLBAR_DEFAULTS_REVISION }));
  const [customizing, setCustomizingState] = useState(true);
  setCustomizing = setCustomizingState;
  const registry = useMemo(
    () => createDesktopToolsetRegistry(JSON.parse(JSON.stringify(layoutState)), undefined, [], () => undefined),
    [layoutState]
  );
  const main = registry.require("core.main");
  const groups = getToolsetPaletteGroups("core.main", registry);
  const widgetState = { onInvoke, currentZoom: { scale: 1, minZoom: 0.25, maxZoom: 4 } };
  const palette = (paletteGroups: typeof groups, customize: boolean) => createElement(ToolPalette, {
    itemGroups: paletteGroups.map(group => group.items),
    gridLayout: main.gridLayout,
    mode: "floating",
    orientation: "horizontal",
    title: "Main",
    contentGrip: false,
    platform,
    onInvoke,
    widgetState,
    customize: customize ? { groupIds: paletteGroups.map(group => group.id) } : undefined
  });
  const send = (edit: ToolsetLayoutEdit) => {
    onEdit(edit);
    if (edit.kind === "exitCustomize") {
      setCustomizingState(false);
      return;
    }
    setLayoutState(current => applyToolsetLayoutEdit(current, { toolsetId: "core.main", edit }, {
      presentItemIds: new Set(groups.flatMap(group => group.items.map(item => item.id))),
      orderedItemIdsByGroup: new Map(groups.flatMap(group => group.id ? [[group.id, group.items.map(item => item.id)] as const] : [])),
      commandTitle: () => undefined,
      widgetTitle: widgetId => TOOLBAR_WIDGET_TITLES[widgetId],
      widgetLayout: toolbarWidgetGridSpan,
      gridRows: main.gridLayout?.rows
    }) as typeof current);
  };
  if (!customizing) return palette(groups, false);
  return createElement(ToolbarCustomizeController, {
    toolsetId: "core.main",
    groups,
    onEdit: send,
    children: effectiveGroups => createElement("div", null,
      palette([...effectiveGroups], true),
      createElement(CustomizeBar, {
        onDone: () => send({ kind: "exitCustomize" }),
        onRestoreDefaults: () => send({ kind: "resetToolset" })
      }),
      createElement(GalleryTray, {
        commands: [],
        widgets: APPENDABLE_TOOLBAR_WIDGETS,
        presentItemIds: new Set(effectiveGroups.flatMap(group => group.items.map(item => item.id)))
      }))
  });
}

function mainGroup() {
  const group = container.querySelector<HTMLElement>(".tool-palette.horizontal .tool-group");
  expect(group).not.toBeNull();
  return group!;
}

function zoomSlot() {
  return mainGroup().querySelector<HTMLElement>(`:scope > [data-toolbar-item-id="${ZOOM}"]`);
}

function slotIds() {
  return Array.from(mainGroup().querySelectorAll<HTMLElement>(":scope > [data-toolbar-item-id]"), slot => slot.dataset.toolbarItemId!);
}

/** The slot is four cells, drawn as parts of one, two and one cells, and placed on its own cells. */
function expectFourCells() {
  const slot = zoomSlot();
  expect(slot).not.toBeNull();
  expect(slot!.dataset.toolbarLayoutColSpan).toBe("4");
  expect(slot!.dataset.toolbarLayoutRowSpan).toBe("1");
  expect(slot!.style.gridColumn).toBe("span 4");
  expect(zoomParts(slot!).widths).toEqual([CELL, 2 * CELL + GAP, CELL]);
  const placement = slotGeometry(mainGroup(), 2);
  assertNoOverlap(placement);
  expect(placement.get(ZOOM)).toMatchObject({ colSpan: 4, rowSpan: 1 });
}

function zoomControl(label: string) {
  const control = zoomSlot()!.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  expect(control).not.toBeNull();
  return control!;
}

describe.each(PLATFORMS)("Document Zoom controls with real events (%s)", platform => {
  async function renderLive(onInvoke: (commandId: string) => void) {
    await act(async () => root.render(createElement(ToolPalette, {
      itemGroups: getToolsetPaletteGroups("core.main").map(group => group.items),
      gridLayout: desktopToolsetRegistry.require("core.main").gridLayout,
      mode: "floating",
      orientation: "horizontal",
      title: "Main",
      contentGrip: false,
      platform,
      onInvoke,
      widgetState: { onInvoke, currentZoom: { scale: 1, minZoom: 0.25, maxZoom: 4 } }
    })));
  }

  it("runs view.zoomOut and view.zoomIn once per click", async () => {
    const onInvoke = vi.fn();
    await renderLive(onInvoke);
    await click(zoomControl("Zoom Out"));
    expect(onInvoke.mock.calls).toEqual([["view.zoomOut"]]);
    onInvoke.mockClear();
    await click(zoomControl("Zoom In"));
    expect(onInvoke.mock.calls).toEqual([["view.zoomIn"]]);
  });

  it.each(DOCUMENT_ZOOM_PRESETS.filter(percent => percent !== 100))("runs view.zoomPercent.%s from the percentage menu", async percent => {
    const onInvoke = vi.fn();
    await renderLive(onInvoke);
    const select = zoomControl("Document zoom percentage") as HTMLSelectElement;
    expect(select.value).toBe("100");
    await choose(select, String(percent));
    expect(onInvoke.mock.calls).toEqual([[documentZoomCommandId(percent)]]);
  });

  it("stays four cells with working buttons after reorder, drag-out, gallery re-add and Restore Defaults", async () => {
    const rects = installLayoutRects();
    try {
      const onInvoke = vi.fn();
      const edits: ToolsetLayoutEdit[] = [];
      await act(async () => root.render(createElement(MainWithCustomize, { platform, onInvoke, onEdit: edit => edits.push(edit) })));
      const shippedIds = slotIds();
      expect(shippedIds[0]).toBe(ZOOM);
      expectFourCells();

      /** Leave Customize with Done, use the live buttons and menu, then customize again. */
      const expectButtonsWork = async () => {
        const done = Array.from(container.querySelectorAll<HTMLButtonElement>(".customize-main-toolbar-button"))
          .find(button => button.textContent === "Done")!;
        await click(done);
        expect(container.querySelector(".tool-palette.customizing")).toBeNull();
        expectFourCells();
        onInvoke.mockClear();
        await click(zoomControl("Zoom Out"));
        await click(zoomControl("Zoom In"));
        await choose(zoomControl("Document zoom percentage") as HTMLSelectElement, "200");
        expect(onInvoke.mock.calls).toEqual([["view.zoomOut"], ["view.zoomIn"], [documentZoomCommandId(200)]]);
        await act(async () => setCustomizing!(true));
        expect(container.querySelector(".tool-palette.customizing")).not.toBeNull();
      };

      // 1. Reorder: drag the zoom slot onto Text, in the row below.
      await drag(zoomSlot()!, center(mainGroup().querySelector('[data-toolbar-item-id="tool.text"]')!));
      expect(edits.at(-1)).toMatchObject({ kind: "reorderItems", groupId: "core.main.items" });
      const reordered = slotIds();
      expect(reordered.indexOf(ZOOM)).toBe(shippedIds.indexOf("tool.text"));
      expect([...reordered].sort()).toEqual([...shippedIds].sort());
      expectFourCells();
      await expectButtonsWork();

      // 2. Drag it out: released above the palette, outside the palette and the tray.
      await drag(zoomSlot()!, { x: 50, y: -200 });
      expect(edits.at(-1)).toEqual({ kind: "removeItem", itemId: ZOOM });
      expect(zoomSlot()).toBeNull();
      expect(slotIds()).toEqual(reordered.filter(id => id !== ZOOM));

      // 3. Re-add it from the gallery, dropped on Selection.
      const tile = container.querySelector<HTMLButtonElement>('.gallery-tile-widget[aria-label="Document Zoom"]');
      expect(tile).not.toBeNull();
      expect(tile!.disabled).toBe(false);
      const selectIndex = slotIds().indexOf("tool.select");
      await drag(tile!, center(mainGroup().querySelector('[data-toolbar-item-id="tool.select"]')!));
      expect(edits.at(-1)).toEqual({ kind: "addWidget", groupId: "core.main.items", index: selectIndex, widgetId: ZOOM });
      expect(slotIds().indexOf(ZOOM)).toBe(selectIndex);
      expect([...slotIds()].sort()).toEqual([...shippedIds].sort());
      expect(container.querySelector<HTMLButtonElement>('.gallery-tile-widget[aria-label="Document Zoom"]')!.disabled).toBe(true);
      expectFourCells();
      await expectButtonsWork();

      // 4. Restore Defaults: the shipped layout, zoom first.
      const restore = Array.from(container.querySelectorAll<HTMLButtonElement>(".customize-main-toolbar-button"))
        .find(button => button.textContent === "Restore Defaults")!;
      await click(restore);
      expect(edits.at(-1)).toEqual({ kind: "resetToolset" });
      expect(slotIds()).toEqual(shippedIds);
      expectFourCells();
      await expectButtonsWork();
    } finally {
      rects.mockRestore();
    }
  });
});
