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

describe("Pen native art interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
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
  });

  async function renderMainWindow() {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.art.pen",
        initialCrosshairsVisible: false,
        initialDocument: createPhase4Document("Pen Draw"),
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

  function selectedArtObjectId(): string {
    const graphic = container.querySelector<HTMLElement>(".graphic-object");
    const objectId = graphic?.dataset.objectId;
    if (!objectId) {
      throw new Error("Expected inserted graphic object.");
    }
    return objectId;
  }

  function debugArtObject(objectId: string) {
    const debug = window.__CHEMDRAFT_AGENT__?.debugArtObject(objectId);
    if (!debug?.ok) {
      throw new Error(`Expected art debug snapshot for ${objectId}.`);
    }
    return debug;
  }

  function dispatchPointer(
    type: "pointerdown" | "pointermove" | "pointerup",
    point: { x: number; y: number },
    pointerId: number
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
      pointerType: { value: "mouse" },
      pressure: { value: 0.5 }
    });
    pageElement().dispatchEvent(event);
  }

  function clickPoint(point: { x: number; y: number }, pointerId: number) {
    dispatchPointer("pointerdown", point, pointerId);
    dispatchPointer("pointerup", point, pointerId);
  }

  function dragPoint(
    start: { x: number; y: number },
    end: { x: number; y: number },
    pointerId: number
  ) {
    dispatchPointer("pointerdown", start, pointerId);
    dispatchPointer("pointermove", end, pointerId);
    dispatchPointer("pointerup", end, pointerId);
  }

  function dispatchKey(key: string, metaKey = false) {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
      metaKey
    }));
  }

  it("clicks Pen nodes, drags Bezier controls, and commits with Enter", async () => {
    await renderMainWindow();

    await act(async () => {
      clickPoint({ x: 160, y: 140 }, 41);
      dragPoint({ x: 220, y: 168 }, { x: 240, y: 180 }, 42);
    });

    expect(snapshotObjectCount()).toBe(0);
    expect(container.querySelector("[data-path-art-kind=\"bezier\"]")).not.toBeNull();
    expect(container.querySelector("[data-path-art-preview-path=\"true\"]")?.getAttribute("d")).toBe(
      "M 160 140 C 160 140 200 156 220 168"
    );

    await act(async () => {
      clickPoint({ x: 284, y: 150 }, 43);
      dispatchKey("Enter");
    });

    const debug = debugArtObject(selectedArtObjectId());
    expect(snapshotObjectCount()).toBe(1);
    expect(container.querySelector("[data-path-art-preview-layer=\"true\"]")).toBeNull();
    expect(container.querySelector("[data-active-tool=\"tool.select\"]")).not.toBeNull();
    expect(debug.object.data.artPathKind).toBe("bezier");
    expect(debug.object.data.pathClosed).toBe(false);
    expect(debug.object.data.pathNodes).toEqual([
      { point: { x: 160, y: 140 } },
      {
        point: { x: 220, y: 168 },
        inControl: { x: 200, y: 156 },
        outControl: { x: 240, y: 180 }
      },
      { point: { x: 284, y: 150 } }
    ]);
    expect(debug.plan.pathD).toContain(" C ");
    expect(container.querySelector("[data-can-undo=\"true\"]")).not.toBeNull();

    await act(async () => {
      dispatchKey("z", true);
    });
    expect(snapshotObjectCount()).toBe(0);
  });

  it("closes the Pen path by clicking the first node", async () => {
    await renderMainWindow();

    await act(async () => {
      clickPoint({ x: 140, y: 140 }, 51);
      clickPoint({ x: 220, y: 140 }, 52);
      clickPoint({ x: 196, y: 210 }, 53);
      clickPoint({ x: 143, y: 142 }, 54);
    });

    const debug = debugArtObject(selectedArtObjectId());
    expect(snapshotObjectCount()).toBe(1);
    expect(debug.object.data.artPathKind).toBe("bezier");
    expect(debug.object.data.pathClosed).toBe(true);
    expect(debug.object.data.pathNodes).toEqual([
      { point: { x: 140, y: 140 } },
      { point: { x: 220, y: 140 } },
      { point: { x: 196, y: 210 } }
    ]);
    expect(container.querySelector("[data-path-art-preview-layer=\"true\"]")).toBeNull();
    expect(container.querySelector("[data-active-tool=\"tool.select\"]")).not.toBeNull();
  });
});
