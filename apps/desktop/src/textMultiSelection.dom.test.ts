// @vitest-environment jsdom

import { act, createElement } from "react";
import type { ChemDraftDocument, TextObject } from "@chemdraft/chem-core";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule, insertNativeTextObject, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("multiple selected text formatting (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let objectId: string;
  const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let captureDescriptors: Array<PropertyDescriptor | undefined>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "macos" ? "MacIntel" : "Win32" });
    captureDescriptors = captureMethods.map(name => Object.getOwnPropertyDescriptor(Element.prototype, name));
    for (const name of captureMethods) {
      Object.defineProperty(Element.prototype, name, { configurable: true, value: () => false });
    }
    saveKeybindingSettings({ scheme: "chemdraft" });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    captureMethods.forEach((name, index) => {
      const descriptor = captureDescriptors[index];
      if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
      else Reflect.deleteProperty(Element.prototype, name);
    });
    Reflect.deleteProperty(navigator, "platform");
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
  });

  async function mount(tool = "tool.select", selected = false, withSecondText = false, selectBoth: boolean | "reverse" = false) {
    let doc = insertNativeTextObject(createPhase4Document("Text editing"), { x: 200, y: 200 }, "Reaction conditions");
    objectId = doc.pages[0].objects.find(object => object.type === "text")!.id;
    if (withSecondText) doc = insertNativeTextObject(doc, { x: 400, y: 300 }, "Other label");
    const selectedIds = selectBoth
      ? doc.pages[0].objects.filter(object => object.type === "text").map(object => object.id)
      : selected ? [objectId] : [];
    doc = selectDocumentObjects(doc, doc.pages[0].id, selectBoth === "reverse" ? selectedIds.reverse() : selectedIds);
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialActiveToolCommandId: tool, initialCrosshairsVisible: false,
      initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      element.getBoundingClientRect = () => rect;
    }
  }

  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const editor = () => container.querySelector<HTMLTextAreaElement>(".text-object-editor");
  const texts = (doc: ChemDraftDocument) => doc.pages[0].objects.filter((object): object is TextObject => object.type === "text");

  it.each([false, true])("formats every selected text box in one Undo step (reverse selection: %s)", async reverse => {
    await mount("tool.select", true, true, reverse ? "reverse" : true);
    const original = snapshot().document;
    const ids = original.selection.objectIds;
    const command = async (id: string) => {
      await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(id); });
    };
    await command("text.font.times");
    const fontChanged = snapshot().document;
    expect(texts(fontChanged).filter(object => ids.includes(object.id)).map(object => object.style.fontFamily))
      .toEqual(["Times New Roman, Times, serif", "Times New Roman, Times, serif"]);
    await command("text.size.20");
    const sized = snapshot().document;
    expect(texts(sized).filter(object => ids.includes(object.id)).map(object => object.style.fontSizePx))
      .toEqual([26.667, 26.667]);
    expect(sized.selection).toEqual(original.selection);
    await command("edit.undo");
    expect(snapshot().document.pages).toEqual(fontChanged.pages);
    await command("edit.undo");
    expect(snapshot().document.pages).toEqual(original.pages);
    await command("edit.redo");
    await command("edit.redo");
    expect(snapshot().document.pages).toEqual(sized.pages);
  });

  it("keeps an unselected text box unchanged", async () => {
    await mount("tool.select", true, true);
    const original = snapshot().document.pages[0].objects[1];
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("text.size.20"); });
    expect(texts(snapshot().document)[0].style.fontSizePx).toBe(26.667);
    expect(snapshot().document.pages[0].objects[1]).toEqual(original);
  });

  it("keeps character-range formatting inside the active editor", async () => {
    await mount("tool.text", false, true);
    const original = snapshot().document.pages[0].objects;
    await click(glyph(), 1);
    await act(async () => {
      const input = editor()!;
      input.setSelectionRange(0, 8);
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
    });
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("text.size.20"); });
    const objects = snapshot().document.pages[0].objects;
    expect(objects[0].style).toEqual(original[0].style);
    expect(objects[0]).toMatchObject({ spans: [
      { text: "Reaction", style: { fontSizePx: 26.667 } },
      { text: " conditions", style: {} }
    ] });
    expect(objects[1]).toEqual(original[1]);
    expect(editor()).not.toBeNull();
  });

  it("formats text boxes in a mixed selection without changing molecules or unselected labels", async () => {
    let doc = insertNativeSingleBondMolecule(createPhase4Document("Mixed selection"), { x: 60, y: 80 });
    doc = insertNativeTextObject(doc, { x: 200, y: 200 }, "First label");
    doc = insertNativeTextObject(doc, { x: 400, y: 200 }, "Second label");
    doc = insertNativeTextObject(doc, { x: 400, y: 350 }, "Leave this label alone");
    const original = doc.pages[0].objects;
    doc = selectDocumentObjects(doc, doc.pages[0].id, original.slice(0, 3).map(object => object.id));
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden", nativePalette: true,
      initialRulersVisible: false, initialCrosshairsVisible: false
    })));
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("text.size.20"); });
    const after = snapshot().document;
    expect(after.pages[0].objects[0]).toEqual(original[0]);
    expect(after.pages[0].objects[3]).toEqual(original[3]);
    expect(texts(after).slice(0, 2).map(object => object.style.fontSizePx)).toEqual([26.667, 26.667]);
    expect(after.selection).toEqual(doc.selection);
  });
  function glyph() {
    // Document-order SVG layers paint the glyph; the HTML overlay and top interaction chrome
    // are pointer-transparent. Before editing, elementFromPoint on the visible text hits this
    // text/tspan subtree, whose owning group enables pointer events. Never dispatch to the overlay.
    const text = container.querySelector<SVGElement>(`.page-svg-visual-layer [data-page-svg-object-visual="${objectId}"] text`)!;
    expect(text).not.toBeNull();
    const target = text.querySelector<SVGElement>("tspan") ?? text;
    target.setAttribute("tabindex", "-1");
    return target;
  }

  async function mouse(target: Element, type: string, detail: number) {
    let prevented = false;
    await act(async () => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
        buttons: type.endsWith("down") ? 1 : 0, clientX: 220, clientY: 208, detail });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      target.dispatchEvent(event);
      prevented = event.defaultPrevented;
    });
    return prevented;
  }

  async function click(target: SVGElement, count: number) {
    // Mouse pointerdown.detail is zero in real browsers. Model the companion mousedown's
    // default focus action explicitly: untrusted bridge/jsdom events do not perform it.
    const prevented = await mouse(target, "pointerdown", 0);
    if (!prevented) {
      const mousePrevented = await mouse(target, "mousedown", count);
      if (!mousePrevented) await act(async () => target.focus());
    }
    expect(snapshot().document.selection.objectIds).toEqual([objectId]);
    await mouse(target, "pointerup", 0);
    expect(snapshot().document.selection.objectIds).toEqual([objectId]);
    await mouse(target, "mouseup", count);
    await mouse(target, "click", count);
    expect(snapshot().document.selection.objectIds).toEqual([objectId]);
    expect(container.querySelector('[role="status"]')?.textContent).not.toBe("No selection");
  }

});
