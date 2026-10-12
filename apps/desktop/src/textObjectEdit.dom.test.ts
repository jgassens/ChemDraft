// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTextObject, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("existing text editing (%s)", platform => {
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

  async function mount(tool = "tool.select", selected = false) {
    let doc = insertNativeTextObject(createPhase4Document("Text editing"), { x: 200, y: 200 }, "Reaction conditions");
    objectId = doc.pages[0].objects.find(object => object.type === "text")!.id;
    doc = selectDocumentObjects(doc, doc.pages[0].id, selected ? [objectId] : []);
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
  function glyph() {
    // The painted SVG glyph is above the pointer-transparent HTML overlay. Do not dispatch
    // to the overlay: elementFromPoint on the visible text returns this text/tspan subtree.
    const text = container.querySelector<SVGElement>(`.page-svg-surface text[data-object-id="${objectId}"], .page-svg-surface [data-object-id="${objectId}"] text`)!;
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

  function expectEditing() {
    expect(editor()?.value).toBe("Reaction conditions");
    expect(editor()?.closest("[data-object-id]")?.getAttribute("data-object-id")).toBe(objectId);
    expect(document.activeElement).toBe(editor());
    expect(editor()?.selectionStart).toBe("Reaction conditions".length);
    expect(editor()?.selectionEnd).toBe("Reaction conditions".length);
    expect(snapshot().document.pages[0].objects).toHaveLength(1);
  }

  it.each(["tool.select", "tool.text"])("double-clicks the painted glyph with %s without clearing selection", async tool => {
    await mount(tool);
    const target = glyph();
    await click(target, 1);
    await click(target, 2);
    await mouse(target, "dblclick", 2);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expectEditing();
  });

  it("Text-tool single-click edits existing text and survives the default focus action", async () => {
    await mount("tool.text");
    await click(glyph(), 1);
    expectEditing();
  });

  it("keeps editing through the second glyph press after Text restores Select", async () => {
    await mount();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true, cancelable: true })); });
    expect(snapshot().activeToolCommandId).toBe("tool.text");
    const target = glyph();
    await click(target, 1);
    expect(snapshot().activeToolCommandId).toBe("tool.select");
    const firstEditor = editor();
    await click(target, 2);
    expect(editor()).toBe(firstEditor);
    await mouse(target, "dblclick", 2);
    expectEditing();
  });

  it.each(["command", "T"])("creates a second text after activating Text by %s with text selected", async activation => {
    await mount("tool.select", true);
    const originalText = snapshot().document.pages[0].objects[0];
    await act(async () => {
      if (activation === "command") await window.__CHEMDRAFT_AGENT__!.command("tool.text");
      else window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true, cancelable: true }));
    });
    expect(snapshot().activeToolCommandId).toBe("tool.text");
    expect(editor()).toBeNull();
    expect(snapshot().document.selection.objectIds).toEqual([objectId]);
    await act(async () => {
      const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true,
        button: 0, buttons: 1, clientX: 400, clientY: 350 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector(".page")!.dispatchEvent(event);
    });
    const newEditor = editor()!;
    expect(newEditor).not.toBeNull();
    expect(newEditor.value).toBe("Text");
    const texts = snapshot().document.pages[0].objects.filter(object => object.type === "text");
    expect(texts).toHaveLength(2);
    expect(texts.find(object => object.id === objectId)).toEqual(originalText);
    const newText = texts.find(object => object.id !== objectId)!;
    expect(newText).toMatchObject({ type: "text", text: "Text" });
    expect(newEditor.closest("[data-object-id]")?.getAttribute("data-object-id")).toBe(newText.id);
    expect(document.activeElement).toBe(newEditor);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(newEditor, "New conditions");
      newEditor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { newEditor.blur(); });
    const objects = snapshot().document.pages[0].objects;
    expect(objects).toHaveLength(2);
    expect(objects.find(object => object.id === objectId)).toEqual(originalText);
    expect(objects.find(object => object.id !== objectId)).toMatchObject({ type: "text", text: "New conditions" });
  });
});
