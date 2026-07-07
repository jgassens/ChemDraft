// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec } from "./commands";
import { ToolPalette } from "./ToolPalette";
import type { ToolbarPaletteItemModel } from "./toolsets";

const bondCommand: CommandSpec = {
  id: "tool.bond",
  title: "Single Bond",
  icon: "bond",
  source: "core",
  shortcutLabel: "M"
};

function dispatchPointer(element: Element, type: string, relatedTarget?: EventTarget | null) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget ?? null });
  element.dispatchEvent(event);
}

function dispatchPointerButton(element: Element, type: string) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  element.dispatchEvent(event);
}

const schemaBondItem: ToolbarPaletteItemModel = {
  id: "tool.bond",
  kind: "button",
  label: "Single Bond",
  icon: "bond",
  primary: { type: "command", command: bondCommand },
  submenu: {
    type: "command-grid",
    id: "bond-tools",
    title: "Bond tools",
    columns: 2,
    items: [
      bondCommand,
      { id: "tool.wedgeBond", title: "Solid Wedge Bond", icon: "bond", source: "core", enabled: true }
    ]
  },
  tooltip: { title: "Single Bond", description: "Draw a bond.", shortcut: "M", shortcutLabel: "M" },
  layout: { colSpan: 1, rowSpan: 1 }
};

async function renderSchemaPalette(item: ToolbarPaletteItemModel, onInvoke = vi.fn()) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(ToolPalette, {
      groups: [],
      itemGroups: [[item]],
      gridLayout: { columns: 4, cellWidth: 24, cellHeight: 24, gap: 2, padding: 4 },
      onInvoke
    }));
  });
  const button = host.querySelector<HTMLButtonElement>(`[data-toolbar-item-id="${item.id}"] button`);
  if (!button) {
    throw new Error(`Expected toolbar button ${item.id}.`);
  }
  return { button, host, onInvoke, root };
}

describe("ToolPalette hover tooltips", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("shows icon tooltips after 500ms and clears them immediately on leave", async () => {
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(createElement(ToolPalette, {
          groups: [[bondCommand]],
          onInvoke: () => undefined
        }));
      });

      const owner = host.querySelector('[data-command-tooltip-owner="tool.bond"]');
      if (!owner) throw new Error("Expected bond toolbar button shell.");

      await act(async () => {
        dispatchPointer(owner, "pointerover");
      });
      expect(owner.getAttribute("data-tooltip-visible")).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(499);
      });
      expect(owner.getAttribute("data-tooltip-visible")).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(owner.getAttribute("data-tooltip-visible")).toBe("true");

      await act(async () => {
        dispatchPointer(owner, "pointerout", document.body);
      });
      expect(owner.getAttribute("data-tooltip-visible")).toBeNull();

      await act(async () => {
        dispatchPointer(owner, "pointerover");
        dispatchPointer(owner, "pointerout", document.body);
        vi.advanceTimersByTime(500);
      });
      expect(owner.getAttribute("data-tooltip-visible")).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});

