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
import {
  webFloatingPalettePosition,
  WEB_FLOATING_PALETTE_GRAB_MARGIN_PX,
  WEB_FLOATING_PALETTE_MIN_Y_PX,
  WEB_FLOATING_PALETTE_TITLE_BAR_PX
} from "./webFloatingPaletteFrame";

/*
 * The browser floating palette (MainWindow's `.web-floating-palette`, WebFloatingPaletteSection) is as
 * exactly as wide as `webFloatingPaletteWidth` says, in every viewport (it is never shrunk, wrapped or
 * scrolled; a wide one runs past the viewport's edge and is dragged), so every item the grid lays out
 * must sit inside that width.
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
  const match = /^(-?\d+(?:\.\d+)?)px\b/.exec(value);
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
const VIEWPORT_HEIGHT = 800;

function setViewportWidth(width: number): void {
  vi.spyOn(globalThis, "innerWidth", "get").mockReturnValue(width);
}

function setViewportHeight(height: number): void {
  vi.spyOn(globalThis, "innerHeight", "get").mockReturnValue(height);
}

beforeEach(() => {
  setViewportWidth(WIDE_VIEWPORT);
  setViewportHeight(VIEWPORT_HEIGHT);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
});

function mainPalette(registry: DesktopToolsetRegistry, position = DEFAULT_POSITION) {
  const toolset = registry.require("core.main");
  const groups = getToolsetPaletteGroups(toolset.id, registry, new Map(), false).map(group => group.items);
  const naturalWidth = webFloatingPaletteWidth(toolset, groups);
  const element = (
    <WebFloatingPaletteSection
      toolsetId={toolset.id}
      title={toolset.title}
      naturalWidth={naturalWidth}
      position={position}
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
  naturalWidth: number;
  items: { id: string; left: number; right: number }[];
}

/** Render Main as MainWindow renders a browser floating palette; lay out its items (relative to the frame's left edge). */
function layOutMain(registry: DesktopToolsetRegistry, position = DEFAULT_POSITION): MainLayout {
  const { naturalWidth, element } = mainPalette(registry, position);
  container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(element);
  document.body.append(container);

  const section = container.querySelector<HTMLElement>(".web-floating-palette")!;
  const palette = section.querySelector<HTMLElement>(".tool-palette")!;
  expect(palette.classList.contains("horizontal")).toBe(true);
  const frameWidth = px(section.style.getPropertyValue("--palette-width"));
  const frameX = px(section.style.getPropertyValue("--palette-x"));
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
  return { frameWidth, frameX, naturalWidth, items };
}

function expectEveryItemInside({ frameWidth, items }: MainLayout): void {
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect({ id: item.id, inside: item.left >= 0 && item.right <= frameWidth }).toEqual({ id: item.id, inside: true });
  }
}

