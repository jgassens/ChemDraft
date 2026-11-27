// @vitest-environment jsdom
// Main's style widget (six colour swatches, alignment, x², font, size, B/I/U, x₂ — or the molecule,
// shape and arrow layouts) sits on the tool grid as exactly the 11×2 cells its controls draw: no
// spare column, so no blank cell beside it in Customize Toolbar or on the live toolbar, and the same
// cells in both. Layouts saved with the old 12×2 span load in the 11×2 form.
//
// jsdom has no layout engine, so the geometry is computed, not measured: App.css is loaded into the
// document so the cascade is the real one, the cell and gap come from the tool grid's computed
// grid-auto-columns / column-gap, each control's width from its computed width, and placement from
// CSS grid's column-flow auto-placement of the rendered slots. The layout-engine check of the same
// thing is in docs/manual-stress-checklist.md.
import { readFileSync } from "node:fs";
import { DndContext } from "@dnd-kit/core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { ToolPalette } from "./ToolPalette";
import {
  MAIN_STYLE_CONTROLS_GRID_SPAN,
  createDesktopToolsetRegistry,
  desktopToolsetRegistry,
  getToolsetItemGroups,
  getToolsetPaletteGroups,
  toolbarWidgetGridSpan,
  type DesktopToolsetRegistry
} from "./toolsets";
import { TOOLBAR_WIDGET_IDS, type ToolbarWidgetState } from "./toolbars/toolbarWidgets";
import { MAIN_STYLE_ROW_CELLS, mainStyleRowsForVariant, rowCellCost } from "./toolbars/mainStyleWidget";
import type { ToolbarSelectionKind, ToolbarStyleVariant } from "./toolbars/toolbarSelectionKind";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STYLE = TOOLBAR_WIDGET_IDS.mainStyleControls;
const appCssText = readFileSync("apps/desktop/src/App.css", "utf8");
const PLATFORMS: readonly ShortcutPlatform[] = ["macos", "windows"];

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

type Placement = { column: number; row: number; colSpan: number; rowSpan: number };

/** CSS grid auto-placement for `grid-auto-flow: column` (sparse) with a fixed row count. */
function placeColumnFlow(
  slots: readonly { id: string; colSpan: number; rowSpan: number }[],
  rows: number
): { placed: Map<string, Placement>; taken: Set<string>; columns: number } {
  const taken = new Set<string>();
  const placed = new Map<string, Placement>();
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
  const columns = Math.max(0, ...Array.from(placed.values(), place => place.column + place.colSpan));
  return { placed, taken, columns };
}

function selection(kind: ToolbarSelectionKind): NonNullable<ToolbarWidgetState["currentSelection"]> {
  return {
    kind,
    objectTypes: [],
    moleculeContext: kind === "molecule" ? "molecule" : "none",
    arrowToolIds: [],
    textEditing: false,
    selectedCount: kind === "none" ? 0 : 1
  };
}

async function renderMain({ customize = false, platform, registry = desktopToolsetRegistry, kind }: {
  customize?: boolean;
  platform: ShortcutPlatform;
  registry?: DesktopToolsetRegistry;
  kind?: ToolbarSelectionKind;
}) {
  const main = registry.require("core.main");
  const groups = getToolsetPaletteGroups("core.main", registry);
  const palette = createElement(ToolPalette, {
    itemGroups: groups.map(group => group.items),
    gridLayout: main.gridLayout,
    mode: "floating",
    orientation: "horizontal",
    title: "Main",
    contentGrip: false,
    platform,
    onInvoke: () => undefined,
    widgetState: kind ? { onInvoke: () => undefined, currentSelection: selection(kind) } : undefined,
    customize: customize ? { groupIds: groups.map(group => group.id) } : undefined
  });
  await act(async () => root.render(customize ? createElement(DndContext, null, palette) : palette));
  const group = container.querySelector<HTMLElement>(".tool-palette.horizontal .tool-group")!;
  expect(group).not.toBeNull();
  const style = getComputedStyle(group);
  expect(style.getPropertyValue("grid-auto-flow")).toBe("column");
  const cell = px(style.getPropertyValue("grid-auto-columns"));
  const gap = px(style.getPropertyValue("column-gap"));
  expect({ cell, gap }).toEqual({ cell: 24, gap: 4 });
  const slot = group.querySelector<HTMLElement>(`:scope > [data-toolbar-item-id="${STYLE}"]`)!;
  expect(slot).not.toBeNull();
  return { group, slot, rows: main.gridLayout?.rows ?? 2, cell, gap };
}

