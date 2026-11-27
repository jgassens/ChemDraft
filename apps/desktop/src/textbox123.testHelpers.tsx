import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import type { TextObject } from "@chemdraft/chem-core";
import {
  nativeTextEditorCaret, planNativeTextEditorLayout, planTextObjectPlacement, type NativeTextCaretAffinity
} from "@chemdraft/layout-engine";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTextObject, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";

/**
 * Real-event harness for the 1.2.3 text box spec (docs/plans/textbox-behavior.md).
 * Every gesture is dispatched as the browser sends it: pointer events at client
 * coordinates over the rendered text, then keydown/beforeinput/input/keyup with the
 * browser's default text action applied only when the app did not prevent it. The agent
 * bridge snapshot is used only to READ the committed document, never to drive it.
 *
 * jsdom has no layout: getBoundingClientRect is 0, so client = page * scale, and there
 * is no SVG glyph measurement, so the editor uses the layout engine's advances.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

export const OWNER_TEXT = "now is the time for all good men to come to the aid of their party. and do other things in this day and age... jhehehehe'";

/** Explicit per-test timeouts: each typed key is a full MainWindow commit, so a loaded machine
 * can take several times the local run's second or so. */
export const TEXTBOX_TEST_TIMEOUT = 20_000;
export const TEXTBOX_TYPING_TEST_TIMEOUT = 60_000;

/** The text as the editor's textarea holds it: a textarea turns CRLF and a lone CR into LF. */
export const textareaText = (text: string) => text.replace(/\r\n?/g, "\n");

const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;

