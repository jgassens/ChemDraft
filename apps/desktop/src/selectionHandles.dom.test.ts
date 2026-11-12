// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import {
  createPhase4Document, insertNativeSingleBondMolecule, scaleDocumentObjectsAroundPoint, selectDocumentObjects
} from "./documentWorkflow";
import { hitTestDocument } from "./interaction/hitTest";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
type Point = { x: number; y: number };

describe("selection handles and additive molecule picks", () => {
  let container: HTMLDivElement;
  let root: Root;
  let css: HTMLStyleElement;
  let molecule: MoleculeObject;
  let captures: Map<number, Element>;
  const captureMethods = {
    set: Element.prototype.setPointerCapture,
    release: Element.prototype.releasePointerCapture,
    has: Element.prototype.hasPointerCapture
  };

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    // Selection can replace the pressed wrapper. Honor capture so release still reaches the page.
    captures = new Map();
    Element.prototype.setPointerCapture = vi.fn(function (this: Element, id: number) { captures.set(id, this); });
    Element.prototype.releasePointerCapture = function (id: number) { captures.delete(id); };
    Element.prototype.hasPointerCapture = function (id: number) { return captures.get(id) === this; };
    // Keep separate clicks outside the double-press window, independently of test-host speed.
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now += 1000);
    window.history.replaceState(null, "", "/?agentBridge=1");
    css = document.createElement("style");
    css.textContent = readFileSync(resolve("apps/desktop/src/App.css"), "utf8");
    document.head.append(css);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    css.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    Element.prototype.setPointerCapture = captureMethods.set;
    Element.prototype.releasePointerCapture = captureMethods.release;
    Element.prototype.hasPointerCapture = captureMethods.has;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const page = () => container.querySelector<HTMLElement>(".page")!;
  const wrapper = () => container.querySelector<HTMLElement>(`.native-molecule-object[data-object-id="${molecule.id}"]`)!;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const selectedAtoms = () => [...container.querySelectorAll("[data-selected-atom-id]")]
    .map(element => element.getAttribute("data-selected-atom-id"));

  async function mount(platform: ShortcutPlatform = "macos", scale = 1, moleculeCount = 1) {
    let inserted = insertNativeSingleBondMolecule(createPhase4Document("Selection handle overlap"), { x: 300, y: 300 });
    if (scale !== 1) inserted = scaleDocumentObjectsAroundPoint(
      inserted, [inserted.pages[0].objects[0].id], { x: 300, y: 300 }, scale, scale
    );
    for (let index = 1; index < moleculeCount; index += 1) {
      const point = { x: 300, y: 300 + index * 180 };
      inserted = insertNativeSingleBondMolecule(inserted, point);
      inserted = scaleDocumentObjectsAroundPoint(
        inserted, [inserted.pages[0].objects.at(-1)!.id], point, scale, scale
      );
    }
    const initialDocument = selectDocumentObjects(inserted, inserted.pages[0].id, []);
    molecule = initialDocument.pages[0].objects[0] as MoleculeObject;
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument, initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden",
      initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false,
      shortcutPlatform: platform
    })));
    const { width, height } = initialDocument.pages[0];
    page().getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({})
    });
  }

  function framePx(frame: HTMLElement, property: "left" | "top" | "width" | "height") {
    const value = frame.style[property].match(/calc\(([-\d.]+)px/);
    if (!value) throw new Error(`Missing frame ${property}: ${frame.style.cssText}`);
    return Number(value[1]);
  }

  // jsdom has no layout/elementFromPoint. Supply only the missing layout: frame geometry comes
  // from the rendered inline styles; handle sizes/offsets come from the real application CSS.
  // Pick the topmost handle at the coordinate before trying the shared geometric molecule hit.
  function handleRect(handle: HTMLElement) {
    const frame = handle.closest<HTMLElement>(".object-transform-frame")!;
    const style = getComputedStyle(handle);
    const width = Number.parseFloat(style.width);
    const height = Number.parseFloat(style.height);
    const frameWidth = framePx(frame, "width");
    const frameHeight = framePx(frame, "height");
    const offset = (value: string, extent: number) => value.endsWith("%")
      ? Number.parseFloat(value) * extent / 100 : Number.parseFloat(value);
    const left = style.left && style.left !== "auto"
      ? offset(style.left, frameWidth) : frameWidth - offset(style.right, frameWidth) - width;
    const top = style.top && style.top !== "auto"
      ? offset(style.top, frameHeight) : frameHeight - offset(style.bottom, frameHeight) - height;
    return {
      x: molecule.x + framePx(frame, "left") + left,
      y: molecule.y + framePx(frame, "top") + top,
      width, height
    };
  }

  function targetAt(point: Point): HTMLElement {
    const handles = [...container.querySelectorAll<HTMLElement>("[data-molecule-transform-frame] .object-resize-handle")];
    const handle = handles.reverse().find(element => {
      const rect = handleRect(element);
      return point.x >= rect.x && point.x <= rect.x + rect.width
        && point.y >= rect.y && point.y <= rect.y + rect.height;
    });
    if (handle) return handle;
    const hit = hitTestDocument(snapshot(), point);
    const body = [...snapshot().pages[0].objects].reverse().find(object =>
      point.x >= object.x && point.x <= object.x + object.width
      && point.y >= object.y && point.y <= object.y + object.height
    );
    const objectId = hit?.objectId ?? body?.id;
    return objectId ? container.querySelector<HTMLElement>(`.native-molecule-object[data-object-id="${objectId}"]`)! : page();
  }

  function pointer(target: EventTarget, type: string, point: Point, shiftKey = false) {
    const event = new MouseEvent(type, {
      bubbles: true, cancelable: true, button: 0,
      buttons: type.endsWith("down") || (type === "pointermove" && captures.has(1)) ? 1 : 0,
      clientX: point.x, clientY: point.y, shiftKey
    });
    Object.defineProperties(event, {
      pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" }
    });
    const captured = type === "pointermove" || type === "pointerup" || type === "pointercancel" ? captures.get(1) : undefined;
    (captured ?? target).dispatchEvent(event);
    if (type === "pointerup" || type === "pointercancel") captures.delete(1);
  }

  async function clickAt(point: Point, shiftKey = false) {
    for (const type of ["pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      await act(async () => pointer(targetAt(point), type, point, shiftKey));
    }
  }

  it.each<ShortcutPlatform>(["macos", "windows"])("Shift-click adds the adjacent atom through an overlapping resize handle (%s)", async platform => {
    await mount(platform);
    await clickAt(molecule.atoms[0]);
    expect(selectedAtoms()).toEqual([molecule.atoms[0].id]);
    const neighbor = molecule.atoms[1];
    expect(targetAt(neighbor).dataset.objectResizeCorner).toBe("top-right");
    const before = snapshot().pages[0].objects;
    await clickAt(neighbor, true);
    expect({ kind: wrapper().dataset.selectedNativeKind, status: container.querySelector('[role="status"]')?.textContent })
      .toEqual({ kind: "parts", status: "Selected 2 molecule parts" });
    expect(selectedAtoms()).toEqual(molecule.atoms.map(atom => atom.id));
    expect(container.querySelector('[data-whole-molecule-selection="true"]')).toBeNull();
    expect(snapshot().pages[0].objects).toEqual(before);
  });

  describe.each<ShortcutPlatform>(["macos", "windows"])("selection status (%s)", platform => {
    it.each([
      { parts: 1, objects: 1, label: "Selected 1 molecule part and 1 object" },
      { parts: 2, objects: 1, label: "Selected 2 molecule parts and 1 object" },
      { parts: 1, objects: 2, label: "Selected 1 molecule part and 2 objects" },
      { parts: 1, objects: 0, label: "Selected atom" },
      { parts: 2, objects: 0, label: "Selected 2 molecule parts" },
      { parts: 0, objects: 2, label: "Selected 2 objects" }
    ])("reports $parts parts and $objects whole objects", async ({ parts, objects, label }) => {
      await mount(platform, 4, objects + 1);
      const before = snapshot().pages[0].objects;
      const wholeMolecules = before.slice(1) as MoleculeObject[];
      for (let index = 0; index < parts; index += 1) {
        await clickAt(molecule.atoms[index], index > 0);
      }
      for (let index = 0; index < objects; index += 1) {
        const whole = wholeMolecules[index];
        // Inside the body bounds, away from either atom and the diagonal bond; no rings.
        const point = { x: whole.x + whole.width * 0.2, y: whole.y + whole.height * 0.2 };
        expect(hitTestDocument(snapshot(), point)).toBeUndefined();
        expect(targetAt(point).dataset.objectId).toBe(whole.id);
        await clickAt(point, true);
      }
      expect([...snapshot().selection.objectIds].sort()).toEqual([
        ...(parts > 0 ? [molecule.id] : []), ...wholeMolecules.map(whole => whole.id)
      ].sort());
      if (parts > 0) expect(wrapper().dataset.selectedNativeKind).toBe(parts === 1 ? "atom" : "parts");
      expect(snapshot().pages[0].objects).toEqual(before);
      expect(container.querySelector('[role="status"]')?.textContent).toBe(label);
    });
  });

  it("Shift-click adds a bond through an overlapping resize handle", async () => {
    await mount();
    await clickAt(molecule.atoms[0]);
    const midpoint = {
      x: (molecule.atoms[0].x + molecule.atoms[1].x) / 2,
      y: (molecule.atoms[0].y + molecule.atoms[1].y) / 2
    };
    expect(hitTestDocument(snapshot(), midpoint)?.kind).toBe("bond");
    expect(targetAt(midpoint).dataset.objectResizeCorner).toBe("top-right");
    const before = snapshot().pages[0].objects;
    await clickAt(midpoint, true);
    expect(wrapper().dataset.selectedNativeKind).toBe("parts");
    expect(container.querySelector("[data-selected-bond-id]")?.getAttribute("data-selected-bond-id"))
      .toBe(molecule.bonds[0].id);
    expect(selectedAtoms()).toContain(molecule.atoms[0].id);
    expect(snapshot().pages[0].objects).toEqual(before);
  });

  it("keeps plain clicks on the overlapping handle as resize presses", async () => {
    await mount();
    await clickAt(molecule.atoms[0]);
    expect(targetAt(molecule.atoms[1]).dataset.objectResizeCorner).toBe("top-right");
    const before = snapshot().pages[0].objects;
    await clickAt(molecule.atoms[1]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Resize selected molecule fragment");
    expect(selectedAtoms()).toEqual([molecule.atoms[0].id]);
    expect(snapshot().pages[0].objects).toEqual(before);
  });

  it("keeps normal-sized fragment handles unchanged even with Shift over an atom", async () => {
    await mount("macos", 4);
    await clickAt(molecule.atoms[0]);
    await clickAt(molecule.atoms[1], true);
    expect(selectedAtoms()).toEqual(molecule.atoms.map(atom => atom.id));
    const frame = container.querySelector<HTMLElement>("[data-molecule-transform-frame]")!;
    expect(framePx(frame, "width")).toBeGreaterThan(28);
    expect(framePx(frame, "height")).toBeGreaterThan(28);
    expect(targetAt(molecule.atoms[0]).dataset.objectResizeCorner).toBe("bottom-left");
    const before = snapshot().pages[0].objects;
    await clickAt(molecule.atoms[0], true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Resize selected molecule fragment");
    expect(selectedAtoms()).toEqual(molecule.atoms.map(atom => atom.id));
    expect(snapshot().pages[0].objects).toEqual(before);
  });

  it.each([false, true])("keeps the one-atom resize handle usable over empty space (Shift: %s)", async shift => {
    await mount();
    await clickAt(molecule.atoms[0]);
    const handle = container.querySelector<HTMLElement>('[data-object-resize-corner="bottom-left"]')!;
    const rect = handleRect(handle);
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    expect(hitTestDocument(snapshot(), point)).toBeUndefined();
    expect(targetAt(point)).toBe(handle);
    const before = snapshot();
    await act(async () => pointer(targetAt(point), "pointerdown", point, shift));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Resize selected molecule fragment");
    expect(Element.prototype.setPointerCapture).toHaveBeenCalledWith(1);
    await act(async () => pointer(page(), "pointermove", { x: point.x - 15, y: point.y + 15 }, shift));
    expect(container.querySelector(".object-resize-readout")).not.toBeNull();
    await act(async () => pointer(page(), "pointercancel", point, shift));
    expect(snapshot()).toEqual(before);
    expect(selectedAtoms()).toEqual([molecule.atoms[0].id]);
  });
});
