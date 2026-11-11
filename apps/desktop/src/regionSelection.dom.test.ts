// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { MainWindow } from "./MainWindow";
import {
  createPhase4Document, insertNativeTemplateMolecule, scaleDocumentObjectsAroundPoint, selectDocumentObjects
} from "./documentWorkflow";
import { hitTestDocument, resolveSelectionHit } from "./interaction/hitTest";
import { DOM_COMMAND_EVENT } from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
type Point = { x: number; y: number };
type Modifiers = { shiftKey?: boolean; altKey?: boolean };

describe.each<ShortcutPlatform>(["macos", "windows"])("region selection starting parts (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let a: MoleculeObject;
  let b: MoleculeObject;
  let captures: Map<number, Element>;
  const captureMethods = {
    set: Element.prototype.setPointerCapture,
    release: Element.prototype.releasePointerCapture,
    has: Element.prototype.hasPointerCapture
  };
  const page = () => container.querySelector<HTMLElement>(".page")!;
  const wrapper = (object: MoleculeObject) => container.querySelector<HTMLElement>(
    `.native-molecule-object[data-object-id="${object.id}"]`
  )!;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const status = () => container.querySelector('[role="status"]')?.textContent;
  const chrome = (object: MoleculeObject) => container.querySelector<HTMLElement>(
    `.document-object-chrome[data-object-controls="${object.id}"]`
  )!;
  const atomIds = (object: MoleculeObject) => [...chrome(object).querySelectorAll("[data-selected-atom-id]")]
    .map(element => element.getAttribute("data-selected-atom-id"));

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    captures = new Map();
    Element.prototype.setPointerCapture = function (id: number) { captures.set(id, this); };
    Element.prototype.releasePointerCapture = function (id: number) { captures.delete(id); };
    Element.prototype.hasPointerCapture = function (id: number) { return captures.get(id) === this; };
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now += 1000);
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    Element.prototype.setPointerCapture = captureMethods.set;
    Element.prototype.releasePointerCapture = captureMethods.release;
    Element.prototype.hasPointerCapture = captureMethods.has;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Dispatch actual DOM pointer events, with capture and modifiers, rather than bridge events.
  async function pointer(type: "pointerdown" | "pointermove" | "pointerup", point: Point, modifiers: Modifiers = {}) {
    const hit = hitTestDocument(snapshot(), point);
    const target = captures.get(1) ?? (hit ? wrapper(hit.objectId === a.id ? a : b) : page());
    await act(async () => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1,
      pointerId: 1, pointerType: "mouse", isPrimary: true,
      clientX: point.x, clientY: point.y, ...modifiers
    })));
    if (type === "pointerup") captures.delete(1);
  }

  async function click(point: Point, modifiers: Modifiers = {}) {
    await pointer("pointerdown", point, modifiers);
    await pointer("pointerup", point, modifiers);
  }

  function expectOnlyStartingAtom() {
    expect({ kind: wrapper(a).dataset.selectedNativeKind, atom: wrapper(a).dataset.selectedNativeAtomId })
      .toEqual({ kind: "atom", atom: a.atoms[0].id });
    expect(atomIds(a)).toEqual([a.atoms[0].id]);
    expect(chrome(a).querySelector("[data-selected-bond-id]")).toBeNull();
    expect(container.querySelector('[data-whole-molecule-selection="true"]')).toBeNull();
    expect(atomIds(b)).toEqual([]);
    // Plain atom picks include their host id; region results store only whole-object ids.
    // Either encoding represents the same atom part, checked above.
    expect(snapshot().selection.objectIds.filter(id => id !== a.id)).toEqual([]);
  }

  async function mount(tool: string) {
    let initialDocument = createPhase4Document("Region selection parts");
    for (const center of [{ x: 220, y: 220 }, { x: 480, y: 220 }]) {
      initialDocument = insertNativeTemplateMolecule(initialDocument, center, "benzene");
      initialDocument = scaleDocumentObjectsAroundPoint(
        initialDocument, initialDocument.selection.objectIds, center, 3, 3
      );
    }
    initialDocument = selectDocumentObjects(initialDocument, initialDocument.pages[0].id, []);
    [a, b] = initialDocument.pages[0].objects as MoleculeObject[];
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument, initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden",
      initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: true,
      shortcutPlatform: platform
    })));
    const { width, height } = initialDocument.pages[0];
    page().getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({})
    });
    await click(a.atoms[0]);
    expectOnlyStartingAtom();
    expect(status()).toBe("Selected atom");
    if (tool !== "tool.select") {
      await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, {
        detail: { commandId: tool }
      })));
    }
    expect(container.querySelector<HTMLElement>(".app-shell")?.dataset.activeTool).toBe(tool);
  }

  const centerOfA = () => ({
    x: a.atoms.reduce((sum, atom) => sum + atom.x, 0) / a.atoms.length,
    y: a.atoms.reduce((sum, atom) => sum + atom.y, 0) / a.atoms.length
  });

  function boxAround(points: readonly Point[], padding: number) {
    const left = Math.min(...points.map(point => point.x)) - padding;
    const right = Math.max(...points.map(point => point.x)) + padding;
    const top = Math.min(...points.map(point => point.y)) - padding;
    const bottom = Math.max(...points.map(point => point.y)) + padding;
    return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
  }

  async function region(tool: string, box: Point[], modifiers: Modifiers) {
    expect(hitTestDocument(snapshot(), box[0])).toBeUndefined();
    await pointer("pointerdown", box[0], modifiers);
    if (tool === "tool.lasso") {
      for (const point of [...box.slice(1), box[0]]) await pointer("pointermove", point, modifiers);
    } else {
      await pointer("pointermove", box[2], modifiers);
    }
    await pointer("pointerup", tool === "tool.lasso" ? box[0] : box[2], modifiers);
  }

  describe.each(["tool.select", "tool.lasso"])("%s", tool => {
    it("Shift-click on empty ring center keeps exactly the starting atom", async () => {
      await mount(tool);
      const before = snapshot();
      // The Rings inspector is closed: a ring interior is empty canvas by policy.
      expect(resolveSelectionHit(before, centerOfA(), { includeRings: false })).toBeUndefined();
      await click(centerOfA(), { shiftKey: true });
      expect(status()).toBe("Selected atom");
      expectOnlyStartingAtom();
      expect(snapshot().pages).toEqual(before.pages);
    });

    it("Shift-region around B unions B with A's starting atom", async () => {
      await mount(tool);
      const before = snapshot().pages[0].objects;
      await region(tool, boxAround(b.atoms, 20), { shiftKey: true });
      expect(wrapper(a).dataset.selectedNativeKind).toBe("atom");
      expect(atomIds(a)).toEqual([a.atoms[0].id]);
      expect(chrome(a).querySelector('[data-whole-molecule-selection="true"]')).toBeNull();
      expect(chrome(b).querySelector('[data-whole-molecule-selection="true"]')).not.toBeNull();
      expect(snapshot().selection.objectIds).toEqual([b.id]);
      expect(snapshot().pages[0].objects).toEqual(before);
    });

    it.each([false, true])("Alt-region removes the starting atom only if covered (%s)", async covered => {
      await mount(tool);
      const before = snapshot().pages[0].objects;
      await region(tool, boxAround([a.atoms[covered ? 0 : 3]], 16), { altKey: true });
      if (covered) {
        expect(snapshot().selection.objectIds).toEqual([]);
        expect(container.querySelector("[data-selected-atom-id]")).toBeNull();
        expect(wrapper(a).dataset.selectedNativeKind).toBeUndefined();
      } else {
        expectOnlyStartingAtom();
      }
      expect(snapshot().pages[0].objects).toEqual(before);
    });

    it("plain empty click still clears the starting selection", async () => {
      await mount(tool);
      await click(centerOfA());
      expect(snapshot().selection.objectIds).toEqual([]);
      expect(container.querySelector("[data-selected-atom-id]")).toBeNull();
      expect(wrapper(a).dataset.selectedNativeKind).toBeUndefined();
    });

    it("Escape restores the starting atom and disarms the region gesture", async () => {
      await mount(tool);
      const before = snapshot();
      await pointer("pointerdown", { x: 50, y: 50 }, { shiftKey: true });
      await pointer("pointermove", { x: 100, y: 50 }, { shiftKey: true });
      await pointer("pointermove", { x: 100, y: 100 }, { shiftKey: true });
      expect(container.querySelector(tool === "tool.lasso" ? ".selection-lasso-surface" : ".selection-marquee")).not.toBeNull();
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(status()).toBe("Selection canceled");
      expectOnlyStartingAtom();
      expect(snapshot()).toEqual(before);
      await pointer("pointerup", { x: 100, y: 100 }, { shiftKey: true });
      expectOnlyStartingAtom();
      expect(container.querySelector(".selection-lasso-surface, .selection-marquee")).toBeNull();
    });
  });
});
