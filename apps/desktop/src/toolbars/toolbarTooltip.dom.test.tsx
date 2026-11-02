// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolPalette } from "../ToolPalette";
import type { CommandSpec } from "../commands";
import type { ToolbarPaletteItemModel } from "../toolsets";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

  it("shows every tooltip when sweeping across four buttons after the 500 ms delay", () => {
    let previous: HTMLButtonElement | null = null;
    for (const button of buttons) {
      moveTo(button, previous);
      advance(499);
      expectTooltip();
      advance(2);
      expectTooltip(button);
      previous = button;
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

  it.each(["leave", "press"])("hides a visible tooltip on pointer %s", (action) => {
    moveTo(buttons[0]!);
    advance(501);
    expectTooltip(buttons[0]!);
    if (action === "leave") {
      moveTo(null, buttons[0]!);
    } else {
      act(() => pointer(buttons[0]!, "pointerdown"));
    }
    expectTooltip();
    advance(501);
    expectTooltip();
  });
});
