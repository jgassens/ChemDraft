// @vitest-environment jsdom

import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MainWindow } from "./MainWindow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("shared browser menu bar", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    const tauriGlobal = globalThis as typeof globalThis & {
      __TAURI__?: unknown;
      __TAURI_INTERNALS__?: unknown;
    };
    delete tauriGlobal.__TAURI__;
    delete tauriGlobal.__TAURI_INTERNALS__;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  async function renderBrowserPreview() {
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(MainWindow, {
        initialPaletteMode: "floating",
        initialRulersVisible: false,
        nativePalette: false
      })));
    });
  }

  function button(selector: string): HTMLButtonElement {
    const element = container.querySelector<HTMLButtonElement>(selector);
    if (!element) {
      throw new Error(`Expected button ${selector}.`);
    }
    return element;
  }

  function buttonWithText(text: string): HTMLButtonElement {
    const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.textContent?.includes(text)
    );
    if (!element) {
      throw new Error(`Expected button containing ${text}.`);
    }
    return element;
  }

  it("opens routed File commands and closes after invoking a page setup item", async () => {
    await renderBrowserPreview();

    expect(container.querySelectorAll('[role="menubar"]')).toHaveLength(1);
    expect(container.querySelector('[data-dev-browser-menu-bar="true"]')).toBeNull();

    await act(async () => {
      button('[data-menu-section="file"]').click();
    });

    expect(container.querySelector('.menu-section.is-open > [role="menu"]')).not.toBeNull();
    expect(button('[data-command-id="document.open"]').textContent).toContain("Open");
    await act(async () => {
      buttonWithText("Page Setup").click();
    });
    await act(async () => {
      buttonWithText("Paper Size").click();
    });
    expect(button('[data-command-id="page.setSize.a4"]').textContent).toContain("A4");

    await act(async () => {
      button('[data-command-id="page.setSize.a4"]').click();
      await Promise.resolve();
    });

    expect(container.querySelector('.menu-section.is-open > [role="menu"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Page size: A4");
  });

  it("opens routed View toolbar toggles in the browser menu", async () => {
    await renderBrowserPreview();

    await act(async () => {
      button('[data-menu-section="view"]').click();
    });

    expect(container.querySelector('.menu-section.is-open > [role="menu"]')).not.toBeNull();
    expect(button('[data-command-id="view.toggleRulers"]').getAttribute("aria-checked")).toBe("false");
    expect(button('[data-command-id="view.toggleCrosshairs"]').getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      buttonWithText("Toolbars").click();
    });
    expect(button('[data-command-id="view.toolset.toggle.core.ringInspector"]').textContent).toContain("Rings");
    expect(button('[data-command-id="view.toolset.toggle.core.moleculeInspector"]').textContent).toContain("Molecule");
  });
});
