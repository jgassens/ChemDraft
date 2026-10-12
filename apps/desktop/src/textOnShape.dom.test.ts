// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentObjectSchema, type ChemDraftDocument, type GraphicObject, type MoleculeObject } from "@chemdraft/chem-core";
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

describe.each(["macos", "windows"] as const)("Text tool on shapes (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform === "macos" ? "MacIntel" : "Win32");
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

  function pointer(element: Element, type: string, point: { x: number; y: number }, shiftKey = false) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y, shiftKey });
    Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 7 },
      pointerType: { value: "mouse" } });
    element.dispatchEvent(event);
  }

  async function press(element: Element, point: { x: number; y: number }, shiftKey = false) {
    await act(async () => {
      for (const type of ["pointerdown", "pointerup"]) {
        pointer(element, type, point, shiftKey);
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

  async function expectTextPlacementOnObject(initial: ChemDraftDocument, selector: string,
    point: { x: number; y: number }, shiftKey = false) {
    await render(initial);
    // jsdom has no SVG hit testing: dispatch to an object target that the browser delivers
    // to the object handler, rather than bypassing it via the page.
    await press(target(selector), point, shiftKey);
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

  async function expectTextPlacement(filled: boolean, shiftKey = false) {
    const initial = shapeDocument(filled);
    const shape = initial.pages[0].objects[0] as GraphicObject;
    const point = { x: shape.x + shape.width / 2, y: filled ? shape.y + shape.height / 2 : shape.y };
    await expectTextPlacementOnObject(initial,
      `[data-object-id="${shape.id}"] ${filled ? ".graphic-glyph-hit-target" : ".graphic-glyph-stroke"}`, point, shiftKey);
  }

  const anchor = { kind: "point", point: { x: 300, y: 300 } };
  const objectCases = [
    { type: "graphic", graphicKind: "image", data: { imageHref: "data:image/png;base64,iVBORw0KGgo=" } },
    { type: "reaction", components: [] },
    { type: "reaction-arrow", arrowKind: "forward", start: anchor,
      end: { kind: "point", point: { x: 360, y: 300 } } },
    { type: "mechanism-arrow", arrowKind: "full-headed", source: anchor,
      target: { kind: "point", point: { x: 360, y: 300 } } },
    { type: "electron-mark", markKind: "charge", anchor, charge: 1 },
    { type: "bracket", bracketKind: "square" },
    { type: "plus" },
    { type: "annotation", message: "Note" },
    { type: "superatom", label: "Me", metadata: { label: "Me" } },
    { type: "r-group-label", label: "R", display: { label: "R" } },
    { type: "generic-atom-label", label: "X" },
    { type: "unknown-compatibility-object", sourceFormat: "test", sourceObjectType: "test", warning: "Test fixture" }
  ];

  function overlappingTextDocument(kind: string) {
    const initial = structuredClone(shapeDocument(true));
    if (kind !== "filled rectangle") {
      initial.pages[0].objects = [DocumentObjectSchema.parse({
        id: "label-target", x: 300, y: 280, width: 100, height: 60,
        ...objectCases.find(fields => kind === "image"
          ? fields.type === "graphic" : fields.type === "reaction-arrow")
      })];
    }
    const background = initial.pages[0].objects[0]!;
    return insertNativeTextObject(initial, { x: background.x + 5, y: background.y + 5 }, "Existing");
  }

  it.each(["filled rectangle", "image", "reaction arrow"])(
    "edits text over a %s when the underlying object receives the press", async kind => {
      const initial = overlappingTextDocument(kind);
      const background = initial.pages[0].objects[0]!;
      const text = initial.pages[0].objects.find(object => object.type === "text")!;
      await render(selectDocumentObjects(initial, initial.pages[0].id, []));
      // jsdom cannot choose the topmost painted target. Send the press at the text's
      // glyph coordinates to the underlying hit target, as the browser's layers do.
      const selector = background.type === "graphic" && background.graphicKind !== "image"
        ? `[data-object-id="${background.id}"] .graphic-glyph-hit-target`
        : `[data-object-id="${background.id}"]`;
      await press(target(selector), { x: text.x + 3, y: text.y + 5 });
      expect(snapshot().pages[0].objects).toEqual(initial.pages[0].objects);
      expect(snapshot().selection.objectIds).toEqual([text.id]);
      const editor = target(".text-object-editor") as HTMLTextAreaElement;
      expect(editor.closest("[data-object-id]")?.getAttribute("data-object-id")).toBe(text.id);
      expect(editor.value).toBe("Existing");
      expect(document.activeElement).toBe(editor);
      expect(editor.selectionStart).toBe(editor.value.length);
      expect(editor.selectionEnd).toBe(editor.value.length);
      expect(container.querySelector('[data-can-undo="true"]')).toBeNull();
      await command(forceDocumentHistoryCommandId("edit.undo"));
      expect(snapshot().pages[0].objects).toEqual(initial.pages[0].objects);
    }
  );

  it("creates text on bare rectangle area beside existing text with one undo entry", async () => {
    const initial = overlappingTextDocument("filled rectangle");
    const background = initial.pages[0].objects[0]!;
    const point = { x: background.x + background.width - 5, y: background.y + background.height - 3 };
    await render(selectDocumentObjects(initial, initial.pages[0].id, []));
    await press(target(`[data-object-id="${background.id}"] .graphic-glyph-hit-target`), point);
    const texts = snapshot().pages[0].objects.filter(object => object.type === "text");
    expect(texts).toHaveLength(2);
    expect(texts[1]).toMatchObject({ x: point.x, y: point.y, text: "Text" });
    expect(snapshot().pages[0].objects.slice(0, 2)).toEqual(initial.pages[0].objects);
    expect(snapshot().selection.objectIds).toEqual([texts[1]!.id]);
    expect(document.activeElement).toBe(target(".text-object-editor"));
    await command(forceDocumentHistoryCommandId("edit.undo"));
    expect(snapshot().pages[0].objects).toEqual(initial.pages[0].objects);
    expect(container.querySelector('[data-can-undo="true"]')).toBeNull();
  });

  function rotatedTextDocument(rotation: number) {
    const initial = structuredClone(overlappingTextDocument("filled rectangle"));
    // Cover both the rotated text and its unrotated box with the underlying shape.
    Object.assign(initial.pages[0].objects[0]!, { x: 280, y: 220, width: 160, height: 140 });
    Object.assign(initial.pages[0].objects[1]!, { x: 300, y: 280, width: 100, height: 20, rotation });
    return selectDocumentObjects(initial, initial.pages[0].id, []);
  }

  it.each([
    { rotation: 90, point: { x: 350, y: 245 } },
    { rotation: 45, point: { x: 318, y: 258 } }
  ])("edits painted text rotated $rotation degrees when the shape receives the press", async ({ rotation, point }) => {
    const initial = rotatedTextDocument(rotation);
    const background = initial.pages[0].objects[0]!;
    const text = initial.pages[0].objects[1]!;
    await render(initial);
    await press(target(`[data-object-id="${background.id}"] .graphic-glyph-hit-target`), point);
    expect(snapshot().pages[0].objects.filter(object => object.type === "text")).toHaveLength(1);
    expect(snapshot().pages[0].objects).toEqual(initial.pages[0].objects);
    expect(snapshot().selection.objectIds).toEqual([text.id]);
    const editor = target(".text-object-editor") as HTMLTextAreaElement;
    expect(editor.closest("[data-object-id]")?.getAttribute("data-object-id")).toBe(text.id);
    expect(editor.value).toBe("Existing");
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(editor.value.length);
    expect(editor.selectionEnd).toBe(editor.value.length);
    expect(container.querySelector('[data-can-undo="true"]')).toBeNull();
  });

  it.each([
    { rotation: 90, point: { x: 339, y: 290 } },
    { rotation: 45, point: { x: 366, y: 290 } }
  ])("creates text just outside the $rotation degree text despite being inside its unrotated box", async ({ rotation, point }) => {
    const initial = rotatedTextDocument(rotation);
    const background = initial.pages[0].objects[0]!;
    await render(initial);
    await press(target(`[data-object-id="${background.id}"] .graphic-glyph-hit-target`), point);
    const texts = snapshot().pages[0].objects.filter(object => object.type === "text");
    expect(texts).toHaveLength(2);
    expect(texts[1]).toMatchObject({ x: point.x, y: point.y, text: "Text" });
    expect(snapshot().pages[0].objects.slice(0, 2)).toEqual(initial.pages[0].objects);
    expect(snapshot().selection.objectIds).toEqual([texts[1]!.id]);
    expect(document.activeElement).toBe(target(".text-object-editor"));
    await command(forceDocumentHistoryCommandId("edit.undo"));
    expect(snapshot().pages[0].objects).toEqual(initial.pages[0].objects);
    expect(container.querySelector('[data-can-undo="true"]')).toBeNull();
  });

  it("edits the last overlapping text in document order even under a later shape", async () => {
    let initial = overlappingTextDocument("filled rectangle");
    const background = initial.pages[0].objects[0]!;
    const lowerText = initial.pages[0].objects[1]!;
    initial = structuredClone(insertNativeTextObject(initial, { x: lowerText.x, y: lowerText.y }, "Top text"));
    const topText = initial.pages[0].objects[2]!;
    initial.pages[0].objects = [lowerText, topText, background];
    await render(selectDocumentObjects(initial, initial.pages[0].id, []));
    await press(target(`[data-object-id="${background.id}"] .graphic-glyph-hit-target`),
      { x: topText.x + 3, y: topText.y + 5 });
    expect(snapshot().pages[0].objects).toEqual(initial.pages[0].objects);
    expect(snapshot().selection.objectIds).toEqual([topText.id]);
    expect((target(".text-object-editor") as HTMLTextAreaElement).value).toBe("Top text");
    expect(container.querySelector('[data-can-undo="true"]')).toBeNull();
  });

  it.each(objectCases)("creates text on $type with one undo entry", async (fields) => {
    const initial = createPhase4Document("Text on object");
    const object = DocumentObjectSchema.parse({ id: "label-target", x: 300, y: 280,
      width: 60, height: 40, ...fields });
    initial.pages[0].objects = [object];
    await expectTextPlacementOnObject(initial, `[data-object-id="${object.id}"]`, { x: 330, y: 300 });
  });

  it("keeps page Text placement semantics for Shift-click on a shape", async () => {
    await expectTextPlacement(true, true);
  });

  it("keeps the Text tool's Shift-hover arrow resize handle in its own handler", async () => {
    const initial = insertNativeArtGraphicObject(createPhase4Document("Text handle"),
      { x: 300, y: 300 }, "tool.art.reactionArrow");
    const shape = initial.pages[0].objects[0] as GraphicObject;
    await render(initial);
    await act(async () => {
      const event = new MouseEvent("pointermove", { bubbles: true, buttons: 0,
        clientX: 330, clientY: 300, shiftKey: true });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" } });
      target(`[data-object-id="${shape.id}"]`).dispatchEvent(event);
    });
    const start = { x: shape.x + shape.width, y: shape.y + shape.height };
    const end = { x: start.x + 30, y: start.y + 20 };
    await act(async () => pointer(target('[data-object-resize-corner="bottom-right"]'), "pointerdown", start, true));
    await act(async () => pointer(target(".page"), "pointermove", end, true));
    await act(async () => pointer(target(".page"), "pointerup", end, true));
    expect(snapshot().pages[0].objects).toHaveLength(1);
    expect(snapshot().pages[0].objects[0]!.width).not.toBe(shape.width);
    expect(container.querySelector(".text-object-editor")).toBeNull();
    await command(forceDocumentHistoryCommandId("edit.undo"));
    expect(snapshot().pages[0].objects).toEqual(initial.pages[0].objects);
  });

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