function placement(group: HTMLElement, rows: number) {
  const slots = Array.from(group.querySelectorAll<HTMLElement>(":scope > [data-toolbar-item-id]")).map(slot => ({
    id: slot.dataset.toolbarItemId!,
    colSpan: Number(slot.dataset.toolbarLayoutColSpan),
    rowSpan: Number(slot.dataset.toolbarLayoutRowSpan)
  }));
  return { order: slots.map(slot => slot.id), ...placeColumnFlow(slots, rows) };
}

/**
 * The widget's visible parts, row by row: every button is a control, and every select sits in a
 * label sized in whole cells. Each part's width is read from the cascade and converted to cells.
 */
function visibleParts(slot: HTMLElement, cell: number, gap: number) {
  const widget = slot.querySelector<HTMLElement>(".main-toolbar-style-controls")!;
  expect(widget).not.toBeNull();
  const rows = Array.from(widget.querySelectorAll<HTMLElement>(":scope > .toolbar-style-row"));
  expect(rows).toHaveLength(2);
  return {
    widget,
    rows: rows.map(row => {
      const parts = Array.from(row.querySelectorAll<HTMLElement>("button, label.toolbar-control-label, .toolbar-cell-gap"))
        .filter(part => !part.parentElement?.closest("label.toolbar-control-label"));
      return parts.map(part => {
        const width = px(getComputedStyle(part).width);
        const cells = (width + gap) / (cell + gap);
        expect(Number.isInteger(cells), `${part.getAttribute("aria-label") ?? part.className} is ${width}px`).toBe(true);
        return {
          name: part.classList.contains("toolbar-cell-gap") ? "(gap)" : part.getAttribute("aria-label")
            ?? part.querySelector("select")?.getAttribute("aria-label") ?? "?",
          cells
        };
      });
    })
  };
}

