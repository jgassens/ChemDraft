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

describe("polyline native art interactions", () => {
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
        initialActiveToolCommandId: "tool.art.polyline",
        initialCrosshairsVisible: false,
        initialDocument: createPhase4Document("Polyline Draw"),
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

  function dispatchPointerDown(point: { x: number; y: number }, detail = 1) {
    const event = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      detail
    });
    Object.defineProperties(event, {
      isPrimary: { value: true },
      pointerId: { value: 37 },
      pointerType: { value: "mouse" },
      pressure: { value: 0.5 }
    });
    pageElement().dispatchEvent(event);
  }

  function dispatchPointerMove(point: { x: number; y: number }) {
    const event = new MouseEvent("pointermove", {
      bubbles: true,
      button: 0,
      buttons: 0,
      cancelable: true,
      clientX: point.x,
      clientY: point.y
    });
    Object.defineProperties(event, {
      isPrimary: { value: true },
      pointerId: { value: 37 },
      pointerType: { value: "mouse" },
      pressure: { value: 0.5 }
    });
    pageElement().dispatchEvent(event);
  }

  function dispatchPointerCancel() {
    const event = new MouseEvent("pointercancel", {
      bubbles: true,
      button: 0,
      buttons: 0,
      cancelable: true,
      clientX: 220,
      clientY: 168
    });
    Object.defineProperties(event, {
      isPrimary: { value: true },
      pointerId: { value: 37 },
      pointerType: { value: "mouse" },
      pressure: { value: 0 }
    });
    pageElement().dispatchEvent(event);
  }

  function previewPathD(): string | null | undefined {
    return container
      .querySelector("[data-polyline-art-preview-path=\"true\"]")
      ?.getAttribute("d");
  }

  function dispatchKey(key: string, metaKey = false) {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
      metaKey
    }));
  }

  it("abandons an in-progress draw on pointer cancel", async () => {
    // A path draw is click-to-place, so a cancel has no preview document to restore — but the state
    // is live geometry and neither cancel handler cleared it. `pathArtDrawRef.current` gates two
    // pointer-move paths with no pointerId check and an early `return`, so a stranded draw swallowed
    // every later move on the page and on every object, left the preview overlay on screen with no
    // gesture behind it, and kept a `startDocument` snapshot that went stale as the commit base.
    await renderMainWindow();

    await act(async () => {
      dispatchPointerDown({ x: 160, y: 140 });
      dispatchPointerMove({ x: 220, y: 168 });
    });
    expect(previewPathD()).toBe("M 160 140 L 220 168");

    await act(async () => {
      dispatchPointerCancel();
    });
    expect(container.querySelector("[data-polyline-art-preview-layer=\"true\"]")).toBeNull();

    // The ref is gone, not just the React state: a live draw would repaint the preview on the next
    // move, since that move path only checks `pathArtDrawRef.current`.
    await act(async () => {
      dispatchPointerMove({ x: 300, y: 240 });
    });
    expect(container.querySelector("[data-polyline-art-preview-layer=\"true\"]")).toBeNull();

    // And the next click starts a fresh path rather than appending to the abandoned one.
    await act(async () => {
      dispatchPointerDown({ x: 320, y: 260 });
      dispatchPointerMove({ x: 360, y: 300 });
    });
    expect(previewPathD()).toBe("M 320 260 L 360 300");

    await act(async () => {
      dispatchPointerDown({ x: 360, y: 300 });
      dispatchKey("Enter");
    });
    // Only the fresh two-node path was committed; the abandoned nodes are absent.
    expect(snapshotObjectCount()).toBe(1);
    expect(debugArtObject(selectedArtObjectId()).object.data.pathNodes).toEqual([
      { point: { x: 320, y: 260 } },
      { point: { x: 360, y: 300 } }
    ]);
  });

  it("clicks polyline nodes and commits the path with Enter", async () => {
    await renderMainWindow();

    await act(async () => {
      dispatchPointerDown({ x: 160, y: 140 });
      dispatchPointerMove({ x: 220, y: 168 });
    });
    expect(snapshotObjectCount()).toBe(0);
    expect(container.querySelector("[data-polyline-art-preview-layer=\"true\"]")).not.toBeNull();
    expect(container.querySelector("[data-polyline-art-preview-path=\"true\"]")?.getAttribute("d")).toBe("M 160 140 L 220 168");

    await act(async () => {
      dispatchPointerDown({ x: 220, y: 168 });
      dispatchPointerDown({ x: 204, y: 224 });
      dispatchKey("Enter");
    });

    const objectId = selectedArtObjectId();
    const debug = debugArtObject(objectId);
    expect(snapshotObjectCount()).toBe(1);
    expect(container.querySelector("[data-polyline-art-preview-layer=\"true\"]")).toBeNull();
    expect(container.querySelector("[data-active-tool=\"tool.select\"]")).not.toBeNull();
    expect(debug.object.data.artPathKind).toBe("polyline");
    expect(debug.object.data.pathClosed).toBe(false);
    expect(debug.object.data.pathNodes).toEqual([
      { point: { x: 160, y: 140 } },
      { point: { x: 220, y: 168 } },
      { point: { x: 204, y: 224 } }
    ]);
    expect(debug.plan.pathD).toBe("M 6 6 L 66 34 L 50 90");
    expect(container.querySelector("[data-can-undo=\"true\"]")).not.toBeNull();

    await act(async () => {
      dispatchKey("z", true);
    });
    expect(snapshotObjectCount()).toBe(0);
  });

  it("removes the last in-progress polyline node with Backspace before committing", async () => {
    await renderMainWindow();

    await act(async () => {
      dispatchPointerDown({ x: 120, y: 120 });
      dispatchPointerDown({ x: 180, y: 154 });
      dispatchPointerDown({ x: 260, y: 112 });
      dispatchKey("Backspace");
    });
    expect(snapshotObjectCount()).toBe(0);
    expect(container.querySelectorAll("[data-polyline-art-preview-node]")).toHaveLength(2);

    await act(async () => {
      dispatchKey("Enter");
    });

    const debug = debugArtObject(selectedArtObjectId());
    expect(debug.object.data.pathNodes).toEqual([
      { point: { x: 120, y: 120 } },
      { point: { x: 180, y: 154 } }
    ]);
    expect(debug.plan.pathD).toBe("M 6 6 L 66 40");
  });

  it("closes the in-progress polyline by clicking the first node", async () => {
    await renderMainWindow();

    await act(async () => {
      dispatchPointerDown({ x: 140, y: 140 });
      dispatchPointerDown({ x: 220, y: 140 });
      dispatchPointerDown({ x: 196, y: 210 });
      dispatchPointerDown({ x: 143, y: 142 });
    });

    const debug = debugArtObject(selectedArtObjectId());
    expect(snapshotObjectCount()).toBe(1);
    expect(debug.object.data.pathClosed).toBe(true);
    expect(debug.object.data.pathNodes).toEqual([
      { point: { x: 140, y: 140 } },
      { point: { x: 220, y: 140 } },
      { point: { x: 196, y: 210 } }
    ]);
    expect(container.querySelector("[data-polyline-art-preview-layer=\"true\"]")).toBeNull();
    expect(container.querySelector("[data-active-tool=\"tool.select\"]")).not.toBeNull();
  });
});
