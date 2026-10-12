// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, GraphicObject, MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import {
  createPhase4Document,
  insertNativeArtGraphicObject,
  insertNativeSingleBondMolecule,
  insertNativeTextObject,
  selectDocumentObjects
} from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { forceDocumentHistoryCommandId } from "./editHistoryRouting";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("Text tool on shapes", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.hasPointerCapture = () => false;
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(initialDocument: ChemDraftDocument, commandId = "tool.text") {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialDocument,
        initialActiveToolCommandId: commandId,
        initialCrosshairsVisible: false,
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612,
      width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => rect;
    container.querySelector<HTMLElement>(".canvas-region")!.getBoundingClientRect = () => rect;
  }

  function snapshot() {
    return window.__CHEMDRAFT_AGENT__!.snapshot().document;
  }

  function target(selector: string): Element {
    const element = container.querySelector(selector);
    expect(element, selector).not.toBeNull();
    return element!;
  }

  async function press(element: Element, point: { x: number; y: number }) {
    await act(async () => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
          buttons: type === "pointerdown" ? 1 : 0, clientX: point.x, clientY: point.y });
        Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 7 },
          pointerType: { value: "mouse" } });
        element.dispatchEvent(event);
      }
    });
  }

  async function command(commandId: string) {
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }));
    });
  }

  function shapeDocument(filled: boolean) {
    const doc = structuredClone(insertNativeArtGraphicObject(createPhase4Document("Text on shape"),
      { x: 300, y: 300 }, "tool.art.rect"));
    const shape = doc.pages[0].objects[0] as GraphicObject;
    shape.style = { ...shape.style, fillColor: filled ? "#ff0000" : "none", fillMode: "solid" };
    return selectDocumentObjects(doc, doc.pages[0].id, []);
  }

  async function expectTextPlacement(filled: boolean) {
    const initial = shapeDocument(filled);
    const shape = initial.pages[0].objects[0] as GraphicObject;
    const point = { x: shape.x + shape.width / 2, y: filled ? shape.y + shape.height / 2 : shape.y };
    await render(initial);
    // jsdom has no SVG hit testing: dispatch to the actual interior catcher or visible stroke
    // that the browser delivers to the object handler, rather than bypassing it via the page.
    const hit = target(`[data-object-id="${shape.id}"] ${filled ? ".graphic-glyph-hit-target" : ".graphic-glyph-stroke"}`);
    await press(hit, point);
    const texts = snapshot().pages[0].objects.filter((object) => object.type === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ x: point.x, y: point.y });
    expect(snapshot().pages[0].objects).toHaveLength(2);
    expect(snapshot().selection.objectIds).toEqual([texts[0]!.id]);
    const editor = target(".text-object-editor");
    expect(document.activeElement).toBe(editor);
    await command(forceDocumentHistoryCommandId("edit.undo"));
    expect(snapshot().pages[0].objects).toEqual(initial.pages[0].objects);
    expect(container.querySelector('[data-can-undo="true"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/^Undid .+/);
    await command(forceDocumentHistoryCommandId("edit.redo"));
    expect(snapshot().pages[0].objects.filter((object) => object.type === "text")).toHaveLength(1);
  }

  it("creates focused text inside a filled rectangle with one labelled undo entry", async () => {
    await expectTextPlacement(true);
  });

  it("creates focused text on an unfilled shape's stroke with one labelled undo entry", async () => {
    await expectTextPlacement(false);
  });

  it("reopens an existing text instead of inserting another", async () => {
    const initial = insertNativeTextObject(createPhase4Document("Existing text"), { x: 300, y: 300 }, "Existing");
    const text = initial.pages[0].objects[0]!;
    await render(selectDocumentObjects(initial, initial.pages[0].id, []));
    await press(target(`[data-object-id="${text.id}"]`), { x: 305, y: 305 });
    expect(snapshot().pages[0].objects).toEqual(initial.pages[0].objects);
    expect((target(".text-object-editor") as HTMLTextAreaElement).value).toBe("Existing");
    expect(document.activeElement).toBe(target(".text-object-editor"));
    expect(container.querySelector('[data-can-undo="true"]')).toBeNull();
  });

  it("opens the atom label editor when pressing an atom", async () => {
    const initial = insertNativeSingleBondMolecule(createPhase4Document("Atom text"), { x: 300, y: 300 });
    const molecule = initial.pages[0].objects[0] as MoleculeObject;
    const atom = molecule.atoms[0]!;
    await render(selectDocumentObjects(initial, initial.pages[0].id, []));
    await press(target(`[data-object-id="${molecule.id}"]`), atom);
    const editor = target('[data-atom-label-editor="true"]');
    expect(editor.getAttribute("data-atom-id")).toBe(atom.id);
    expect(document.activeElement).toBe(editor);
    expect(container.querySelector(".text-object-editor")).toBeNull();
    expect(snapshot().pages[0].objects).toEqual(initial.pages[0].objects);
  });

  it("still selects a filled rectangle with the Select tool", async () => {
    const initial = shapeDocument(true);
    const shape = initial.pages[0].objects[0] as GraphicObject;
    await render(initial, "tool.select");
    await press(target(`[data-object-id="${shape.id}"] .graphic-glyph-hit-target`),
      { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 });
    expect(snapshot().selection.objectIds).toEqual([shape.id]);
    expect(snapshot().pages[0].objects).toEqual(initial.pages[0].objects);
    expect(container.querySelector(".text-object-editor")).toBeNull();
  });
});