export function textboxHarness(platform: ShortcutPlatform) {
  let container: HTMLDivElement;
  let root: Root;
  let captureDescriptors: Array<PropertyDescriptor | undefined> = [];
  let objectId = "";
  let lastTime = 1000;

  const setup = () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "macos" ? "MacIntel" : "Win32" });
    captureDescriptors = captureMethods.map(name => Object.getOwnPropertyDescriptor(Element.prototype, name));
    for (const name of captureMethods) Object.defineProperty(Element.prototype, name, { configurable: true, value: () => false });
    saveKeybindingSettings({ scheme: "chemdraw" });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  };

  const teardown = () => {
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
  };

  const object = (): TextObject =>
    window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0]!.objects.find(candidate => candidate.id === objectId) as TextObject;
  const editor = () => container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
  const chrome = () => editor().closest<HTMLElement>("[data-object-chrome]")!;
  const scale = () => Number(chrome().style.getPropertyValue("--page-scale")) || 1;
  // Offsets as the textarea counts them: an object stored with CRLF is read with LF breaks.
  const layout = () => {
    const current = object();
    const text = textareaText(current.text);
    return planNativeTextEditorLayout(text === current.text ? current
      : { ...current, text, spans: [{ text, script: "normal", style: {} }] });
  };
  const caret = () => container.querySelector<HTMLElement>(".text-editor-caret");
  const selectionRects = () => [...container.querySelectorAll<HTMLElement>(".text-editor-selection-rect")];
  const glyphs = () => [...container.querySelectorAll(`.page-svg-visual-layer [data-page-svg-object-visual="${objectId}"] text > tspan`)];
  const settle = async (ms = 50) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

  /** Client point of a caret stop: the boundary between two rendered glyphs (unrotated boxes). */
  const clientAt = (offset: number, affinity: NativeTextCaretAffinity = "downstream", dx = 0) => {
    const current = object();
    const caretPoint = nativeTextEditorCaret(layout(), offset, affinity);
    return {
      x: (current.x + caretPoint.x + dx) * scale(),
      y: (current.y + (caretPoint.top + caretPoint.bottom) / 2) * scale()
    };
  };

  const pointer = async (target: Element, type: string, point: { x: number; y: number },
    init: { buttons?: number; shiftKey?: boolean; detail?: number; timeGap?: number } = {}) => {
    let prevented = false;
    await act(async () => {
      const isPointer = type.startsWith("pointer");
      const event = new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, buttons: init.buttons ?? (type.endsWith("up") || type === "click" ? 0 : 1),
        clientX: point.x, clientY: point.y, detail: init.detail ?? (isPointer ? 0 : 1), shiftKey: init.shiftKey ?? false
      });
      lastTime += init.timeGap ?? 60;
      Object.defineProperties(event, {
        pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true }, timeStamp: { value: lastTime }
      });
      target.dispatchEvent(event);
      prevented = event.defaultPrevented;
    });
    return prevented;
  };

  /** A browser click: pointerdown, mousedown (unless prevented), pointerup, mouseup, click. */
  const click = async (target: Element, point: { x: number; y: number }, init: { shiftKey?: boolean; detail?: number; timeGap?: number } = {}) => {
    const downPrevented = await pointer(target, "pointerdown", point, { shiftKey: init.shiftKey, timeGap: init.timeGap });
    if (!downPrevented) await pointer(target, "mousedown", point, { shiftKey: init.shiftKey, detail: init.detail });
    await pointer(target, "pointerup", point, { shiftKey: init.shiftKey });
    if (!downPrevented) await pointer(target, "mouseup", point, { shiftKey: init.shiftKey, detail: init.detail });
    await pointer(target, "click", point, { shiftKey: init.shiftKey, detail: init.detail });
  };

  /** Mount a text box and open it for editing with a real Text-tool click on its glyphs.
   * `stored` puts the text into the document exactly as given (an older file with CRLF). */
  const mount = async (text: string, options: { width: number; mode?: "fixed-width" | "auto"; x?: number; y?: number; stored?: boolean }) => {
    let doc = createPhase4Document("Text box");
    doc = structuredClone(insertNativeTextObject(doc, { x: options.x ?? 100, y: options.y ?? 100 }, text));
    const inserted = doc.pages[0]!.objects.find(candidate => candidate.type === "text") as TextObject;
    objectId = inserted.id;
    Object.assign(inserted, { width: options.width });
    // insertNativeTextObject puts "Text" in an empty box; start from a really empty one.
    if (text === "") Object.assign(inserted, { text: "", spans: [] });
    else if (options.stored) Object.assign(inserted, { text, spans: [{ text, script: "normal", style: {} }] });
    inserted.style = { ...inserted.style, textBoxSizingMode: options.mode ?? "fixed-width" };
    doc = selectDocumentObjects(doc, doc.pages[0]!.id, [objectId]);
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialActiveToolCommandId: "tool.text", initialCrosshairsVisible: false,
      initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true, shortcutPlatform: platform
    })));
    const glyph = glyphs()[0]!;
    const placement = planTextObjectPlacement(inserted);
    await click(glyph, { x: placement.x + 2, y: placement.y - 2 });
    await settle(100);
    if (!editor()) throw new Error("text editor did not open");
    return editor();
  };

  const setValue = (target: HTMLTextAreaElement, value: string) =>
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(target, value);

  /** Insert text as the browser does: keydown, beforeinput, then (unless prevented) replace the
   * selection and fire input, then keyup. Returns whether the app prevented the default. */
  const type = async (data: string, inputType = data === "\n" ? "insertLineBreak" : "insertText",
    keyInit: KeyboardEventInit = {}) => {
    for (const character of data === "\n" ? ["\n"] : [...data]) {
      const key = character === "\n" ? "Enter" : character;
      let prevented = false;
      await act(async () => {
        const target = editor();
        const keydown = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...keyInit });
        target.dispatchEvent(keydown);
        prevented = keydown.defaultPrevented;
        if (!prevented) {
          const beforeInput = new InputEvent("beforeinput", { inputType, data: character === "\n" ? null : character, bubbles: true, cancelable: true });
          target.dispatchEvent(beforeInput);
          prevented = beforeInput.defaultPrevented;
        }
        if (!prevented) {
          const start = target.selectionStart, end = target.selectionEnd;
          setValue(target, target.value.slice(0, start) + character + target.value.slice(end));
          target.setSelectionRange(start + character.length, start + character.length);
          target.dispatchEvent(new InputEvent("input", { inputType, data: character === "\n" ? null : character, bubbles: true }));
        }
        target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, ...keyInit }));
      });
    }
  };

  /** Backspace/Delete as the browser does when not prevented: delete the selection, or one
   * character before/after the caret. */
  const deleteKey = async (key: "Backspace" | "Delete", keyInit: KeyboardEventInit = {}) => {
    await act(async () => {
      const target = editor();
      const keydown = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...keyInit });
      target.dispatchEvent(keydown);
      if (keydown.defaultPrevented) return;
      const inputType = key === "Backspace" ? "deleteContentBackward" : "deleteContentForward";
      const beforeInput = new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true });
      target.dispatchEvent(beforeInput);
      if (beforeInput.defaultPrevented) return;
      let start = target.selectionStart, end = target.selectionEnd;
      if (start === end) {
        if (key === "Backspace") start = Math.max(0, start - 1); else end = Math.min(target.value.length, end + 1);
      }
      setValue(target, target.value.slice(0, start) + target.value.slice(end));
      target.setSelectionRange(start, start);
      target.dispatchEvent(new InputEvent("input", { inputType, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, ...keyInit }));
    });
  };

  /** A navigation key. jsdom has no native caret movement, so an unprevented key leaves the
   * selection where it was (a browser would move it through the hidden textarea layout). */
  const press = async (key: string, keyInit: KeyboardEventInit = {}) => {
    let prevented = false;
    await act(async () => {
      const target = editor();
      const keydown = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...keyInit });
      target.dispatchEvent(keydown);
      prevented = keydown.defaultPrevented;
      target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, ...keyInit }));
    });
    await settle(20);
    return prevented;
  };

  const caretBox = () => {
    const element = caret();
    if (!element || element.hidden || element.style.display === "none") return undefined;
    return {
      left: parseFloat(element.style.left), top: parseFloat(element.style.top), height: parseFloat(element.style.height),
      line: Number(element.dataset.caretLine), offset: Number(element.dataset.caretOffset)
    };
  };

  /** A drag over the rendered text from one caret stop to another. */
  const drag = async (from: number, to: number) => {
    const target = editor();
    await pointer(target, "pointerdown", clientAt(from), { timeGap: 1000 });
    await pointer(target, "pointermove", clientAt(to));
    await pointer(target, "pointerup", clientAt(to));
  };

  /** A plain-text paste as the browser sends it: the command key, then the paste event. */
  const paste = async (data: Record<string, string>, keyInit: KeyboardEventInit) => {
    await act(async () => {
      const target = editor();
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true, cancelable: true, ...keyInit }));
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => data[type] ?? "", types: Object.keys(data) } });
      target.dispatchEvent(event);
    });
    await settle(50);
  };

  /** IME composition as the browser sends it: the first update replaces the selection, each
   * later update replaces the text being composed, and compositionend commits it. */
  const compose = async (updates: readonly string[], onUpdate?: (composing: string) => void) => {
    const target = editor();
    const start = target.selectionStart, end = target.selectionEnd;
    const before = target.value.slice(0, start), after = target.value.slice(end);
    await act(async () => {
      target.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
    });
    for (const composing of updates) {
      await act(async () => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", keyCode: 229, isComposing: true, bubbles: true, cancelable: true } as KeyboardEventInit));
        target.dispatchEvent(new CompositionEvent("compositionupdate", { data: composing, bubbles: true }));
        setValue(target, before + composing + after);
        target.setSelectionRange(before.length + composing.length, before.length + composing.length);
        target.dispatchEvent(new InputEvent("input", { inputType: "insertCompositionText", data: composing, isComposing: true, bubbles: true }));
      });
      onUpdate?.(composing);
    }
    await act(async () => {
      target.dispatchEvent(new CompositionEvent("compositionend", { data: updates[updates.length - 1] ?? "", bubbles: true }));
    });
  };

  /** Where the model says the caret for the textarea's selection is drawn, in chrome-local px. */
  const expectedCaretBox = (affinity: NativeTextCaretAffinity = "downstream") => {
    const target = editor();
    const offset = target.selectionDirection === "backward" ? target.selectionStart : target.selectionEnd;
    const caretPoint = nativeTextEditorCaret(layout(), offset, affinity);
    return { left: caretPoint.x * scale(), top: caretPoint.top * scale(), line: caretPoint.lineIndex, offset };
  };

  return {
    setup, teardown, mount, object, editor, chrome, scale, layout, caret, caretBox, expectedCaretBox, selectionRects,
    glyphs, settle, clientAt, pointer, click, drag, type, deleteKey, press, paste, compose, setValue,
    get container() { return container; }
  };
}
