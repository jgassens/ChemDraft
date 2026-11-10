// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec } from "./commands";
import { TOOLBAR_FLYOUT_HOLD_MS, ToolPalette } from "./ToolPalette";
import type { ToolbarPaletteItemModel } from "./toolsets";
import { getToolsetItemGroups } from "./toolsets";
import { foldMainToolbar, toolbarOverflowPrefix } from "./toolbars/toolbarFit";
import { MAIN_TOOLBAR_GROUPS } from "@chemdraft/toolset-registry";

const popovers = vi.hoisted(() => ({ open: vi.fn(), update: vi.fn(), dispose: vi.fn() }));
vi.mock("./window-manager", async original => ({ ...await original<typeof import("./window-manager")>(),
  openToolsetToolbarItemsPopover: popovers.open
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bondCommand: CommandSpec = {
  id: "tool.bond",
  title: "Single Bond",
  icon: "bond",
  source: "core",
  shortcutLabel: "M"
};

describe("toolbar fit policy", () => {
  const groups = ["select-text", "bonds-rings", "arrows", "symbols-shapes", "orbitals", "arrange", "style-3d", "undeclared"]
    .map(id => ({ id, length: 100, prefixes: [24, 100], foldedLength: 24 }));
  it("folds Orbitals and Undeclared together, then Arrange, Style & 3D, Symbols & Shapes, Arrows, Bonds & Rings", () => {
    const steps = [["orbitals", "undeclared"], ["arrange"], ["style-3d"], ["symbols-shapes"], ["arrows"], ["bonds-rings"]];
    let available = 800;
    const expected: string[] = [];
    for (const step of steps) {
      available--;
      expected.push(...step);
      expect([...foldMainToolbar(groups, available, 0)]).toEqual(expected);
      available -= step.length * 76 - 1;
    }
    expect(foldMainToolbar(groups, 0, 0).has("select-text")).toBe(false);
  });
  it("unfolds in reverse order and ignores absent/empty groups", () => {
    expect([...foldMainToolbar(groups, 343, 0)]).toEqual(["orbitals", "undeclared", "arrange", "style-3d", "symbols-shapes", "arrows", "bonds-rings"]);
    expect([...foldMainToolbar(groups, 344, 0)]).toEqual(["orbitals", "undeclared", "arrange", "style-3d", "symbols-shapes", "arrows"]);
    expect([...foldMainToolbar(groups, 420, 0)]).toEqual(["orbitals", "undeclared", "arrange", "style-3d", "symbols-shapes"]);
    expect([...foldMainToolbar(groups, 800, 0)]).toEqual([]);
    expect([...foldMainToolbar(groups.filter(group => group.id === "select-text"), 1, 4)]).toEqual([]);
  });
  it("reserves overflow space and keeps a prefix across packed two-row cells and multi-cell controls", () => {
    const packed = [{ length: 108, prefixes: [24, 24, 80, 108], foldedLength: 24 }];
    expect(toolbarOverflowPrefix(packed, 107, 4, 24)).toBe(2);
    expect(toolbarOverflowPrefix(packed, 108, 4, 24)).toBe(4);
    expect(toolbarOverflowPrefix([{ length: 180, prefixes: [24, 140, 180], foldedLength: 24 }], 100, 4, 24)).toBe(1);
    expect(toolbarOverflowPrefix([{ length: 24, prefixes: [24], foldedLength: 24 }, ...packed], 110, 4, 24)).toBe(3);
  });
});

describe("ToolPalette viewport fitting", () => {
  afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });
  function mockBounds(main = false, orientation: "horizontal" | "vertical" = "horizontal") {
    let available = main ? 900 : 200;
    const rect = (width: number, height = 24, x = 0, y = 0) => ({ width, height, x, y, left: x, top: y,
      right: x + width, bottom: y + height, toJSON() {} });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const element = this as HTMLElement;
      if (element.matches(".tool-palette")) {
        const length = element.classList.contains("toolbar-measuring") ? (main ? 828 : 136) : available;
        return orientation === "horizontal" ? rect(length, 60) : rect(60, length);
      }
      if (element.matches(".tool-group")) return orientation === "horizontal" ? rect(main ? 100 : 136, 52) : rect(52, 136);
      if (element.matches(".toolbar-overflow-measure")) return rect(24);
      const index = Number(element.dataset.toolbarItemId?.split(".").at(-1));
      if (!main && Number.isFinite(index)) return orientation === "horizontal"
        ? index < 2 ? rect(24, 24, 0, index * 28) : index === 2 ? rect(80, 52, 28) : rect(24, 24, 112)
        : index < 2 ? rect(24, 24, index * 28, 0) : index === 2 ? rect(52, 80, 0, 28) : rect(24, 24, 0, 112);
      return rect(24);
    });
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation(element => {
      const style = computed(element);
      if (element.matches(".tool-palette")) return new Proxy(style, { get: (target, key) => key === "columnGap" || key === "rowGap" ? "4px" : Reflect.get(target, key) });
      return style;
    });
    popovers.open.mockReset().mockReturnValue({ ready: Promise.resolve(), update: popovers.update, dispose: popovers.dispose, close: vi.fn() });
    popovers.update.mockReset().mockResolvedValue(undefined);
    popovers.dispose.mockReset();
    return (length: number) => { available = length; window.dispatchEvent(new Event("resize")); };
  }
  const item = (index: number): ToolbarPaletteItemModel => ({ ...schemaBondItem, id: `fit.${index}`,
    primary: { type: "command", command: { ...bondCommand, id: `fit.${index}` } }, submenu: null,
    layout: { colSpan: index === 2 ? 3 : 1, rowSpan: index === 2 ? 2 : 1 } });

  it("shows no overflow when all items fit, moves hidden focus to More tools, and opens the ordered remainder", async () => {
    const resize = mockBounds();
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    const items = [0, 1, 2, 3].map(item);
    await act(async () => root.render(createElement(ToolPalette, { toolsetId: "user.quick", itemGroups: [items],
      mode: "floating", orientation: "horizontal", title: "Quick tools", onInvoke: vi.fn() })));
    const toolbar = host.querySelector<HTMLElement>(".tool-palette")!;
    expect(toolbar.getAttribute("role")).toBe("toolbar");
    expect(toolbar.getAttribute("aria-label")).toBe("Quick tools");
    expect(toolbar.querySelector(":scope > [data-toolbar-overflow]")).toBeNull();
    await act(async () => toolbar.querySelector<HTMLButtonElement>(':scope > .tool-group [data-toolbar-item-id="fit.3"] button')!.focus());
    await act(async () => resize(100));
    const overflow = toolbar.querySelector<HTMLButtonElement>(":scope > [data-toolbar-overflow]")!;
    expect(document.activeElement).toBe(overflow);
    expect(overflow.getAttribute("aria-label")).toBe("More tools");
    expect(overflow.getAttribute("aria-haspopup")).toBe("menu");
    expect(overflow.hasAttribute("aria-controls")).toBe(false);
    expect([...toolbar.querySelectorAll<HTMLElement>(":scope > .tool-group > [data-toolbar-item-id]")].map(element => element.dataset.toolbarItemId)).toEqual(["fit.0", "fit.1"]);
    await act(async () => overflow.click());
    expect(popovers.open.mock.calls[0][0].toolbar.items.map((entry: ToolbarPaletteItemModel) => entry.id)).toEqual(["fit.2", "fit.3"]);
    await act(async () => root.render(createElement(ToolPalette, { toolsetId: "user.quick", itemGroups: [items],
      mode: "floating", orientation: "horizontal", title: "Quick tools", activeTool: "fit.3",
      widgetState: { currentObjectColor: "#00ff00", onInvoke: vi.fn() }, onInvoke: vi.fn() })));
    expect(popovers.update).toHaveBeenLastCalledWith(expect.objectContaining({ activeTool: "fit.3",
      widgetState: expect.objectContaining({ currentObjectColor: "#00ff00" }) }));
    await act(async () => resize(200));
    expect(toolbar.querySelector(":scope > [data-toolbar-overflow]")).toBeNull();
    expect(popovers.update).toHaveBeenLastCalledWith(undefined);
    await act(async () => root.unmount());
  });

  it("folds whole groups, transfers focus to the named fold button and unfolds as length returns", async () => {
    const resize = mockBounds(true);
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    const groups = MAIN_TOOLBAR_GROUPS.map((group, index) => ({ ...group, items: [item(index * 2), item(index * 2 + 1)] }));
    await act(async () => root.render(createElement(ToolPalette, { toolsetId: "core.main", groupMetadata: groups,
      itemGroups: groups.map(group => group.items), mode: "floating", orientation: "horizontal", onInvoke: vi.fn() })));
    const toolbar = host.querySelector<HTMLElement>(".tool-palette")!;
    await act(async () => toolbar.querySelector<HTMLButtonElement>(':scope > [data-toolbar-group-id="orbitals"] button')!.focus());
    await act(async () => resize(827));
    expect([...toolbar.querySelectorAll<HTMLElement>(":scope > .tool-group > [data-toolbar-fold]")].map(element => element.dataset.toolbarFold)).toEqual(["orbitals", "undeclared"]);
    const fold = toolbar.querySelector<HTMLButtonElement>(':scope > .tool-group > [data-toolbar-fold="orbitals"]')!;
    expect(document.activeElement).toBe(fold);
    expect(fold.getAttribute("aria-label")).toBe("Orbitals");
    await act(async () => fold.click());
    expect(popovers.open.mock.calls[0][0].toolbar.items).toEqual(groups[4].items);
    for (const key of ["Enter", " "]) await act(async () => fold.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    expect(popovers.open).toHaveBeenCalledTimes(3);
    await act(async () => fold.focus());
    await act(async () => resize(100));
    expect(document.activeElement).toBe(toolbar.querySelector(":scope > [data-toolbar-overflow]"));
    await act(async () => resize(1));
    expect(toolbar.querySelector(':scope > .tool-group > [data-toolbar-fold="select-text"]')).toBeNull();
    expect(toolbar.querySelector(':scope > [data-toolbar-group-id="select-text"] [data-toolbar-item-id]')).not.toBeNull();
    await act(async () => resize(900));
    expect(toolbar.querySelector(":scope > .tool-group > [data-toolbar-fold]")).toBeNull();
    await act(async () => root.unmount());
  });

  it("fits vertical two-column packing and sends vertical popover placement", async () => {
    const resize = mockBounds(false, "vertical");
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    await act(async () => root.render(createElement(ToolPalette, { toolsetId: "user.vertical", itemGroups: [[0, 1, 2, 3].map(item)],
      mode: "floating", orientation: "vertical", onInvoke: vi.fn() })));
    const toolbar = host.querySelector<HTMLElement>(".tool-palette")!;
    expect(toolbar.querySelector(":scope > [data-toolbar-overflow]")).toBeNull();
    await act(async () => resize(100));
    expect(toolbar.querySelectorAll(":scope > .tool-group > [data-toolbar-item-id]")).toHaveLength(2);
    await act(async () => toolbar.querySelector<HTMLButtonElement>(":scope > [data-toolbar-overflow]")!.click());
    expect(popovers.open.mock.calls[0][0].orientation).toBe("vertical");
    await act(async () => root.unmount());
  });

  it("fits legacy section controls as atomic items and includes them in overflow", async () => {
    const resize = mockBounds();
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    const control: ToolbarPaletteItemModel = { ...item(2), kind: "control", layout: { colSpan: 1, rowSpan: 1 },
      primary: { type: "control", controlId: "widget.core.textStyleControls" } };
    await act(async () => root.render(createElement(ToolPalette, { toolsetId: "user.controls", itemGroups: [[item(0), item(1), control, item(3)]],
      mode: "floating", orientation: "horizontal", onInvoke: vi.fn() })));
    const toolbar = host.querySelector<HTMLElement>(".tool-palette")!;
    expect(toolbar.querySelector(':scope > .tool-group [data-toolbar-style-controls="text"]')).not.toBeNull();
    await act(async () => resize(100));
    expect(toolbar.querySelector(':scope > .tool-group [data-toolbar-style-controls="text"]')).toBeNull();
    await act(async () => toolbar.querySelector<HTMLButtonElement>(":scope > [data-toolbar-overflow]")!.click());
    expect(popovers.open.mock.calls[0][0].toolbar.items[0]).toEqual(control);
    await act(async () => root.unmount());
  });
});

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

  it.each(["cyclopropane", "cyclobutane", "cyclopentane", "cyclohexane", "cycloheptane", "cyclooctane"])("opens the ring dropdown and invokes %s exactly once", async name => {
    vi.useFakeTimers();
    const ring = getToolsetItemGroups("core.main").flat().find(item => item.id === "tool.benzene")!;
    const { button, host, root, onInvoke } = await renderSchemaPalette(ring);
    try {
      await act(async () => {
        button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      const menu = host.querySelector<HTMLElement>('[data-command-flyout-menu="ring-templates"]')!;
      expect(menu.getAttribute("role")).toBe("menu");
      expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(9);
      const choice = menu.querySelector<HTMLButtonElement>(`[data-command-id="tool.${name}"]`)!;
      await act(async () => { choice.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      expect(onInvoke).toHaveBeenCalledExactlyOnceWith(`tool.${name}`);
      expect(menu.hidden).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("invokes the primary command exactly once before the flyout hold threshold", async () => {
    vi.useFakeTimers();
    const onInvoke = vi.fn();
    const { button, root } = await renderSchemaPalette(schemaBondItem, onInvoke);

    await act(async () => {
      dispatchPointerButton(button, "pointerdown");
      vi.advanceTimersByTime(TOOLBAR_FLYOUT_HOLD_MS - 1);
      dispatchPointerButton(button, "pointerup");
    });

    expect(onInvoke).toHaveBeenCalledWith("tool.bond");
    expect(onInvoke).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("opens submenu on long-press without invoking the primary command", async () => {
    vi.useFakeTimers();
    const onInvoke = vi.fn();
    const { button, host, root } = await renderSchemaPalette(schemaBondItem, onInvoke);

    await act(async () => {
      dispatchPointerButton(button, "pointerdown");
      vi.advanceTimersByTime(TOOLBAR_FLYOUT_HOLD_MS);
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
