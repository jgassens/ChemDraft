// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec } from "./commands";
import { ToolPalette } from "./ToolPalette";

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
