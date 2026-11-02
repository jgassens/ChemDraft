// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MoleculeObject, type TextObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeArtGraphicObject, insertNativeTextObject, selectDocumentObjects } from "./documentWorkflow";
import * as workflow from "./documentWorkflow";
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

  // The 1 px editor border outsets the content frame on every side (App.css).
  const editorBorder = 1;

  function assertAutomaticEditorWidth(object: TextObject, contentWidth = 117.126, scale = 1) {
    const frame = editor()!.closest<HTMLElement>(".document-object-chrome")!;
    // Independent font numbers, never the production measurement function: nine Cs
    // at 18 px = 9 * .723 * 18 (outward-rounded Arial/Helvetica real advances).
    // jsdom checks the geometry supplied to the browser, not real glyph wrapping.
    expect(parseFloat(frame.style.width)).toBeCloseTo(Math.max(object.width * scale, (contentWidth + 0.5) * scale + 4) + 2 * editorBorder, 8);
    expect(parseFloat(frame.style.width)).toBeGreaterThanOrEqual(contentWidth * scale + 4 + 2 * editorBorder);
  }

  it("sizes the editor on placement, edit, undo and reopen without changing stored widths on open", async () => {
    const id = await place("CCCCCCCCC", 200);
    const placed = texts()[0];
    await open(id);
    expect(texts()[0].width).toBe(placed.width);
    assertAutomaticEditorWidth(texts()[0]);
    await type("CCCCCCCCCC");
    assertAutomaticEditorWidth(texts()[0], 130.14);
    await pagePress();
    await undo();
    expect(texts()[0]).toEqual(placed);
    await open(id);
    assertAutomaticEditorWidth(texts()[0]);
    expect(texts()[0]).toEqual(placed);
  });

  it.each([undefined, "auto", "fixed-width", "fixed-size"])(
    "preserves loaded narrow widths (%s) and widens only automatic editor chrome", async sizingMode => {
      const drawing = structuredClone(insertNativeTextObject(createPhase4Document("Old text"), { x: 200, y: 200 }, "CCCCCCCCC",
        { fontSizePx: 18 }));
      const object = drawing.pages[0]!.objects[0] as TextObject;
      object.width = 106.44; // 1.1.0's nine-C width, including its 6 px padding.
      if (sizingMode) object.style.textBoxSizingMode = sizingMode;
      else delete object.style.textBoxSizingMode;
      await act(async () => root.unmount()); container.innerHTML = "";
      root = createRoot(container);
      await act(async () => root.render(createElement(MainWindow, {
        initialDocument: drawing, initialPaletteMode: "hidden", nativePalette: true,
        initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform
      })));
      expect(texts()[0].width).toBe(106.44);
      await open(object.id);
      expect(texts()[0].width).toBe(106.44);
      if (sizingMode === "fixed-width" || sizingMode === "fixed-size") {
        const frame = editor()!.closest<HTMLElement>(".document-object-chrome")!;
        expect(frame.style.width).toBe(`${106.44 + 2 * editorBorder}px`);
      } else assertAutomaticEditorWidth(texts()[0]);
      await type("CCCCCCCCCC"); await pagePress(); await undo();
      expect(texts()[0].width).toBe(106.44);
      await open(object.id);
      expect(texts()[0].width).toBe(106.44);
      if (!sizingMode || sizingMode === "auto") assertAutomaticEditorWidth(texts()[0]);
    }
  );

  async function loadText(text: string, style: TextObject["style"] = {}, storedWidth = 106.44, rotation = 0, withGraphics = false) {
    let drawing = structuredClone(insertNativeTextObject(createPhase4Document("Width regression"), { x: 200, y: 200 }, text,
      { fontSizePx: 18, ...style }));
    const object = drawing.pages[0]!.objects[0] as TextObject;
    object.width = storedWidth;
    object.rotation = rotation;
    if (withGraphics) {
      drawing = insertNativeArtGraphicObject(drawing, { x: 400, y: 300 }, "tool.art.rect");
      drawing = insertNativeArtGraphicObject(drawing, { x: 550, y: 300 }, "tool.art.rect");
    }
    await act(async () => root.unmount()); container.innerHTML = ""; root = createRoot(container);
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: drawing, initialPaletteMode: "hidden", nativePalette: true,
      initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform
    })));
    return object;
  }

  it.each([2, 5])("reserves the last character's %s px letter spacing in old and newly sized boxes", async spacing => {
    const object = await loadText("CCCCCCCCC", { letterSpacingPx: spacing });
    await open(object.id);
    // Nine, rather than eight, advances of letter spacing.
    assertAutomaticEditorWidth(texts()[0], 117.126 + 9 * spacing);
    expect(texts()[0]).toEqual(object);
    await type("CCCCCCCCCC");
    expect(texts()[0].width).toBeCloseTo(130.14 + 10 * spacing + 6);
    assertAutomaticEditorWidth(texts()[0], 130.14 + 10 * spacing);
  });

  it("fits Georgia on old boxes and after typing, preserving the saved frame on reopen", async () => {
    const object = await loadText("HHHHHHHHH", { fontFamily: "Georgia, serif" });
    await open(object.id);
    assertAutomaticEditorWidth(texts()[0], 132.03); // 9 * .815 * 18, independent of the helper.
    expect(texts()[0]).toEqual(object);
    await type("HHHHHHHHHH");
    expect(texts()[0].width).toBeCloseTo(146.7 + 6);
    assertAutomaticEditorWidth(texts()[0], 146.7);
    await pagePress(); await open(object.id);
    assertAutomaticEditorWidth(texts()[0], 146.7);
  });

  it.each(["view.zoomOut", "view.zoomIn"])("scales content while keeping border/caret allowance in CSS pixels: %s", async zoom => {
    const object = await loadText("CCCCCCCCC");
    for (let i = 0; i < 4; i++) await command(zoom);
    const scale = Number(container.querySelector<HTMLElement>(".page-stage")!.style.getPropertyValue("--page-scale"));
    expect(zoom === "view.zoomIn" ? scale > 1 : scale < 1).toBe(true);
    await open(object.id);
    assertAutomaticEditorWidth(texts()[0], 117.126, scale);
    expect(texts()[0]).toEqual(object);
  });

  it("updates only scale-dependent chrome on zoom, leaving idle object views memoized", async () => {
    const views = vi.spyOn(workflow, "nativeGraphicPathEditPoints");
    const object = await loadText("CCCCCCCCC", {}, 106.44, 0, true);
    const selectedId = snapshot().document.selection.objectIds[0]!;
    const idleId = snapshot().document.pages[0].objects.find(item => item.type === "graphic" && item.id !== selectedId)!.id;
    const radiusHandle = () => container.querySelector<HTMLElement>("[data-graphic-corner-radius-handle]")!;
    expect(views.mock.calls.some(([item]) => item.id === idleId)).toBe(true);
    const before = radiusHandle().style.left;
    views.mockClear();
    await command("view.zoomIn");
    expect(views.mock.calls.filter(([item]) => item.id === idleId)).toHaveLength(0);
    expect(views.mock.calls.some(([item]) => item.id === selectedId)).toBe(true);
    expect(radiusHandle().style.left).not.toBe(before);

    await open(object.id);
    const widthBefore = editor()!.closest<HTMLElement>(".document-object-chrome")!.style.width;
    views.mockClear();
    await command("view.zoomIn");
    expect(views).not.toHaveBeenCalled(); // Both rectangles are now idle.
    const scale = Number(container.querySelector<HTMLElement>(".page-stage")!.style.getPropertyValue("--page-scale"));
    assertAutomaticEditorWidth(texts()[0], 117.126, scale);
    expect(editor()!.closest<HTMLElement>(".document-object-chrome")!.style.width).not.toBe(widthBefore);
    expect(texts()[0]).toEqual(object);
  });

  it.each(["left", "center", "right"] as const)("keeps the %s anchor fixed when a rotated frame grows", async textAlign => {
    const object = await loadText("CCCCCCCCC", { textAlign }, 106.44, 30);
    await open(object.id);
    assertAutomaticEditorWidth(texts()[0]);
    const frame = editor()!.closest<HTMLElement>(".document-object-chrome")!;
    const [originX, originY] = frame.style.transformOrigin.split(" ").map(parseFloat);
    const left = parseFloat(frame.style.left);
    const anchor = textAlign === "left" ? 0 : textAlign === "center" ? 0.5 : 1;
    expect(left).toBeCloseTo(200 - anchor * 15.186 - editorBorder, 8);
    expect(left + originX!).toBeCloseTo(253.22, 8); // original stored rotation pivot
    expect(originY).toBeCloseTo(object.height / 2 + editorBorder, 8);
    expect(frame.style.top).toBe(`${200 - editorBorder}px`);
    expect(frame.style.transform).toBe("rotate(30deg)");
    // Evaluate the actual CSS anchor after rotation against the old frame's anchor.
    const localAnchor = editorBorder + anchor * (parseFloat(frame.style.width) - 2 * editorBorder) - originX!;
    expect(left + originX! + localAnchor * Math.cos(Math.PI / 6))
      .toBeCloseTo(253.22 + (anchor - 0.5) * 106.44 * Math.cos(Math.PI / 6), 8);
    expect(200 - editorBorder + originY! + localAnchor * Math.sin(Math.PI / 6))
      .toBeCloseTo(200 + object.height / 2 + (anchor - 0.5) * 106.44 * Math.sin(Math.PI / 6), 8);
    expect(texts()[0]).toEqual(object);
    await pagePress();
    expect(texts()[0]).toEqual(object);
  });

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
