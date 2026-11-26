// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { MainWindow } from "./MainWindow";
import { saveKeybindingSettings } from "./keybindingSettings";

// jsdom has no 2D canvas for the ruler's ticks; the ruler strips (.ruler-left, .ruler-top) still render.
vi.mock("@scena/react-ruler", () => ({ default: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** The declarations of one rule in App.css, by its exact selector. */
function cssRule(selector: string): string {
  const css = readFileSync("apps/desktop/src/App.css", "utf8");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) {
    throw new Error(`No rule for ${selector} in App.css`);
  }
  return match[1].replace(/\s+/g, " ");
}

function px(value: string | undefined): number {
  const match = value?.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (!match) throw new Error(`Expected a px length, got ${JSON.stringify(value)}`);
  return Number(match[1]);
}

/** The declared value of one property in an App.css rule. */
function declaration(selector: string, property: string): string | undefined {
  return cssRule(selector).match(new RegExp(`(?:^|[ ;])${property}: ([^;]+);`))?.[1].trim();
}

function isOpaqueBackground(value: string | undefined): boolean {
  return value !== undefined && !/^(none|transparent|initial|unset|inherit)$/.test(value) && !/rgba?\([^)]*,\s*0\)/.test(value);
}

// Owner bug (1.2.3): with rulers on, the status line at the bottom left of the document window
// ("Inserted picture mixed.png", "⇧: show rotate handles") was drawn over the vertical ruler's
// ticks and straight onto the page with no background. The row is positioned in the workspace,
// whose left edge is the canvas region's, where the vertical ruler sits; it started 8 px in, inside
// the 32 px ruler. jsdom has no layout, so the geometry here is the row's CSS `left` plus its inline
// inset against the ruler's inline (border-box) width, both from MainWindow's RULER_THICKNESS.
describe("status row and the rulers", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let originalInnerWidth = window.innerWidth;

  async function render(options: { rulers: boolean; platform: ShortcutPlatform; width?: number }) {
    saveKeybindingSettings({ scheme: "chemdraft" });
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    originalInnerWidth = window.innerWidth;
    if (options.width !== undefined) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: options.width });
    }
    container = document.createElement("div");
    if (options.width !== undefined) container.style.width = `${options.width}px`;
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.bond",
        initialCrosshairsVisible: false,
        initialPaletteMode: "hidden",
        initialRulersVisible: options.rulers,
        nativePalette: false,
        shortcutPlatform: options.platform
      }));
    });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    const row = container.querySelector<HTMLElement>("[data-status-row]");
    expect(row).not.toBeNull();
    return row!;
  }

  /** The status row's left edge, in px from the workspace's (= the canvas region's) left edge. */
  function statusLeftEdge(row: HTMLElement): number {
    return px(declaration(".status-row", "left")) + (row.style.paddingLeft ? px(row.style.paddingLeft) : 0);
  }

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = undefined;
    root = undefined;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  const platforms: ShortcutPlatform[] = ["macos", "windows"];

  it.each(platforms)("starts the status clear of the vertical ruler when rulers are on (%s)", async (platform) => {
    const row = await render({ rulers: true, platform });
    const canvas = container!.querySelector<HTMLElement>(".canvas-region");
    const verticalRuler = canvas?.querySelector<HTMLElement>(".ruler-left");
    expect(verticalRuler).not.toBeNull();
    // `* { box-sizing: border-box }`: the inline width includes the ruler's border.
    const rulerRight = px(verticalRuler!.style.width);
    expect(rulerRight).toBeGreaterThan(0);
    expect(statusLeftEdge(row)).toBeGreaterThanOrEqual(rulerRight);
    // Anchored to the bottom, never to the top, where the horizontal ruler is.
    expect(cssRule(".status-row")).toMatch(/bottom: 8px;/);
    expect(cssRule(".status-row")).not.toMatch(/(^|[ ;])top:/);
  });

  it.each(platforms)("leaves no ruler gap when rulers are off (%s)", async (platform) => {
    const row = await render({ rulers: false, platform });
    expect(container!.querySelector(".ruler-left")).toBeNull();
    expect(statusLeftEdge(row)).toBe(px(declaration(".status-row", "left")));
  });

  it.each(platforms)("clears the ruler and still truncates in a narrow window (%s)", async (platform) => {
    const row = await render({ rulers: true, platform, width: 360 });
    const verticalRuler = container!.querySelector<HTMLElement>(".ruler-left");
    expect(statusLeftEdge(row)).toBeGreaterThanOrEqual(px(verticalRuler!.style.width));
    // The row ends inside the window and its text shrinks to an ellipsis rather than running on.
    expect(cssRule(".status-row")).toMatch(/right: 8px;/);
    expect(cssRule(".status-row-main")).toMatch(/min-width: 0;/);
    expect(cssRule(".status-message,\n.status-modifier-hint")).toMatch(/min-width: 0;.*overflow: hidden;.*text-overflow: ellipsis;.*white-space: nowrap;/);
  });

  it("gives every status text a background of the window chrome, so it reads over the page", () => {
    const chrome = /var\(--cd-bg-panel\)/;
    for (const selector of [".status-message,\n.status-modifier-hint", ".open-warnings-button"]) {
      const background = declaration(selector, "background");
      expect(isOpaqueBackground(background), `${selector} background: ${background}`).toBe(true);
      expect(background).toMatch(chrome);
    }
    // Translucency would let the page show through the background: no opacity on the texts or the row.
    for (const selector of [".status-row", ".status-row-main", ".status-modifier-hint", ".status-message"]) {
      expect(cssRule(selector), selector).not.toMatch(/(^|[ ;])opacity:/);
    }
    // An empty status draws nothing, not an empty chip.
    expect(isOpaqueBackground(declaration(".status-message:empty", "background"))).toBe(false);
  });
});
