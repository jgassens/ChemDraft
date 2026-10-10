// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { applyNativeChainTool, createPhase4Document } from "./documentWorkflow";

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

// An eraser marquee used to delete every molecule it touched, whole: three bonds of a long chain
// took the other atoms with them. These drive the real pointer handlers on the page.
describe("eraser marquee over a molecule", () => {
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

  function chainDocument() {
    const document = applyNativeChainTool(createPhase4Document("Eraser Chain DOM"), { x: 120, y: 300 }, { x: 600, y: 300 });
    const chain = document.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule");
    if (!chain || chain.bonds.length < 20) {
      throw new Error("Expected a long native chain fixture.");
    }
    return { document, chain };
  }

  async function renderWithEraser(initialDocument: ReturnType<typeof chainDocument>["document"]) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.eraser",
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

  function bridge() {
    const agent = window.__CHEMDRAFT_AGENT__;
    if (!agent) {
      throw new Error("Expected agent bridge.");
    }
    return agent;
  }

  function moleculeSummary(objectId: string) {
    return bridge().snapshot().objects.find((object) => object.id === objectId);
  }

  // The status line is the main window's polite live region (MainWindow's role="status" element).
  function statusText(): string {
    const regions = Array.from(container.querySelectorAll('[role="status"][aria-live="polite"]'));
    return regions.map((region) => region.textContent ?? "").find((text) => text.trim().length > 0) ?? "";
  }

  function dispatchPointer(type: "pointerdown" | "pointermove" | "pointerup", point: { x: number; y: number }, pointerId: number) {
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

  async function eraserDrag(from: { x: number; y: number }, to: { x: number; y: number }, pointerId: number) {
    await act(async () => {
      dispatchPointer("pointerdown", from, pointerId);
      dispatchPointer("pointermove", { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, pointerId);
      dispatchPointer("pointermove", to, pointerId);
    });
    await act(async () => {
      dispatchPointer("pointerup", to, pointerId);
    });
  }

  it("erases only the bond a vertical sweep crosses, and undo/redo restore and repeat it", async () => {
    const { document, chain } = chainDocument();
    await renderWithEraser(document);
    expect(moleculeSummary(chain.id)).toMatchObject({ atomCount: chain.atoms.length, bondCount: chain.bonds.length });

    // A thin vertical sweep through the middle of one bond, starting and ending on blank page.
    const bond = chain.bonds[Math.floor(chain.bonds.length / 2)]!;
    const from = chain.atoms.find((atom) => atom.id === bond.fromAtomId)!;
    const to = chain.atoms.find((atom) => atom.id === bond.toAtomId)!;
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    await eraserDrag({ x: midX - 1, y: midY - 40 }, { x: midX + 1, y: midY + 40 }, 71);

    expect(moleculeSummary(chain.id)).toMatchObject({ atomCount: chain.atoms.length, bondCount: chain.bonds.length - 1 });
    expect(statusText()).toBe("Erased 1 bond");

    await act(async () => {
      await bridge().command("edit.undo");
    });
    expect(moleculeSummary(chain.id)).toMatchObject({ atomCount: chain.atoms.length, bondCount: chain.bonds.length });

    await act(async () => {
      await bridge().command("edit.redo");
    });
    expect(moleculeSummary(chain.id)).toMatchObject({ atomCount: chain.atoms.length, bondCount: chain.bonds.length - 1 });
  });

  it("a sweep across the whole chain still removes it, as one undo step", async () => {
    const { document, chain } = chainDocument();
    await renderWithEraser(document);
    const xs = chain.atoms.map((atom) => atom.x);
    const ys = chain.atoms.map((atom) => atom.y);

    await eraserDrag(
      { x: Math.min(...xs) - 10, y: Math.min(...ys) - 30 },
      { x: Math.max(...xs) + 10, y: Math.max(...ys) + 30 },
      72
    );
    expect(moleculeSummary(chain.id)).toBeUndefined();
    expect(statusText()).toBe(`Erased ${chain.atoms.length} atoms, ${chain.bonds.length} bonds`);

    await act(async () => {
      await bridge().command("edit.undo");
    });
    expect(moleculeSummary(chain.id)).toMatchObject({ atomCount: chain.atoms.length, bondCount: chain.bonds.length });
  });
});
