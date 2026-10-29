// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ColorPickerPopoverBody } from "./ToolPalette";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("palette color picker", () => {
  it("calls onPreviewColor before onCommitColor for a typed hex", async () => {
    const onPreviewColor = vi.fn();
    const onCommitColor = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(ColorPickerPopoverBody, {
        value: "#111111",
        onPreviewColor,
        onCommitColor
      })));
      const input = container.querySelector<HTMLInputElement>(".color-hex-field input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "#1E88E5");
        input.dispatchEvent(new InputEvent("input", { inputType: "insertText", bubbles: true }));
      });

      expect(onPreviewColor).toHaveBeenCalledExactlyOnceWith("#1e88e5");
      expect(onCommitColor).toHaveBeenCalledExactlyOnceWith("#1e88e5");
      expect(onPreviewColor.mock.invocationCallOrder[0]).toBeLessThan(onCommitColor.mock.invocationCallOrder[0]!);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
