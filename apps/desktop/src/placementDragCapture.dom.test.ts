// @vitest-environment jsdom

import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MainWindow } from "./MainWindow";
import { applyNativeChainTool, applyNativeTemplateToolAtPoint, createPhase4Document } from "./documentWorkflow";

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

type CaptureMethods = Pick<Element, "setPointerCapture" | "releasePointerCapture" | "hasPointerCapture">;

// A press that starts on an object hands the pointer to whichever element the press handler
// captured it on, and a browser then delivers every move and the release to that element. These
// tests deliver them the same way: a placement drag that only listens on the page never sees its
// moves when the press began on a molecule (an atom to grow a chain from, a reagent to start an
// arrow on), which is how dragging a chain off an atom added one carbon and stopped.
describe("placement drags that start on an object follow pointer capture", () => {
  let container: HTMLDivElement;
  let root: Root;
  let captured: Element | undefined;
  let originalCapture: CaptureMethods;
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
    originalCapture = {
      setPointerCapture: Element.prototype.setPointerCapture,
      releasePointerCapture: Element.prototype.releasePointerCapture,
      hasPointerCapture: Element.prototype.hasPointerCapture
    };
    captured = undefined;
    Element.prototype.setPointerCapture = function setPointerCapture(this: Element) {
      captured = this;
    };
    Element.prototype.releasePointerCapture = function releasePointerCapture(this: Element) {
      if (captured === this) {
        captured = undefined;
      }
    };
    Element.prototype.hasPointerCapture = function hasPointerCapture(this: Element) {
      return captured === this;
    };
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
    Element.prototype.setPointerCapture = originalCapture.setPointerCapture;
    Element.prototype.releasePointerCapture = originalCapture.releasePointerCapture;
    Element.prototype.hasPointerCapture = originalCapture.hasPointerCapture;
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

  async function renderMainWindow(initialDocument: ChemDraftDocument, initialActiveToolCommandId: string) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialDocument,
        initialActiveToolCommandId,
        initialCrosshairsVisible: false,
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

  function objectElement(objectId: string): Element {
    const object = container.querySelector(`[data-object-id="${objectId}"]`);
    if (!object) {
      throw new Error(`Expected rendered object ${objectId}.`);
    }
    return object;
  }

  function dispatchPointer(
    target: EventTarget,
    type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
    point: { x: number; y: number },
    pointerId: number
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      button: 0,
      buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
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

  /** Press on `pressTarget`, then move and release where a browser would deliver them. */
  async function dragFrom(
    pressTarget: Element,
    from: { x: number; y: number },
    path: readonly { x: number; y: number }[],
    pointerId: number,
    duringDrag?: () => void
  ) {
    await act(async () => {
      dispatchPointer(pressTarget, "pointerdown", from, pointerId);
    });
    for (const point of path) {
      await act(async () => {
        dispatchPointer(captured ?? pageElement(), "pointermove", point, pointerId);
      });
    }
    duringDrag?.();
    await act(async () => {
      dispatchPointer(captured ?? pageElement(), "pointerup", path[path.length - 1] ?? from, pointerId);
    });
  }

  function bridge() {
    const agent = window.__CHEMDRAFT_AGENT__;
    if (!agent) {
      throw new Error("Expected agent bridge.");
    }
    return agent;
  }

  function moleculeNow(objectId: string): MoleculeObject {
    const molecule = bridge().snapshot().document.pages[0].objects.find((object) => object.id === objectId);
    if (!molecule || molecule.type !== "molecule") {
      throw new Error(`Expected molecule ${objectId}.`);
    }
    return molecule;
  }

  function seededMolecule(document: ChemDraftDocument): MoleculeObject {
    const molecule = document.pages[0].objects.find((object) => object.id === document.selection.objectIds[0]);
    if (!molecule || molecule.type !== "molecule") {
      throw new Error("Expected a seeded molecule.");
    }
    return molecule;
  }

  const straightPath = (from: { x: number; y: number }, dx: number, dy: number, steps: number) =>
    Array.from({ length: steps }, (_, index) => ({ x: from.x + (dx * (index + 1)) / steps, y: from.y + (dy * (index + 1)) / steps }));

  it("grows a chain dragged off a ring atom, one undo entry, SMILES derived", async () => {
    const seeded = applyNativeTemplateToolAtPoint(createPhase4Document("Ring Anchor"), { x: 200, y: 260 }, "benzene");
    const ring = seededMolecule(seeded);
    const anchor = ring.atoms.reduce((right, atom) => (atom.x > right.x ? atom : right));
    await renderMainWindow(seeded, "tool.chain");

    let midDragAtoms = 0;
    await dragFrom(objectElement(ring.id), anchor, straightPath(anchor, 160, 0, 8), 71, () => {
      midDragAtoms = moleculeNow(ring.id).atoms.length;
    });

    // The preview grew while the pointer moved, not just the one carbon placed on press.
    expect(midDragAtoms).toBeGreaterThan(ring.atoms.length + 2);
    const grown = moleculeNow(ring.id);
    expect(grown.atoms.length).toBe(midDragAtoms);
    expect(grown.bonds.length).toBe(ring.bonds.length + (grown.atoms.length - ring.atoms.length));
    expect(grown.structureFormat).toBe("smiles");
    expect(grown.structure).not.toBe(ring.structure);
    expect(grown.structure.length).toBeGreaterThan(0);
    // One gesture, one undo entry.
    await act(async () => {
      await bridge().command("edit.undo");
    });
    expect(moleculeNow(ring.id).atoms.length).toBe(ring.atoms.length);
  });

  it("grows a chain dragged off the end atom of a chain", async () => {
    const seeded = applyNativeChainTool(createPhase4Document("Chain End Anchor"), { x: 150, y: 300 }, { x: 230, y: 300 });
    const chain = seededMolecule(seeded);
    const end = chain.atoms[chain.atoms.length - 1];
    await renderMainWindow(seeded, "tool.chain");

    await dragFrom(objectElement(chain.id), end, straightPath(end, 140, 0, 7), 72);

    const grown = moleculeNow(chain.id);
    expect(grown.atoms.length).toBeGreaterThan(chain.atoms.length + 2);
    expect(grown.structure).toBe("C".repeat(grown.atoms.length));
  });

  it("grows a flexible chain dragged off a ring atom", async () => {
    const seeded = applyNativeTemplateToolAtPoint(createPhase4Document("Flexible Ring Anchor"), { x: 200, y: 260 }, "benzene");
    const ring = seededMolecule(seeded);
    const anchor = ring.atoms.reduce((right, atom) => (atom.x > right.x ? atom : right));
    await renderMainWindow(seeded, "tool.chainFlexible");

    await dragFrom(objectElement(ring.id), anchor, [
      ...straightPath(anchor, 120, 0, 6),
      ...straightPath({ x: anchor.x + 120, y: anchor.y }, 0, 100, 5)
    ], 73);

    expect(moleculeNow(ring.id).atoms.length).toBeGreaterThan(ring.atoms.length + 4);
  });

  it("restores the molecule when the captured drag is cancelled or escaped", async () => {
    const seeded = applyNativeTemplateToolAtPoint(createPhase4Document("Ring Anchor Cancel"), { x: 200, y: 260 }, "benzene");
    const ring = seededMolecule(seeded);
    const anchor = ring.atoms.reduce((right, atom) => (atom.x > right.x ? atom : right));
    await renderMainWindow(seeded, "tool.chain");

    // The system takes the pointer away mid-drag: the cancel reaches the object that holds capture.
    await act(async () => {
      dispatchPointer(objectElement(ring.id), "pointerdown", anchor, 75);
    });
    for (const point of straightPath(anchor, 120, 0, 6)) {
      await act(async () => {
        dispatchPointer(captured ?? pageElement(), "pointermove", point, 75);
      });
    }
    expect(moleculeNow(ring.id).atoms.length).toBeGreaterThan(ring.atoms.length + 2);
    await act(async () => {
      dispatchPointer(captured ?? pageElement(), "pointercancel", { x: anchor.x + 120, y: anchor.y }, 75);
    });
    expect(moleculeNow(ring.id).atoms.length).toBe(ring.atoms.length);

    // Escape abandons the drag; the release that follows commits nothing.
    await act(async () => {
      dispatchPointer(objectElement(ring.id), "pointerdown", anchor, 76);
    });
    for (const point of straightPath(anchor, 120, 0, 6)) {
      await act(async () => {
        dispatchPointer(captured ?? pageElement(), "pointermove", point, 76);
      });
    }
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });
    await act(async () => {
      dispatchPointer(captured ?? pageElement(), "pointerup", { x: anchor.x + 120, y: anchor.y }, 76);
    });
    expect(moleculeNow(ring.id).atoms.length).toBe(ring.atoms.length);
    expect(bridge().snapshot().document.pages[0].objects).toHaveLength(seeded.pages[0].objects.length);
  });

  it.each([
    ["an art reaction arrow", "tool.art.reactionArrow"],
    ["a reaction arrow", "tool.reactionArrow"]
  ])("stretches %s drawn starting on top of a molecule", async (_label, toolId) => {
    const seeded = applyNativeTemplateToolAtPoint(createPhase4Document("Arrow On Reagent"), { x: 200, y: 260 }, "benzene");
    const ring = seededMolecule(seeded);
    const center = { x: ring.atoms.reduce((sum, atom) => sum + atom.x, 0) / 6, y: ring.atoms.reduce((sum, atom) => sum + atom.y, 0) / 6 };
    const before = new Set(seeded.pages[0].objects.map((object) => object.id));
    await renderMainWindow(seeded, toolId);

    await dragFrom(objectElement(ring.id), center, straightPath(center, 300, 0, 6), 74);

    const drawn = bridge().snapshot().objects.filter((object) => !before.has(object.id));
    expect(drawn).toHaveLength(1);
    // The arrow follows the 300 px drag; a press that never saw its moves leaves a default arrow.
    expect(drawn[0]!.width).toBeGreaterThan(250);
  });
});
