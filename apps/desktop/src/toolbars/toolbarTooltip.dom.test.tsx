// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolPalette } from "../ToolPalette";
import type { CommandSpec } from "../commands";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("toolbar tooltip pointer transitions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let buttons: HTMLButtonElement[];

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const commands: CommandSpec[] = ["A", "B", "C", "D"].map((title) => ({
      id: `tool.${title.toLowerCase()}`,
      title,
      icon: "palette",
      source: "core",
      category: "tool"
    }));
    act(() => {
      root.render(createElement(ToolPalette, {
        groups: [commands],
        orientation: "horizontal",
        onInvoke: vi.fn()
      }));
    });
    buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button[data-command-id]"));
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
      expect(visible[0]?.querySelector('[role="tooltip"] > span')?.textContent).toBe(button.dataset.tooltip);
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
