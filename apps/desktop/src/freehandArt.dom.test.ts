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

  async function renderMainWindow(commandId: string) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: commandId,
        initialCrosshairsVisible: false,
        initialDocument: createPhase4Document("Freehand Drag"),
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
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

  it("drags one pressure-sensitive pencil stroke and undoes/redoes it as one object", async () => {
    await renderMainWindow("tool.art.pencil");
    const page = pageElement();

    await act(async () => {
      dispatchPointer(page, "pointerdown", { x: 180, y: 180 }, 41, 0.2);
      dispatchPointer(page, "pointermove", { x: 214, y: 196 }, 41, 0.9);
      dispatchPointer(page, "pointermove", { x: 252, y: 178 }, 41, 0.45);
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
});
