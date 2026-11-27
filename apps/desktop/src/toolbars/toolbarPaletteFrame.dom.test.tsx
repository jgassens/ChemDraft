// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolsetRegistry, type ToolsetLayoutState } from "@chemdraft/toolset-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { WebFloatingPaletteSection } from "./WebFloatingPaletteSection";
import { scrollPaletteGridHorizontally, webFloatingPaletteFrame, WEB_FLOATING_PALETTE_MARGIN_PX } from "./webFloatingPaletteFrame";

/*
 * The browser floating palette (MainWindow's `.web-floating-palette`, WebFloatingPaletteSection) is as
 * wide as `webFloatingPaletteWidth` says when the viewport holds it, so every item the grid lays out
 * must sit inside that width; in a narrower viewport the frame is clamped into it and the grid
 * scrolls sideways, so every item must sit inside the grid's scrollable extent instead.
 * JSDOM renders the real markup but does no layout, so this lays the rendered items out itself:
 * item order and spans come from the DOM, the metrics from the App.css rules that govern a horizontal
 * floating palette (read from the stylesheet text, since JSDOM cannot resolve var() in shorthands).
 */

const css = readFileSync("apps/desktop/src/App.css", "utf8");

function declaration(selector: string, property: string): string {
  const blocks = css.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const [, selectors, body] of blocks) {
    if (!selectors.replace(/\/\*[\s\S]*?\*\//g, "").split(",").map(part => part.trim()).includes(selector)) continue;
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
let root: Root | undefined;
const DEFAULT_POSITION = { x: 88, y: 154 };
const WIDE_VIEWPORT = 1920;

function setViewportWidth(width: number): void {
  vi.spyOn(globalThis, "innerWidth", "get").mockReturnValue(width);
}

beforeEach(() => setViewportWidth(WIDE_VIEWPORT));
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
});

function mainPalette(registry: DesktopToolsetRegistry) {
  const toolset = registry.require("core.main");
  const groups = getToolsetPaletteGroups(toolset.id, registry, new Map(), false).map(group => group.items);
  const naturalWidth = webFloatingPaletteWidth(toolset, groups);
  const element = (
    <WebFloatingPaletteSection
      toolsetId={toolset.id}
      title={toolset.title}
      naturalWidth={naturalWidth}
      position={DEFAULT_POSITION}
      onPointerDown={() => {}}
      onPointerMove={() => {}}
      onPointerUp={() => {}}
      onPointerCancel={() => {}}
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
    </WebFloatingPaletteSection>
  );
  return { naturalWidth, element };
}

interface MainLayout {
  /** The frame's drawn width and left edge (viewport pixels). */
  frameWidth: number;
  frameX: number;
  /** The width the items need: the frame's width, or the grid's scrollable extent when it scrolls. */
  contentWidth: number;
  scrolls: boolean;
  items: { id: string; left: number; right: number }[];
}

/** Render Main as MainWindow renders a browser floating palette; lay out its items (relative to the frame's left edge). */
function layOutMain(registry: DesktopToolsetRegistry): MainLayout {
  const { naturalWidth, element } = mainPalette(registry);
  container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(element);
  document.body.append(container);

  const section = container.querySelector<HTMLElement>(".web-floating-palette")!;
  const palette = section.querySelector<HTMLElement>(".tool-palette")!;
  expect(palette.classList.contains("horizontal")).toBe(true);
  const frameWidth = px(section.style.getPropertyValue("--palette-width"));
  const frameX = px(section.style.getPropertyValue("--palette-x"));
  const scrolls = section.dataset.paletteHorizontalScroll === "true";
  // A scrolling grid's extent is its natural content width; otherwise the frame must hold it all.
  const contentWidth = scrolls ? naturalWidth : frameWidth;
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
  expect(end).toBeLessThanOrEqual(contentWidth);
  return { frameWidth, frameX, contentWidth, scrolls, items };
}

function expectEveryItemInside({ contentWidth, items }: MainLayout): void {
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect({ id: item.id, inside: item.left >= 0 && item.right <= contentWidth }).toEqual({ id: item.id, inside: true });
  }
}

