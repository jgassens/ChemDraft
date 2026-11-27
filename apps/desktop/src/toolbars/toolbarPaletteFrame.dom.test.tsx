// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import type { CSSProperties } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolsetRegistry, type ToolsetLayoutState } from "@chemdraft/toolset-registry";
import { afterEach, describe, expect, it } from "vitest";
import { ToolPalette } from "../ToolPalette";
import {
  createDesktopToolsetRegistry,
  desktopToolsets,
  getToolsetPaletteGroups,
  webFloatingPaletteWidth,
  type DesktopToolsetRegistry
} from "../toolsets";
import { MAIN_TOOLBAR_DEFAULTS_REVISION } from "./toolbarLayoutState";
import { applyToolbarProfile } from "./toolbarProfile";

/*
 * The browser floating palette (MainWindow's `.web-floating-palette`) is exactly as wide as
 * `webFloatingPaletteWidth` says, so every item the grid lays out must sit inside that width.
 * JSDOM renders the real markup but does no layout, so this lays the rendered items out itself:
 * item order and spans come from the DOM, the metrics from the App.css rules that govern a horizontal
 * floating palette (read from the stylesheet text, since JSDOM cannot resolve var() in shorthands).
 */

const css = readFileSync("apps/desktop/src/App.css", "utf8");

