// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import {
  createPhase4Document,
  insertNativeSingleBondMolecule,
  insertNativeTemplateMolecule,
  nativeMoleculeCenter,
  nativeMoleculeTransformState
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

describe("freehand art and rotation interactions", () => {
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
    options: {
      initialPaletteMode?: "floating" | "hidden";
      nativePalette?: boolean;
      initialDocument?: ChemDraftDocument;
    } = {}
  ) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: commandId,
        initialCrosshairsVisible: false,
        initialDocument: options.initialDocument ?? createPhase4Document("Freehand Drag"),
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
    pressure: number,
    shiftKey = false
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      shiftKey
    });
    Object.defineProperties(event, {
      isPrimary: { value: true },
      pointerId: { value: pointerId },
      pointerType: { value: "pen" },
      pressure: { value: pressure }
    });
    target.dispatchEvent(event);
  }

  async function holdShiftForRotationHandles() {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Shift",
        shiftKey: true
      }));
    });
  }

  async function releaseShiftForRotationHandles() {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keyup", {
        bubbles: true,
        key: "Shift",
        shiftKey: false
      }));
    });
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

  it("erases a freehand object from its painted path", async () => {
    await renderMainWindow("tool.art.pencil", { initialPaletteMode: "floating", nativePalette: false });
    const objectId = await drawPencilStroke(55);
    expect(snapshotObjectCount()).toBe(1);

    const eraserButton = container.querySelector<HTMLButtonElement>('[data-command-id="tool.eraser"]');
    if (!eraserButton) {
      throw new Error("Expected visible eraser tool button.");
    }
    await act(async () => {
      eraserButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-active-tool="tool.eraser"]')).not.toBeNull();

    const paintedPath = container.querySelector<SVGPathElement>(`[data-object-id="${objectId}"] .graphic-glyph-path`);
    if (!paintedPath) {
      throw new Error("Expected painted freehand path.");
    }
    await act(async () => {
      dispatchPointer(paintedPath, "pointerdown", { x: 214, y: 196 }, 56, 0.5);
    });

    expect(snapshotObjectCount()).toBe(0);
    expect(container.querySelector(`[data-object-id="${objectId}"]`)).toBeNull();
  });

  it("erases every freehand object touched by a dragged eraser marquee", async () => {
    await renderMainWindow("tool.art.pencil", { initialPaletteMode: "floating", nativePalette: false });
    const firstObjectId = await drawPencilStroke(57);

    const pencilButton = container.querySelector<HTMLButtonElement>('[data-command-id="tool.art.pencil"]');
    if (!pencilButton) {
      throw new Error("Expected visible pencil tool button.");
    }
    await act(async () => {
      pencilButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const secondObjectId = await drawPencilStroke(58, [
      { x: 320, y: 184, pressure: 0.3 },
      { x: 356, y: 202, pressure: 0.8 },
      { x: 392, y: 184, pressure: 0.45 }
    ]);
    expect(snapshotObjectCount()).toBe(2);

    const eraserButton = container.querySelector<HTMLButtonElement>('[data-command-id="tool.eraser"]');
    if (!eraserButton) {
      throw new Error("Expected visible eraser tool button.");
    }
    await act(async () => {
      eraserButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      dispatchPointer(pageElement(), "pointerdown", { x: 150, y: 168 }, 59, 0.5);
      dispatchPointer(pageElement(), "pointermove", { x: 408, y: 214 }, 59, 0.5);
    });
    expect(container.querySelector(".selection-marquee")).not.toBeNull();

    await act(async () => {
      dispatchPointer(pageElement(), "pointerup", { x: 408, y: 214 }, 59, 0.5);
    });

    expect(snapshotObjectCount()).toBe(0);
    expect(container.querySelector(`[data-object-id="${firstObjectId}"]`)).toBeNull();
    expect(container.querySelector(`[data-object-id="${secondObjectId}"]`)).toBeNull();
    expect(container.querySelector(".selection-marquee")).toBeNull();
  });

  it("previews freehand object moves with CSS and commits geometry on pointer up", async () => {
    await renderMainWindow("tool.art.pencil");
    const objectId = await drawPencilStroke(61);
    const graphic = container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`);
    if (!graphic) {
      throw new Error("Expected inserted freehand graphic.");
    }

    const before = debugArtObject(objectId).object;
    expect(container.querySelector(".object-rotate-handle")).toBeNull();
    expect(container.querySelector("[data-selection-tilt3d-handle='true']")).toBeNull();
    await holdShiftForRotationHandles();
    expect(container.querySelector(".object-rotate-handle")).not.toBeNull();
    expect(container.querySelector("[data-selection-tilt3d-handle='true']")).toBeNull();
    await releaseShiftForRotationHandles();
    expect(container.querySelector(".object-rotate-handle")).toBeNull();
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

  it("resizes freehand objects with live geometry instead of scaled preview chrome", async () => {
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

    const during = debugArtObject(objectId).object;
    const duringGraphic = container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`);
    expect(during.width).toBeGreaterThan(before.width);
    expect(during.height).toBeGreaterThan(before.height);
    expect(duringGraphic?.getAttribute("data-art-transform-preview")).toBeNull();
    expect(duringGraphic?.querySelector("[data-art-transform-drag-preview='image']")).toBeNull();
    expect(duringGraphic?.querySelector(".graphic-glyph-shell")?.getAttribute("data-art-vector-hidden")).toBeNull();
    expect(duringGraphic?.querySelector(".graphic-glyph")).not.toBeNull();
    expect(duringGraphic?.style.transform).not.toContain("scale");

    await act(async () => {
      dispatchPointer(pageElement(), "pointerup", dragEnd, 72, 0.5);
    });

    const after = debugArtObject(objectId).object;
    expect(after.width).toBeCloseTo(during.width, 3);
    expect(after.height).toBeCloseTo(during.height, 3);
    expect(graphic.getAttribute("data-art-transform-preview")).toBeNull();
  });

  it.each(["bond", "ring"] as const)("snaps a whole %s rigidly without changing chemistry", async (kind) => {
    const seed = createPhase4Document("Molecule Rotation Snap");
    const initialDocument = kind === "bond"
      ? insertNativeSingleBondMolecule(seed, { x: 200, y: 220 })
      : insertNativeTemplateMolecule(seed, { x: 300, y: 300 }, "cyclohexane");
    const original = initialDocument.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    if (!original) throw new Error("Expected molecule.");
    await renderMainWindow("tool.select", { initialDocument });
    await holdShiftForRotationHandles();
    const handle = container.querySelector<HTMLButtonElement>(".object-rotate-handle");
    if (!handle) throw new Error("Expected molecule rotate handle.");
    const center = nativeMoleculeCenter(original);
    const start = { x: center.x + 100, y: center.y };
    const at = (degrees: number) => ({ x: start.x, y: start.y + degrees });
    const molecule = () => {
      const object = window.__CHEMDRAFT_AGENT__?.snapshot().document.pages[0].objects.find((object) => object.id === original.id);
      if (object?.type !== "molecule") throw new Error("Expected molecule snapshot.");
      return object;
    };
    // Establish a freely drawn 7° orientation before testing a second drag's absolute grid.
    const freeStart = { ...start, x: start.x + 30 };
    const freeEnd = { ...freeStart, y: freeStart.y + 7 };
    await act(async () => {
      dispatchPointer(handle, "pointerdown", freeStart, 89, 0.5);
      dispatchPointer(pageElement(), "pointermove", freeEnd, 89, 0.5);
      dispatchPointer(pageElement(), "pointerup", freeEnd, 89, 0.5);
    });
    const before = molecule();
    expect(nativeMoleculeTransformState(before).rotationDegrees).toBe(7);
    await act(async () => {
      dispatchPointer(handle, "pointerdown", start, 90, 0.5);
      dispatchPointer(pageElement(), "pointermove", at(6.9), 90, 0.5);
    });
    expect(nativeMoleculeTransformState(molecule()).rotationDegrees).toBe(15);
    await act(async () => dispatchPointer(pageElement(), "pointermove", at(19), 90, 0.5));
    expect(nativeMoleculeTransformState(molecule()).rotationDegrees).toBe(26);
    await act(async () => dispatchPointer(pageElement(), "pointermove", at(19), 90, 0.5, true));
    const preview = molecule();
    expect(nativeMoleculeTransformState(preview).rotationDegrees).toBe(30);
    await act(async () => dispatchPointer(pageElement(), "pointerup", at(24), 90, 0.5));
    const after = molecule();
    expect(after).toEqual(preview);
    expect(after.bonds).toEqual(before.bonds);
    expect(after.structure).toBe(before.structure);
    expect(after.chemistry).toEqual(before.chemistry);
    const identity = ({ x: _x, y: _y, ...atom }: MoleculeObject["atoms"][number]) => atom;
    expect(after.atoms.map(identity)).toEqual(before.atoms.map(identity));
    for (let i = 0; i < before.atoms.length; i++) {
      for (let j = 0; j < i; j++) {
        expect(Math.hypot(after.atoms[i].x - after.atoms[j].x, after.atoms[i].y - after.atoms[j].y))
          .toBeCloseTo(Math.hypot(before.atoms[i].x - before.atoms[j].x, before.atoms[i].y - before.atoms[j].y), 3);
      }
    }
    await act(async () => { await window.__CHEMDRAFT_AGENT__?.command("edit.undo"); });
    expect(molecule()).toEqual(before);
    await act(async () => { await window.__CHEMDRAFT_AGENT__?.command("edit.undo"); });
    expect(molecule()).toEqual(original);
  });

  it("snaps a whole-object drag and reads Shift changes on every move, committing one undo entry", async () => {
    await renderMainWindow("tool.art.pencil");
    const objectId = await drawPencilStroke(91);
    await holdShiftForRotationHandles();
    const rotateHandle = container.querySelector<HTMLButtonElement>(".object-rotate-handle");
    const graphic = container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`);
    if (!rotateHandle || !graphic) throw new Error("Expected rotation handle and graphic.");

    const original = debugArtObject(objectId).object;
    const start = { x: original.x + original.width + 20, y: original.y + original.height / 2 };
    // The handle measures tangential travel at one degree per page pixel.
    const point = (degrees: number) => ({ x: start.x, y: start.y + degrees });
    const previewRotation = () => graphic.querySelector<HTMLElement>(".graphic-visual-shell")?.style.transform;

    const freeStart = { ...start, x: start.x + 30 };
    const freeEnd = { ...freeStart, y: freeStart.y + 7 };
    await act(async () => {
      dispatchPointer(rotateHandle, "pointerdown", freeStart, 88, 0.5);
      dispatchPointer(pageElement(), "pointermove", freeEnd, 88, 0.5);
    });
    await waitForPreviewFrame();
    await act(async () => dispatchPointer(pageElement(), "pointerup", freeEnd, 88, 0.5));
    const before = debugArtObject(objectId).object;
    expect(before.rotation).toBe(7);
    await act(async () => {
      dispatchPointer(rotateHandle, "pointerdown", start, 92, 0.5);
      dispatchPointer(pageElement(), "pointermove", point(6.9), 92, 0.5);
    });
    await waitForPreviewFrame();
    expect(previewRotation()).toContain("rotate(15deg)");

    // Exercise the object move handler as well as the page's captured-pointer handler.
    await act(async () => dispatchPointer(graphic, "pointermove", point(19), 92, 0.5));
    await waitForPreviewFrame();
    expect(previewRotation()).toContain("rotate(26deg)");
    await act(async () => dispatchPointer(graphic, "pointermove", point(19), 92, 0.5, true));
    await waitForPreviewFrame();
    expect(previewRotation()).toContain("rotate(30deg)");
    await act(async () => dispatchPointer(pageElement(), "pointermove", point(19), 92, 0.5));
    await waitForPreviewFrame();
    expect(previewRotation()).toContain("rotate(26deg)");
    await act(async () => dispatchPointer(pageElement(), "pointermove", point(19), 92, 0.5, true));
    await waitForPreviewFrame();
    expect(previewRotation()).toContain("rotate(30deg)");

    // A changed release point/modifier must not jump away from the last visible preview.
    await act(async () => dispatchPointer(pageElement(), "pointerup", point(24), 92, 0.5));
    expect(debugArtObject(objectId).object.rotation).toBe(30);
    expect(graphic.getAttribute("data-art-transform-preview")).toBeNull();
    await act(async () => { await window.__CHEMDRAFT_AGENT__?.command("edit.undo"); });
    expect(debugArtObject(objectId).object.rotation).toBe(before.rotation);
    await act(async () => { await window.__CHEMDRAFT_AGENT__?.command("edit.undo"); });
    expect(debugArtObject(objectId).object.rotation).toBe(original.rotation);
    await act(async () => { await window.__CHEMDRAFT_AGENT__?.command("edit.undo"); });
    expect(snapshotObjectCount()).toBe(0);
  });

  it.each([[-7, 90], [4, 105]])("Shift snaps an art object at 100° with delta %s° to %s°", async (delta, expected) => {
    await renderMainWindow("tool.art.pencil");
    const objectId = await drawPencilStroke(93);
    await holdShiftForRotationHandles();
    const handle = container.querySelector<HTMLButtonElement>(".object-rotate-handle");
    const graphic = container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`);
    if (!handle || !graphic) throw new Error("Expected rotation handle and graphic.");
    const original = debugArtObject(objectId).object;
    const start = { x: original.x + original.width + 20, y: original.y + original.height / 2 };
    const at = (degrees: number) => ({ x: start.x, y: start.y + degrees });
    const freeStart = { ...start, x: start.x + 30 };
    const freeEnd = { ...freeStart, y: freeStart.y + 100 };
    await act(async () => {
      dispatchPointer(handle, "pointerdown", freeStart, 94, 0.5);
      dispatchPointer(pageElement(), "pointermove", freeEnd, 94, 0.5);
    });
    await waitForPreviewFrame();
    await act(async () => dispatchPointer(pageElement(), "pointerup", freeEnd, 94, 0.5));
    expect(debugArtObject(objectId).object.rotation).toBe(100);
    await act(async () => {
      dispatchPointer(handle, "pointerdown", start, 95, 0.5, true);
      dispatchPointer(pageElement(), "pointermove", at(delta), 95, 0.5, true);
    });
    await waitForPreviewFrame();
    expect(graphic.querySelector<HTMLElement>(".graphic-visual-shell")?.style.transform).toContain(`rotate(${expected}deg)`);
    await act(async () => dispatchPointer(pageElement(), "pointerup", at(delta + 10), 95, 0.5));
    expect(debugArtObject(objectId).object.rotation).toBe(expected);
    await act(async () => { await window.__CHEMDRAFT_AGENT__?.command("edit.undo"); });
    expect(debugArtObject(objectId).object.rotation).toBe(100);
  });

  it.each([false, true])("snaps a multi-object rotation (grouped: %s) and commits its live preview", async (grouped) => {
    await renderMainWindow("tool.art.pencil");
    const first = await drawPencilStroke(101);
    await act(async () => { await window.__CHEMDRAFT_AGENT__?.command("tool.art.pencil"); });
    const second = await drawPencilStroke(102, [
      { x: 380, y: 180, pressure: 0.2 },
      { x: 414, y: 196, pressure: 0.9 },
      { x: 452, y: 178, pressure: 0.45 }
    ]);
    await act(async () => {
      await window.__CHEMDRAFT_AGENT__?.command("edit.selectAll");
      if (grouped) await window.__CHEMDRAFT_AGENT__?.command("layout.group");
    });
    const frame = container.querySelector<HTMLElement>(".group-selection-frame");
    const handle = container.querySelector<HTMLButtonElement>("[data-group-rotate-handle='true']");
    if (!frame || !handle) throw new Error("Expected group rotation frame.");
    const coordinate = (value: string) => Number(value.match(/calc\(([-\d.]+)px/)?.[1]);
    const start = {
      x: coordinate(frame.style.left) + coordinate(frame.style.width) + 20,
      y: coordinate(frame.style.top) + coordinate(frame.style.height) / 2
    };
    const at = (degrees: number) => ({ x: start.x, y: start.y + degrees });
    const originals = [debugArtObject(first).object, debugArtObject(second).object];
    await act(async () => {
      dispatchPointer(handle, "pointerdown", start, 103, 0.5);
      dispatchPointer(pageElement(), "pointermove", at(14.9), 103, 0.5);
    });
    expect(debugArtObject(first).object.rotation).toBe(15);
    expect(debugArtObject(second).object.rotation).toBe(15);
    await act(async () => dispatchPointer(pageElement(), "pointermove", at(22), 103, 0.5));
    expect(debugArtObject(first).object.rotation).toBe(22);
    await act(async () => dispatchPointer(pageElement(), "pointermove", at(22), 103, 0.5, true));
    const preview = [debugArtObject(first).object, debugArtObject(second).object];
    expect(preview.map((object) => object.rotation)).toEqual([15, 15]);
    await act(async () => dispatchPointer(pageElement(), "pointerup", at(24), 103, 0.5));
    expect([debugArtObject(first).object, debugArtObject(second).object]).toEqual(preview);
    await act(async () => { await window.__CHEMDRAFT_AGENT__?.command("edit.undo"); });
    expect([debugArtObject(first).object, debugArtObject(second).object]).toEqual(originals);
  });

  it("previews freehand object rotation without mutating rotation until pointer up", async () => {
    await renderMainWindow("tool.art.pencil");
    const objectId = await drawPencilStroke(81);
    const graphic = container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`);
    expect(container.querySelector<HTMLButtonElement>(".object-rotate-handle")).toBeNull();
    await holdShiftForRotationHandles();
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
    expect(graphic.style.transform).not.toContain("rotate");
    expect(graphic.querySelector<HTMLElement>(".graphic-visual-shell")?.style.transform).toContain("rotate");

    await act(async () => {
      dispatchPointer(pageElement(), "pointerup", dragEnd, 82, 0.5);
    });

    const after = debugArtObject(objectId).object;
    expect(after.rotation).not.toBeCloseTo(before.rotation, 3);
    expect(graphic.getAttribute("data-art-transform-preview")).toBeNull();
  });

  it("updates modifier hints on rotation start, Shift down/up and blur while preserving result messages", async () => {
    await renderMainWindow("tool.art.pencil");
    const objectId = await drawPencilStroke(111);
    const hint = () => container.querySelector("[data-modifier-hint]")?.textContent ?? "";
    const message = () => container.querySelector("[data-status-message]")?.textContent;
    expect(hint()).toContain("show rotate handles");
    await holdShiftForRotationHandles();
    const handle = container.querySelector<HTMLButtonElement>(".object-rotate-handle");
    if (!handle) throw new Error("Expected rotate handle.");
    const object = debugArtObject(objectId).object;
    const start = { x: object.x + object.width + 20, y: object.y + object.height / 2 };
    await act(async () => dispatchPointer(handle, "pointerdown", start, 112, 0.5));
    expect(hint()).toContain("snap to 15° steps");
    const statusDuringDrag = message();
    expect(statusDuringDrag).toBe("Rotate selected art object");

    // No pointer movement is needed to reveal what a newly held modifier will do.
    await holdShiftForRotationHandles();
    expect(hint()).toContain("Snapping to 15°");
    expect(hint()).toContain("release");
    expect(message()).toBe(statusDuringDrag);
    await releaseShiftForRotationHandles();
    expect(hint()).toContain("snap to 15° steps");
    expect(message()).toBe(statusDuringDrag);

    await holdShiftForRotationHandles();
    await act(async () => window.dispatchEvent(new FocusEvent("blur")));
    expect(hint()).toContain("snap to 15° steps");
    expect(hint()).not.toContain("Snapping");
    expect(message()).toBe(statusDuringDrag);
    const end = { ...start, y: start.y + 22 };
    await act(async () => dispatchPointer(pageElement(), "pointermove", end, 112, 0.5));
    await waitForPreviewFrame();
    await act(async () => dispatchPointer(pageElement(), "pointerup", end, 112, 0.5));
    expect(message()).toBe("Rotated selected art object");
    expect(hint()).toContain("show rotate handles");
    expect(hint()).not.toContain("15°");
    await holdShiftForRotationHandles();
    expect(message()).toBe("Rotated selected art object");
    await act(async () => { await window.__CHEMDRAFT_AGENT__?.command("tool.bond"); });
    expect(hint()).not.toContain("rotate handles");
  });
});