/** The grab margin of the title bar (which spans the frame) lies inside a viewport `viewport` px wide. */
function expectGrabMarginInViewport(frameX: number, frameWidth: number, viewport: number): void {
  const grab = Math.min(WEB_FLOATING_PALETTE_GRAB_MARGIN_PX, frameWidth);
  expect(frameX + frameWidth).toBeGreaterThanOrEqual(grab);
  expect(frameX + grab).toBeLessThanOrEqual(viewport);
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
  it("keeps the standard Main toolbar's natural frame where the viewport holds it", () => {
    const layout = layOutMain(new ToolsetRegistry(desktopToolsets));
    expect(layout.frameX).toBe(DEFAULT_POSITION.x);
    expect(layout.frameWidth).toBe(layout.naturalWidth);
  });

  it("never gives a browser palette a scrollbar or a viewport-clamped width", () => {
    expect(css).not.toMatch(/data-palette-horizontal-scroll/);
    for (const [, selectors, body] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!selectors.includes(".web-floating-palette")) continue;
      expect({ selectors: selectors.trim(), scrollsOrClamps: /(?:overflow-x|max-width)\s*:/.test(body) })
        .toEqual({ selectors: selectors.trim(), scrollsOrClamps: false });
    }
    expect(declaration(".web-floating-palette", "width")).toBe("var(--palette-width, 96px)");
    expect(declaration(".web-floating-palette", "overflow")).toBe("visible");
  });

  for (const viewport of [1024, 1280]) {
    it(`keeps the standard Main toolbar's natural width at ${viewport} px and lets it be dragged to its rightmost button`, () => {
      setViewportWidth(viewport);
      const registry = new ToolsetRegistry(desktopToolsets);
      const atDefault = layOutMain(registry);
      // Natural width, wider than the viewport, at the user's position: it runs past the right edge.
      expect(atDefault.frameWidth).toBe(atDefault.naturalWidth);
      expect(atDefault.frameWidth).toBeGreaterThan(viewport);
      expect(atDefault.frameX).toBe(DEFAULT_POSITION.x);
      expect(container!.querySelector(".web-floating-palette")!.hasAttribute("data-palette-horizontal-scroll")).toBe(false);
      expectEveryItemInside(atDefault);
      container!.remove();

      // Dragged as far left as it goes: the rightmost button lies inside the viewport.
      const farLeft = webFloatingPalettePosition(atDefault.naturalWidth, { x: -10_000, y: DEFAULT_POSITION.y }, { width: viewport, height: VIEWPORT_HEIGHT });
      const draggedLeft = layOutMain(registry, farLeft);
      expect(draggedLeft.frameWidth).toBe(draggedLeft.naturalWidth);
      expect(draggedLeft.frameX).toBe(WEB_FLOATING_PALETTE_GRAB_MARGIN_PX - draggedLeft.naturalWidth);
      const rightmost = draggedLeft.items.reduce((a, b) => (b.right > a.right ? b : a));
      expect(draggedLeft.frameX + rightmost.right).toBeGreaterThan(0);
      expect(draggedLeft.frameX + rightmost.right).toBeLessThanOrEqual(viewport);
      expectGrabMarginInViewport(draggedLeft.frameX, draggedLeft.frameWidth, viewport);
      container!.remove();

      // The rightmost item can be dragged wholly into view (on RC6's Main it is the eleven-cell style
      // widget, wider than the grab margin, so the far-left position shows only its right part).
      const reach = webFloatingPalettePosition(
        atDefault.naturalWidth, { x: viewport - 8 - rightmost.right, y: DEFAULT_POSITION.y }, { width: viewport, height: VIEWPORT_HEIGHT }
      );
      const reached = layOutMain(registry, reach);
      const reachedRightmost = reached.items.find(item => item.id === rightmost.id)!;
      expect(reached.frameX + reachedRightmost.left).toBeGreaterThanOrEqual(0);
      expect(reached.frameX + reachedRightmost.right).toBeLessThanOrEqual(viewport);
      expectGrabMarginInViewport(reached.frameX, reached.frameWidth, viewport);
      container!.remove();

      // A stored position past either edge is drawn with the grab margin back inside.
      for (const x of [-10_000, 10_000]) {
        const restored = layOutMain(registry, { x, y: DEFAULT_POSITION.y });
        expect(restored.frameWidth).toBe(restored.naturalWidth);
        expectGrabMarginInViewport(restored.frameX, restored.frameWidth, viewport);
        container!.remove();
      }
    });
  }

  it("leaves the molecule-drawing Main toolbar's frame unchanged at 1024 px", () => {
    setViewportWidth(1024);
    const registry = new ToolsetRegistry(applyToolbarProfile(desktopToolsets, "molecule-drawing"));
    const layout = layOutMain(registry);
    expect(layout.frameX).toBe(DEFAULT_POSITION.x);
    expect(layout.frameWidth).toBe(layout.naturalWidth);
    expectEveryItemInside(layout);
  });

  it("moves, never resizes, the frame when the viewport is resized", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const stored = { x: 1100, y: 600 };
    const { element, naturalWidth } = mainPalette(new ToolsetRegistry(desktopToolsets), stored);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(element));
    const section = container.querySelector<HTMLElement>(".web-floating-palette")!;
    expect(section.style.getPropertyValue("--palette-x")).toBe("1100px");
    expect(section.style.getPropertyValue("--palette-y")).toBe("600px");
    expect(section.style.getPropertyValue("--palette-width")).toBe(`${naturalWidth}px`);

    setViewportWidth(1024);
    setViewportHeight(400);
    act(() => { globalThis.dispatchEvent(new Event("resize")); });
    expect(section.style.getPropertyValue("--palette-x")).toBe(`${1024 - WEB_FLOATING_PALETTE_GRAB_MARGIN_PX}px`);
    expect(section.style.getPropertyValue("--palette-y")).toBe(`${400 - WEB_FLOATING_PALETTE_GRAB_MARGIN_PX}px`);
    expect(section.dataset.paletteX).toBe(String(1024 - WEB_FLOATING_PALETTE_GRAB_MARGIN_PX));
    expect(section.style.getPropertyValue("--palette-width")).toBe(`${naturalWidth}px`);

    setViewportWidth(WIDE_VIEWPORT);
    setViewportHeight(VIEWPORT_HEIGHT);
    act(() => { globalThis.dispatchEvent(new Event("resize")); });
    expect(section.style.getPropertyValue("--palette-x")).toBe("1100px");
    expect(section.style.getPropertyValue("--palette-y")).toBe("600px");
  });
});

