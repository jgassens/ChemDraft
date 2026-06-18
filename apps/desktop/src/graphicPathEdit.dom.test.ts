// @vitest-environment jsdom

import { applyPatch, type ChemDraftDocument, type GraphicObject } from "@chemdraft/chem-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MainWindow, type MainWindowProps } from "./MainWindow";
import {
  createPhase4Document,
  insertNativeArtGraphicObject,
  nativeGraphicPathEditPoints,
  updateNativeGraphicPathHandle
} from "./documentWorkflow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type DebugArtResult = ReturnType<NonNullable<Window["__CHEMDRAFT_AGENT__"]>["debugArtObject"]>;

const pageRect = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 792,
  bottom: 612,
  width: 792,
  height: 612,
  toJSON: () => ({})
} as DOMRect;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("graphic path direct editing interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let originalRequestAnimationFrame: typeof requestAnimationFrame | undefined;
  let originalCancelAnimationFrame: typeof cancelAnimationFrame | undefined;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0);
    globalThis.cancelAnimationFrame = (handle: number) => window.clearTimeout(handle);
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.hasPointerCapture = () => false;
    window.history.replaceState(null, "", "/?agentBridge=1&artStyleQa=0");

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    } else {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
    if (originalCancelAnimationFrame) {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    } else {
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  });

  async function renderMainWindow(
    initialDocument: ChemDraftDocument,
    options: Pick<MainWindowProps, "initialActiveToolCommandId" | "initialPaletteMode" | "nativePalette"> = {}
  ) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialDocument,
        initialActiveToolCommandId: options.initialActiveToolCommandId,
        initialCrosshairsVisible: false,
        initialPaletteMode: options.initialPaletteMode ?? "hidden",
        initialRulersVisible: false,
        nativePalette: options.nativePalette ?? true
      }));
    });
    const page = pageElement();
    page.getBoundingClientRect = () => pageRect;
    await act(async () => {
      await Promise.resolve();
    });
  }

  function pageElement(): HTMLElement {
    const page = container.querySelector<HTMLElement>(".page");
    if (!page) {
      throw new Error("Expected rendered page.");
    }
    return page;
  }

  function objectElement(objectId: string): HTMLElement {
    const object = container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`);
    if (!object) {
      throw new Error(`Expected rendered object ${objectId}.`);
    }
    return object;
  }

  function pathHandle(handle: "start" | "middle" | "end"): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`[data-graphic-path-handle="${handle}"]`);
    if (!button) {
      throw new Error(`Expected ${handle} path handle.`);
    }
    return button;
  }

  function markerHandle(handle: "markerStart" | "markerEnd"): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`[data-graphic-marker-handle="${handle}"]`);
    if (!button) {
      throw new Error(`Expected ${handle} marker handle.`);
    }
    return button;
  }

  function gradientHandle(handle: "start" | "end" | "center" | "radius" | "focus"): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`[data-graphic-gradient-handle="${handle}"]`);
    if (!button) {
      throw new Error(`Expected ${handle} gradient handle.`);
    }
    return button;
  }

  function pathNodeHandle(index: number): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`[data-graphic-path-node-index="${index}"]`);
    if (!button) {
      throw new Error(`Expected path node ${index} handle.`);
    }
    return button;
  }

  function resizeHandle(corner: "top-left" | "top-right" | "bottom-left" | "bottom-right"): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`[data-object-resize-corner="${corner}"]`);
    if (!button) {
      throw new Error(`Expected ${corner} resize handle.`);
    }
    return button;
  }

  function debugArtObject(objectId: string): Extract<DebugArtResult, { ok: true }> {
    const bridge = window.__CHEMDRAFT_AGENT__;
    if (!bridge) {
      throw new Error("Expected agent bridge.");
    }
    const result = bridge.debugArtObject(objectId);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result;
  }

  function pathD(selector: ".graphic-glyph-hit-target" | ".graphic-glyph-path"): string {
    const path = container.querySelector<SVGElement>(selector);
    const d = path?.getAttribute("d");
    if (!d) {
      throw new Error(`Expected ${selector} path d.`);
    }
    return d;
  }

  function pathHandleLocalPosition(handle: "start" | "middle" | "end"): { left: string; top: string } {
    const button = pathHandle(handle);
    return {
      left: button.style.left,
      top: button.style.top
    };
  }

  function expectPositionUsesPageScale(element: HTMLElement) {
    expect(element.style.left).toContain("var(--page-scale)");
    expect(element.style.top).toContain("var(--page-scale)");
  }

  function expectFrameUsesPlanBounds(element: HTMLElement, plan: Extract<DebugArtResult, { ok: true }>["plan"]) {
    expect(element.style.left).toBe(`calc(${plan.frameBounds.x}px * var(--page-scale))`);
    expect(element.style.top).toBe(`calc(${plan.frameBounds.y}px * var(--page-scale))`);
    expect(element.style.width).toBe(`calc(${plan.frameBounds.width}px * var(--page-scale))`);
    expect(element.style.height).toBe(`calc(${plan.frameBounds.height}px * var(--page-scale))`);
  }

  function expectProjectedPointShift(
    actual: { x: number; y: number } | undefined,
    before: { x: number; y: number },
    dx: number,
    dy: number
  ) {
    expect(actual?.x).toBeCloseTo(before.x + dx, 3);
    expect(actual?.y).toBeCloseTo(before.y + dy, 3);
  }

  function expectProjectedPointPinned(
    actual: { x: number; y: number } | undefined,
    before: { x: number; y: number },
    tolerance = 0.75
  ) {
    expect(Math.hypot(
      (actual?.x ?? 0) - before.x,
      (actual?.y ?? 0) - before.y
    )).toBeLessThan(tolerance);
  }

  async function waitPastDoublePressWindow() {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 410));
    });
  }

  async function flushScheduledPreview() {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  function graphicById(document: ChemDraftDocument, objectId: string): GraphicObject {
    const object = document.pages.flatMap((page) => page.objects).find((candidate) => candidate.id === objectId);
    if (object?.type !== "graphic") {
      throw new Error(`Expected graphic object ${objectId}.`);
    }
    return object;
  }

  function dispatchPointer(
    target: EventTarget,
    type: "pointerdown" | "pointermove" | "pointerup",
    point: { x: number; y: number },
    pointerId: number,
    detail = 1,
    modifiers: MouseEventInit = {}
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      detail,
      ...modifiers
    });
    Object.defineProperties(event, {
      isPrimary: { value: true },
      pointerId: { value: pointerId },
      pointerType: { value: "mouse" }
    });
    target.dispatchEvent(event);
  }

  it("previews a line middle-handle drag below the object drag threshold", async () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Immediate Path Preview"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    await renderMainWindow(document);
    const before = debugArtObject(objectId);
    const middle = before.projectedEditPoints?.middle;
    if (!middle) {
      throw new Error("Expected projected middle handle.");
    }

    await act(async () => {
      dispatchPointer(pathHandle("middle"), "pointerdown", middle, 1);
      dispatchPointer(pageElement(), "pointermove", { x: middle.x, y: middle.y - 2 }, 1);
    });
    const preview = debugArtObject(objectId);

    expect(preview.object.data.artPathKind).toBe("quadratic");
    expect(preview.object.data.pathControlPoint?.x).toBeCloseTo(middle.x, 3);
    expect(preview.object.data.pathControlPoint?.y).toBeCloseTo(middle.y - 2, 3);
    expect(container.querySelector('[data-can-undo="true"]')).toBeNull();

    await act(async () => {
      dispatchPointer(pageElement(), "pointerup", { x: middle.x, y: middle.y - 2 }, 1);
    });
  });

  it("drags an arrowhead handle to resize the marker as one undoable edit", async () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Arrowhead Marker Drag"),
      { x: 220, y: 180 },
      "tool.art.arrow"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    await renderMainWindow(document);
    const before = debugArtObject(objectId);
    const marker = before.plan.markerHandles.find((handle) => handle.id === "markerEnd");
    if (!marker) {
      throw new Error("Expected end marker handle.");
    }
    const start = {
      x: before.object.x + marker.point.x,
      y: before.object.y + marker.point.y
    };
    const target = {
      x: before.object.x + marker.terminal.point.x - marker.terminal.direction.x * 28,
      y: before.object.y + marker.terminal.point.y - marker.terminal.direction.y * 28
    };

    await act(async () => {
      dispatchPointer(markerHandle("markerEnd"), "pointerdown", start, 11);
      dispatchPointer(pageElement(), "pointermove", target, 11);
      dispatchPointer(pageElement(), "pointerup", target, 11);
    });

    expect(debugArtObject(objectId).object.data.markerEnd).toEqual({
      kind: "filled-arrow",
      sizePx: 28
    });
    expect(container.querySelector('[data-can-undo="true"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "z",
        metaKey: true
      }));
    });

    expect(debugArtObject(objectId).object.data.markerEnd).toEqual({
      kind: "filled-arrow",
      sizePx: 10
    });
  });

  it("drags a linear gradient endpoint as one undoable edit", async () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Linear Gradient Handle Drag"),
      { x: 220, y: 180 },
      "tool.art.roundedRect"
    );
    const objectId = inserted.selection.objectIds[0] ?? "";
    const painted = applyPatch(inserted, {
      op: "updateObject",
      objectId,
      changes: {
        style: {
          ...graphicById(inserted, objectId).style,
          fillColor: "#1d7f68",
          fillMode: "solid",
          fillPaint: {
            kind: "linear-gradient",
            units: "object",
            x1: 0,
            y1: 0,
            x2: 1,
            y2: 0,
            stops: [
              { offset: 0, color: "#ffffff" },
              { offset: 1, color: "#1d7f68" }
            ]
          }
        }
      }
    });
    await renderMainWindow(painted);
    expect(container.querySelector('[data-graphic-gradient-control-line="fill"]')).not.toBeNull();

    const before = debugArtObject(objectId).object;
    const start = {
      x: before.x + before.width,
      y: before.y
    };
    const target = {
      x: before.x + before.width * 0.2,
      y: before.y + before.height * 0.8
    };

    await act(async () => {
      dispatchPointer(gradientHandle("end"), "pointerdown", start, 21);
      dispatchPointer(pageElement(), "pointermove", target, 21);
      dispatchPointer(pageElement(), "pointerup", target, 21);
    });

    const editedPaint = debugArtObject(objectId).object.style.fillPaint;
    expect(editedPaint).toMatchObject({
      kind: "linear-gradient",
      x1: 0,
      y1: 0
    });
    expect(editedPaint?.kind === "linear-gradient" ? editedPaint.x2 : undefined).toBeCloseTo(0.2, 6);
    expect(editedPaint?.kind === "linear-gradient" ? editedPaint.y2 : undefined).toBeCloseTo(0.8, 6);
    expect(container.querySelector('[data-can-undo="true"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "z",
        metaKey: true
      }));
    });

    expect(debugArtObject(objectId).object.style.fillPaint).toMatchObject({
      kind: "linear-gradient",
      x2: 1,
      y2: 0
    });
  });

  it("drags a radial gradient radius as one undoable edit", async () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Radial Gradient Handle Drag"),
      { x: 220, y: 180 },
      "tool.art.roundedRect"
    );
    const objectId = inserted.selection.objectIds[0] ?? "";
    const painted = applyPatch(inserted, {
      op: "updateObject",
      objectId,
      changes: {
        style: {
          ...graphicById(inserted, objectId).style,
          fillColor: "#1d7f68",
          fillMode: "solid",
          fillPaint: {
            kind: "radial-gradient",
            units: "object",
            cx: 0.5,
            cy: 0.5,
            r: 0.5,
            fx: 0.3,
            fy: 0.25,
            stops: [
              { offset: 0, color: "#ffffff" },
              { offset: 1, color: "#1d7f68" }
            ]
          }
        }
      }
    });
    await renderMainWindow(painted);
    expect(container.querySelector('[data-graphic-gradient-radius-ring="fill"]')).not.toBeNull();
    expect(gradientHandle("center")).not.toBeNull();
    expect(gradientHandle("focus")).not.toBeNull();

    const before = debugArtObject(objectId).object;
    const center = {
      x: before.x + before.width * 0.5,
      y: before.y + before.height * 0.5
    };
    const maxDimension = Math.max(before.width, before.height, 1);
    const start = {
      x: center.x + maxDimension * 0.5,
      y: center.y
    };
    const target = {
      x: center.x + maxDimension * 0.25,
      y: center.y
    };

    await act(async () => {
      dispatchPointer(gradientHandle("radius"), "pointerdown", start, 22);
      dispatchPointer(pageElement(), "pointermove", target, 22);
      dispatchPointer(pageElement(), "pointerup", target, 22);
    });

    const editedPaint = debugArtObject(objectId).object.style.fillPaint;
    expect(editedPaint).toMatchObject({
      kind: "radial-gradient",
      cx: 0.5,
      cy: 0.5
    });
    expect(editedPaint?.kind === "radial-gradient" ? editedPaint.r : undefined).toBeCloseTo(0.25, 6);
    expect(container.querySelector('[data-can-undo="true"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "z",
        metaKey: true
      }));
    });

    expect(debugArtObject(objectId).object.style.fillPaint).toMatchObject({
      kind: "radial-gradient",
      r: 0.5
    });
  });

  it("copies active fill from a clicked source graphic with the eyedropper tool", async () => {
    const withTarget = insertNativeArtGraphicObject(
      createPhase4Document("Eyedropper Fill Copy"),
      { x: 220, y: 180 },
      "tool.art.circle"
    );
    const targetId = withTarget.selection.objectIds[0] ?? "";
    const withSource = insertNativeArtGraphicObject(withTarget, { x: 340, y: 180 }, "tool.art.rect");
    const sourceId = withSource.selection.objectIds[0] ?? "";
    const styledSource = applyPatch(withSource, {
      op: "updateObject",
      objectId: sourceId,
      changes: {
        style: {
          ...graphicById(withSource, sourceId).style,
          fillColor: "#1d7f68",
          fillOpacity: 0.45,
          fillMode: "solid",
          fillPaint: {
            kind: "radial-gradient",
            units: "object",
            cx: 0.5,
            cy: 0.5,
            r: 0.5,
            fx: 0.25,
            fy: 0.25,
            stops: [
              { offset: 0, color: "#ffffff" },
              { offset: 1, color: "#1d7f68" }
            ]
          }
        }
      }
    });
    const selectedTarget = applyPatch(styledSource, {
      op: "setSelection",
      pageId: styledSource.pages[0].id,
      objectIds: [targetId]
    });
    await renderMainWindow(selectedTarget, { initialActiveToolCommandId: "tool.art.eyedropper" });

    const source = debugArtObject(sourceId).object;
    await act(async () => {
      dispatchPointer(objectElement(sourceId), "pointerdown", {
        x: source.x + source.width / 2,
        y: source.y + source.height / 2
      }, 23);
    });

    expect(debugArtObject(targetId).object.style).toMatchObject({
      fillColor: "#1d7f68",
      fillOpacity: 0.45,
      fillPaint: {
        kind: "radial-gradient",
        stops: [
          { offset: 0, color: "#ffffff" },
          { offset: 1, color: "#1d7f68" }
        ]
      }
    });
    expect(debugArtObject(sourceId).object.style.fillColor).toBe("#1d7f68");
    expect(container.querySelector('[data-can-undo="true"]')).not.toBeNull();
  });

  it("copies active stroke and marker style from a clicked source line to a selected arc", async () => {
    const withTarget = insertNativeArtGraphicObject(
      createPhase4Document("Eyedropper Stroke Copy"),
      { x: 220, y: 180 },
      "tool.art.arc270"
    );
    const targetId = withTarget.selection.objectIds[0] ?? "";
    const withSource = insertNativeArtGraphicObject(withTarget, { x: 360, y: 180 }, "tool.art.line");
    const sourceId = withSource.selection.objectIds[0] ?? "";
    const styledSource = applyPatch(withSource, {
      op: "updateObject",
      objectId: sourceId,
      changes: {
        style: {
          ...graphicById(withSource, sourceId).style,
          strokeColor: "#6046a8",
          strokeOpacity: 0.62,
          strokeWidth: 7,
          strokeDasharray: "8 6",
          strokeLineCap: "square"
        },
        data: {
          ...graphicById(withSource, sourceId).data,
          markerEnd: { kind: "filled-arrow", sizePx: 18 }
        }
      }
    });
    const selectedTarget = applyPatch(styledSource, {
      op: "setSelection",
      pageId: styledSource.pages[0].id,
      objectIds: [targetId]
    });
    await renderMainWindow(selectedTarget, { initialActiveToolCommandId: "tool.art.eyedropper" });

    const source = debugArtObject(sourceId).object;
    await act(async () => {
      dispatchPointer(objectElement(sourceId), "pointerdown", {
        x: source.x + source.width / 2,
        y: source.y + source.height / 2
      }, 24);
    });

    expect(debugArtObject(targetId).object.style).toMatchObject({
      strokeColor: "#6046a8",
      strokeOpacity: 0.62,
      strokeWidth: 7,
      strokeDasharray: "8 6",
      strokeLineCap: "square"
    });
    expect(debugArtObject(targetId).object.data.markerEnd).toEqual({ kind: "filled-arrow", sizePx: 18 });
    expect(container.querySelector('[data-can-undo="true"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "z",
        metaKey: true
      }));
    });

    expect(debugArtObject(targetId).object.style.strokeColor).not.toBe("#6046a8");
    expect(debugArtObject(targetId).object.data.markerEnd).toBeUndefined();
  });

  it("copies full art appearance with Option-eyedropper and undoes the copy", async () => {
    const withTarget = insertNativeArtGraphicObject(
      createPhase4Document("Eyedropper Full Appearance Copy"),
      { x: 220, y: 180 },
      "tool.art.circle"
    );
    const targetId = withTarget.selection.objectIds[0] ?? "";
    const withSource = insertNativeArtGraphicObject(withTarget, { x: 360, y: 180 }, "tool.art.rect");
    const sourceId = withSource.selection.objectIds[0] ?? "";
    const styledSource = applyPatch(withSource, {
      op: "updateObject",
      objectId: sourceId,
      changes: {
        style: {
          ...graphicById(withSource, sourceId).style,
          fillColor: "#1d7f68",
          fillOpacity: 0.5,
          fillMode: "solid",
          fillPaint: { kind: "solid", color: "#1d7f68", opacity: 0.5 },
          strokeColor: "#b3261e",
          strokeOpacity: 0.7,
          strokeWidth: 5,
          strokeDasharray: "3 4",
          opacity: 0.8,
          effect: "shadow"
        }
      }
    });
    const selectedTarget = applyPatch(styledSource, {
      op: "setSelection",
      pageId: styledSource.pages[0].id,
      objectIds: [targetId]
    });
    const initialTargetStyle = graphicById(selectedTarget, targetId).style;
    await renderMainWindow(selectedTarget, { initialActiveToolCommandId: "tool.art.eyedropper" });

    const source = debugArtObject(sourceId).object;
    await act(async () => {
      dispatchPointer(objectElement(sourceId), "pointerdown", {
        x: source.x + source.width / 2,
        y: source.y + source.height / 2
      }, 25, 1, { altKey: true });
    });

    expect(debugArtObject(targetId).object.style).toMatchObject({
      fillColor: "#1d7f68",
      fillOpacity: 0.5,
      strokeColor: "#b3261e",
      strokeOpacity: 0.7,
      strokeWidth: 5,
      strokeDasharray: "3 4",
      opacity: 0.8,
      effect: "shadow"
    });
    expect(container.querySelector('[data-can-undo="true"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "z",
        metaKey: true
      }));
    });

    expect(debugArtObject(targetId).object.style).toMatchObject({
      fillColor: initialTargetStyle.fillColor,
      strokeColor: initialTargetStyle.strokeColor,
      strokeWidth: initialTargetStyle.strokeWidth
    });
    expect(debugArtObject(targetId).object.style.effect).toBeUndefined();
  });

  it("exits the eyedropper tool with Escape", async () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Eyedropper Escape"),
      { x: 220, y: 180 },
      "tool.art.rect"
    );
    await renderMainWindow(document, { initialActiveToolCommandId: "tool.art.eyedropper" });

    expect(container.querySelector('[data-active-tool="tool.art.eyedropper"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true
      }));
    });

    expect(container.querySelector('[data-active-tool="tool.select"]')).not.toBeNull();
  });

  it("positions native art path handles through the active page scale", async () => {
    const arrowDocument = insertNativeArtGraphicObject(
      createPhase4Document("Scaled Arrowhead Handles"),
      { x: 220, y: 180 },
      "tool.art.arrow"
    );
    await renderMainWindow(arrowDocument);

    expectPositionUsesPageScale(pathHandle("start"));
    expectPositionUsesPageScale(pathHandle("middle"));
    expectPositionUsesPageScale(pathHandle("end"));
    expectPositionUsesPageScale(markerHandle("markerEnd"));
  });

  it("positions native art corner-radius handles through the active page scale", async () => {
    const roundedRectDocument = insertNativeArtGraphicObject(
      createPhase4Document("Scaled Corner Radius Handle"),
      { x: 220, y: 180 },
      "tool.art.roundedRectShadow"
    );
    await renderMainWindow(roundedRectDocument);
    const cornerHandle = container.querySelector<HTMLElement>("[data-graphic-corner-radius-handle=\"true\"]");
    const cornerReadout = container.querySelector<HTMLElement>("[data-graphic-corner-radius-readout=\"true\"]");
    if (!cornerHandle || !cornerReadout) {
      throw new Error("Expected scaled corner radius handle and readout.");
    }

    expectPositionUsesPageScale(cornerHandle);
    expectPositionUsesPageScale(cornerReadout);
  });

  it("clears rounded rectangle transform chrome after an empty-canvas click", async () => {
    const roundedRectDocument = insertNativeArtGraphicObject(
      createPhase4Document("Rounded Rect Deselect Chrome"),
      { x: 420, y: 280 },
      "tool.art.roundedRect"
    );
    await renderMainWindow(roundedRectDocument);

    expect(container.querySelector('[data-art-transform-frame="true"]')).not.toBeNull();
    expect(container.querySelector('[data-selection-rotate-handle="true"]')).not.toBeNull();
    expect(container.querySelector('[data-selection-tilt3d-handle="true"]')).not.toBeNull();
    expect(container.querySelector("[data-graphic-corner-radius-handle=\"true\"]")).not.toBeNull();

    await act(async () => {
      dispatchPointer(pageElement(), "pointerdown", { x: 20, y: 20 }, 28);
      dispatchPointer(pageElement(), "pointerup", { x: 20, y: 20 }, 28);
    });

    expect(container.querySelector('[data-art-transform-frame="true"]')).toBeNull();
    expect(container.querySelector('[data-selection-rotate-handle="true"]')).toBeNull();
    expect(container.querySelector('[data-selection-tilt3d-handle="true"]')).toBeNull();
    expect(container.querySelector("[data-graphic-corner-radius-handle=\"true\"]")).toBeNull();
  });

  it("switches rounded rectangle direct-edit chrome to transform chrome on double-click", async () => {
    const roundedRectDocument = insertNativeArtGraphicObject(
      createPhase4Document("Rounded Rect Transform Mode"),
      { x: 420, y: 280 },
      "tool.art.roundedRect"
    );
    const objectId = roundedRectDocument.selection.objectIds[0] ?? "";
    await renderMainWindow(roundedRectDocument);

    expect(container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`)?.dataset.graphicInteractionMode)
      .toBe("corner-radius-edit");

    const object = graphicById(roundedRectDocument, objectId);
    const target = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
    const graphicElement = container.querySelector<HTMLElement>(`[data-object-id="${objectId}"].graphic-object`);
    if (!graphicElement) {
      throw new Error("Expected selected rounded rectangle element.");
    }

    await act(async () => {
      dispatchPointer(graphicElement, "pointerdown", target, 31, 2);
      dispatchPointer(graphicElement, "pointerup", target, 31, 2);
    });

    expect(container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`)?.dataset.graphicInteractionMode)
      .toBe("object-transform");
    expect(container.querySelector('[data-art-transform-frame="true"]')).not.toBeNull();
    expect(container.querySelector('[data-selection-rotate-handle="true"]')).not.toBeNull();
    expect(container.querySelector("[data-graphic-corner-radius-handle=\"true\"]")).toBeNull();
  });

  it("resizes selected graphic shapes with live geometry instead of scaling selection chrome", async () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Graphic Shape Resize Chrome"),
      { x: 260, y: 210 },
      "tool.art.rect"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    await renderMainWindow(document);
    const before = debugArtObject(objectId);
    const beforeFrame = container.querySelector<HTMLElement>('[data-art-transform-frame="true"]');
    if (!beforeFrame) {
      throw new Error("Expected art transform frame before resize.");
    }
    expectFrameUsesPlanBounds(beforeFrame, before.plan);

    const dragStart = {
      x: before.object.x + before.object.width,
      y: before.object.y + before.object.height
    };
    const dragEnd = { x: dragStart.x + 38, y: dragStart.y + 32 };

    await act(async () => {
      dispatchPointer(resizeHandle("bottom-right"), "pointerdown", dragStart, 33);
      dispatchPointer(pageElement(), "pointermove", dragEnd, 33);
    });
    await flushScheduledPreview();

    const duringObjectElement = container.querySelector<HTMLElement>(`[data-object-id="${objectId}"].graphic-object`);
    expect(duringObjectElement?.dataset.artTransformPreview).toBeUndefined();
    const during = debugArtObject(objectId);
    expect(during.object.width).toBeGreaterThan(before.object.width);
    expect(during.object.height).toBeGreaterThan(before.object.height);
    const duringFrame = container.querySelector<HTMLElement>('[data-art-transform-frame="true"]');
    if (!duringFrame) {
      throw new Error("Expected art transform frame during resize.");
    }
    expectFrameUsesPlanBounds(duringFrame, during.plan);

    await act(async () => {
      dispatchPointer(pageElement(), "pointerup", dragEnd, 33);
    });
    expect(container.querySelector('[data-can-undo="true"]')).not.toBeNull();
  });

  it("drags a selected polyline node as one undoable path edit", async () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Polyline Node Drag"),
      { x: 220, y: 180 },
      "tool.art.polyline"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    await renderMainWindow(document);
    const before = debugArtObject(objectId).object;
    const middleNode = before.data.pathNodes?.[1]?.point;
    if (!middleNode) {
      throw new Error("Expected inserted polyline middle node.");
    }
    const target = { x: middleNode.x + 26, y: middleNode.y - 18 };

    expect(container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`)?.dataset.graphicInteractionMode).toBe("path-edit");
    expect(container.querySelectorAll("[data-graphic-path-node-index]")).toHaveLength(3);
    expect(container.querySelector("[data-art-transform-frame=\"true\"]")).toBeNull();

    await act(async () => {
      dispatchPointer(pathNodeHandle(1), "pointerdown", middleNode, 29);
      dispatchPointer(pageElement(), "pointermove", target, 29);
      dispatchPointer(pageElement(), "pointerup", target, 29);
    });
    const after = debugArtObject(objectId).object;

    expect(after.data.artPathKind).toBe("polyline");
    expect(after.data.pathNodes?.[0]?.point).toEqual(before.data.pathNodes?.[0]?.point);
    expect(after.data.pathNodes?.[1]?.point.x).toBeCloseTo(target.x, 3);
    expect(after.data.pathNodes?.[1]?.point.y).toBeCloseTo(target.y, 3);
    expect(after.data.pathNodes?.[2]?.point).toEqual(before.data.pathNodes?.[2]?.point);
    expect(container.querySelector('[data-can-undo="true"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "z",
        metaKey: true
      }));
    });

    expect(debugArtObject(objectId).object.data.pathNodes?.[1]?.point).toEqual(middleNode);
  });

  it("splits a clicked art line with scissors as an undoable path edit", async () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Scissors Split"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    await renderMainWindow(document, { initialActiveToolCommandId: "tool.art.scissors" });
    const before = debugArtObject(objectId);
    const middle = before.projectedEditPoints?.middle;
    if (!middle) {
      throw new Error("Expected projected line middle.");
    }

    await act(async () => {
      dispatchPointer(objectElement(objectId), "pointerdown", middle, 77);
    });
    const after = debugArtObject(objectId).object;

    expect(after.data.artPathKind).toBe("polyline");
    expect(after.data.pathNodes).toHaveLength(3);
    expect(after.data.pathNodes?.[1]?.point.x).toBeCloseTo(middle.x, 3);
    expect(after.data.pathNodes?.[1]?.point.y).toBeCloseTo(middle.y, 3);
    expect(container.querySelector('[data-can-undo="true"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "z",
        metaKey: true
      }));
    });

    const undone = debugArtObject(objectId).object;
    expect(undone.data.artPathKind).toBe("line");
    expect(undone.data.pathNodes).toBeUndefined();
  });

  it("shows the new polyline node immediately after a scissors split", async () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Scissors Polyline Feedback"),
      { x: 220, y: 180 },
      "tool.art.polyline"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    await renderMainWindow(document, { initialActiveToolCommandId: "tool.art.scissors" });
    const before = debugArtObject(objectId).object;
    const start = before.data.pathNodes?.[0]?.point;
    const next = before.data.pathNodes?.[1]?.point;
    if (!start || !next) {
      throw new Error("Expected inserted polyline nodes.");
    }
    const splitPoint = {
      x: (start.x + next.x) / 2,
      y: (start.y + next.y) / 2
    };

    expect(container.querySelector('[data-active-tool="tool.art.scissors"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-graphic-path-node-index]")).toHaveLength(0);

    await act(async () => {
      dispatchPointer(objectElement(objectId), "pointerdown", splitPoint, 78);
    });
    const after = debugArtObject(objectId).object;
    const selectedHandle = container.querySelector<HTMLElement>('[data-graphic-path-node-selected="true"]');

    expect(container.querySelector('[data-active-tool="tool.art.scissors"]')).not.toBeNull();
    expect(container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`)?.dataset.graphicInteractionMode).toBe("path-edit");
    expect(after.data.pathNodes).toHaveLength(4);
    expect(container.querySelectorAll("[data-graphic-path-node-index]")).toHaveLength(4);
    expect(selectedHandle?.dataset.graphicPathNodeIndex).toBe("1");
    expect(after.data.pathNodes?.[1]?.point.x).toBeCloseTo(splitPoint.x, 3);
    expect(after.data.pathNodes?.[1]?.point.y).toBeCloseTo(splitPoint.y, 3);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Scissors: node added; click path for more; Esc exits");
  });

  it("exits the scissors tool with Escape", async () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Scissors Escape"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    await renderMainWindow(document, { initialActiveToolCommandId: "tool.art.scissors" });

    expect(container.querySelector('[data-active-tool="tool.art.scissors"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true
      }));
    });

    expect(container.querySelector('[data-active-tool="tool.select"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Selection: click object or canvas; drag moves or selects; choose another tool");
  });

  it("exits idle drawing tools with Escape", async () => {
    await renderMainWindow(createPhase4Document("Idle Tool Escape"), { initialActiveToolCommandId: "tool.art.circle" });

    expect(container.querySelector('[data-active-tool="tool.art.circle"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true
      }));
    });

    expect(container.querySelector('[data-active-tool="tool.select"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Selection: click object or canvas; drag moves or selects; choose another tool");
  });

  it("commits a line-to-quadratic drag as one undoable history entry", async () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Path Undo"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    await renderMainWindow(document);
    const middle = debugArtObject(objectId).projectedEditPoints?.middle;
    if (!middle) {
      throw new Error("Expected projected middle handle.");
    }

    await act(async () => {
      dispatchPointer(pathHandle("middle"), "pointerdown", middle, 2);
      dispatchPointer(pageElement(), "pointermove", { x: middle.x, y: middle.y - 2 }, 2);
      dispatchPointer(pageElement(), "pointermove", { x: middle.x, y: middle.y - 24 }, 2);
      dispatchPointer(pageElement(), "pointerup", { x: middle.x, y: middle.y - 24 }, 2);
    });

    expect(debugArtObject(objectId).object.data.artPathKind).toBe("quadratic");
    expect(container.querySelector('[data-can-undo="true"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "z",
        metaKey: true
      }));
    });

    expect(debugArtObject(objectId).object.data.artPathKind).toBe("line");
  });

  it("keeps a quadratic path editable after deselecting and reselecting through its hit target", async () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Path Reselect"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    await renderMainWindow(document);
    const middle = debugArtObject(objectId).projectedEditPoints?.middle;
    if (!middle) {
      throw new Error("Expected projected middle handle.");
    }

    await act(async () => {
      dispatchPointer(pathHandle("middle"), "pointerdown", middle, 3);
      dispatchPointer(pageElement(), "pointermove", { x: middle.x, y: middle.y - 20 }, 3);
      dispatchPointer(pageElement(), "pointerup", { x: middle.x, y: middle.y - 20 }, 3);
    });
    await act(async () => {
      dispatchPointer(pageElement(), "pointerdown", { x: 20, y: 20 }, 4);
      dispatchPointer(pageElement(), "pointerup", { x: 20, y: 20 }, 4);
    });
    expect(container.querySelector("[data-graphic-path-handle]")).toBeNull();

    const hitTarget = container.querySelector<SVGElement>(".graphic-glyph-hit-target");
    if (!hitTarget) {
      throw new Error("Expected graphic hit target.");
    }
    const start = debugArtObject(objectId).projectedEditPoints?.start;
    if (!start) {
      throw new Error("Expected projected start point.");
    }
    await act(async () => {
      dispatchPointer(hitTarget, "pointerdown", start, 5);
      dispatchPointer(hitTarget, "pointerup", start, 5);
    });

    expect(debugArtObject(objectId).editPoints?.pathKind).toBe("quadratic");
    expect(container.querySelector('[data-graphic-path-handle="middle"]')).not.toBeNull();
  });

  it("uses a wide invisible hit target to select a thin semantic arc", async () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Thin Arc Hit Target"),
      { x: 220, y: 180 },
      "tool.art.arc270"
    );
    const objectId = inserted.selection.objectIds[0] ?? "";
    const graphic = graphicById(inserted, objectId);
    const document = applyPatch(
      applyPatch(inserted, {
        op: "updateObject",
        objectId,
        changes: {
          style: {
            ...graphic.style,
            strokeWidth: 1
          }
        }
      }),
      { op: "setSelection", pageId: inserted.pages[0].id, objectIds: [] }
    );
    await renderMainWindow(document);

    const hitTarget = container.querySelector<SVGElement>(".graphic-glyph-hit-target");
    if (!hitTarget) {
      throw new Error("Expected graphic hit target.");
    }
    expect(Number(hitTarget.getAttribute("stroke-width"))).toBeGreaterThan(1);
    expect(Number(hitTarget.getAttribute("stroke-width"))).toBeGreaterThanOrEqual(14);
    expect(container.querySelector("[data-graphic-path-handle]")).toBeNull();

    const middle = debugArtObject(objectId).projectedEditPoints?.middle;
    if (!middle) {
      throw new Error("Expected projected arc middle.");
    }
    await act(async () => {
      dispatchPointer(hitTarget, "pointerdown", middle, 6);
      dispatchPointer(hitTarget, "pointerup", middle, 6);
    });

    expect(container.querySelector('[data-graphic-path-handle="middle"]')).not.toBeNull();
    expect(debugArtObject(objectId).editPoints?.pathKind).toBe("arc");
  });

  it("keeps a rotated and tilted arc middle handle attached after drag", async () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Projected Arc Handle"),
      { x: 220, y: 180 },
      "tool.art.arc270"
    );
    const objectId = inserted.selection.objectIds[0] ?? "";
    const graphic = graphicById(inserted, objectId);
    const document = applyPatch(inserted, {
      op: "updateObject",
      objectId,
      changes: {
        rotation: 28,
        style: {
          ...graphic.style,
          tiltXDegrees: 18,
          tiltYDegrees: -12
        }
      }
    });
    await renderMainWindow(document);
    const middle = debugArtObject(objectId).projectedEditPoints?.middle;
    if (!middle) {
      throw new Error("Expected projected arc middle.");
    }
    const target = { x: middle.x + 8, y: middle.y - 8 };

    await act(async () => {
      dispatchPointer(pathHandle("middle"), "pointerdown", middle, 7);
      dispatchPointer(pageElement(), "pointermove", target, 7);
      dispatchPointer(pageElement(), "pointermove", target, 7);
      dispatchPointer(pageElement(), "pointerup", target, 7);
    });
    const after = debugArtObject(objectId);

    expect(after.object.data.artPathKind).toBe("arc");
    expect(after.object.data.pathControlPoint).toBeUndefined();
    expect(Math.hypot(
      (after.projectedEditPoints?.middle.x ?? 0) - target.x,
      (after.projectedEditPoints?.middle.y ?? 0) - target.y
    )).toBeLessThan(0.75);
  });

  it("moves the visible stroke with the object after endpoint editing", async () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Endpoint Edit Object Drag"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    await renderMainWindow(document);
    const end = debugArtObject(objectId).projectedEditPoints?.end;
    if (!end) {
      throw new Error("Expected projected end handle.");
    }
    const editedEnd = { x: end.x + 34, y: end.y + 10 };

    await act(async () => {
      dispatchPointer(pathHandle("end"), "pointerdown", end, 8);
      dispatchPointer(pageElement(), "pointermove", editedEnd, 8);
      dispatchPointer(pageElement(), "pointerup", editedEnd, 8);
    });
    const beforeDrag = debugArtObject(objectId);
    const beforePathD = pathD(".graphic-glyph-path");
    const beforeHitD = pathD(".graphic-glyph-hit-target");
    const dragStart = beforeDrag.projectedEditPoints?.middle;
    if (!dragStart || !beforeDrag.projectedEditPoints) {
      throw new Error("Expected projected line edit points.");
    }
    const dx = 30;
    const dy = 18;
    const hitTarget = container.querySelector<SVGElement>(".graphic-glyph-hit-target");
    if (!hitTarget) {
      throw new Error("Expected graphic hit target.");
    }

    await act(async () => {
      dispatchPointer(hitTarget, "pointerdown", dragStart, 9);
      dispatchPointer(pageElement(), "pointermove", { x: dragStart.x + dx, y: dragStart.y + dy }, 9);
      dispatchPointer(pageElement(), "pointerup", { x: dragStart.x + dx, y: dragStart.y + dy }, 9);
    });
    const afterDrag = debugArtObject(objectId);

    expect(afterDrag.object.x).toBeCloseTo(beforeDrag.object.x + dx, 3);
    expect(afterDrag.object.y).toBeCloseTo(beforeDrag.object.y + dy, 3);
    expect(afterDrag.object.data.lineStart?.x).toBeCloseTo((beforeDrag.object.data.lineStart?.x ?? 0) + dx, 3);
    expect(afterDrag.object.data.lineStart?.y).toBeCloseTo((beforeDrag.object.data.lineStart?.y ?? 0) + dy, 3);
    expect(afterDrag.object.data.lineEnd?.x).toBeCloseTo((beforeDrag.object.data.lineEnd?.x ?? 0) + dx, 3);
    expect(afterDrag.object.data.lineEnd?.y).toBeCloseTo((beforeDrag.object.data.lineEnd?.y ?? 0) + dy, 3);
    expectProjectedPointShift(afterDrag.projectedEditPoints?.start, beforeDrag.projectedEditPoints.start, dx, dy);
    expectProjectedPointShift(afterDrag.projectedEditPoints?.end, beforeDrag.projectedEditPoints.end, dx, dy);
    expect(pathD(".graphic-glyph-path")).toBe(beforePathD);
    expect(pathD(".graphic-glyph-hit-target")).toBe(beforeHitD);
    expect(pathD(".graphic-glyph-hit-target")).toBe(pathD(".graphic-glyph-path"));
  });

  it("keeps quadratic stroke, hit target, handles, and box aligned after reselect and object drag", async () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Quadratic Drag Alignment"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    await renderMainWindow(document);
    const middle = debugArtObject(objectId).projectedEditPoints?.middle;
    if (!middle) {
      throw new Error("Expected projected middle handle.");
    }

    await act(async () => {
      dispatchPointer(pathHandle("middle"), "pointerdown", middle, 10);
      dispatchPointer(pageElement(), "pointermove", { x: middle.x + 8, y: middle.y - 28 }, 10);
      dispatchPointer(pageElement(), "pointerup", { x: middle.x + 8, y: middle.y - 28 }, 10);
    });
    await act(async () => {
      dispatchPointer(pageElement(), "pointerdown", { x: 20, y: 20 }, 11);
      dispatchPointer(pageElement(), "pointerup", { x: 20, y: 20 }, 11);
    });
    expect(container.querySelector("[data-graphic-path-handle]")).toBeNull();

    const reselectPoint = debugArtObject(objectId).projectedEditPoints?.middle;
    const hitTarget = container.querySelector<SVGElement>(".graphic-glyph-hit-target");
    if (!reselectPoint || !hitTarget) {
      throw new Error("Expected quadratic hit target and middle point.");
    }
    await act(async () => {
      dispatchPointer(hitTarget, "pointerdown", reselectPoint, 12);
      dispatchPointer(hitTarget, "pointerup", reselectPoint, 12);
    });
    expect(container.querySelector('[data-graphic-path-handle="middle"]')).not.toBeNull();
    await waitPastDoublePressWindow();

    const beforeDrag = debugArtObject(objectId);
    if (!beforeDrag.projectedEditPoints) {
      throw new Error("Expected projected quadratic edit points.");
    }
    const beforePathD = pathD(".graphic-glyph-path");
    const beforeHitD = pathD(".graphic-glyph-hit-target");
    const beforeHandles = {
      start: pathHandleLocalPosition("start"),
      middle: pathHandleLocalPosition("middle"),
      end: pathHandleLocalPosition("end")
    };
    const dx = -24;
    const dy = 32;

    await act(async () => {
      dispatchPointer(hitTarget, "pointerdown", beforeDrag.projectedEditPoints!.middle, 13);
      dispatchPointer(pageElement(), "pointermove", {
        x: beforeDrag.projectedEditPoints!.middle.x + dx,
        y: beforeDrag.projectedEditPoints!.middle.y + dy
      }, 13);
      dispatchPointer(pageElement(), "pointerup", {
        x: beforeDrag.projectedEditPoints!.middle.x + dx,
        y: beforeDrag.projectedEditPoints!.middle.y + dy
      }, 13);
    });
    const afterDrag = debugArtObject(objectId);

    expect(afterDrag.object.data.artPathKind).toBe("quadratic");
    expect(afterDrag.object.x).toBeCloseTo(beforeDrag.object.x + dx, 3);
    expect(afterDrag.object.y).toBeCloseTo(beforeDrag.object.y + dy, 3);
    expectProjectedPointShift(afterDrag.projectedEditPoints?.start, beforeDrag.projectedEditPoints.start, dx, dy);
    expectProjectedPointShift(afterDrag.projectedEditPoints?.middle, beforeDrag.projectedEditPoints.middle, dx, dy);
    expectProjectedPointShift(afterDrag.projectedEditPoints?.end, beforeDrag.projectedEditPoints.end, dx, dy);
    expect(pathD(".graphic-glyph-path")).toBe(beforePathD);
    expect(pathD(".graphic-glyph-hit-target")).toBe(beforeHitD);
    expect(pathD(".graphic-glyph-hit-target")).toBe(pathD(".graphic-glyph-path"));
    expect(pathHandleLocalPosition("start")).toEqual(beforeHandles.start);
    expect(pathHandleLocalPosition("middle")).toEqual(beforeHandles.middle);
    expect(pathHandleLocalPosition("end")).toEqual(beforeHandles.end);
  });

  it("resizes a bent line with its visible curve, hit target, handles, and box still aligned", async () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Quadratic Resize Alignment"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    await renderMainWindow(document);
    const middle = debugArtObject(objectId).projectedEditPoints?.middle;
    if (!middle) {
      throw new Error("Expected projected middle handle.");
    }

    await act(async () => {
      dispatchPointer(pathHandle("middle"), "pointerdown", middle, 14);
      dispatchPointer(pageElement(), "pointermove", { x: middle.x + 12, y: middle.y - 30 }, 14);
      dispatchPointer(pageElement(), "pointerup", { x: middle.x + 12, y: middle.y - 30 }, 14);
    });
    const bent = debugArtObject(objectId);
    const transformPress = bent.projectedEditPoints?.middle;
    const hitTarget = container.querySelector<SVGElement>(".graphic-glyph-hit-target");
    if (!transformPress || !hitTarget) {
      throw new Error("Expected quadratic hit target and transform press point.");
    }

    await act(async () => {
      dispatchPointer(hitTarget, "pointerdown", transformPress, 15, 2);
      dispatchPointer(hitTarget, "pointerup", transformPress, 15, 2);
    });
    const transformFrame = container.querySelector<HTMLElement>('[data-art-transform-frame="true"]');
    expect(transformFrame).not.toBeNull();
    if (!transformFrame) {
      throw new Error("Expected art transform frame.");
    }
    expectFrameUsesPlanBounds(transformFrame, debugArtObject(objectId).plan);
    expect(container.querySelector("[data-graphic-path-handle]")).toBeNull();

    const beforeResize = debugArtObject(objectId);
    const beforePathD = pathD(".graphic-glyph-path");
    const beforeLineStart = beforeResize.object.data.lineStart;
    const beforeLineEnd = beforeResize.object.data.lineEnd;
    const beforeControl = beforeResize.object.data.pathControlPoint;
    if (!beforeLineStart || !beforeLineEnd || !beforeControl) {
      throw new Error("Expected explicit quadratic geometry before resize.");
    }
    const dragStart = {
      x: beforeResize.object.x + beforeResize.object.width,
      y: beforeResize.object.y + beforeResize.object.height
    };
    const dragEnd = { x: dragStart.x + 44, y: dragStart.y + 26 };

    await act(async () => {
      dispatchPointer(resizeHandle("bottom-right"), "pointerdown", dragStart, 16);
      dispatchPointer(pageElement(), "pointermove", dragEnd, 16);
      dispatchPointer(pageElement(), "pointerup", dragEnd, 16);
    });
    const afterResize = debugArtObject(objectId);

    expect(afterResize.object.data.artPathKind).toBe("quadratic");
    expect(afterResize.object.width).toBeGreaterThan(beforeResize.object.width);
    expect(afterResize.object.height).toBeGreaterThan(beforeResize.object.height);
    expect(afterResize.object.data.lineStart?.x).not.toBeCloseTo(beforeLineStart.x, 3);
    expect(afterResize.object.data.lineEnd?.x).not.toBeCloseTo(beforeLineEnd.x, 3);
    expect(afterResize.object.data.pathControlPoint?.y).not.toBeCloseTo(beforeControl.y, 3);
    expect(pathD(".graphic-glyph-path")).not.toBe(beforePathD);
    expect(pathD(".graphic-glyph-hit-target")).toBe(pathD(".graphic-glyph-path"));

    await act(async () => {
      dispatchPointer(pageElement(), "pointerdown", { x: 20, y: 20 }, 17);
      dispatchPointer(pageElement(), "pointerup", { x: 20, y: 20 }, 17);
    });
    expect(container.querySelector("[data-graphic-path-handle]")).toBeNull();

    const reselectPoint = debugArtObject(objectId).projectedEditPoints?.middle;
    const resizedHitTarget = container.querySelector<SVGElement>(".graphic-glyph-hit-target");
    if (!reselectPoint || !resizedHitTarget) {
      throw new Error("Expected resized quadratic hit target and middle point.");
    }
    await act(async () => {
      dispatchPointer(resizedHitTarget, "pointerdown", reselectPoint, 18);
      dispatchPointer(resizedHitTarget, "pointerup", reselectPoint, 18);
    });
    expect(container.querySelector('[data-graphic-path-handle="middle"]')).not.toBeNull();
    await waitPastDoublePressWindow();

    const beforeDrag = debugArtObject(objectId);
    const dragPoint = beforeDrag.projectedEditPoints?.middle;
    if (!dragPoint || !beforeDrag.projectedEditPoints) {
      throw new Error("Expected resized quadratic edit points before object drag.");
    }
    const dx = 18;
    const dy = -22;
    const postResizePathD = pathD(".graphic-glyph-path");

    await act(async () => {
      dispatchPointer(resizedHitTarget, "pointerdown", dragPoint, 19);
      dispatchPointer(pageElement(), "pointermove", { x: dragPoint.x + dx, y: dragPoint.y + dy }, 19);
      dispatchPointer(pageElement(), "pointerup", { x: dragPoint.x + dx, y: dragPoint.y + dy }, 19);
    });
    const afterDrag = debugArtObject(objectId);

    expect(afterDrag.object.x).toBeCloseTo(beforeDrag.object.x + dx, 3);
    expect(afterDrag.object.y).toBeCloseTo(beforeDrag.object.y + dy, 3);
    expectProjectedPointShift(afterDrag.projectedEditPoints?.start, beforeDrag.projectedEditPoints.start, dx, dy);
    expectProjectedPointShift(afterDrag.projectedEditPoints?.middle, beforeDrag.projectedEditPoints.middle, dx, dy);
    expectProjectedPointShift(afterDrag.projectedEditPoints?.end, beforeDrag.projectedEditPoints.end, dx, dy);
    expect(pathD(".graphic-glyph-path")).toBe(postResizePathD);
    expect(pathD(".graphic-glyph-hit-target")).toBe(pathD(".graphic-glyph-path"));
  });

  it("does not bake a rotated line on a non-drag path handle click", async () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Rotated Handle Click"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0] ?? "";
    const document = applyPatch(inserted, {
      op: "updateObject",
      objectId,
      changes: {
        rotation: 38
      }
    });
    await renderMainWindow(document);
    const end = debugArtObject(objectId).projectedEditPoints?.end;
    if (!end) {
      throw new Error("Expected projected end handle.");
    }

    await act(async () => {
      dispatchPointer(pathHandle("end"), "pointerdown", end, 20);
      dispatchPointer(pageElement(), "pointerup", end, 20);
    });
    const afterClick = debugArtObject(objectId);

    expect(afterClick.object.rotation).toBeCloseTo(38, 3);
    expect(afterClick.object.data.lineStart).toBeUndefined();
    expect(afterClick.object.data.lineEnd).toBeUndefined();
    expect(afterClick.object.data.pathControlPoint).toBeUndefined();
    expect(container.querySelector('[data-can-undo="true"]')).toBeNull();
  });

  it("bakes a rotated line before endpoint drag and keeps handles attached through reselect and undo", async () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Rotated Endpoint Drag"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0] ?? "";
    const document = applyPatch(inserted, {
      op: "updateObject",
      objectId,
      changes: {
        rotation: 41
      }
    });
    await renderMainWindow(document);
    const before = debugArtObject(objectId);
    const start = before.projectedEditPoints?.start;
    const end = before.projectedEditPoints?.end;
    if (!start || !end) {
      throw new Error("Expected rotated line edit points.");
    }
    const target = { x: end.x + 32, y: end.y + 12 };

    await act(async () => {
      dispatchPointer(pathHandle("end"), "pointerdown", end, 21);
      dispatchPointer(pageElement(), "pointermove", target, 21);
      dispatchPointer(pageElement(), "pointerup", target, 21);
    });
    const afterDrag = debugArtObject(objectId);

    expect(afterDrag.object.rotation).toBeCloseTo(0, 3);
    expect(afterDrag.object.data.artPathKind).toBe("line");
    expect(afterDrag.object.data.lineStart).toBeDefined();
    expect(afterDrag.object.data.lineEnd).toBeDefined();
    expect(Math.hypot(
      (afterDrag.projectedEditPoints?.start.x ?? 0) - start.x,
      (afterDrag.projectedEditPoints?.start.y ?? 0) - start.y
    )).toBeLessThan(0.75);
    expect(Math.hypot(
      (afterDrag.projectedEditPoints?.end.x ?? 0) - target.x,
      (afterDrag.projectedEditPoints?.end.y ?? 0) - target.y
    )).toBeLessThan(0.75);
    expect(container.querySelector('[data-can-undo="true"]')).not.toBeNull();

    await act(async () => {
      dispatchPointer(pageElement(), "pointerdown", { x: 20, y: 20 }, 22);
      dispatchPointer(pageElement(), "pointerup", { x: 20, y: 20 }, 22);
    });
    expect(container.querySelector("[data-graphic-path-handle]")).toBeNull();

    const hitTarget = container.querySelector<SVGElement>(".graphic-glyph-hit-target");
    const reselectPoint = debugArtObject(objectId).projectedEditPoints?.end;
    if (!hitTarget || !reselectPoint) {
      throw new Error("Expected baked line hit target.");
    }
    await act(async () => {
      dispatchPointer(hitTarget, "pointerdown", reselectPoint, 23);
      dispatchPointer(hitTarget, "pointerup", reselectPoint, 23);
    });
    expect(container.querySelector('[data-graphic-path-handle="end"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "z",
        metaKey: true
      }));
    });
    const undone = debugArtObject(objectId);

    expect(undone.object.rotation).toBeCloseTo(41, 3);
    expect(undone.object.data.lineStart).toBeUndefined();
    expect(undone.object.data.lineEnd).toBeUndefined();
    expect(undone.object.data.pathControlPoint).toBeUndefined();
  });

  it("bakes X/Y projected quadratic geometry before endpoint length edits so the opposite endpoint stays pinned", async () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Tilted Quadratic Endpoint Drag"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0] ?? "";
    const linePoints = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!linePoints) {
      throw new Error("Expected inserted line edit points.");
    }
    const bent = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "middle",
      { x: linePoints.middle.x - 36, y: linePoints.middle.y + 58 }
    );
    const bentGraphic = graphicById(bent, objectId);
    const tilted = applyPatch(bent, {
      op: "updateObject",
      objectId,
      changes: {
        rotation: 28,
        style: {
          ...bentGraphic.style,
          tiltXDegrees: 128,
          tiltYDegrees: -94
        }
      }
    });
    await renderMainWindow(tilted);

    const before = debugArtObject(objectId);
    const start = before.projectedEditPoints?.start;
    const end = before.projectedEditPoints?.end;
    if (!start || !end) {
      throw new Error("Expected projected tilted quadratic endpoints.");
    }
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    const target = {
      x: end.x + dx / length * 145,
      y: end.y + dy / length * 145
    };

    await act(async () => {
      dispatchPointer(pathHandle("end"), "pointerdown", end, 24);
      dispatchPointer(pageElement(), "pointermove", {
        x: end.x + (target.x - end.x) * 0.5,
        y: end.y + (target.y - end.y) * 0.5
      }, 24);
      dispatchPointer(pageElement(), "pointermove", target, 24);
      dispatchPointer(pageElement(), "pointerup", target, 24);
    });
    const after = debugArtObject(objectId);

    expect(after.object.data.artPathKind).toBe("quadratic");
    expect(after.object.rotation).toBeCloseTo(0, 3);
    expect(after.object.style.tiltXDegrees).toBeUndefined();
    expect(after.object.style.tiltYDegrees).toBeUndefined();
    expectProjectedPointPinned(after.projectedEditPoints?.start, start);
    expectProjectedPointPinned(after.projectedEditPoints?.middle, before.projectedEditPoints!.middle, 6);
    expect(Math.hypot(
      (after.projectedEditPoints?.end.x ?? 0) - target.x,
      (after.projectedEditPoints?.end.y ?? 0) - target.y
    )).toBeLessThan(0.75);
    expect(pathD(".graphic-glyph-hit-target")).toBe(pathD(".graphic-glyph-path"));
  });
});
