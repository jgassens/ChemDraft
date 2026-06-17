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

  async function renderMainWindow(
    initialDocument = createPhase4Document("Lasso"),
    initialActiveToolCommandId = "tool.lasso"
  ) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId,
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

  function activeToolCommandId(): string | undefined {
    return container.querySelector<HTMLElement>(".app-shell")?.dataset.activeTool;
  }

  function graphicElement(objectId: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(`[data-object-id="${objectId}"].graphic-object`);
    if (!element) {
      throw new Error(`Expected graphic element for ${objectId}.`);
    }
    return element;
  }

  function graphicInteractionMode(objectId: string): string | undefined {
    return graphicElement(objectId).dataset.graphicInteractionMode;
  }

  function graphicLeftPx(objectId: string): number {
    const style = graphicElement(objectId).getAttribute("style") ?? "";
    const percentMatch = style.match(/left:\s*([-\d.]+)%/);
    if (percentMatch) {
      return (Number(percentMatch[1]) / 100) * pageRect.width;
    }
    const match = style.match(/left:\s*calc\(([-\d.]+)px \* var\(--page-scale\)\)/);
    if (!match) {
      throw new Error(`Expected page-scaled left style for ${objectId}: ${style}`);
    }
    return Number(match[1]);
  }

  function graphicTopPx(objectId: string): number {
    const style = graphicElement(objectId).getAttribute("style") ?? "";
    const percentMatch = style.match(/top:\s*([-\d.]+)%/);
    if (percentMatch) {
      return (Number(percentMatch[1]) / 100) * pageRect.height;
    }
    const match = style.match(/top:\s*calc\(([-\d.]+)px \* var\(--page-scale\)\)/);
    if (!match) {
      throw new Error(`Expected page-scaled top style for ${objectId}: ${style}`);
    }
    return Number(match[1]);
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
    expect(activeToolCommandId()).toBe("tool.lasso");

    const targetElement = graphicElement(target.id);
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
      dispatchPointer(page, "pointerup", points[0], { altKey: false });
    });

    expect(activeToolCommandId()).toBe("tool.select");
    expect(container.querySelector('[data-group-selection="true"]')).toBeNull();
    expect(graphicInteractionMode(target.id)).toBeUndefined();
    expect(graphicInteractionMode(graphics[1].id)).toBeDefined();
  });

  it("moves a selected graphic group instead of collapsing to the clicked object", async () => {
    const firstInserted = insertNativeArtGraphicObject(
      createPhase4Document("Lasso Group Move"),
      { x: 140, y: 150 },
      "tool.art.circle"
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

    await renderMainWindow(selectedDocument, "tool.select");

    const before = new Map(graphics.map((graphic) => [
      graphic.id,
      { left: graphicLeftPx(graphic.id), top: graphicTopPx(graphic.id) }
    ]));
    const page = pageElement();
    const targetElement = graphicElement(target.id);
    const start = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    const end = { x: start.x + 24, y: start.y + 18 };

    await act(async () => {
      dispatchPointer(targetElement, "pointerdown", start, { pointerId: 7 });
      dispatchPointer(page, "pointermove", end, { pointerId: 7 });
      dispatchPointer(page, "pointerup", end, { pointerId: 7 });
    });

    expect(container.querySelector('[data-group-selection="true"]')).not.toBeNull();
    const targetInitial = before.get(target.id);
    expect(targetInitial).toBeDefined();
    const groupDx = graphicLeftPx(target.id) - targetInitial!.left;
    const groupDy = graphicTopPx(target.id) - targetInitial!.top;
    expect(Math.abs(groupDx)).toBeGreaterThan(1);
    expect(Math.abs(groupDy)).toBeGreaterThan(1);
    for (const graphic of graphics) {
      const initial = before.get(graphic.id);
      expect(initial).toBeDefined();
      expect(graphicLeftPx(graphic.id) - initial!.left).toBeCloseTo(groupDx, 5);
      expect(graphicTopPx(graphic.id) - initial!.top).toBeCloseTo(groupDy, 5);
    }
  });
});
