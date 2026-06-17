// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("freehand native art interactions", () => {
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
    window.history.replaceState(null, "", "/?agentBridge=1");

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
    commandId: string,
    options: { initialPaletteMode?: "floating" | "hidden"; nativePalette?: boolean } = {}
  ) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: commandId,
        initialCrosshairsVisible: false,
        initialDocument: createPhase4Document("Freehand Drag"),
        initialPaletteMode: options.initialPaletteMode ?? "hidden",
        initialRulersVisible: false,
        nativePalette: options.nativePalette ?? true
      }));
    });
    pageElement().getBoundingClientRect = () => pageRect;
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

  function snapshotObjectCount(): number {
    const bridge = window.__CHEMDRAFT_AGENT__;
    if (!bridge) {
      throw new Error("Expected agent bridge.");
    }
    return bridge.snapshot().pages[0]?.objectCount ?? 0;
  }

  function debugArtObject(objectId: string) {
    const debug = window.__CHEMDRAFT_AGENT__?.debugArtObject(objectId);
    if (!debug?.ok) {
      throw new Error(`Expected art debug snapshot for ${objectId}.`);
    }
    return debug;
  }

  function dispatchPointer(
    target: EventTarget,
    type: "pointerdown" | "pointermove" | "pointerup",
    point: { x: number; y: number },
    pointerId: number,
    pressure: number
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      cancelable: true,
      clientX: point.x,
      clientY: point.y
    });
    Object.defineProperties(event, {
      isPrimary: { value: true },
      pointerId: { value: pointerId },
      pointerType: { value: "pen" },
      pressure: { value: pressure }
    });
    target.dispatchEvent(event);
  }

  async function waitForPreviewFrame() {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  async function drawPencilStroke(pointerId: number, points = [
    { x: 180, y: 180, pressure: 0.2 },
    { x: 214, y: 196, pressure: 0.9 },
    { x: 252, y: 178, pressure: 0.45 }
  ]): Promise<string> {
    const [start, ...rest] = points;
    const page = pageElement();
    await act(async () => {
      dispatchPointer(page, "pointerdown", start, pointerId, start.pressure);
      for (const point of rest) {
        dispatchPointer(page, "pointermove", point, pointerId, point.pressure);
      }
    });
    await waitForPreviewFrame();
    const end = points[points.length - 1];
    await act(async () => {
      dispatchPointer(page, "pointerup", end, pointerId, end.pressure);
    });

    const graphic = Array.from(container.querySelectorAll<HTMLElement>(".graphic-object")).at(-1);
    const objectId = graphic?.dataset.objectId;
    if (!objectId) {
      throw new Error("Expected inserted freehand graphic.");
    }
    return objectId;
  }

  it("drags one pressure-sensitive pencil stroke and undoes/redoes it as one object", async () => {
    await renderMainWindow("tool.art.pencil");
    const page = pageElement();

    await act(async () => {
      dispatchPointer(page, "pointerdown", { x: 180, y: 180 }, 41, 0.2);
      dispatchPointer(page, "pointermove", { x: 214, y: 196 }, 41, 0.9);
      dispatchPointer(page, "pointermove", { x: 252, y: 178 }, 41, 0.45);
    });
    await waitForPreviewFrame();

    const previewPath = container.querySelector<SVGPathElement>("[data-freehand-art-preview-path]");
    expect(snapshotObjectCount()).toBe(0);
    expect(previewPath?.getAttribute("data-active")).toBe("true");
    expect(previewPath?.getAttribute("d")).toContain("L 252 178");
    expect(previewPath?.getAttribute("stroke")).toBe("#111111");
    expect(previewPath?.getAttribute("stroke-width")).toBe("5");

    await act(async () => {
      dispatchPointer(page, "pointerup", { x: 252, y: 178 }, 41, 0.45);
    });

    const graphic = container.querySelector<HTMLElement>(".graphic-object");
    const objectId = graphic?.dataset.objectId;
    if (!objectId) {
      throw new Error("Expected inserted freehand graphic.");
    }
    const debug = window.__CHEMDRAFT_AGENT__?.debugArtObject(objectId);
    if (!debug?.ok) {
      throw new Error("Expected freehand debug snapshot.");
    }

    expect(snapshotObjectCount()).toBe(1);
    expect(previewPath?.hasAttribute("d")).toBe(false);
    expect(container.querySelector('[data-active-tool="tool.select"]')).not.toBeNull();
    expect(debug.object.data.artPathKind).toBe("freehand");
    expect(debug.object.data.freehandOptions?.size).toBe(5);
    expect(debug.object.data.freehandPoints?.map((point) => point.pressure)).toEqual([0.2, 0.9, 0.45]);
    expect(debug.plan.pathD).toMatch(/^M /);
    expect(debug.plan.pathD).toContain(" Z");
    expect(debug.plan.width).toBeGreaterThan(1);
    expect(debug.plan.height).toBeGreaterThan(1);
    expect(container.querySelector(".graphic-glyph-path")?.getAttribute("fill")).toBe("#111111");
    expect(container.querySelector(".graphic-glyph-path")?.getAttribute("stroke")).toBe("none");
    expect(container.querySelector('[data-can-undo="true"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "z",
        metaKey: true
      }));
    });
    expect(snapshotObjectCount()).toBe(0);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "z",
        metaKey: true,
        shiftKey: true
      }));
    });
    expect(snapshotObjectCount()).toBe(1);
  });

  it("starts a new pencil stroke when pressing inside an existing freehand object", async () => {
    await renderMainWindow("tool.art.pencil", { initialPaletteMode: "floating", nativePalette: false });
    const firstObjectId = await drawPencilStroke(51);
    expect(snapshotObjectCount()).toBe(1);

    const pencilButton = container.querySelector<HTMLButtonElement>('[data-command-id="tool.art.pencil"]');
    if (!pencilButton) {
      throw new Error("Expected visible pencil tool button.");
    }
    await act(async () => {
      pencilButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const firstGraphic = container.querySelector<HTMLElement>(`[data-object-id="${firstObjectId}"]`);
    if (!firstGraphic) {
      throw new Error("Expected first freehand graphic.");
    }

    await act(async () => {
      dispatchPointer(firstGraphic, "pointerdown", { x: 204, y: 188 }, 52, 0.5);
      dispatchPointer(pageElement(), "pointermove", { x: 224, y: 196 }, 52, 0.65);
      dispatchPointer(pageElement(), "pointerup", { x: 244, y: 186 }, 52, 0.4);
    });

    expect(snapshotObjectCount()).toBe(2);
    expect(container.querySelectorAll(".graphic-object")).toHaveLength(2);
  });

  it("previews freehand object moves with CSS and commits geometry on pointer up", async () => {
    await renderMainWindow("tool.art.pencil");
    const objectId = await drawPencilStroke(61);
    const graphic = container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`);
    if (!graphic) {
      throw new Error("Expected inserted freehand graphic.");
    }

    const before = debugArtObject(objectId).object;
    const dragPoint = {
      x: before.x + before.width / 2,
      y: before.y + before.height / 2
    };
    const dx = 34;
    const dy = -18;

    await act(async () => {
      dispatchPointer(graphic, "pointerdown", dragPoint, 62, 0.5);
      dispatchPointer(pageElement(), "pointermove", { x: dragPoint.x + dx, y: dragPoint.y + dy }, 62, 0.5);
    });
    await waitForPreviewFrame();

    expect(debugArtObject(objectId).object.x).toBeCloseTo(before.x, 3);
    expect(debugArtObject(objectId).object.y).toBeCloseTo(before.y, 3);
    expect(graphic.getAttribute("data-art-transform-preview")).toBe("true");
    expect(graphic.getAttribute("data-art-transform-preview-mode")).toBe("move");
    expect(graphic.getAttribute("data-art-transform-preview-proxy")).toBe("svg-image");
    expect(graphic.querySelector("[data-art-transform-drag-preview='image']")).not.toBeNull();
    expect(graphic.querySelector(".graphic-glyph-shell")?.getAttribute("data-art-vector-hidden")).toBe("true");
    expect(graphic.querySelector(".graphic-glyph")).toBeNull();
    expect(graphic.style.transform).toContain("translate");

    await act(async () => {
      dispatchPointer(pageElement(), "pointerup", { x: dragPoint.x + dx, y: dragPoint.y + dy }, 62, 0.5);
    });

    const after = debugArtObject(objectId).object;
    expect(after.x).toBeCloseTo(before.x + dx, 3);
    expect(after.y).toBeCloseTo(before.y + dy, 3);
    expect(graphic.getAttribute("data-art-transform-preview")).toBeNull();
  });

  it("previews freehand object resize without mutating geometry until pointer up", async () => {
    await renderMainWindow("tool.art.pencil");
    const objectId = await drawPencilStroke(71);
    const graphic = container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`);
    const resizeHandle = container.querySelector<HTMLButtonElement>('[data-object-resize-corner="bottom-right"]');
    if (!graphic || !resizeHandle) {
      throw new Error("Expected selected freehand graphic with resize handle.");
    }

    const before = debugArtObject(objectId).object;
    const dragStart = {
      x: before.x + before.width,
      y: before.y + before.height
    };
    const dragEnd = {
      x: dragStart.x + 44,
      y: dragStart.y + 30
    };

    await act(async () => {
      dispatchPointer(resizeHandle, "pointerdown", dragStart, 72, 0.5);
      dispatchPointer(pageElement(), "pointermove", dragEnd, 72, 0.5);
    });
    await waitForPreviewFrame();

    expect(debugArtObject(objectId).object.width).toBeCloseTo(before.width, 3);
    expect(debugArtObject(objectId).object.height).toBeCloseTo(before.height, 3);
    expect(graphic.getAttribute("data-art-transform-preview")).toBe("true");
    expect(graphic.getAttribute("data-art-transform-preview-mode")).toBe("resize");
    expect(graphic.getAttribute("data-art-transform-preview-proxy")).toBe("svg-image");
    expect(graphic.querySelector("[data-art-transform-drag-preview='image']")).not.toBeNull();
    expect(graphic.querySelector(".graphic-glyph-shell")?.getAttribute("data-art-vector-hidden")).toBe("true");
    expect(graphic.querySelector(".graphic-glyph")).toBeNull();
    expect(graphic.style.transform).toContain("scale");

    await act(async () => {
      dispatchPointer(pageElement(), "pointerup", dragEnd, 72, 0.5);
    });

    const after = debugArtObject(objectId).object;
    expect(after.width).toBeGreaterThan(before.width);
    expect(after.height).toBeGreaterThan(before.height);
    expect(graphic.getAttribute("data-art-transform-preview")).toBeNull();
  });

  it("previews freehand object rotation without mutating rotation until pointer up", async () => {
    await renderMainWindow("tool.art.pencil");
    const objectId = await drawPencilStroke(81);
    const graphic = container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`);
    const rotateHandle = container.querySelector<HTMLButtonElement>(".object-rotate-handle");
    if (!graphic || !rotateHandle) {
      throw new Error("Expected selected freehand graphic with rotate handle.");
    }

    const before = debugArtObject(objectId).object;
    const center = {
      x: before.x + before.width / 2,
      y: before.y + before.height / 2
    };
    const dragStart = {
      x: center.x + before.width / 2 + 20,
      y: center.y
    };
    const dragEnd = {
      x: center.x + before.width / 2 + 20,
      y: center.y + 36
    };

    await act(async () => {
      dispatchPointer(rotateHandle, "pointerdown", dragStart, 82, 0.5);
      dispatchPointer(pageElement(), "pointermove", dragEnd, 82, 0.5);
    });
    await waitForPreviewFrame();

    expect(debugArtObject(objectId).object.rotation).toBeCloseTo(before.rotation, 3);
    expect(graphic.getAttribute("data-art-transform-preview")).toBe("true");
    expect(graphic.getAttribute("data-art-transform-preview-mode")).toBe("rotate");
    expect(graphic.getAttribute("data-art-transform-preview-proxy")).toBe("svg-image");
    expect(graphic.querySelector("[data-art-transform-drag-preview='image']")).not.toBeNull();
    expect(graphic.querySelector(".graphic-glyph-shell")?.getAttribute("data-art-vector-hidden")).toBe("true");
    expect(graphic.querySelector(".graphic-glyph")).toBeNull();
    expect(graphic.style.transform).toContain("rotate");

    await act(async () => {
      dispatchPointer(pageElement(), "pointerup", dragEnd, 82, 0.5);
    });

    const after = debugArtObject(objectId).object;
    expect(after.rotation).not.toBeCloseTo(before.rotation, 3);
    expect(graphic.getAttribute("data-art-transform-preview")).toBeNull();
  });
});