describe("webFloatingPalettePosition", () => {
  const viewport = { width: 1024, height: 768 };

  it("keeps a position that leaves the grab margin inside", () => {
    expect(webFloatingPalettePosition(312, { x: 88, y: 154 }, viewport)).toEqual({ x: 88, y: 154 });
  });

  it("lets a narrow palette run partly past the right and left edges", () => {
    expect(webFloatingPalettePosition(312, { x: 900, y: 154 }, viewport)).toEqual({ x: 900, y: 154 });
    expect(webFloatingPalettePosition(312, { x: -200, y: 154 }, viewport)).toEqual({ x: -200, y: 154 });
  });

  it("keeps a grab margin of the title bar inside the viewport", () => {
    expect(webFloatingPalettePosition(312, { x: 5000, y: 154 }, viewport).x).toBe(1024 - WEB_FLOATING_PALETTE_GRAB_MARGIN_PX);
    expect(webFloatingPalettePosition(312, { x: -5000, y: 154 }, viewport).x).toBe(WEB_FLOATING_PALETTE_GRAB_MARGIN_PX - 312);
    expect(webFloatingPalettePosition(1431, { x: -5000, y: 154 }, viewport).x).toBe(WEB_FLOATING_PALETTE_GRAB_MARGIN_PX - 1431);
  });

  it("keeps the whole title bar height inside, below the top strip", () => {
    expect(webFloatingPalettePosition(312, { x: 88, y: 5000 }, viewport).y).toBe(768 - WEB_FLOATING_PALETTE_GRAB_MARGIN_PX);
    expect(768 - WEB_FLOATING_PALETTE_GRAB_MARGIN_PX + WEB_FLOATING_PALETTE_TITLE_BAR_PX).toBeLessThanOrEqual(768);
    expect(webFloatingPalettePosition(312, { x: 88, y: -50 }, viewport).y).toBe(WEB_FLOATING_PALETTE_MIN_Y_PX);
  });

  it("keeps a palette narrower than the grab margin wholly inside", () => {
    expect(webFloatingPalettePosition(30, { x: -100, y: 154 }, viewport).x).toBe(0);
    expect(webFloatingPalettePosition(30, { x: 2000, y: 154 }, viewport).x).toBe(1024 - 30);
  });

  it("clamps a max-content palette by its rendered width, not the passed one", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const rendered = 300;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: rendered, height: 100, x: 0, y: 0, top: 0, left: 0, right: rendered, bottom: 100, toJSON: () => ({}) });
    setViewportWidth(1024);
    const render = (x: number) => {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      act(() => root!.render(
        <WebFloatingPaletteSection toolsetId="rings" title="Rings" naturalWidth={32} position={{ x, y: 200 }}
          onPointerDown={() => {}} onPointerMove={() => {}} onPointerUp={() => {}} onPointerCancel={() => {}}>
          <div />
        </WebFloatingPaletteSection>
      ));
      const section = container.querySelector<HTMLElement>(".web-floating-palette")!;
      act(() => root!.unmount());
      root = undefined;
      container.remove();
      return section;
    };
    const left = render(-10_000);
    expect(left.dataset.paletteX).toBe(String(WEB_FLOATING_PALETTE_GRAB_MARGIN_PX - rendered));
    expect(left.dataset.paletteWidth).toBe(String(rendered));
    const right = render(10_000);
    expect(right.dataset.paletteX).toBe(String(1024 - WEB_FLOATING_PALETTE_GRAB_MARGIN_PX));
  });
});
