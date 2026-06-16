// @vitest-environment jsdom

import { applyPatch, type ChemDraftDocument, type GraphicObject } from "@chemdraft/chem-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeArtGraphicObject } from "./documentWorkflow";

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

  async function renderMainWindow(initialDocument: ChemDraftDocument) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialDocument,
        initialCrosshairsVisible: false,
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
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

  function pathHandle(handle: "start" | "middle" | "end"): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`[data-graphic-path-handle="${handle}"]`);
    if (!button) {
      throw new Error(`Expected ${handle} path handle.`);
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

  function expectProjectedPointShift(
    actual: { x: number; y: number } | undefined,
    before: { x: number; y: number },
    dx: number,
    dy: number
  ) {
    expect(actual?.x).toBeCloseTo(before.x + dx, 3);
    expect(actual?.y).toBeCloseTo(before.y + dy, 3);
  }

  async function waitPastDoublePressWindow() {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 410));
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
    detail = 1
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      detail
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
    expect(container.querySelector('[data-art-transform-frame="true"]')).not.toBeNull();
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
});