function expectFrameInViewport(layout: MainLayout, viewport: number): void {
  expect(layout.frameX).toBeGreaterThanOrEqual(0);
  expect(layout.frameX + layout.frameWidth).toBeLessThanOrEqual(viewport);
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

describe("browser floating Main toolbar in a viewport narrower than it", () => {
  const scrollRule = ".web-floating-palette[data-palette-horizontal-scroll] > .tool-palette.floating.horizontal";

  it("keeps the standard Main toolbar's natural frame where the viewport holds it", () => {
    const layout = layOutMain(new ToolsetRegistry(desktopToolsets));
    expect(layout.scrolls).toBe(false);
    expect(layout.frameX).toBe(DEFAULT_POSITION.x);
    expectFrameInViewport(layout, WIDE_VIEWPORT);
  });

  for (const viewport of [1024, 1280]) {
    it(`clamps the standard Main frame into a ${viewport} px viewport and scrolls its grid to reach every button`, () => {
      setViewportWidth(viewport);
      const layout = layOutMain(new ToolsetRegistry(desktopToolsets));
      expect(layout.scrolls).toBe(true);
      expectFrameInViewport(layout, viewport);
      expect(layout.frameWidth).toBe(viewport - 2 * WEB_FLOATING_PALETTE_MARGIN_PX);
      // Every button lies inside the grid's scrollable extent, and that grid scrolls inside the frame.
      expectEveryItemInside(layout);
      expect(layout.contentWidth).toBeGreaterThan(layout.frameWidth);
      expect(declaration(scrollRule, "overflow-x")).toBe("auto");
      expect(declaration(scrollRule, "scrollbar-width")).not.toBe("none");
      expect(declaration(scrollRule, "max-width")).toBe("100%");
      expect(declaration(".web-floating-palette[data-palette-horizontal-scroll]", "grid-template-columns")).toBe("minmax(0, 1fr)");
      // The title row is a child of the clamped frame, so it stays inside it.
      const section = container!.querySelector<HTMLElement>(".web-floating-palette")!;
      expect(section.querySelector(":scope > .palette-title")).not.toBeNull();
      // No button is taken out of the tab order, so keyboard focus (which scrolls it into view) reaches
      // each one. (Some are disabled here only because this render has no selection or zoom state.)
      const buttons = Array.from(section.querySelectorAll<HTMLButtonElement>(".tool-palette button"));
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.filter(button => button.tabIndex < 0).map(button => button.getAttribute("aria-label"))).toEqual([]);
    });
  }

  it("leaves the molecule-drawing Main toolbar's frame unchanged at 1024 px", () => {
    setViewportWidth(1024);
    const registry = new ToolsetRegistry(applyToolbarProfile(desktopToolsets, "molecule-drawing"));
    const layout = layOutMain(registry);
    expect(layout.scrolls).toBe(false);
    expect(layout.frameX).toBe(DEFAULT_POSITION.x);
    expect(layout.frameWidth).toBe(mainPalette(registry).naturalWidth);
    expectEveryItemInside(layout);
  });

  it("re-clamps when the viewport is resized and turns vertical wheel into sideways scrolling", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { element } = mainPalette(new ToolsetRegistry(desktopToolsets));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(element));
    const section = container.querySelector<HTMLElement>(".web-floating-palette")!;
    expect(section.dataset.paletteHorizontalScroll).toBeUndefined();

    setViewportWidth(1280);
    act(() => { globalThis.dispatchEvent(new Event("resize")); });
    expect(section.dataset.paletteHorizontalScroll).toBe("true");
    expect(section.style.getPropertyValue("--palette-width")).toBe("1264px");
    expect(section.style.getPropertyValue("--palette-x")).toBe("8px");

    const scroller = section.querySelector<HTMLElement>(":scope > .tool-palette")!;
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 1430 });
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 1262 });
    const wheel = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    scroller.firstElementChild!.dispatchEvent(wheel);
    expect(scroller.scrollLeft).toBe(100);
    expect(wheel.defaultPrevented).toBe(true);

    setViewportWidth(WIDE_VIEWPORT);
    act(() => { globalThis.dispatchEvent(new Event("resize")); });
    expect(section.dataset.paletteHorizontalScroll).toBeUndefined();
    expect(section.style.getPropertyValue("--palette-x")).toBe(`${DEFAULT_POSITION.x}px`);
  });
});

describe("webFloatingPaletteFrame", () => {
  it("keeps a palette that fits where the user put it", () => {
    expect(webFloatingPaletteFrame(312, 88, 1024)).toEqual({ x: 88, width: 312, scrollsHorizontally: false });
  });

  it("moves a fitting palette left so its right edge stays inside", () => {
    expect(webFloatingPaletteFrame(400, 900, 1024)).toEqual({ x: 616, width: 400, scrollsHorizontally: false });
  });

  it("clamps a palette wider than the viewport to its margins and scrolls it", () => {
    expect(webFloatingPaletteFrame(1431, 88, 1280)).toEqual({ x: 8, width: 1264, scrollsHorizontally: true });
  });
});

describe("scrollPaletteGridHorizontally", () => {
  const scroller = () => ({ scrollWidth: 1430, clientWidth: 1000, scrollLeft: 0 });

  it("scrolls by a vertical wheel and stops at the ends", () => {
    const element = scroller();
    expect(scrollPaletteGridHorizontally(element, { deltaX: 0, deltaY: 300, deltaMode: 0 })).toBe(true);
    expect(element.scrollLeft).toBe(300);
    expect(scrollPaletteGridHorizontally(element, { deltaX: 0, deltaY: 1000, deltaMode: 0 })).toBe(true);
    expect(element.scrollLeft).toBe(430);
    expect(scrollPaletteGridHorizontally(element, { deltaX: 0, deltaY: 50, deltaMode: 0 })).toBe(false);
  });

  it("leaves horizontal wheels and grids that fit to the browser", () => {
    expect(scrollPaletteGridHorizontally(scroller(), { deltaX: 40, deltaY: 10, deltaMode: 0 })).toBe(false);
    expect(scrollPaletteGridHorizontally({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 }, { deltaX: 0, deltaY: 40, deltaMode: 0 })).toBe(false);
  });
});
