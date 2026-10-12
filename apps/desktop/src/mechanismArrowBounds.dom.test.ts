// @vitest-environment jsdom

import { applyPatch, type ChemDraftDocument, type MechanismArrowObject, type MoleculeObject } from "@chemdraft/chem-core";
import { mechanismArrowGeometry } from "@chemdraft/layout-engine";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createMechanismArrowBetween, createPhase4Document, insertNativeSingleBondMolecule, rotateDocumentObject } from "./documentWorkflow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("anchored mechanism arrow interaction frame", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver;
  let originalRequestAnimationFrame: typeof requestAnimationFrame;
  let originalCancelAnimationFrame: typeof cancelAnimationFrame;
  const captureMethods = {
    set: Element.prototype.setPointerCapture, release: Element.prototype.releasePointerCapture,
    has: Element.prototype.hasPointerCapture
  };

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    globalThis.requestAnimationFrame = (callback) => window.setTimeout(() => callback(Date.now()), 0);
    globalThis.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
    // SVG handlers capture on their owning group, rather than the path clicked below.
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
    vi.spyOn(window, "confirm").mockReturnValue(false);
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    globalThis.ResizeObserver = originalResizeObserver;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    Element.prototype.setPointerCapture = captureMethods.set;
    Element.prototype.releasePointerCapture = captureMethods.release;
    Element.prototype.hasPointerCapture = captureMethods.has;
    vi.restoreAllMocks();
  });

  function pointer(target: EventTarget, type: string, point: { x: number; y: number }, pointerId: number) {
    const event = new MouseEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1,
      clientX: point.x, clientY: point.y
    });
    Object.defineProperties(event, {
      pointerId: { value: pointerId }, pointerType: { value: "mouse" }, isPrimary: { value: true }
    });
    target.dispatchEvent(event);
  }

  it("moves the frame with the rendered curve, restores it on undo, and uses it for marquee selection", async () => {
    let initial = insertNativeSingleBondMolecule(createPhase4Document(), { x: 150, y: 150 });
    const source = initial.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    initial = insertNativeSingleBondMolecule(initial, { x: 350, y: 150 });
    const target = initial.pages[0].objects.find((object): object is MoleculeObject =>
      object.type === "molecule" && object.id !== source.id)!;
    initial = createMechanismArrowBetween(initial, "full-headed",
      { kind: "atom", objectId: source.id, atomId: source.atoms[0].id },
      { kind: "atom", objectId: target.id, atomId: target.atoms[0].id });
    let arrow = initial.pages[0].objects.find((object): object is MechanismArrowObject => object.type === "mechanism-arrow")!;
    // Start with a stored frame matching the rendered geometry. Both main and this branch
    // pass the initial assertion; the regression must fail only after the anchor moves.
    const initialGeometry = mechanismArrowGeometry(initial.pages[0], arrow)!;
    const initialPoints = [initialGeometry.source, initialGeometry.target, ...initialGeometry.controls];
    const x = Math.min(...initialPoints.map((point) => point.x)) - 12;
    const y = Math.min(...initialPoints.map((point) => point.y)) - 12;
    initial = applyPatch(initial, { op: "updateObject", objectId: arrow.id, changes: {
      x, y, width: Math.max(...initialPoints.map((point) => point.x)) + 12 - x,
      height: Math.max(...initialPoints.map((point) => point.y)) + 12 - y
    } });
    arrow = initial.pages[0].objects.find((object): object is MechanismArrowObject => object.id === arrow.id && object.type === "mechanism-arrow")!;
    initial = applyPatch(initial, { op: "setSelection", pageId: initial.pages[0].id, objectIds: [source.id] });
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialDocument: initial, initialActiveToolCommandId: "tool.select",
        initialCrosshairsVisible: false, initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true
      }));
    });
    const pageElement = container.querySelector<HTMLElement>(".page")!;
    const page = initial.pages[0];
    pageElement.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: page.width, bottom: page.height,
      width: page.width, height: page.height, toJSON: () => ({})
    });
    const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
    const frame = () => container.querySelector<HTMLElement>(`.mechanism-arrow-object[data-object-id="${arrow.id}"]`)!;
    // Arrow paint lives in an ordered SVG run; its handles are portalled into chrome.
    const controls = () => container.querySelector<HTMLElement>(`[data-object-controls="${arrow.id}"]`)!;
    const curve = () => container.querySelector<SVGPathElement>(`[data-page-svg-object-visual="${arrow.id}"] path`)!;
    const boundsFromCurve = (document: ChemDraftDocument) => {
      const geometry = mechanismArrowGeometry(document.pages[0], arrow)!;
      expect(curve().getAttribute("d")).toBe(geometry.pathD);
      const points = [geometry.source, geometry.target, ...geometry.controls];
      const x = Math.min(...points.map((point) => point.x)) - 12;
      const y = Math.min(...points.map((point) => point.y)) - 12;
      return { x, y,
        width: Math.max(...points.map((point) => point.x)) + 12 - x,
        height: Math.max(...points.map((point) => point.y)) + 12 - y };
    };
    const expectFrame = (bounds: ReturnType<typeof boundsFromCurve>) => {
      expect(parseFloat(frame().style.left)).toBeCloseTo(bounds.x / page.width * 100, 8);
      expect(parseFloat(frame().style.top)).toBeCloseTo(bounds.y / page.height * 100, 8);
      expect(parseFloat(frame().style.width)).toBeCloseTo(bounds.width / page.width * 100, 8);
      expect(parseFloat(frame().style.height)).toBeCloseTo(bounds.height / page.height * 100, 8);
      expect(controls().style.left).toBe(frame().style.left);
      expect(controls().style.top).toBe(frame().style.top);
      expect(controls().style.width).toBe(frame().style.width);
      expect(controls().style.height).toBe(frame().style.height);
      if (snapshot().selection.objectIds.includes(arrow.id)) {
        arrow.controlPoints.forEach((control, index) => {
          const handle = controls().querySelector<HTMLElement>(`[data-mechanism-handle-index="${index}"]`)!;
          expect(handle).not.toBeNull();
          expect(handle.style.left).toBe(`calc(${control.x - bounds.x}px * var(--page-scale))`);
          expect(handle.style.top).toBe(`calc(${control.y - bounds.y}px * var(--page-scale))`);
        });
      }
    };
    const oldBounds = boundsFromCurve(snapshot());
    expect(oldBounds).toEqual({ x: arrow.x, y: arrow.y, width: arrow.width, height: arrow.height });
    expectFrame(oldBounds);
    const oldPath = curve().getAttribute("d");
    const sourceElement = container.querySelector<HTMLElement>(`.document-object[data-object-id="${source.id}"]`)!;
    const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
    const end = { x: start.x, y: start.y + 200 };
    await act(async () => { pointer(sourceElement, "pointerdown", start, 1); });
    // The object owns pointer capture for a whole-molecule move.
    await act(async () => { pointer(sourceElement, "pointermove", end, 1); });
    await act(async () => { pointer(sourceElement, "pointerup", end, 1); });
    const moved = snapshot();
    const movedSource = moved.pages[0].objects.find((object): object is MoleculeObject => object.id === source.id && object.type === "molecule")!;
    expect(movedSource.y).toBeCloseTo(source.y + 200);
    expect(movedSource.bonds).toEqual(source.bonds);
    expect(movedSource.chemistry).toEqual(source.chemistry);
    expect(moved.pages[0].objects.find((object) => object.id === arrow.id)).toEqual(arrow);
    const newBounds = boundsFromCurve(moved);
    expect(newBounds).not.toEqual(oldBounds);
    expect(curve().getAttribute("d")).not.toBe(oldPath);
    expectFrame(newBounds);

    // The SVG shaft remains the actual pointer target, at its newly resolved coordinates.
    await act(async () => {
      pointer(curve(), "pointerdown", mechanismArrowGeometry(moved.pages[0], arrow)!.source, 10);
      pointer(pageElement, "pointerup", mechanismArrowGeometry(moved.pages[0], arrow)!.source, 10);
    });
    expect(snapshot().selection.objectIds).toEqual([arrow.id]);
    expect(frame().classList.contains("selected")).toBe(true);
    expectFrame(newBounds);
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
    expect(snapshot().pages[0].objects).toEqual(initial.pages[0].objects);
    expect(curve().getAttribute("d")).toBe(oldPath);
    expectFrame(oldBounds);
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.redo"); });
    expectFrame(newBounds);

    const marquee = async (bounds: typeof oldBounds, pointerId: number) => {
      const start = { x: bounds.x - 2, y: bounds.y - 2 };
      const end = { x: bounds.x + bounds.width + 2, y: bounds.y + bounds.height + 2 };
      await act(async () => { pointer(pageElement, "pointerdown", start, pointerId); });
      await act(async () => { pointer(pageElement, "pointermove", end, pointerId); });
      await act(async () => { pointer(pageElement, "pointerup", end, pointerId); });
    };
    await marquee(oldBounds, 11);
    expect(snapshot().selection.objectIds).not.toContain(arrow.id);
    await marquee(newBounds, 12);
    expect(snapshot().selection.objectIds).toContain(arrow.id);
    expectFrame(boundsFromCurve(snapshot()));

    // Render the same moved snapshot after committing a quarter turn. jsdom does not
    // lay out CSS transforms, so apply the actual DOM transform/origin numerically.
    const rotated = applyPatch(rotateDocumentObject(snapshot(), arrow.id, 90), {
      op: "setSelection", pageId: page.id, objectIds: [arrow.id]
    });
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialDocument: rotated, initialActiveToolCommandId: "tool.select",
        initialCrosshairsVisible: false, initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true
      }));
    });
    const bounds = boundsFromCurve(snapshot());
    expectFrame(bounds);
    expect(frame().style.transform).toBe("rotate(90deg)");
    const origin = [...frame().style.transformOrigin.matchAll(/calc\(([-\d.e]+)px/g)].map((match) => Number(match[1]));
    expect(origin).toHaveLength(2);
    const svgGroup = curve().closest("[transform]")!;
    const svgTransform = svgGroup.getAttribute("transform")!.match(/rotate\(([-\d.]+) ([-\d.]+) ([-\d.]+)\)/)!;
    expect(Number(svgTransform[1])).toBe(90);
    const pivot = { x: Number(svgTransform[2]), y: Number(svgTransform[3]) };
    const geometry = mechanismArrowGeometry(rotated.pages[0], arrow)!;
    for (const [index, control] of geometry.controls.entries()) {
      const handle = controls().querySelector<HTMLElement>(`[data-mechanism-handle-index="${index}"]`)!;
      expect(handle).not.toBeNull();
      const localX = Number(handle.style.left.match(/calc\(([-\d.e]+)px/)![1]);
      const localY = Number(handle.style.top.match(/calc\(([-\d.e]+)px/)![1]);
      expect(bounds.x + origin[0] - (localY - origin[1])).toBeCloseTo(pivot.x - (control.y - pivot.y), 3);
      expect(bounds.y + origin[1] + (localX - origin[0])).toBeCloseTo(pivot.y + (control.x - pivot.x), 3);
    }
  });
});
