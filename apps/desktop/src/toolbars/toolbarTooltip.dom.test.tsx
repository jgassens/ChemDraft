// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolPalette } from "../ToolPalette";
import type { CommandSpec } from "../commands";
import type { ToolbarPaletteItemModel } from "../toolsets";
import { PaletteControlTooltip, PaletteControlTooltipContext, TOOLTIP_DELAY_MS, TOOLTIP_RESHOW_WINDOW_MS, usePaletteTooltipState } from "./toolbarTooltip";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("palette tooltip handoff", () => {
  let container: HTMLDivElement;
  let root: Root;
  let state: ReturnType<typeof usePaletteTooltipState>;
  function Harness() {
    state = usePaletteTooltipState();
    return <PaletteControlTooltipContext.Provider value={state}>
      <PaletteControlTooltip tooltip="Button A"><button id="a">A</button></PaletteControlTooltip>
      <PaletteControlTooltip tooltip="Button B"><button id="b">B</button></PaletteControlTooltip>
      <PaletteControlTooltip tooltip="Button C"><button id="c">C</button></PaletteControlTooltip>
    </PaletteControlTooltipContext.Provider>;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(Harness)));
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove(); vi.useRealTimers();
  });
  const button = (id: string) => container.querySelector<HTMLButtonElement>(`#${id}`)!;
  const visible = (id: string) => button(id).dataset.tooltipVisible === "true";
  function pointer(id: string, type: "pointerover" | "pointerout", relatedTarget: Element = document.body) {
    button(id).dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget }));
  }
  function showA() {
    act(() => pointer("a", "pointerover"));
    expect(visible("a")).toBe(false);
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
    expect(visible("a")).toBe(true);
  }

  it("switches A to B to C promptly when leave and enter share a tick", () => {
    showA();
    act(() => {
      pointer("a", "pointerout", button("b"));
      pointer("b", "pointerover", button("a"));
      // A stale document listener can still run before React commits B.
      state.clearTooltip(button("a").dataset.tooltipOwnerId, { onlyMatchingPending: true });
      button("b").dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    });
    expect(visible("a")).toBe(false);
    expect(visible("b")).toBe(true);
    act(() => {
      pointer("b", "pointerout", button("c"));
      pointer("c", "pointerover", button("b"));
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(visible("b")).toBe(false);
    expect(visible("c")).toBe(true);
  });

  it("hides on leaving A for empty space and restores the first-hover delay", () => {
    showA();
    act(() => pointer("a", "pointerout"));
    expect(visible("a")).toBe(false);
    act(() => vi.advanceTimersByTime(TOOLTIP_RESHOW_WINDOW_MS + 1));
    act(() => pointer("b", "pointerover"));
    expect(visible("b")).toBe(false);
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
    expect(visible("b")).toBe(true);
  });

  it("switches promptly across the small gap between neighbouring controls", () => {
    showA();
    act(() => pointer("a", "pointerout"));
    expect(visible("a")).toBe(false);
    act(() => vi.advanceTimersByTime(50));
    act(() => pointer("b", "pointerover"));
    expect(visible("b")).toBe(true);
  });

  it("does not let a late leave from A cancel B's first-hover timer", () => {
    act(() => {
      pointer("a", "pointerover");
      pointer("a", "pointerout", button("b"));
      pointer("b", "pointerover", button("a"));
      state.clearTooltip(button("a").dataset.tooltipOwnerId, { onlyMatchingPending: true });
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(visible("a")).toBe(false);
    expect(visible("b")).toBe(true);
  });

  it("ends the warm interval on explicit dismissal while between controls", () => {
    showA();
    act(() => pointer("a", "pointerout"));
    act(() => state.clearTooltip(button("a").dataset.tooltipOwnerId));
    act(() => pointer("b", "pointerover"));
    expect(visible("b")).toBe(false);
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
    expect(visible("b")).toBe(true);
  });

  it("cancels pending and visible tooltips on blur", () => {
    showA();
    act(() => window.dispatchEvent(new Event("blur")));
    expect(visible("a")).toBe(false);
    act(() => pointer("b", "pointerover"));
    act(() => window.dispatchEvent(new Event("blur")));
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
    expect(visible("b")).toBe(false);
  });
});

describe("toolbar tooltip pointer transitions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let buttons: HTMLButtonElement[];
  let onInvoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onInvoke = vi.fn();
    const commands: CommandSpec[] = ["A", "B", "C", "D"].map((title) => ({
      id: `tool.${title.toLowerCase()}`,
      title,
      icon: "palette",
      source: "core",
      category: "tool"
    }));
    act(() => {
      root.render(createElement(ToolPalette, {
        itemGroups: [commands.map<ToolbarPaletteItemModel>((command, index) => ({
          id: command.id,
          kind: "button",
          label: command.title,
          primary: { type: "command", command },
          submenu: index === 0 ? {
            id: "menu.a",
            type: "command-grid",
            items: [commands[2]!]
          } : null,
          tooltip: { title: command.title, description: null, shortcut: null },
          layout: { colSpan: 1, rowSpan: 1 }
        }))],
        orientation: "horizontal",
        onInvoke
      }));
    });
    buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button.icon-button[data-command-id]"));
    expect(buttons).toHaveLength(4);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function pointer(target: EventTarget, type: string, relatedTarget: EventTarget | null = null) {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: type !== "pointerenter" && type !== "pointerleave",
      pointerId: 1,
      pointerType: "mouse",
      relatedTarget
    }));
  }

  function moveTo(next: HTMLButtonElement | null, previous: HTMLButtonElement | null = null) {
    // A browser emits boundary events before pointermove. Keep this input in one batch:
    // React synthesizes leave/enter from out/over, while the move reaches the document's
    // capture listener for the previously visible tooltip before effects are cleaned up.
    act(() => {
      if (previous) {
        pointer(previous, "pointerout", next);
        pointer(previous, "pointerleave", next);
      }
      if (next) {
        pointer(next, "pointerover", previous);
        pointer(next, "pointerenter", previous);
      }
      pointer(next ?? document, "pointermove");
    });
  }

  function advance(ms: number) {
    act(() => vi.advanceTimersByTime(ms));
  }

  function expectTooltip(button?: HTMLButtonElement) {
    const visible = Array.from(container.querySelectorAll('[data-tooltip-visible="true"]'));
    expect(visible).toEqual(button ? [button.closest("[data-tooltip-owner-id]")] : []);
    if (button) {
      expect(visible[0]?.querySelector('[role="tooltip"] > .visually-hidden')?.textContent).toBe(button.dataset.tooltip);
    }
  }

  it("shows every tooltip when sweeping across four buttons after the initial delay", () => {
    moveTo(buttons[0]!);
    advance(TOOLTIP_DELAY_MS - 1);
    expectTooltip();
    advance(1);
    expectTooltip(buttons[0]!);
    for (let index = 1; index < buttons.length; index += 1) {
      moveTo(buttons[index]!, buttons[index - 1]!);
      expectTooltip(buttons[index]!);
    }
  });

  it("restores the full delay for each button after the warm interval expires", () => {
    for (const button of buttons) {
      moveTo(button);
      advance(TOOLTIP_DELAY_MS - 1);
      expectTooltip();
      advance(1);
      expectTooltip(button);
      moveTo(null, button);
      advance(TOOLTIP_RESHOW_WINDOW_MS + 1);
    }
  });

  it("shows no tooltip after leaving before the delay", () => {
    moveTo(buttons[0]!);
    advance(250);
    moveTo(null, buttons[0]!);
    advance(501);
    expectTooltip();
  });

  it.each(["Enter", " "])("cancels pending B when focused A is activated with %s", (key) => {
    act(() => buttons[0]!.focus());
    moveTo(buttons[1]!);
    advance(250);
    act(() => buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    expect(onInvoke).toHaveBeenCalledExactlyOnceWith("tool.a");
    advance(501);
    expectTooltip();
  });

  it("cancels pending B when ArrowDown opens focused A's flyout", () => {
    act(() => buttons[0]!.focus());
    moveTo(buttons[1]!);
    advance(250);
    act(() => buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(buttons[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(onInvoke).not.toHaveBeenCalled();
    advance(501);
    expectTooltip();
  });

  it.each(["press", "scroll", "blur"])("cancels pending B on %s", (action) => {
    moveTo(buttons[1]!);
    advance(250);
    act(() => {
      if (action === "press") {
        pointer(buttons[0]!, "pointerdown");
      } else if (action === "scroll") {
        container.dispatchEvent(new Event("scroll"));
      } else {
        window.dispatchEvent(new Event("blur"));
      }
    });
    advance(501);
    expectTooltip();
  });

  it("shows only B after moving quickly from A to B, with B's full delay", () => {
    moveTo(buttons[0]!);
    advance(250);
    moveTo(buttons[1]!, buttons[0]!);
    advance(250);
    expectTooltip();
    advance(249);
    expectTooltip();
    advance(2);
    expectTooltip(buttons[1]!);
  });

  it.each(["leave", "press", "scroll", "blur"])("hides a visible tooltip on %s", (action) => {
    moveTo(buttons[0]!);
    advance(501);
    expectTooltip(buttons[0]!);
    if (action === "leave") {
      moveTo(null, buttons[0]!);
    } else if (action === "press") {
      act(() => pointer(buttons[0]!, "pointerdown"));
    } else if (action === "scroll") {
      act(() => container.dispatchEvent(new Event("scroll")));
    } else {
      act(() => window.dispatchEvent(new Event("blur")));
    }
    expectTooltip();
    advance(501);
    expectTooltip();
    moveTo(buttons[1]!);
    advance(TOOLTIP_DELAY_MS - 1);
    expectTooltip();
    advance(1);
    expectTooltip(buttons[1]!);
  });
});