describe("ToolPalette schema-backed items", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("invokes the primary command on a short press", async () => {
    vi.useFakeTimers();
    const onInvoke = vi.fn();
    const { button, root } = await renderSchemaPalette(schemaBondItem, onInvoke);

    await act(async () => {
      dispatchPointerButton(button, "pointerdown");
      vi.advanceTimersByTime(120);
      dispatchPointerButton(button, "pointerup");
    });

    expect(onInvoke).toHaveBeenCalledWith("tool.bond");
    await act(async () => root.unmount());
  });

  it("opens submenu on long-press without invoking the primary command", async () => {
    vi.useFakeTimers();
    const onInvoke = vi.fn();
    const { button, host, root } = await renderSchemaPalette(schemaBondItem, onInvoke);

    await act(async () => {
      dispatchPointerButton(button, "pointerdown");
      vi.advanceTimersByTime(421);
      dispatchPointerButton(button, "pointerup");
    });

    const menu = host.querySelector<HTMLElement>('[data-command-flyout-menu="bond-tools"]');
    expect(menu?.hidden).toBe(false);
    expect(menu?.getAttribute("data-toolbar-command-grid-columns")).toBe("2");
    expect(menu?.style.getPropertyValue("--toolbar-command-flyout-columns")).toBe("2");
    expect(onInvoke).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("exposes inline submenu menu semantics only while the DOM menu is open", async () => {
    vi.useFakeTimers();
    const { button, host, root } = await renderSchemaPalette(schemaBondItem);

    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBeNull();

    await act(async () => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    const menu = host.querySelector<HTMLElement>('[data-command-flyout-menu="bond-tools"]');
    const wedge = host.querySelector<HTMLButtonElement>('[data-command-flyout-menu="bond-tools"] [data-command-id="tool.wedgeBond"]');
    if (!menu || !wedge) {
      throw new Error("Expected inline bond submenu.");
    }

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(menu.id);
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.getAttribute("aria-label")).toBe("Bond tools");
    expect(menu.getAttribute("data-toolbar-submenu-owner-id")).toBe("tool.bond");
    expect(wedge.getAttribute("role")).toBe("menuitem");
    await act(async () => root.unmount());
  });

  it("does not open a submenu for null-submenu items during long-press", async () => {
    vi.useFakeTimers();
    const onInvoke = vi.fn();
    const noSubmenuItem: ToolbarPaletteItemModel = { ...schemaBondItem, submenu: null };
    const { button, host, root } = await renderSchemaPalette(noSubmenuItem, onInvoke);

    await act(async () => {
      dispatchPointerButton(button, "pointerdown");
      vi.advanceTimersByTime(500);
      dispatchPointerButton(button, "pointerup");
    });

    expect(host.querySelector("[data-toolbar-submenu]")).toBeNull();
    expect(onInvoke).toHaveBeenCalledWith("tool.bond");
    await act(async () => root.unmount());
  });

  it("invokes submenu commands and closes the submenu", async () => {
    vi.useFakeTimers();
    const onInvoke = vi.fn();
    const { button, host, root } = await renderSchemaPalette(schemaBondItem, onInvoke);

    await act(async () => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const menu = host.querySelector<HTMLElement>('[data-command-flyout-menu="bond-tools"]');
    const wedge = host.querySelector<HTMLButtonElement>('[data-command-flyout-menu="bond-tools"] [data-command-id="tool.wedgeBond"]');
    if (!wedge) {
      throw new Error("Expected wedge submenu item.");
    }
    await act(async () => {
      wedge.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      wedge.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      wedge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onInvoke).toHaveBeenCalledWith("tool.wedgeBond");
    expect(onInvoke).toHaveBeenCalledTimes(1);
    expect(menu?.hidden).toBe(true);
    await act(async () => root.unmount());
  });

  it("does not invoke disabled submenu commands", async () => {
    vi.useFakeTimers();
    const onInvoke = vi.fn();
    const disabledSubmenuItem: ToolbarPaletteItemModel = {
      ...schemaBondItem,
      submenu: {
        ...schemaBondItem.submenu!,
        items: [
          bondCommand,
          {
            id: "tool.wedgeBond",
            title: "Solid Wedge Bond",
            icon: "bond",
            source: "core",
            enabled: false,
            disabledReason: "Selection cannot accept wedge bonds"
          }
        ]
      }
    };
    const { button, host, root } = await renderSchemaPalette(disabledSubmenuItem, onInvoke);

    await act(async () => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const wedge = host.querySelector<HTMLButtonElement>('[data-command-flyout-menu="bond-tools"] [data-command-id="tool.wedgeBond"]');
    if (!wedge) {
      throw new Error("Expected disabled wedge submenu item.");
    }

    expect(wedge.disabled).toBe(true);
    expect(wedge.getAttribute("aria-disabled")).toBe("true");
    expect(wedge.getAttribute("data-disabled")).toBe("true");
    await act(async () => {
      wedge.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      wedge.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      wedge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onInvoke).not.toHaveBeenCalledWith("tool.wedgeBond");
    await act(async () => root.unmount());
  });

  it("disables owner buttons when no primary or submenu command can run", async () => {
    vi.useFakeTimers();
    const disabledItem: ToolbarPaletteItemModel = {
      ...schemaBondItem,
      primary: {
        type: "command",
        command: { ...bondCommand, enabled: false, disabledReason: "Select a molecule" }
      },
      submenu: {
        ...schemaBondItem.submenu!,
        items: schemaBondItem.submenu!.items.map((command) => ({
          ...command,
          enabled: false,
          disabledReason: "Select a molecule"
        }))
      }
    };
    const { button, root } = await renderSchemaPalette(disabledItem);

    expect(button.disabled).toBe(true);
    await act(async () => root.unmount());
  });

  it("closes inline submenus on outside pointerdown and Escape", async () => {
    vi.useFakeTimers();
    const { button, host, root } = await renderSchemaPalette(schemaBondItem);

    await act(async () => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const menu = host.querySelector<HTMLElement>('[data-command-flyout-menu="bond-tools"]');
    expect(menu?.hidden).toBe(false);

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(menu?.hidden).toBe(true);

    await act(async () => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(menu?.hidden).toBe(false);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(menu?.hidden).toBe(true);
    await act(async () => root.unmount());
  });

  it("uses schema tooltip text and grid span metadata", async () => {
    vi.useFakeTimers();
    const wideItem = { ...schemaBondItem, id: "wide.bond", layout: { colSpan: 4, rowSpan: 1 } };
    const { host, root } = await renderSchemaPalette(wideItem);
    const owner = host.querySelector('[data-toolbar-item-id="wide.bond"]');
    if (!owner) {
      throw new Error("Expected wide item.");
    }

    await act(async () => {
      dispatchPointer(owner, "pointerover");
      vi.advanceTimersByTime(500);
    });

    expect(owner.getAttribute("data-tooltip-visible")).toBe("true");
    expect(owner.textContent).toContain("Single Bond");
    expect(owner.textContent).toContain("Draw a bond.");
    expect(owner.getAttribute("data-toolbar-layout-col-span")).toBe("4");
    expect((owner as HTMLElement).style.gridColumn).toBe("span 4");
    await act(async () => root.unmount());
  });
});