describe.each(PLATFORMS)("Main style widget on the tool grid (%s)", platform => {
  it.each([false, true])("occupies exactly the 11×2 cells its controls draw (customize=%s)", async customize => {
    const { slot, cell, gap } = await renderMain({ customize, platform });
    expect(slot.dataset.toolbarLayoutColSpan).toBe("11");
    expect(slot.dataset.toolbarLayoutRowSpan).toBe("2");
    expect(slot.style.gridColumn).toBe("span 11");
    expect(slot.style.gridRow).toBe("span 2");

    const { widget, rows } = visibleParts(slot, cell, gap);
    // Six swatches, alignment and x² over font, size, B/I/U and x₂ (the text layout, which Customize
    // pins and an empty selection shows).
    expect(rows.map(row => row.map(part => part.name))).toEqual([
      ["Color: Black", "Color: White", "Color: Blue", "Color: Red", "Color: Green", "Color: Gray",
        "Align Text Left", "Align Text Center", "Align Text Right", "Justify Text", "Superscript Text"],
      ["Text font", "Text size", "Bold Text", "Italic Text", "Underline Text", "Subscript Text"]
    ]);
    expect(rows.map(row => row.reduce((total, part) => total + part.cells, 0))).toEqual([11, 11]);
    // So the span's cells are exactly the parts' cells: none spare.
    expect(rows.flat().reduce((total, part) => total + part.cells, 0)).toBe(11 * 2);
    // The widget is the span's width, with no lead-in padding and nothing to justify either way.
    const widgetStyle = getComputedStyle(widget);
    expect(px(widgetStyle.width)).toBe(11 * cell + 10 * gap);
    expect(px(widgetStyle.paddingLeft || "0px")).toBe(0);
  });

  it("puts every control on the same cells in Customize Toolbar and on the live toolbar", async () => {
    const live = await renderMain({ platform });
    const livePlacement = placement(live.group, live.rows);
    const liveParts = visibleParts(live.slot, live.cell, live.gap).rows;
    const liveSlotStyle = getComputedStyle(live.slot);
    // The live slot starts its content at its own start edge (no push to the end).
    expect(liveSlotStyle.justifyItems).toBe("start");
    expect(live.slot.classList.contains("customize-slot")).toBe(false);
    await act(async () => root.unmount());
    root = createRoot(container);

    const customize = await renderMain({ customize: true, platform });
    const customizePlacement = placement(customize.group, customize.rows);
    const customizeParts = visibleParts(customize.slot, customize.cell, customize.gap).rows;
    const customizeSlotStyle = getComputedStyle(customize.slot);
    // The customize frame is an outline, so it insets nothing: content starts at the slot's edge.
    expect(customize.slot.classList.contains("customize-slot-widget")).toBe(true);
    expect(customizeSlotStyle.getPropertyValue("border-left-width")).toBe("0px");
    expect(customizeSlotStyle.getPropertyValue("outline-style")).toBe("dashed");
    expect(customizeSlotStyle.getPropertyValue("outline-offset")).toBe("0px");
    const content = customize.slot.querySelector<HTMLElement>(".customize-widget-grid-content")!;
    expect(getComputedStyle(content).display).toBe("block");

    expect(customizePlacement.placed.get(STYLE)).toEqual(livePlacement.placed.get(STYLE));
    expect(customizeParts).toEqual(liveParts);
    // Every item the two views share sits on the same cells (Customize may show the trailing divider).
    for (const id of livePlacement.order) {
      expect(customizePlacement.placed.get(id), id).toEqual(livePlacement.placed.get(id));
    }
  });

  it("leaves no empty grid cell in the art + style group, from its divider to the toolbar's end", async () => {
    for (const customize of [false, true]) {
      const { group, rows } = await renderMain({ customize, platform });
      const { order, placed, taken, columns } = placement(group, rows);
      const style = placed.get(STYLE)!;
      expect(style.colSpan * style.rowSpan).toBe(22);
      // The group starts after the last divider before the style widget (the art tools: Colors,
      // Clean Up, 3D and their row-two partners) and runs to the end of the grid.
      const divider = order.slice(0, order.indexOf(STYLE))
        .filter(id => group.querySelector(`:scope > [data-toolbar-item-id="${id}"]`)?.matches(".toolbar-item-separator, .customize-slot-separator"))
        .at(-1)!;
      expect(divider).toBeDefined();
      const firstColumn = placed.get(divider)!.column + 1;
      expect(style.column - firstColumn).toBe(3);
      const lastColumn = customize ? columns : style.column + style.colSpan;
      const empty: string[] = [];
      for (let column = firstColumn; column < lastColumn; column += 1) {
        for (let row = 0; row < rows; row += 1) {
          if (!taken.has(`${column},${row}`)) empty.push(`${column},${row}`);
        }
      }
      expect(empty, `customize=${customize}`).toEqual([]);
      // The style widget is the group's last block on the live toolbar, ending at the grid's edge.
      if (!customize) expect(style.column + style.colSpan).toBe(columns);
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it.each(["molecule", "shape", "arrow"] as const)("keeps the 11×2 footprint for the %s layout", async kind => {
    const { slot, cell, gap } = await renderMain({ platform, kind });
    const { widget, rows } = visibleParts(slot, cell, gap);
    expect(widget.dataset.mainStyleVariant).toBe(kind);
    expect(slot.dataset.toolbarLayoutColSpan).toBe("11");
    expect(rows.map(row => row.reduce((total, part) => total + part.cells, 0))).toEqual([11, 11]);
  });
});

describe("Main style widget grid span", () => {
  it("equals the cells every layout draws", () => {
    expect(MAIN_STYLE_CONTROLS_GRID_SPAN).toEqual({ colSpan: MAIN_STYLE_ROW_CELLS, rowSpan: 2 });
    for (const variant of ["text", "molecule", "shape", "arrow"] as const satisfies readonly ToolbarStyleVariant[]) {
      const { rows } = mainStyleRowsForVariant(variant, { onInvoke: () => undefined });
      expect([rowCellCost(rows.primary), rowCellCost(rows.secondary)], variant).toEqual([11, 11]);
    }
    expect(toolbarWidgetGridSpan(STYLE)).toEqual({ colSpan: 11, rowSpan: 2 });
    expect(getToolsetItemGroups("core.main").flat().find(item => item.id === STYLE)?.layout)
      .toMatchObject({ colSpan: 11, rowSpan: 2 });
  });

  it.each(PLATFORMS)("loads 1.2.2/RC5 layouts that saved the 12×2 style widget in the 11×2 form (%s)", async platform => {
    const twelveCells = { colSpan: 12, rowSpan: 2 };
    const styleItem = {
      id: STYLE, kind: "control", label: "Text style controls",
      primary: { type: "control", controlId: STYLE }, submenu: null, layout: twelveCells
    };
    const registry = createDesktopToolsetRegistry({
      version: 1,
      mainToolbarDefaultsRevision: 2,
      toolsetOverrides: [{
        toolsetId: "core.main",
        itemOverrides: [{ commandId: STYLE, layout: twelveCells }]
      }],
      userToolsets: [{
        id: "user.styleBar", title: "Style Bar", source: "user", defaultVisible: true, defaultMode: "floating",
        gridLayout: { orientation: "horizontal", rows: 2, cellWidth: 24, cellHeight: 24 },
        groups: [{ id: "user.styleBar.items", items: [{ commandId: "tool.select", title: "Selection Tool" }, styleItem] }]
      }]
    }, undefined, [], () => undefined);

    expect(getToolsetItemGroups("core.main", registry).flat().find(item => item.id === STYLE)?.layout)
      .toMatchObject({ colSpan: 11, rowSpan: 2 });
    const userItems = getToolsetItemGroups("user.styleBar", registry).flat();
    expect(userItems.map(item => item.id)).toEqual(["tool.select", STYLE]);
    expect(userItems[1]!.layout).toMatchObject({ colSpan: 11, rowSpan: 2 });

    // And Main renders it on 11×2 cells with no blank cell.
    const { group, slot, rows } = await renderMain({ platform, registry });
    expect(slot.dataset.toolbarLayoutColSpan).toBe("11");
    const { placed, columns } = placement(group, rows);
    expect(placed.get(STYLE)).toMatchObject({ row: 0, colSpan: 11, rowSpan: 2 });
    expect(placed.get(STYLE)!.column + 11).toBe(columns);
  });

  it("the old 12-cell span is what left the two blank cells", () => {
    // Blank cells inside the widget's slot: the span's cells the controls do not draw on, per row.
    const blankCells = (colSpan: number) => {
      const { rows } = mainStyleRowsForVariant("text", { onInvoke: () => undefined });
      return [rows.primary, rows.secondary].reduce((total, row) => total + colSpan - rowCellCost(row), 0);
    };
    expect(blankCells(MAIN_STYLE_CONTROLS_GRID_SPAN.colSpan)).toBe(0);
    // One per row: the empty column after x² and x₂ in Customize Toolbar, before the swatches live.
    expect(blankCells(12)).toBe(2);
  });
});
