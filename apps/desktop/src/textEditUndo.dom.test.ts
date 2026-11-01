// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoleculeObject, TextObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTextObject, selectDocumentObjects } from "./documentWorkflow";
import { beginAssistantTransaction, endAssistantTransaction, writeAssistantTransaction } from "./assistant/assistantTransaction";
import { forceDocumentHistoryCommandId } from "./editHistoryRouting";
import { DOM_COMMAND_EVENT, PALETTE_COMMAND_CANCEL_EVENT, PALETTE_COMMAND_COMMIT_EVENT, PALETTE_COMMAND_PREVIEW_EVENT } from "./window-manager";
import { moleculeStructureBondColorCommandId } from "./commands";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["macos", "windows"] as const)("text edit history (%s)", platform => {
  let container: HTMLDivElement, root: Root;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const texts = () => snapshot().document.pages[0].objects.filter(object => object.type === "text") as TextObject[];
  const editor = () => container.querySelector<HTMLTextAreaElement>(".text-object-editor");
  const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let captureDescriptors: Array<PropertyDescriptor | undefined>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    captureDescriptors = captureMethods.map(name => Object.getOwnPropertyDescriptor(Element.prototype, name));
    for (const name of captureMethods) Object.defineProperty(Element.prototype, name, { configurable: true, value: () => false });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: createPhase4Document("Text undo"), initialPaletteMode: "hidden", nativePalette: true,
      initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    captureMethods.forEach((name, index) => {
      const descriptor = captureDescriptors[index];
      if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
      else Reflect.deleteProperty(Element.prototype, name);
    });
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });

  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  async function pagePress(x = 100, y = 500) {
    await act(async () => {
      const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector(".page")!.dispatchEvent(event);
    });
  }
  async function type(value: string) {
    expect(editor()).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), value);
      editor()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function place(value: string, x: number) {
    await command("tool.text"); await pagePress(x, 200); await type(value); await pagePress();
    expect(editor()).toBeNull();
    return texts().find(object => object.text === value)!.id;
  }
  async function open(id: string) {
    const glyph = container.querySelector(`[data-page-svg-object-visual="${id}"] text`)!;
    await act(async () => glyph.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(editor()).not.toBeNull(); expect(document.activeElement).toBe(editor());
  }

  async function glyphPress(id: string) {
    const glyph = container.querySelector(`[data-page-svg-object-visual="${id}"] text`)!;
    await act(async () => {
      const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 100, clientY: 100 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      glyph.dispatchEvent(event);
    });
    await act(async () => vi.advanceTimersByTimeAsync(100));
  }
  async function palette(event: string, color: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(event, { detail: { commandId: moleculeStructureBondColorCommandId(color) } })));
  }
  async function dragRight(id: string, dx: number) {
    const typed = texts().find(object => object.id === id)!;
    const handle = container.querySelector(`[data-object-id="${id}"] [data-text-resize-edge="right"]`)!;
    const pointer = async (target: Element, kind: string, x: number) => act(async () => {
      const event = new MouseEvent(kind, { bubbles: true, cancelable: true, button: 0,
        buttons: kind === "pointerup" ? 0 : 1, clientX: x, clientY: typed.y + typed.height });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      target.dispatchEvent(event);
    });
    const page = container.querySelector(".page")!;
    await pointer(handle, "pointerdown", typed.x + typed.width);
    await pointer(page, "pointermove", typed.x + typed.width + dx);
    await pointer(page, "pointerup", typed.x + typed.width + dx);
  }
  const undo = () => command(forceDocumentHistoryCommandId("edit.undo"));
  const redo = () => command(forceDocumentHistoryCommandId("edit.redo"));

  it("records one labelled edit across keystrokes and redoes it without losing Beta", async () => {
    const alpha = await place("Alpha", 200); await place("Beta", 400); await open(alpha);
    for (const value of ["Alpha1", "Alpha12", "Alpha123"]) await type(value);
    await pagePress(); await undo();
    expect(container.textContent).toContain("Undid Edit Text");
    expect(texts().map(object => object.text)).toEqual(["Alpha", "Beta"]);
    await redo(); expect(container.textContent).toContain("Redid Edit Text");
    expect(texts().map(object => object.text)).toEqual(["Alpha123", "Beta"]);
    await undo(); await undo(); expect(texts().map(object => object.text)).toEqual(["Alpha"]);
    await undo(); expect(texts()).toEqual([]);
  });

  it("redoes an edit with the platform keyboard shortcut", async () => {
    const alpha = await place("Alpha", 200); await place("Beta", 400);
    await open(alpha); await type("Alpha123"); await pagePress(); await undo();
    expect(texts().map(object => object.text)).toEqual(["Alpha", "Beta"]);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: platform === "windows" ? "y" : "z", bubbles: true, cancelable: true,
      ctrlKey: platform === "windows", metaKey: platform === "macos", shiftKey: platform === "macos"
    })));
    expect(texts().map(object => object.text)).toEqual(["Alpha123", "Beta"]);
    expect(container.textContent).toContain("Redid Edit Text");
  });

  it.each([false, true])("keeps resize history linear during an open edit (typing changed: %s)", async changed => {
    const alpha = await place("Alpha", 200); await place("Beta", 400);
    const before = texts()[0];
    await open(alpha);
    if (changed) await type("Alpha123");
    const textarea = editor();
    const typed = texts()[0];
    const handle = container.querySelector(`[data-object-id="${alpha}"] [data-text-resize-edge="right"]`)!;
    const pointer = async (target: Element, kind: string, x: number) => act(async () => {
      const event = new MouseEvent(kind, { bubbles: true, cancelable: true, button: 0,
        buttons: kind === "pointerup" ? 0 : 1, clientX: x, clientY: typed.y + typed.height });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      target.dispatchEvent(event);
    });
    const page = container.querySelector(".page")!;
    await pointer(handle, "pointerdown", typed.x + typed.width);
    expect(editor()).not.toBeNull();
    await pointer(page, "pointermove", typed.x + typed.width + 40);
    await pointer(page, "pointerup", typed.x + typed.width + 40);
    expect(editor()).toBe(textarea);
    expect(texts()[0].width).toBe(typed.width + 40);
    const resized = texts()[0];
    await type(`${typed.text}4`);
    await pagePress();
    await undo(); expect(texts()[0]).toEqual(resized);
    expect(container.textContent).toContain("Undid Edit Text");
    await undo(); expect(texts()[0]).toEqual(typed);
    expect(texts().map(object => object.text)).toEqual([changed ? "Alpha123" : "Alpha", "Beta"]);
    if (changed) {
      await undo(); expect(texts()[0]).toEqual(before);
      expect(container.textContent).toContain("Undid Edit Text");
      expect(texts().map(object => object.text)).toEqual(["Alpha", "Beta"]);
    }
    await undo(); expect(texts().map(object => object.text)).toEqual(["Alpha"]);
  });

  it("keeps a just-placed edit open through resize and converts only when it finishes", async () => {
    await command("tool.text"); await pagePress(200, 200); await type("N");
    const typed = texts()[0];
    const handle = container.querySelector(`[data-object-id="${typed.id}"] [data-text-resize-edge="right"]`)!;
    const pointer = async (target: Element, kind: string, x: number) => act(async () => {
      const event = new MouseEvent(kind, { bubbles: true, cancelable: true, button: 0,
        buttons: kind === "pointerup" ? 0 : 1, clientX: x, clientY: typed.y + typed.height });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      target.dispatchEvent(event);
    });
    const page = container.querySelector(".page")!;
    await pointer(handle, "pointerdown", typed.x + typed.width);
    expect(editor()?.value).toBe("N");
    await pointer(page, "pointermove", typed.x + typed.width + 40);
    await pointer(page, "pointerup", typed.x + typed.width + 40);
    expect(editor()?.value).toBe("N");
    const resized = { ...typed, width: typed.width + 40, style: { ...typed.style, textBoxSizingMode: "fixed-width" } };
    expect(snapshot().document.pages[0].objects).toEqual([resized]);
    await pagePress();
    const converted = snapshot().document.pages[0].objects;
    expect(converted).toHaveLength(1);
    expect(converted[0]).toMatchObject({ type: "molecule", atoms: [{ element: "N" }] });
    await undo(); expect(snapshot().document.pages[0].objects).toEqual([resized]);
    await undo(); expect(snapshot().document.pages[0].objects).toEqual([typed]);
    await undo(); expect(snapshot().document.pages[0].objects).toEqual([]);
    await redo(); expect(snapshot().document.pages[0].objects).toEqual([typed]);
    await redo(); expect(snapshot().document.pages[0].objects).toEqual([resized]);
    await redo(); expect(snapshot().document.pages[0].objects).toEqual(converted);
  });

  it("records an open edit before an assistant transaction writes", async () => {
    const alpha = await place("Alpha", 200); await place("Beta", 400);
    await open(alpha); await type("Alpha123");
    await act(async () => {
      const current = snapshot().document;
      const tx = beginAssistantTransaction({ pluginId: "org.chemdraft.assistant", runId: "text-edit",
        tabId: "initial", label: "Insert caption", sendSelection: current.selection });
      try { writeAssistantTransaction(tx, insertNativeTextObject(current, { x: 500, y: 350 }, "Gamma")); }
      finally { endAssistantTransaction(tx, { touchedIds: [] }); }
    });
    expect(editor()?.value).toBe("Alpha123");
    expect(texts().map(object => object.text)).toEqual(["Alpha123", "Beta", "Gamma"]);
    await type("Alpha1234");
    await pagePress(); await undo();
    expect(texts().map(object => object.text)).toEqual(["Alpha123", "Beta", "Gamma"]);
    await undo();
    expect(texts().map(object => object.text)).toEqual(["Alpha123", "Beta"]);
    await undo(); expect(texts().map(object => object.text)).toEqual(["Alpha", "Beta"]);
    expect(container.textContent).toContain("Undid Edit Text");
    await undo(); expect(texts().map(object => object.text)).toEqual(["Alpha"]);
  });

  it.each([false, true])("adds no phantom entry for an unchanged edit (reverted typing: %s)", async reverted => {
    const alpha = await place("Alpha", 200); await place("Beta", 400); await open(alpha);
    if (reverted) { await type("Alpha123"); await type("Alpha"); }
    await pagePress(); await undo();
    expect(texts().map(object => object.text)).toEqual(["Alpha"]);
    await undo(); expect(texts()).toEqual([]);
  });

  it("groups typing and selected-range bold into the same Edit Text entry", async () => {
    const alpha = await place("Alpha", 200); await place("Beta", 400);
    const before = texts()[0]; await open(alpha); await type("Alpha123");
    await act(async () => {
      editor()!.setSelectionRange(5, 8);
      editor()!.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
    });
    await command("text.bold");
    expect(editor()).not.toBeNull();
    expect(texts()[0].spans.find(span => span.text === "123")?.style.fontWeight).toBe(700);
    await type("Alpha1234"); await pagePress(); const after = texts()[0];
    await undo(); expect(texts()[0]).toEqual(before);
    expect(container.textContent).toContain("Undid Edit Text");
    await redo(); expect(texts()[0]).toEqual(after);
    await undo(); await undo(); expect(texts().map(object => object.text)).toEqual(["Alpha"]);
  });

  it.each(["blur", "Escape", "tool switch", "another edit"])("commits on %s and clears the session snapshot", async finish => {
    const alpha = await place("Alpha", 200); const beta = await place("Beta", 400);
    await open(alpha); await type("Alpha123");
    if (finish === "blur") await act(async () => editor()!.blur());
    else if (finish === "Escape") await act(async () => editor()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    else if (finish === "tool switch") await command("tool.select");
    else { await open(beta); await type("Beta456"); await pagePress(); await undo(); }
    await undo(); expect(texts().map(object => object.text)).toEqual(["Alpha", "Beta"]);
    expect(container.textContent).toContain("Undid Edit Text");
    await open(alpha); await pagePress(); await undo();
    expect(texts().map(object => object.text)).toEqual(["Alpha"]);
  });

  it("keeps focused native typing undo, but commits before forced document Undo", async () => {
    const alpha = await place("Alpha", 200); await place("Beta", 400); await open(alpha); await type("Alpha123");
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    try {
      const event = new KeyboardEvent("keydown", { key: "z", bubbles: true, cancelable: true,
        metaKey: platform === "macos", ctrlKey: platform === "windows" });
      await act(async () => editor()!.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      await command("edit.undo"); expect(execCommand).toHaveBeenCalledWith("undo");
      expect(editor()?.value).toBe("Alpha123");
      await undo(); expect(editor()).toBeNull();
      expect(texts().map(object => object.text)).toEqual(["Alpha", "Beta"]);
      await redo(); expect(texts().map(object => object.text)).toEqual(["Alpha123", "Beta"]);
    } finally { Reflect.deleteProperty(document, "execCommand"); }
  });

  it("settles an open edit before switching tabs and never applies its snapshot to another tab", async () => {
    const alpha = await place("Alpha", 200); await place("Beta", 400);
    await command("document.new"); await command("document.previousTab");
    await open(alpha); await type("Alpha123"); await command("document.nextTab");
    expect(texts()).toEqual([]); await undo(); expect(texts()).toEqual([]);
    await command("document.previousTab"); await undo();
    expect(texts().map(object => object.text)).toEqual(["Alpha", "Beta"]);
    await redo(); expect(texts().map(object => object.text)).toEqual(["Alpha123", "Beta"]);
  });

  it("keeps first typing and formatting of newly placed text in the placement entry", async () => {
    await command("tool.text"); await pagePress(200, 200); await type("Alpha"); await command("text.bold");
    await pagePress(); expect(texts()[0].style.fontWeight).toBe(700);
    await undo(); expect(texts()).toEqual([]);
    await redo(); expect(texts()[0]).toMatchObject({ text: "Alpha", style: { fontWeight: 700 } });
  });

  it("finishes before the close prompt, preserves undo on Cancel and drops the snapshot on Discard", async () => {
    const alpha = await place("Alpha", 200); await place("Beta", 400);
    const close = () => act(async () => container.querySelector<HTMLButtonElement>(".document-tab-close")!.click());
    await open(alpha); await type("Alpha123"); await close();
    expect(editor()).toBeNull();
    const prompt = () => container.querySelector('[role="dialog"][aria-label="Save changes before closing?"]')!;
    expect(prompt()).not.toBeNull();
    await act(async () => [...prompt().querySelectorAll("button")].find(button => button.textContent === "Cancel")!.click());
    await undo(); expect(texts().map(object => object.text)).toEqual(["Alpha", "Beta"]);
    expect(container.textContent).toContain("Undid Edit Text");
    await open(alpha); await type("Alpha456"); await close();
    await act(async () => [...prompt().querySelectorAll("button")].find(button => button.textContent === "Don't Save")!.click());
    expect(texts()).toEqual([]); await undo(); expect(texts()).toEqual([]);
    expect(container.textContent).toContain("Nothing to undo");
  });

  it("keeps the first edit's atom conversion entry and never converts a reopened text box", async () => {
    await command("tool.text"); await pagePress(200, 200); await type("N"); await pagePress();
    expect(texts()).toEqual([]);
    expect(snapshot().document.pages[0].objects[0]).toMatchObject({ type: "molecule", atoms: [{ element: "N" }] });
    await undo(); expect(texts().map(object => object.text)).toEqual(["N"]);
    await undo(); expect(snapshot().document.pages[0].objects).toEqual([]);
    const alpha = await place("Alpha", 200); await open(alpha); await type("N"); await pagePress();
    expect(texts().map(object => object.text)).toEqual(["N"]);
    await undo(); expect(texts().map(object => object.text)).toEqual(["Alpha"]);
    expect(container.textContent).toContain("Undid Edit Text");
  });

  it("forced Undo of a just-placed first edit removes the placement without atom conversion", async () => {
    await command("tool.text"); await pagePress(200, 200); await type("N");
    expect(editor()?.value).toBe("N");
    await undo();
    expect(editor()).toBeNull();
    expect(snapshot().document.pages[0].objects).toEqual([]);
    await redo();
    expect(texts().map(object => object.text)).toEqual(["N"]);
    await undo(); expect(snapshot().document.pages[0].objects).toEqual([]);
  });

  it("forced Redo closes a just-placed first edit without atom conversion", async () => {
    await command("tool.text"); await pagePress(200, 200); await type("N");
    await redo(); expect(editor()).toBeNull();
    expect(texts().map(object => object.text)).toEqual(["N"]);
    await undo(); expect(snapshot().document.pages[0].objects).toEqual([]);
  });

  it("records the edit before a separate document command takes its undo baseline", async () => {
    const alpha = await place("Alpha", 200); await place("Beta", 400);
    await open(alpha); await type("CH2Cl2"); await command("style.formulaText");
    expect(editor()?.value).toBe("CH2Cl2"); expect(texts()[0].spans.some(span => span.script === "subscript")).toBe(true);
    const formatted = texts()[0];
    await type("CH2Cl2 caption"); await pagePress();
    await undo(); expect(texts()[0]).toEqual(formatted);
    await undo(); expect(texts()[0].text).toBe("CH2Cl2");
    expect(texts()[0].spans.every(span => span.script === "normal")).toBe(true);
    await undo(); expect(texts().map(object => object.text)).toEqual(["Alpha", "Beta"]);
    expect(container.textContent).toContain("Undid Edit Text");
  });

  it("keeps a no-op checkpoint to one Edit Text entry with no empty entry", async () => {
    const alpha = await place("Alpha", 200); await place("Beta", 400);
    await open(alpha); await type("Alpha123");
    await act(async () => {
      const current = snapshot().document;
      const tx = beginAssistantTransaction({ pluginId: "org.chemdraft.assistant", runId: "noop", tabId: "initial", label: "No change",
        sendSelection: current.selection });
      try { writeAssistantTransaction(tx, current); } finally { endAssistantTransaction(tx, { touchedIds: [] }); }
    });
    expect(editor()?.value).toBe("Alpha123");
    await pagePress();
    await undo();
    expect(container.textContent).toContain("Undid Edit Text");
    expect(texts().map(object => object.text)).toEqual(["Alpha", "Beta"]);
    await undo(); expect(texts().map(object => object.text)).toEqual(["Alpha"]);
    await undo(); expect(texts()).toEqual([]);
  });

  it("redoes exactly through a checkpointed session (type, resize, type, finish)", async () => {
    const alpha = await place("Alpha", 200); await place("Beta", 400);
    const states = [texts()]; await open(alpha);
    await type("Alpha1"); await dragRight(alpha, 40); await type("Alpha12");
    await pagePress(); const final = texts();
    await undo(); states.push(texts()); await undo(); states.push(texts()); await undo();
    expect(texts()).toEqual(states[0]);
    expect(texts().map(object => object.text)).toEqual(["Alpha", "Beta"]);
    await redo(); const first = texts(); expect(first[0].text).toBe("Alpha1");
    await redo(); expect(texts()[0].width).toBeCloseTo(first[0].width + 40, 6);
    await redo(); expect(texts()).toEqual(final);
    expect(texts()[0].text).toBe("Alpha12");
    expect(states[1][0].text).toBe("Alpha1"); expect(states[2][0].text).toBe("Alpha1");
  });

  it("settles a chooser preview before a Text-tool click starts an edit", async () => {
    const alpha = await place("Alpha", 200);
    const molecules = () => snapshot().document.pages[0].objects.filter(object => object.type === "molecule") as MoleculeObject[];
    await command("tool.bond");
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.click({ page: { x: 500, y: 400 } }); });
    expect(molecules()).toHaveLength(1);
    const original = molecules()[0].style.bondColor;
    await command("tool.text");
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, "#123456");
    expect(molecules()[0].style.bondColor).toBe("#123456");
    await glyphPress(alpha);
    expect(editor()).not.toBeNull();
    await type("Alphax"); await pagePress();
    await undo();
    expect(container.textContent).toContain("Undid Edit Text");
    expect(texts().map(object => object.text)).toEqual(["Alpha"]);
    expect(molecules()[0].style.bondColor).toBe("#123456");
    await undo();
    expect(texts().map(object => object.text)).toEqual(["Alpha"]);
    expect(molecules()[0].style.bondColor).toBe(original);
    await palette(PALETTE_COMMAND_CANCEL_EVENT, "#123456");
    expect(molecules()[0].style.bondColor).toBe(original);
    await undo(); expect(molecules()).toHaveLength(0);
    expect(texts().map(object => object.text)).toEqual(["Alpha"]);
  });

  it.each(["rotation", "resize"])("keeps an open numeric %s preview as its own entry when a text edit starts", async kind => {
    let drawing = createPhase4Document("Numeric preview");
    drawing.pages[0]!.objects = [{
      id: "rect-a", type: "graphic", graphicKind: "rect", x: 100, y: 100, width: 80, height: 50, rotation: 0, style: {}, data: {}
    }];
    drawing = insertNativeTextObject(drawing, { x: 400, y: 300 }, "Alpha");
    const alpha = drawing.pages[0]!.objects.find(object => object.type === "text")!.id;
    drawing = selectDocumentObjects(drawing, drawing.pages[0]!.id, ["rect-a"]);
    await act(async () => root.unmount()); container.innerHTML = "";
    root = createRoot(container);
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: drawing, initialPaletteMode: "hidden", nativePalette: true,
      initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform
    })));
    const rect = () => snapshot().document.pages[0].objects.find(object => object.id === "rect-a")!;
    const before = rect();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true })));
    const handle = container.querySelector(kind === "rotation" ? '[data-selection-rotate-handle="true"]' : '[data-object-resize-corner]');
    expect(handle).not.toBeNull();
    await act(async () => handle!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const input = container.querySelector<HTMLInputElement>(kind === "rotation" ? '[aria-label="Z rotation degrees"]' : '[aria-label="X stretch percent"]');
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, kind === "rotation" ? "25" : "125");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const previewed = rect();
    expect(previewed).not.toEqual(before);
    await open(alpha); await type("Alphax"); await pagePress();
    await undo();
    expect(container.textContent).toContain("Undid Edit Text");
    expect(texts().map(object => object.text)).toEqual(["Alpha"]);
    expect(rect()).toEqual(previewed);
    await undo();
    expect(rect()).toEqual(before);
    expect(texts().map(object => object.text)).toEqual(["Alpha"]);
  });
});
