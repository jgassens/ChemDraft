// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPatches } from "@chemdraft/chem-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhase4Document, insertNativeArtGraphicObject } from "./documentWorkflow";
import { createArtInspectorModel, selectedGraphicObjectsForArtInspector } from "./artInspectorModel";
import { ToolPalette } from "./ToolPalette";
import { objectEffectOpacityCommandId, objectEffectSizeCommandId, objectGradientStopOffsetCommandId } from "./commands";

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

function gradientArtInspectorModel() {
  const document = insertNativeArtGraphicObject(
    createPhase4Document("Palette gradient stops"),
    { x: 220, y: 180 },
    "tool.art.rect"
  );
  const objectId = document.selection.objectIds[0];
  if (!objectId) {
    throw new Error("Expected selected art object.");
  }
  const gradientDocument = applyPatches(document, [{
    op: "updateObject",
    objectId,
    changes: {
      style: {
        fillPaint: {
          kind: "linear-gradient",
          units: "object",
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 1,
          stops: [
            { offset: 0, color: "#1d7f68" },
            { offset: 1, color: "#ffffff" }
          ]
        },
        fillColor: "#1d7f68",
        fillMode: "solid"
      }
    }
  }]);
  return createArtInspectorModel({
    document: gradientDocument,
    selectedGraphicObjects: selectedGraphicObjectsForArtInspector(gradientDocument),
    requestedPaintTarget: "fill"
  });
}

function effectArtInspectorModel() {
  const document = insertNativeArtGraphicObject(
    createPhase4Document("Palette effect controls"),
    { x: 220, y: 180 },
    "tool.art.rect"
  );
  const objectId = document.selection.objectIds[0];
  if (!objectId) {
    throw new Error("Expected selected art object.");
  }
  const effectDocument = applyPatches(document, [{
    op: "updateObject",
    objectId,
    changes: {
      style: {
        effects: [{ kind: "glow", color: "#1d7f68", opacity: 0.42, blurPx: 7, spreadPx: 1.2 }]
      }
    }
  }]);
  return createArtInspectorModel({
    document: effectDocument,
    selectedGraphicObjects: selectedGraphicObjectsForArtInspector(effectDocument),
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
    currentArtStyle = artInspectorModelFor(commandId),
    onCancel = vi.fn()
  }: {
    commandId?: string;
    currentArtStyle?: ReturnType<typeof createArtInspectorModel>;
    onCancel?: () => void;
  } = {}) {
    const onInvoke = vi.fn();
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    act(() => {
      root.render(createElement(ToolPalette, {
        groups: [],
        activeTool: "tool.select",
        orientation: "horizontal",
        showArtStyleControls: true,
        currentObjectColor: "#111111",
        currentArtStyleTarget: "fill",
        currentArtStyle,
        onArtStylePreview: onPreview,
        onArtStyleCommit: onCommit,
        onArtStyleCancel: onCancel,
        onInvoke
      }));
    });
    return { onCommit, onInvoke, onPreview };
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

  function changeRangeValue(input: HTMLInputElement, value: string) {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    valueSetter?.call(input, value);
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
    expect([...fillSelect.options].map((option) => option.value)).toContain("object.paint.type.gloss");

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

    act(() => {
      root.render(createElement(ToolPalette, {
        groups: [],
        activeTool: "tool.select",
        orientation: "horizontal",
        showArtStyleControls: true,
        currentObjectColor: "#111111",
        currentArtStyleTarget: "fill",
        currentArtStyle: artInspectorModelFor("tool.art.rect"),
        onInvoke
      }));
    });

    const restoredFillSelect = container.querySelector<HTMLSelectElement>('[data-art-paint-type-select="fill"]');
    if (!restoredFillSelect) {
      throw new Error("Expected restored fill paint type selector.");
    }
    expect([...restoredFillSelect.options].map((option) => option.value)).toContain("object.paint.type.gloss");
  });

  it("invokes native effect commands from buttons and visible effect controls", () => {
    const { onInvoke } = renderPalette();
    const glowButton = container.querySelector<HTMLButtonElement>('[data-art-effect-button="glow"]');
    if (!glowButton) {
      throw new Error("Expected glow effect button.");
    }

    act(() => {
      glowButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith("object.effect.glow");

    const clearButton = container.querySelector<HTMLButtonElement>('[data-art-effect-button="none"]');
    if (!clearButton) {
      throw new Error("Expected clear effects button.");
    }
    act(() => {
      clearButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith("object.effect.none");

    const { onPreview, onCommit } = renderPalette({ currentArtStyle: effectArtInspectorModel() });
    expect(container.querySelector('[data-art-effect-controls="glow"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-art-effect-button="glow"]')?.className).toContain("active");
    const effectColorTrigger = container.querySelector<HTMLButtonElement>('[data-art-effect-color-trigger="glow"]');
    if (!effectColorTrigger) {
      throw new Error("Expected effect color trigger.");
    }
    expect(effectColorTrigger.textContent).toContain("Effect");
    act(() => {
      effectColorTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[aria-label="Effect color mixer"]')).not.toBeNull();

    const effectOpacity = container.querySelector<HTMLInputElement>('[data-art-inspector-slider="glow-effect-opacity"] input');
    const effectSize = container.querySelector<HTMLInputElement>('[data-art-inspector-slider="glow-effect-size"] input');
    if (!effectOpacity || !effectSize) {
      throw new Error("Expected effect opacity and size sliders.");
    }
    act(() => {
      changeRangeValue(effectOpacity, "72");
    });
    expect(onPreview).toHaveBeenCalledWith(objectEffectOpacityCommandId("glow", 0.72));

    act(() => {
      effectSize.focus();
      changeRangeValue(effectSize, "50");
      effectSize.blur();
    });
    expect(onPreview).toHaveBeenCalledWith(objectEffectSizeCommandId("glow", 0.5));
    expect(onCommit).toHaveBeenCalledWith(objectEffectSizeCommandId("glow", 0.5));
  });

  it("drags gradient stop markers directly across the gradient rail", () => {
    const { onCommit, onPreview } = renderPalette({ currentArtStyle: gradientArtInspectorModel() });
    const rail = container.querySelector<HTMLDivElement>('[data-art-gradient-rail="fill"]');
    const marker = container.querySelector<HTMLButtonElement>('[data-art-gradient-stop="0"]');
    if (!rail || !marker) {
      throw new Error("Expected gradient rail and stop marker.");
    }

    Object.defineProperty(rail, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 10,
        y: 4,
        left: 10,
        top: 4,
        right: 110,
        bottom: 22,
        width: 100,
        height: 18,
        toJSON: () => undefined
      })
    });

    act(() => {
      marker.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, buttons: 1 }));
      marker.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 47, buttons: 1 }));
    });
    expect(onPreview).toHaveBeenLastCalledWith(objectGradientStopOffsetCommandId(0, 0.37));

    act(() => {
      marker.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 47, buttons: 0 }));
    });
    expect(onCommit).toHaveBeenCalledWith(objectGradientStopOffsetCommandId(0, 0.37));
  });
});
