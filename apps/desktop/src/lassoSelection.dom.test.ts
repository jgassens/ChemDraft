// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphicObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import {
  createPhase4Document,
  insertNativeArtGraphicObject,
  selectDocumentObjects
} from "./documentWorkflow";

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

describe("lasso selection interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.hasPointerCapture = () => false;

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  async function renderMainWindow(initialDocument = createPhase4Document("Lasso")) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.lasso",
        initialCrosshairsVisible: false,
        initialDocument,
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

  function graphicInteractionMode(objectId: string): string | undefined {
    return container.querySelector<HTMLElement>(`[data-object-id="${objectId}"].graphic-object`)
      ?.dataset.graphicInteractionMode;
  }

  function dispatchPointer(
    target: EventTarget,
    type: "pointerdown" | "pointermove" | "pointerup",
    point: { x: number; y: number },
    options: { altKey?: boolean; pointerId?: number } = {}
  ) {
    const event = new MouseEvent(type, {
      altKey: options.altKey ?? false,
      bubbles: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      cancelable: true,
      clientX: point.x,
      clientY: point.y
    });
    Object.defineProperties(event, {
      isPrimary: { value: true },
      pointerId: { value: options.pointerId ?? 1 },
      pointerType: { value: "mouse" }
    });
    target.dispatchEvent(event);
  }

  it("starts over a selected graphic and Alt-lasso subtracts it from the group", async () => {
    const firstInserted = insertNativeArtGraphicObject(
      createPhase4Document("Lasso Subtract"),
      { x: 140, y: 150 },
      "tool.art.rect"
    );
    const secondInserted = insertNativeArtGraphicObject(firstInserted, { x: 280, y: 150 }, "tool.art.rect");
    const graphics = secondInserted.pages[0].objects.filter((object): object is GraphicObject =>
      object.type === "graphic"
    );
    const selectedDocument = selectDocumentObjects(
      secondInserted,
      secondInserted.pages[0].id,
      graphics.map((object) => object.id)
    );
    const target = graphics[0];

    await renderMainWindow(selectedDocument);

    expect(container.querySelector('[data-group-selection="true"]')).not.toBeNull();

    const targetElement = container.querySelector<HTMLElement>(`[data-object-id="${target.id}"]`);
    if (!targetElement) {
      throw new Error("Expected target graphic element.");
    }
    const page = pageElement();
    const points = [
      { x: target.x + 2, y: target.y + target.height / 2 },
      { x: target.x - 8, y: target.y - 8 },
      { x: target.x + target.width + 8, y: target.y - 8 },
      { x: target.x + target.width + 8, y: target.y + target.height + 8 },
      { x: target.x - 8, y: target.y + target.height + 8 }
    ];

    await act(async () => {
      dispatchPointer(targetElement, "pointerdown", points[0], { altKey: true });
      for (const point of points.slice(1)) {
        dispatchPointer(page, "pointermove", point, { altKey: true });
      }
      dispatchPointer(page, "pointerup", points[0], { altKey: true });
    });

    expect(container.querySelector('[data-group-selection="true"]')).toBeNull();
    expect(graphicInteractionMode(target.id)).toBeUndefined();
    expect(graphicInteractionMode(graphics[1].id)).toBeDefined();
  });
});
