// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MainWindow } from "./MainWindow";
import {
  CHEMDRAFT_SELECTION_CLIPBOARD_TYPE,
  createPhase4Document,
  insertNativeArtGraphicObject,
  insertNativeTemplateMolecule
} from "./documentWorkflow";
import type { MoleculeObject } from "@chemdraft/chem-core";

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

describe("canvas clipboard menu and copy guard", () => {
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

  async function renderMainWindow(initialDocument = createPhase4Document("Clipboard Menu")) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.select",
        initialCrosshairsVisible: false,
        initialDocument,
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });
    pageElement().getBoundingClientRect = () => pageRect;
    const canvasRegion = container.querySelector<HTMLElement>(".canvas-region");
    if (canvasRegion) {
      canvasRegion.getBoundingClientRect = () => pageRect;
    }
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

  async function rightClick(target: EventTarget, point: { x: number; y: number }) {
    await act(async () => {
      target.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        button: 2,
        cancelable: true,
        clientX: point.x,
        clientY: point.y
      }));
    });
  }

  /** Read a rendered object's page-space geometry out of its inline style. */
  function stylePx(
    element: HTMLElement,
    property: "left" | "top" | "width" | "height",
    pageSize: { width: number; height: number }
  ): number {
    const style = element.getAttribute("style") ?? "";
    const calcMatch = style.match(new RegExp(`${property}:\\s*calc\\(([-\\d.]+)px \\* var\\(--page-scale\\)\\)`));
    if (calcMatch) {
      return Number(calcMatch[1]);
    }
    const percentMatch = style.match(new RegExp(`${property}:\\s*([-\\d.]+)%`));
    if (percentMatch) {
      // Percentages are a share of the PAGE (in page units), not of the rendered rectangle.
      const basis = property === "left" || property === "width" ? pageSize.width : pageSize.height;
      return (Number(percentMatch[1]) / 100) * basis;
    }
    throw new Error(`Expected a ${property} in ${style}`);
  }

  function menuCommandIds(menu: Element | null): string[] {
    return [...(menu?.querySelectorAll<HTMLElement>("[data-command-id]") ?? [])]
      .map((item) => item.dataset.commandId ?? "");
  }

  it("offers Paste when the canvas is right-clicked with nothing under the pointer", async () => {
    // Right-clicking bare page used to open no menu at all, which left the mouse with no way to
    // paste: the only Paste in the app was in the object menu (needs an object) and the Edit menu.
    await renderMainWindow();
    await rightClick(pageElement(), { x: 320, y: 260 });

    const menu = container.querySelector('[data-context-target-kind="page"]');
    expect(menu).not.toBeNull();
    expect(menuCommandIds(menu)).toContain("clipboard.paste");
    expect(menu?.getAttribute("role")).toBe("menu");
  });

  it("closes the page menu on the next click", async () => {
    await renderMainWindow();
    await rightClick(pageElement(), { x: 320, y: 260 });
    expect(container.querySelector('[data-context-target-kind="page"]')).not.toBeNull();

    await act(async () => {
      const event = new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        cancelable: true,
        clientX: 320,
        clientY: 260
      });
      Object.defineProperties(event, {
        isPrimary: { value: true },
        pointerId: { value: 31 },
        pointerType: { value: "mouse" }
      });
      pageElement().dispatchEvent(event);
    });

    expect(container.querySelector('[data-context-target-kind="page"]')).toBeNull();
  });

  function dispatchPointer(
    target: EventTarget,
    type: "pointerdown" | "pointermove" | "pointerup",
    point: { x: number; y: number },
    pointerId = 41
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      detail: 1
    });
    Object.defineProperties(event, {
      isPrimary: { value: true },
      pointerId: { value: pointerId },
      pointerType: { value: "mouse" }
    });
    target.dispatchEvent(event);
  }

  /** Dispatch a copy the way the web view does, and hand back what landed on the clipboard. */
  async function dispatchCopy(): Promise<Map<string, string>> {
    const written = new Map<string, string>();
    const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, "clipboardData", {
      value: { setData: (type: string, text: string) => written.set(type, text) }
    });
    await act(async () => {
      window.dispatchEvent(copyEvent);
    });
    return written;
  }

  it("copies only the fragment a marquee selected, not the whole molecule", async () => {
    // The marquee/lasso path selects atoms and bonds with NO object ids (selectionPolicy keeps the
    // host molecule out), which Copy read as "nothing is selected".
    const withRing = insertNativeTemplateMolecule(
      createPhase4Document("Fragment Copy"),
      { x: 300, y: 300 },
      "cyclohexane"
    );
    await renderMainWindow(withRing);

    // Drag a marquee over the ring's two left-hand atoms only.
    await act(async () => {
      dispatchPointer(pageElement(), "pointerdown", { x: 265, y: 270 });
      dispatchPointer(pageElement(), "pointermove", { x: 280, y: 300 });
      dispatchPointer(pageElement(), "pointermove", { x: 295, y: 330 });
      dispatchPointer(pageElement(), "pointerup", { x: 295, y: 330 });
    });

    const written = await dispatchCopy();
    const payloadText = written.get(CHEMDRAFT_SELECTION_CLIPBOARD_TYPE);
    if (!payloadText) {
      throw new Error(`Expected the ChemDraft flavor on the clipboard; got ${[...written.keys()].join(", ")}`);
    }
    const copied = (JSON.parse(payloadText) as { objects: MoleculeObject[] }).objects[0];
    if (copied?.type !== "molecule") {
      throw new Error("Expected a molecule on the clipboard.");
    }
    // Part of the ring, not all of it — and a self-consistent graph: every copied bond has both
    // of its atoms in the copy.
    expect(copied.atoms.length).toBeGreaterThan(0);
    expect(copied.atoms.length).toBeLessThan(6);
    const copiedAtomIds = new Set(copied.atoms.map((atom) => atom.id));
    expect(copied.bonds.every((bond) =>
      copiedAtomIds.has(bond.fromAtomId) && copiedAtomIds.has(bond.toAtomId)
    )).toBe(true);
  });

  it("keeps the marquee fragment when it is right-clicked, so menu Copy copies the fragment", async () => {
    // Right-click used to promote the whole molecule into the document selection, so Copy from the
    // context menu handed over the entire structure even though only a piece was highlighted.
    const withRing = insertNativeTemplateMolecule(
      createPhase4Document("Fragment Menu Copy"),
      { x: 300, y: 300 },
      "cyclohexane"
    );
    await renderMainWindow(withRing);

    await act(async () => {
      dispatchPointer(pageElement(), "pointerdown", { x: 265, y: 270 });
      dispatchPointer(pageElement(), "pointermove", { x: 280, y: 300 });
      dispatchPointer(pageElement(), "pointermove", { x: 295, y: 330 });
      dispatchPointer(pageElement(), "pointerup", { x: 295, y: 330 });
    });

    const beforeMenu = await dispatchCopy();
    const fragmentAtomCount = (payloadText: string | undefined): number => {
      if (!payloadText) {
        throw new Error("Expected the ChemDraft flavor on the clipboard.");
      }
      const copied = (JSON.parse(payloadText) as { objects: MoleculeObject[] }).objects[0];
      return copied?.type === "molecule" ? copied.atoms.length : Number.NaN;
    };
    const marqueeAtomCount = fragmentAtomCount(beforeMenu.get(CHEMDRAFT_SELECTION_CLIPBOARD_TYPE));

    const moleculeElement = container.querySelector<HTMLElement>('[data-object-id]');
    if (!moleculeElement) {
      throw new Error("Expected the molecule element.");
    }
    await rightClick(moleculeElement, { x: 281, y: 311 });
    // The right-click really landed on the molecule (otherwise this test would prove nothing).
    expect(container.querySelector("[data-context-object-id]")).not.toBeNull();

    expect(fragmentAtomCount(
      (await dispatchCopy()).get(CHEMDRAFT_SELECTION_CLIPBOARD_TYPE)
    )).toBe(marqueeAtomCount);
  });

  it("pastes where the pointer is, not in the middle of the view", async () => {
    const withRect = insertNativeArtGraphicObject(
      createPhase4Document("Pointer Paste"),
      { x: 120, y: 140 },
      "tool.art.rect"
    );
    await renderMainWindow(withRect);

    const copied = await dispatchCopy();
    const payloadText = copied.get(CHEMDRAFT_SELECTION_CLIPBOARD_TYPE);
    if (!payloadText) {
      throw new Error("Expected the copied selection on the clipboard.");
    }

    const pointer = { x: 470, y: 330 };
    await act(async () => {
      const move = new MouseEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX: pointer.x,
        clientY: pointer.y
      });
      window.dispatchEvent(move);
    });

    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        types: [CHEMDRAFT_SELECTION_CLIPBOARD_TYPE],
        getData: (type: string) => (type === CHEMDRAFT_SELECTION_CLIPBOARD_TYPE ? payloadText : "")
      }
    });
    await act(async () => {
      window.dispatchEvent(pasteEvent);
    });

    const graphics = [...container.querySelectorAll<HTMLElement>(".graphic-object")];
    expect(graphics).toHaveLength(2);
    const pasted = graphics.find((element) => element.dataset.objectId !== withRect.selection.objectIds[0]);
    if (!pasted) {
      throw new Error("Expected a second art object after the paste.");
    }
    // The page is rendered at 1:1 from (0, 0) here, so a client point IS a page point.
    const pageSize = withRect.pages[0];
    const centre = {
      x: stylePx(pasted, "left", pageSize) + stylePx(pasted, "width", pageSize) / 2,
      y: stylePx(pasted, "top", pageSize) + stylePx(pasted, "height", pageSize) / 2
    };
    expect(centre.x).toBeCloseTo(pointer.x, 0);
    expect(centre.y).toBeCloseTo(pointer.y, 0);
  });

  it("swallows a copy with nothing selected instead of letting the web view copy its own markup", async () => {
    // An unhandled copy reaches WebKit, which puts the app's page markup on the pasteboard; the
    // next paste read that back as text and dropped a "<!DOCTYPE html>" text box on the drawing.
    await renderMainWindow(createPhase4Document("Copy Guard"));

    const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(copyEvent);
    });

    expect(copyEvent.defaultPrevented).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Select objects before copying");
  });
});
