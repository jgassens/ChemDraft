// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppMenuSection } from "./appMenu";
import { MenuBar } from "./MenuBar";

const sections: readonly AppMenuSection[] = [
  {
    id: "file",
    label: "File",
    items: [
      { kind: "command", id: "new", commandId: "document.new", label: "New", enabled: true },
      { kind: "command", id: "disabled", commandId: "document.disabled", label: "Disabled", enabled: false },
      {
        kind: "submenu",
        id: "export",
        label: "Export",
        items: [{ kind: "command", id: "svg", commandId: "export.svg", label: "SVG", enabled: true }]
      }
    ]
  },
  {
    id: "edit",
    label: "Edit",
    items: [{ kind: "command", id: "undo", commandId: "edit.undo", label: "Undo", enabled: true }]
  }
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function mount(onInvoke = vi.fn()): typeof onInvoke {
  act(() => {
    root = createRoot(container!);
    root.render(createElement(MenuBar, { sections, onInvoke }));
  });
  return onInvoke;
}

async function key(target: Element, value: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 5));
  });
}

describe("MenuBar keyboard interaction", () => {
  it("uses roving top-level focus and arrow keys", async () => {
    mount();
    const file = container!.querySelector<HTMLButtonElement>('[data-menu-section="file"]')!;
    const edit = container!.querySelector<HTMLButtonElement>('[data-menu-section="edit"]')!;
    file.focus();

    expect(file.tabIndex).toBe(0);
    expect(edit.tabIndex).toBe(-1);
    await key(file, "ArrowRight");

    expect(document.activeElement).toBe(edit);
    expect(file.tabIndex).toBe(-1);
    expect(edit.tabIndex).toBe(0);
  });

  it("opens from the keyboard, skips disabled rows, invokes once, and restores section focus", async () => {
    const onInvoke = mount();
    const file = container!.querySelector<HTMLButtonElement>('[data-menu-section="file"]')!;
    file.focus();
    await key(file, "ArrowDown");

    const newItem = container!.querySelector<HTMLButtonElement>('[data-command-id="document.new"]')!;
    const exportItem = [...container!.querySelectorAll<HTMLButtonElement>("button[role='menuitem']")].find(
      (button) => button.textContent?.includes("Export")
    )!;
    expect(document.activeElement).toBe(newItem);

    await key(newItem, "ArrowDown");
    expect(document.activeElement).toBe(exportItem);
    await key(exportItem, "ArrowDown");
    expect(document.activeElement).toBe(newItem);

    await act(async () => {
      newItem.click();
      await new Promise((resolve) => window.setTimeout(resolve, 5));
    });
    expect(onInvoke).toHaveBeenCalledTimes(1);
    expect(onInvoke).toHaveBeenCalledWith("document.new");
    expect(document.activeElement).toBe(file);
  });

  it("moves into and back out of nested flyouts and restores focus on Escape", async () => {
    mount();
    const file = container!.querySelector<HTMLButtonElement>('[data-menu-section="file"]')!;
    file.focus();
    await key(file, "ArrowDown");
    const newItem = container!.querySelector<HTMLButtonElement>('[data-command-id="document.new"]')!;
    await key(newItem, "End");
    const exportItem = document.activeElement as HTMLButtonElement;

    await key(exportItem, "ArrowRight");
    const svg = container!.querySelector<HTMLButtonElement>('[data-command-id="export.svg"]')!;
    expect(document.activeElement).toBe(svg);

    await key(svg, "ArrowLeft");
    expect(document.activeElement).toBe(exportItem);
    await key(exportItem, "Escape");
    expect(document.activeElement).toBe(file);
    expect(container!.querySelector("ul[role='menu']")).toBeNull();
  });

  it("sizes dropdowns to their content and keeps one near the right edge inside the viewport", async () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const right = this.matches("ul[role='menu']") ? 1100 : 0;
        return { left: right - 300, right, top: 0, bottom: 0, width: 300, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    try {
      mount();
      const file = container!.querySelector<HTMLButtonElement>('[data-menu-section="file"]')!;
      await act(async () => {
        file.click();
      });
      const menu = container!.querySelector<HTMLUListElement>("ul[role='menu']")!;
      expect(menu.className).toBe("menu-dropdown");
      // 1100 right edge vs 1000 - 8 margin: shift left by 108px.
      expect(menu.style.left).toBe("-108px");
      const css = readFileSync(resolve(__dirname, "App.css"), "utf8");
      const rule = css.match(/\.menu-dropdown \{[^}]*\}/)![0];
      expect(rule).toContain("width: max-content");
      expect(rule).toContain("max-width: calc(100vw - 16px)");
      expect(rule).toContain("min-width: min(220px, calc(100vw - 16px))");
    } finally {
      spy.mockRestore();
    }
  });

  describe("placement", () => {
    function mockLayout(opts: { menuLeft: number; menuWidth: number; parentLeft: number; parentWidth: number }) {
      return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        let left = 0;
        let width = 0;
        if (this.matches("ul.menu-flyout")) {
          left = opts.menuLeft;
          width = opts.menuWidth;
        } else if (this.matches("li.menu-has-submenu, li.menu-dropdown-item")) {
          left = opts.parentLeft;
          width = opts.parentWidth;
        } else if (this.matches("ul[role='menu']")) {
          left = opts.menuLeft;
          width = opts.menuWidth;
        }
        return { left, right: left + width, top: 0, bottom: 0, width, height: 0, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
      });
    }

    async function openFlyout(): Promise<HTMLUListElement> {
      mount();
      await act(async () => {
        container!.querySelector<HTMLButtonElement>('[data-menu-section="file"]')!.click();
      });
      const exportItem = container!.querySelector<HTMLButtonElement>("ul[role='menu'] button[aria-haspopup='menu']")!;
      await act(async () => {
        exportItem.click();
      });
      return container!.querySelector<HTMLUListElement>("ul.menu-flyout")!;
    }

    it("opens a flyout to the right when it fits", async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
      const spy = mockLayout({ menuLeft: 300, menuWidth: 200, parentLeft: 100, parentWidth: 200 });
      try {
        const flyout = await openFlyout();
        expect(flyout.style.right).toBe("");
        expect(flyout.style.left).toBe("");
      } finally {
        spy.mockRestore();
      }
    });

    it("flips a flyout left when only the left side fits", async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
      const spy = mockLayout({ menuLeft: 502, menuWidth: 200, parentLeft: 300, parentWidth: 200 });
      try {
        const flyout = await openFlyout();
        expect(flyout.style.right).toBe("100%");
        expect(flyout.style.left).toBe("auto");
      } finally {
        spy.mockRestore();
      }
    });

    it("clamps a flyout inside the viewport when neither side fits", async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
      const spy = mockLayout({ menuLeft: 222, menuWidth: 300, parentLeft: 20, parentWidth: 200 });
      try {
        const flyout = await openFlyout();
        expect(flyout.style.right).toBe("");
        // Viewport left = max(8, min(222, 392 - 300)) = 92; relative to parent at 20 -> 72.
        expect(flyout.style.left).toBe("72px");
        expect(flyout.style.margin).toMatch(/^0(px)?$/);
      } finally {
        spy.mockRestore();
      }
    });

    it("never shifts a dropdown's left edge below the margin on a narrow viewport", async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 200 });
      const spy = mockLayout({ menuLeft: 20, menuWidth: 220, parentLeft: 20, parentWidth: 40 });
      try {
        mount();
        await act(async () => {
          container!.querySelector<HTMLButtonElement>('[data-menu-section="file"]')!.click();
        });
        const menu = container!.querySelector<HTMLUListElement>("ul[role='menu']")!;
        // Overflow shift would be -48; clamped so left edge stays at 8 (20 - 12).
        expect(menu.style.left).toBe("-12px");
      } finally {
        spy.mockRestore();
      }
    });

    it("re-places an open dropdown when the window is resized", async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
      const spy = mockLayout({ menuLeft: 500, menuWidth: 300, parentLeft: 500, parentWidth: 40 });
      try {
        mount();
        await act(async () => {
          container!.querySelector<HTMLButtonElement>('[data-menu-section="file"]')!.click();
        });
        const menu = container!.querySelector<HTMLUListElement>("ul[role='menu']")!;
        expect(menu.style.left).toBe("");
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 700 });
        await act(async () => {
          window.dispatchEvent(new Event("resize"));
        });
        expect(menu.style.left).toBe("-108px");
      } finally {
        spy.mockRestore();
      }
    });
  });
});
