// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhase4Document, insertNativeArtGraphicObject } from "./documentWorkflow";
import { createArtInspectorModel, selectedGraphicObjectsForArtInspector } from "./artInspectorModel";
import { ToolPalette } from "./ToolPalette";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function artInspectorModelFor(commandId: string) {
  const document = insertNativeArtGraphicObject(
    createPhase4Document(`Palette ${commandId}`),
    { x: 220, y: 180 },
    commandId
  );
  return createArtInspectorModel({
    document,
    selectedGraphicObjects: selectedGraphicObjectsForArtInspector(document),
    requestedPaintTarget: "fill"
  });
}

describe("ToolPalette art color popover", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderPalette({
    commandId = "tool.art.rect",
    onCancel = vi.fn()
  }: {
    commandId?: string;
    onCancel?: () => void;
  } = {}) {
    const onInvoke = vi.fn();
    act(() => {
      root.render(createElement(ToolPalette, {
        groups: [],
        activeTool: "tool.select",
        orientation: "horizontal",
        showArtStyleControls: true,
        currentObjectColor: "#111111",
        currentArtStyleTarget: "fill",
        currentArtStyle: artInspectorModelFor(commandId),
        onArtStyleCancel: onCancel,
        onInvoke
      }));
    });
    return { onInvoke };
  }

  function colorTrigger(): HTMLButtonElement {
    const trigger = container.querySelector<HTMLButtonElement>(".toolbar-color-trigger");
    if (!trigger) {
      throw new Error("Expected art color trigger.");
    }
    return trigger;
  }

  function openPicker() {
    act(() => {
      colorTrigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const popover = container.querySelector<HTMLElement>(".art-color-popover");
    if (!popover) {
      throw new Error("Expected art color popover.");
    }
    return popover;
  }

  it("opens reliably and closes on outside pointer, Escape, blur, and selection changes", () => {
    const onCancel = vi.fn();
    renderPalette({ onCancel });

    const popover = openPicker();
    act(() => {
      popover.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      popover.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      popover.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector(".art-color-popover")).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector(".art-color-popover")).toBeNull();

    openPicker();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".art-color-popover")).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);

    openPicker();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(container.querySelector(".art-color-popover")).toBeNull();

    openPicker();
    renderPalette({ commandId: "tool.art.circle", onCancel });
    expect(container.querySelector(".art-color-popover")).toBeNull();

    openPicker();
    act(() => {
      colorTrigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector(".art-color-popover")).toBeNull();
  });

  it("invokes native paint type commands from the art style selector", () => {
    const { onInvoke } = renderPalette();
    const fillSelect = container.querySelector<HTMLSelectElement>('[data-art-paint-type-select="fill"]');
    if (!fillSelect) {
      throw new Error("Expected fill paint type selector.");
    }

    expect([...fillSelect.options].map((option) => option.value)).toContain("object.paint.type.linearGradient");

    act(() => {
      fillSelect.value = "object.paint.type.linearGradient";
      fillSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith("object.paint.type.linearGradient");

    act(() => {
      root.render(createElement(ToolPalette, {
        groups: [],
        activeTool: "tool.select",
        orientation: "horizontal",
        showArtStyleControls: true,
        currentObjectColor: "#111111",
        currentArtStyleTarget: "stroke",
        currentArtStyle: artInspectorModelFor("tool.art.line"),
        onInvoke
      }));
    });

    const strokeSelect = container.querySelector<HTMLSelectElement>('[data-art-paint-type-select="stroke"]');
    if (!strokeSelect) {
      throw new Error("Expected stroke paint type selector.");
    }

    expect([...strokeSelect.options].map((option) => option.value)).toContain("object.paint.type.radialGradient");
    expect([...strokeSelect.options].map((option) => option.value)).not.toContain("object.paint.type.gloss");
  });
});