function declaration(selector: string, property: string): string {
  const blocks = css.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const [, selectors, body] of blocks) {
    if (!selectors.split(",").map(part => part.trim()).includes(selector)) continue;
    const match = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+);`).exec(body);
    if (match) return match[1].trim();
  }
  throw new Error(`App.css has no ${property} for ${selector}`);
}

function px(value: string): number {
  const variable = /^var\((--[\w-]+)\)$/.exec(value);
  if (variable) return px(declaration(":root", variable[1]));
  const match = /^(\d+(?:\.\d+)?)px\b/.exec(value);
  if (!match) throw new Error(`Not a pixel length: ${value}`);
  return Number(match[1]);
}

function span(value: string): number {
  const match = /span (\d+)/.exec(value);
  return match ? Number(match[1]) : 1;
}

/** Sparse CSS grid auto-placement in column flow over `rows` rows; returns each item's column span. */
function columnFlow(items: readonly { colSpan: number; rowSpan: number }[], rows: number) {
  const occupied = new Set<string>();
  let column = 0;
  let row = 0;
  return items.map(item => {
    for (;;) {
      const free = row + item.rowSpan <= rows && Array.from({ length: item.colSpan }, (_, c) =>
        Array.from({ length: item.rowSpan }, (_, r) => !occupied.has(`${column + c},${row + r}`)).every(Boolean)
      ).every(Boolean);
      if (free) {
        for (let c = 0; c < item.colSpan; c += 1) for (let r = 0; r < item.rowSpan; r += 1) occupied.add(`${column + c},${row + r}`);
        return { start: column, end: column + item.colSpan };
      }
      if (row + item.rowSpan < rows) row += 1;
      else { column += 1; row = 0; }
    }
  });
}

const PALETTE = ".tool-palette.floating.horizontal";
const GROUP = ".tool-palette.floating.horizontal .tool-group";

let container: HTMLElement | undefined;
afterEach(() => {
  container?.remove();
  container = undefined;
});

/** Render Main as MainWindow renders a browser floating palette; return [item id, right edge] and the frame width. */
function layOutMain(registry: DesktopToolsetRegistry): { frameWidth: number; items: { id: string; left: number; right: number }[] } {
  const toolset = registry.require("core.main");
  const groups = getToolsetPaletteGroups(toolset.id, registry, new Map(), false).map(group => group.items);
  const width = webFloatingPaletteWidth(toolset, groups);
  container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <section
      className="web-floating-palette"
      data-toolset-id={toolset.id}
      style={{ "--palette-width": `${width}px` } as CSSProperties}
    >
      <div className="palette-title"><span className="palette-title-label">Main</span></div>
      <ToolPalette
        itemGroups={groups}
        gridLayout={toolset.gridLayout}
        mode="floating"
        orientation={toolset.gridLayout?.orientation ?? "vertical"}
        title={toolset.title}
        onInvoke={() => {}}
      />
    </section>
  );
  document.body.append(container);

  const section = container.querySelector<HTMLElement>(".web-floating-palette")!;
  const palette = section.querySelector<HTMLElement>(".tool-palette")!;
  expect(palette.classList.contains("horizontal")).toBe(true);
  const frameWidth = px(section.style.getPropertyValue("--palette-width"));
  const frameBorder = px(declaration(".web-floating-palette", "border"));
  const [, paddingRight, , paddingLeft = paddingRight] = declaration(PALETTE, "padding").split(/\s+/);
  const flexGap = px(declaration(PALETTE, "gap"));
  const cellGap = px(declaration(GROUP, "column-gap"));
  const autoColumn = px(declaration(GROUP, "grid-auto-columns"));
  const rows = Number(/repeat\((\d+),/.exec(declaration(GROUP, "grid-template-rows"))![1]);
  const grip = palette.querySelector(":scope > .palette-content-drag-grip");

  let x = frameBorder + px(paddingLeft);
  if (grip) x += px(declaration(".palette-content-drag-grip", "flex").split(/\s+/)[2]) + flexGap;
  const items: { id: string; left: number; right: number }[] = [];
  const groupElements = Array.from(palette.querySelectorAll<HTMLElement>(":scope > .tool-group"));
  expect(groupElements.length).toBeGreaterThan(0);
  groupElements.forEach((group, index) => {
    x += px(group.style.getPropertyValue("--toolbar-grid-padding") || "0px");
    const cells = Array.from(group.children) as HTMLElement[];
    const placed = columnFlow(cells.map(cell => ({ colSpan: span(cell.style.gridColumn), rowSpan: span(cell.style.gridRow) })), rows);
    placed.forEach(({ start, end }, cellIndex) => {
      const cell = cells[cellIndex];
      items.push({
        id: cell.dataset.toolbarItemId ?? cell.querySelector<HTMLElement>("[data-command-id]")?.dataset.commandId ?? cell.className,
        left: x + start * (autoColumn + cellGap),
        right: x + end * autoColumn + (end - 1) * cellGap
      });
    });
    const columns = Math.max(...placed.map(({ end }) => end));
    x += columns * autoColumn + (columns - 1) * cellGap;
    const last = index === groupElements.length - 1;
    if (!(last && palette.classList.contains("main-style-palette"))) {
      x += px(declaration(GROUP, "padding-right")) + px(declaration(GROUP, "border-right"));
    }
    if (!last) x += flexGap;
  });
  const end = x + (palette.classList.contains("main-style-palette")
    ? px(declaration(".tool-palette.floating.horizontal.main-style-palette", "padding-right"))
    : px(paddingRight)) + frameBorder;
  expect(end).toBeLessThanOrEqual(frameWidth);
  return { frameWidth, items };
}

function expectEveryItemInside({ frameWidth, items }: ReturnType<typeof layOutMain>): void {
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect({ id: item.id, inside: item.left >= 0 && item.right <= frameWidth }).toEqual({ id: item.id, inside: true });
  }
}

describe("browser floating Main toolbar frame", () => {
  const gameToolsets = applyToolbarProfile(desktopToolsets, "molecule-drawing");

  it("holds every item of the molecule-drawing Main toolbar, last column included", () => {
    const layout = layOutMain(new ToolsetRegistry(gameToolsets));
    expectEveryItemInside(layout);
    // The last column the hands-on check saw spill out of the frame.
    expect(layout.items.map(item => item.id)).toEqual(expect.arrayContaining(["tool.charge", "structure.cleanup2d"]));
  });

  it("holds every item after the user changes the profile's Main toolbar", () => {
    const text = desktopToolsets.find(toolset => toolset.id === "core.main")!.groups[0].items
      .find(item => item.commandId === "tool.text")!;
    const userLayout: ToolsetLayoutState = {
      version: 1,
      mainToolbarDefaultsRevision: MAIN_TOOLBAR_DEFAULTS_REVISION,
      toolsetOverrides: [{
        toolsetId: "core.main",
        hiddenCommandIds: ["tool.lasso"],
        itemAdditions: [{ groupId: "core.main.items", item: text }]
      }],
      userToolsets: []
    };
    const layout = layOutMain(createDesktopToolsetRegistry(userLayout, undefined, [], () => undefined, gameToolsets));
    expectEveryItemInside(layout);
    expect(layout.items.map(item => item.id)).toContain("tool.text");
    expect(layout.items.map(item => item.id)).not.toContain("tool.lasso");
  });

  it("holds every item of the standard Main toolbar", () => {
    expectEveryItemInside(layOutMain(new ToolsetRegistry(desktopToolsets)));
  });
});
