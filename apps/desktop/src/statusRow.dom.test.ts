// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MainWindow } from "./MainWindow";
import { saveKeybindingSettings } from "./keybindingSettings";

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

// The status and the build stamp share one row along the bottom of the workspace. Positioned apart
// (the status left with a fixed max-width, the stamp right), a long status or a branch build's long
// stamp ran one into the other and over the warnings count. In one flex row the left part shrinks
// and truncates while the stamp keeps its width, so they cannot overlap at any window width.
// Layout itself is checked in a browser (see the PR); jsdom has none, so this pins the structure and
// the CSS that layout depends on.
describe("status row", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(async () => {
    saveKeybindingSettings({ scheme: "chemdraft" });
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.bond",
        initialCrosshairsVisible: false,
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: false
      }));
    });
    const cdxml = readFileSync("packages/fixtures/cdxml/ten-metals.cdxml", "utf8");
    await act(async () => {
      window.location.hash = `#${new URLSearchParams({ openDocumentText: cdxml, displayName: "ten-metals.cdxml" }).toString()}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  it("holds the status, the warnings count and the build stamp in one row, the stamp last", () => {
    const row = container.querySelector<HTMLElement>("[data-status-row]");
    expect(row).not.toBeNull();
    const status = row!.querySelector("[data-status-message]");
    const warnings = row!.querySelector("[data-open-warnings-button]");
    const stamp = row!.querySelector("[data-build-stamp]");
    expect(status?.getAttribute("role")).toBe("status");
    expect(warnings?.textContent).toBe("11 warnings");
    expect(stamp?.textContent).toMatch(/^Build /);
    expect(row!.lastElementChild).toBe(stamp);
    // One of each: no second, separately positioned stamp or status.
    expect(container.querySelectorAll("[data-build-stamp]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-status-message]")).toHaveLength(1);
  });

  it("lets the status shrink and truncate while the stamp and the warnings count keep their width", () => {
    expect(cssRule(".status-row")).toMatch(/display: flex;/);
    expect(cssRule(".status-row")).toMatch(/left: 8px;.*right: 8px;/);
    expect(cssRule(".status-row-main")).toMatch(/flex: 1 1 auto;/);
    expect(cssRule(".status-row-main")).toMatch(/min-width: 0;/);
    expect(cssRule(".status-message,\n.status-modifier-hint")).toMatch(/min-width: 0;.*text-overflow: ellipsis;.*white-space: nowrap;/);
    expect(cssRule(".build-stamp")).toMatch(/flex: 0 0 auto;/);
    expect(cssRule(".build-stamp")).toMatch(/white-space: nowrap;/);
    expect(cssRule(".open-warnings-button")).toMatch(/flex: 0 0 auto;/);
  });
});
