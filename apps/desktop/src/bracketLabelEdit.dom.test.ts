// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { applySingleBondToolAtPoint, createPhase4Document, insertNativeBracket, selectDocumentObjects } from "./documentWorkflow";
import { toggleBracketRepeatUnit } from "./bracketCommands";
import { DOM_COMMAND_EVENT, type QuitFlushPhase } from "./window-manager";
import { bracketLabelPlan } from "@chemdraft/layout-engine";
import { applyPatch, type ChemDraftDocument } from "@chemdraft/chem-core";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOCUMENT_SESSION_SAVE_DEBOUNCE_MS, type DocumentSessionEnvelope } from "./documentSession";
import { setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";
import { saveAskToSaveBeforeQuit } from "./quitSettings";

const native = vi.hoisted(() => ({
  writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(),
  saveSession: vi.fn<(value: DocumentSessionEnvelope) => Promise<void>>(),
  quitFlush: undefined as undefined | ((phase: QuitFlushPhase, requestId: number) => Promise<void>),
  promptQuit: undefined as undefined | ((id: number) => Promise<void>),
  quit: vi.fn()
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => createElement("canvas") }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => true,
  loadDocumentSession: async () => undefined,
  saveDocumentSession: native.saveSession,
  loadToolsetLayoutState: async () => undefined,
  listToolsetWindowStates: async () => [],
  setToolbarsMenu: async () => {},
  listenForQuitFlushRequest: async (handler: NonNullable<typeof native.quitFlush>) => {
    native.quitFlush = handler; return () => { native.quitFlush = undefined; };
  },
  listenForQuitPromptRequest: async (handler: (id: number) => Promise<void>) => {
    native.promptQuit = handler; return () => { native.promptQuit = undefined; };
  },
  listenForQuitSettings: async () => () => {},
  setQuitPromptEnabled: async () => {},
  prepareQuitPrompt: async () => true,
  resumeQuitAfterPrompt: async () => true,
  reportQuitPromptShowing: async () => true,
  cancelQuit: async () => "cancelled",
  confirmQuitAfterFlush: native.quit,
  confirmPromptedQuit: native.quit
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => "/tmp/repeat-label.chemdraft" }));
vi.mock("@tauri-apps/plugin-fs", async original => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(), writeTextFile: native.writeFile
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("repeat label editing (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let closingId: string;
  let pendingPrompt: { prompt: NativePromptOptions; resolve: (id: string) => void } | undefined;
  let restorePrompt: () => void;
  const captures = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let descriptors: Array<PropertyDescriptor | undefined>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    native.writeFile.mockReset().mockResolvedValue();
    native.saveSession.mockResolvedValue();
    vi.stubGlobal("localStorage", new MemoryStorage());
    pendingPrompt = undefined;
    restorePrompt = setNativePromptProvider(prompt => new Promise(resolve => { pendingPrompt = { prompt, resolve }; }));
    saveAskToSaveBeforeQuit(true);
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform === "macos" ? "MacIntel" : "Win32");
    descriptors = captures.map(name => Object.getOwnPropertyDescriptor(Element.prototype, name));
    captures.forEach(name => Object.defineProperty(Element.prototype, name, { configurable: true, value: () => false }));
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    restorePrompt();
    await act(async () => root.unmount());
    container.remove();
    captures.forEach((name, index) => {
      if (descriptors[index]) Object.defineProperty(Element.prototype, name, descriptors[index]!);
      else Reflect.deleteProperty(Element.prototype, name);
    });
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
  });
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const editor = () => container.querySelector<HTMLInputElement>("[data-bracket-label-editor]");
  const label = () => container.querySelector<SVGElement>(`.page-svg-visual-layer [data-page-svg-object-visual="${closingId}"] .bracket-repeat-label`)!;
  async function mount(selected: boolean, tool = "tool.select", empty = false) {
    let doc = empty ? createPhase4Document("Placement") : toggleBracketRepeatUnit(insertNativeBracket(createPhase4Document("Label"),
      { x: 100, y: 100 }, "round", { x: 260, y: 200 }));
    closingId = doc.pages[0].objects.find(object => object.type === "bracket" && object.side === "close")?.id ?? "";
    if (!selected) doc = selectDocumentObjects(doc, doc.pages[0].id, []);
    await mountDocument(doc, tool);
  }
  async function mountDocument(doc: ChemDraftDocument, tool = "tool.select") {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialActiveToolCommandId: tool, initialCrosshairsVisible: false,
      initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true, shortcutPlatform: platform
    })));
    const rect = { left: 0, top: 0, x: 0, y: 0, width: 792, height: 612, right: 792, bottom: 612, toJSON: () => ({}) } as DOMRect;
    container.querySelectorAll(".page, .canvas-region").forEach(element => { element.getBoundingClientRect = () => rect; });
  }
  async function mouse(target: Element, type: string, detail = 0, point = { x: 264, y: 199 }, modifiers: MouseEventInit = {}) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type.endsWith("down") ? 1 : 0, detail, clientX: point.x, clientY: point.y, ...modifiers });
    Object.defineProperties(event, { pointerId: { value: 8 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    await act(async () => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  }
  async function click(count: number) {
    const target = label();
    target.setAttribute("tabindex", "-1");
    // A real pointer press has detail=0. Emulate the companion mousedown's default focus
    // action, which jsdom/agent-bridge dispatch otherwise skips (and can blur a new editor).
    if (!await mouse(target, "pointerdown")) {
      if (!await mouse(target, "mousedown", count)) await act(async () => target.focus());
    }
    for (const type of ["pointerup", "mouseup", "click"]) await mouse(target, type, type === "pointerup" ? 0 : count);
  }
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function key(key: string, modifiers: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
    await act(async () => { document.activeElement!.dispatchEvent(event); });
    return event;
  }
  async function type(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(editor(), value);
      editor()!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    });
  }
  const savedLabel = (contents = native.writeFile.mock.calls.at(-1)![1]) => openChemDraftPayload(contents).document!.pages[0].objects
    .find(object => object.id === closingId);
  async function openSavedLabel() {
    await mount(true);
    await command("document.save");
    expect(snapshot().file.dirty).toBe(false);
    native.writeFile.mockClear();
    await command("bracket.label.edit");
  }
  it.each([
    ["F5", {}], ["r", { ctrlKey: true }],
    ["R", { ctrlKey: true, shiftKey: true }], ["F5", { ctrlKey: true }]
  ] as const)("protects the focused label from reload %s %j without a command", async (name, modifiers) => {
    await openSavedLabel();
    const before = snapshot();
    const event = await key(name, modifiers);
    expect(event.defaultPrevented).toBe(platform === "windows");
    expect(snapshot()).toEqual(before);
    expect(container.querySelector(".document-rulers-overlay")).toBeNull();
    expect(editor()).toBe(document.activeElement);
    expect(native.writeFile).not.toHaveBeenCalled();
  });
  it("marks an accepted IME draft dirty after Save even when compositionend leaves the input unchanged", async () => {
    await openSavedLabel();
    await act(async () => { editor()!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    await type("候補");
    await command("document.save");
    expect(savedLabel()).toMatchObject({ label: "n" });
    expect(snapshot().file.dirty).toBe(false);
    native.saveSession.mockClear();
    await act(async () => { editor()!.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "候補" })); });
    expect(editor()!.value).toBe("候補");
    expect(snapshot().file.dirty).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(DOCUMENT_SESSION_SAVE_DEBOUNCE_MS + 1); });
    expect(native.saveSession).toHaveBeenCalled();
    expect(savedLabel(native.saveSession.mock.calls.at(-1)![0].contents)).toMatchObject({ label: "候補" });
  });
  it.each(["Enter", "Escape"])("keeps composing %s inside the label editor", async name => {
    await openSavedLabel();
    const field = editor()!;
    await act(async () => { field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    await type("候補");
    expect((await key(name, { isComposing: true })).defaultPrevented).toBe(false);
    expect(editor()).toBe(field);
    expect(label().textContent).toBe("n");
    await act(async () => { field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "候補" })); });
    await key("Enter");
    expect(editor()).toBeNull();
    expect(label().textContent).toBe("候補");
  });
  if (platform === "macos") it("keeps Cmd+; owned by the editor and by Show Rulers on the canvas", async () => {
    await openSavedLabel();
    const before = snapshot();
    expect((await key(";", { metaKey: true })).defaultPrevented).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(container.querySelector(".document-rulers-overlay")).toBeNull();
    await key("Escape");
    const event = new KeyboardEvent("keydown", { key: ";", metaKey: true, bubbles: true, cancelable: true });
    await act(async () => { document.body.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector(".document-rulers-overlay")).not.toBeNull();
  });
  if (platform === "windows") {
    it.each([
      [";", false, ".document-rulers-overlay"],
      ["x", true, ".crosshair-overlay"]
    ] as const)("routes canvas Ctrl+%s to its toggle", async (name, altKey, selector) => {
      await mount(false);
      const canvas = container.querySelector(".page")!;
      expect(container.querySelector(selector)).toBeNull();
      for (const visible of [true, false]) {
        const event = new KeyboardEvent("keydown", { key: name, ctrlKey: true, altKey, bubbles: true, cancelable: true });
        await act(async () => { canvas.dispatchEvent(event); });
        expect(event.defaultPrevented).toBe(true);
        expect(container.querySelector(selector) !== null).toBe(visible);
      }
    });
    it.each([
      { key: "F5" }, { key: "F5", ctrlKey: true }, { key: "BrowserRefresh" }, { key: "r", ctrlKey: true }, { key: "R", ctrlKey: true, shiftKey: true }
    ])("prevents canvas $key without a command", async chord => {
      await mount(false);
      const before = snapshot();
      const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
      await act(async () => { container.querySelector(".page")!.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(true);
      expect(snapshot()).toEqual(before);
      expect(container.querySelector(".document-rulers-overlay, .crosshair-overlay")).toBeNull();
    });
  }
  it("native Save captures the uncommitted repeat label before Escape cancels the editor", async () => {
    await openSavedLabel();
    const field = editor()!;
    await type("m");
    expect(snapshot().file.dirty).toBe(true);
    expect(container.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();
    // The same event Rust emits for native menu clicks and native accelerators; no blur/Enter.
    await command("document.save");
    expect(editor()).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(native.writeFile).toHaveBeenCalledTimes(1);
    expect(savedLabel()).toMatchObject({ label: "m" });
    expect(snapshot().file.dirty).toBe(false);
    await key("Escape");
    await command("bracket.label.edit");
    expect(editor()?.value).toBe("n"); // Escape discards the private draft, as for table cells.
    expect(snapshot().file.dirty).toBe(true); // The working n differs from the saved m.
    expect(native.writeFile).toHaveBeenCalledTimes(1);
    expect(savedLabel()).toMatchObject({ label: "m" });
  });
  it.each([false, true])("saves once from the editor keyboard shortcut (Save As: %s)", async saveAs => {
    await openSavedLabel();
    await type("m");
    const field = editor()!;
    field.setSelectionRange(1, 1);
    const event = await key(saveAs ? "S" : "s", {
      metaKey: platform === "macos", ctrlKey: platform === "windows", shiftKey: saveAs
    });
    expect(event.defaultPrevented).toBe(true);
    expect(native.writeFile).toHaveBeenCalledTimes(1);
    expect(savedLabel()).toMatchObject({ label: "m" });
    expect(editor()).toBe(field);
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([1, 1]);
    expect(snapshot().file.dirty).toBe(false);
    await type("p");
    expect(snapshot().file.dirty).toBe(true);
    await key("Enter");
    expect(label().textContent).toBe("p");
    expect(snapshot().file.dirty).toBe(true);
    expect(savedLabel()).toMatchObject({ label: "m" });
  });
  it.each(["session autosave", "quit/close session flush"])("includes the open draft in %s without marking it clean", async route => {
    await openSavedLabel();
    native.saveSession.mockClear();
    await type("m");
    const field = editor();
    if (route === "session autosave") {
      await act(async () => { await vi.advanceTimersByTimeAsync(DOCUMENT_SESSION_SAVE_DEBOUNCE_MS + 100); });
    } else {
      await act(async () => { await native.quitFlush!("committed", 42); });
      expect(native.quit).toHaveBeenCalledExactlyOnceWith(42);
    }
    const session = native.saveSession.mock.calls.at(-1)![0];
    expect(savedLabel(session.contents)).toMatchObject({ label: "m" });
    expect(session.dirty).toBe(true);
    expect(snapshot().file.dirty).toBe(true);
    expect(editor()).toBe(field);
    expect(native.writeFile).not.toHaveBeenCalled();
  });
  it("freezes the open repeat label during a committed quit write", async () => {
    await openSavedLabel();
    await type("m");
    let finishWrite!: () => void;
    native.saveSession.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
    let flushing!: Promise<void>;
    await act(async () => { flushing = native.quitFlush!("committed", 42); });
    const field = editor()!;
    expect.soft(field.readOnly).toBe(true);
    await type("Late typing");
    expect.soft(field.value).toBe("m");
    expect(savedLabel(native.saveSession.mock.calls.at(-1)![0].contents)).toMatchObject({ label: "m" });
    expect(native.quit).not.toHaveBeenCalled();
    await act(async () => { finishWrite(); await flushing; });
    expect(native.quit).toHaveBeenCalledExactlyOnceWith(42);
  });
  it("flushes a repeat label as clean after typing back to the saved value", async () => {
    await openSavedLabel();
    await type("m");
    await command("document.save");
    await type("p");
    expect(snapshot().file.dirty).toBe(true);
    await type("m");
    expect(editor()?.value).toBe("m");
    await act(async () => { await native.quitFlush!("committed", 42); });
    const session = native.saveSession.mock.lastCall![0];
    expect(savedLabel(session.contents)).toMatchObject({ label: "m" });
    expect(session.dirty).toBe(false);
    expect(native.quit).toHaveBeenCalledExactlyOnceWith(42);
  });
  it.each(["close", "quit"])("prompts for an uncommitted draft on %s and Save writes it", async boundary => {
    await mount(true);
    await command("document.save");
    await command("document.new");
    await command("document.previousTab");
    native.writeFile.mockClear();
    await command("bracket.label.edit");
    await type("m");
    expect(snapshot().file.dirty).toBe(true);
    if (boundary === "close") await command("document.closeTab");
    else await act(async () => { await native.promptQuit!(1); });
    expect(pendingPrompt?.prompt.title).toBe(boundary === "close"
      ? "Save changes before closing?" : "Save changes before quitting?");
    expect(native.quit).not.toHaveBeenCalled();
    expect(native.writeFile).not.toHaveBeenCalled();
    await act(async () => { pendingPrompt!.resolve("save"); });
    expect(native.writeFile).toHaveBeenCalledTimes(1);
    expect(savedLabel()).toMatchObject({ label: "m" });
    if (boundary === "close") expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    else expect(native.quit).toHaveBeenCalledTimes(1);
  });
  it("finishes the draft on a tab switch and keeps an unchanged saved label clean", async () => {
    await openSavedLabel();
    await type("m");
    await command("document.save");
    await command("document.new");
    expect(editor()).toBeNull();
    await command("document.previousTab");
    expect(label().textContent).toBe("m");
    expect(snapshot().file.dirty).toBe(false);
    await command("edit.undo");
    expect(label().textContent).toBe("n");
    expect(snapshot().file.dirty).toBe(true);
  });
  it("reconciles cancellation while a native save is pending against the saved draft", async () => {
    await openSavedLabel();
    await type("m");
    let finishWrite!: () => void;
    native.writeFile.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    await command("document.save");
    await key("Escape");
    await act(async () => { finishWrite(); });
    expect(label().textContent).toBe("n");
    expect(snapshot().file.dirty).toBe(true);
    expect(savedLabel()).toMatchObject({ label: "m" });
  });
  it("returns to clean when an unsaved draft is cancelled", async () => {
    await openSavedLabel();
    await type("m");
    expect(snapshot().file.dirty).toBe(true);
    await key("Escape");
    expect(label().textContent).toBe("n");
    expect(snapshot().file.dirty).toBe(false);
    expect(native.writeFile).not.toHaveBeenCalled();
  });
  it("keeps a saved draft clean when Enter commits it, with one undo step", async () => {
    await openSavedLabel();
    await type("m");
    await command("document.save");
    await key("Enter");
    expect(label().textContent).toBe("m");
    expect(snapshot().file.dirty).toBe(false);
    await command("edit.undo");
    expect(label().textContent).toBe("n");
    await command("edit.redo");
    expect(label().textContent).toBe("m");
  });
  it("flushes the last accepted draft during IME composition and commits it on a tab switch", async () => {
    await openSavedLabel();
    await type("m");
    await act(async () => { editor()!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    await type("candidate");
    await command("document.save");
    expect(savedLabel()).toMatchObject({ label: "m" });
    expect(editor()?.value).toBe("candidate");
    await command("document.new");
    await command("document.previousTab");
    expect(editor()).toBeNull();
    expect(label().textContent).toBe("m");
    expect(snapshot().file.dirty).toBe(false);
  });
  it.each(["round", "square"])("keeps a newly dragged %s pair visibly selected", async kind => {
    await mount(false, `tool.${kind}Bracket`, true);
    const page = container.querySelector(".page")!;
    await mouse(page, "pointerdown", 0, { x: 100, y: 100 });
    await mouse(page, "pointermove", 0, { x: 260, y: 200 });
    await mouse(page, "pointerup", 0, { x: 260, y: 200 });
    const result = snapshot();
    expect(result.activeToolCommandId).toBe("tool.select");
    expect(result.document.selection.objectIds).toEqual(result.document.pages[0].objects.map(object => object.id));
    expect(result.document.selection.objectIds).toHaveLength(2);
    expect(container.querySelector("[data-group-selection]")).not.toBeNull();
  });
  it.each([false, true])("double-clicks the painted label (initially selected: %s) and retains focus while typing", async selected => {
    await mount(selected);
    await click(1);
    // Like existing text objects, a single Select click selects without starting an edit.
    expect(editor()).toBeNull();
    await click(2);
    await mouse(label(), "dblclick", 2);
    expect(editor()?.value).toBe("n");
    expect(document.activeElement).toBe(editor());
    await key("t");
    expect(snapshot().activeToolCommandId).toBe("tool.select");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(editor(), "m");
      editor()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await key("Enter");
    expect(editor()).toBeNull();
    expect(label().textContent).toBe("m");
    await command("edit.undo");
    expect(label().textContent).toBe("n");
    await command("edit.redo");
    expect(label().textContent).toBe("m");
  });
  it("uses the same editor as the context command and cancels with Escape", async () => {
    await mount(true);
    await command("bracket.label.edit");
    expect(editor()?.value).toBe("n");
    await key("Escape");
    expect(editor()).toBeNull();
    expect(label().textContent).toBe("n");
  });
  it.each([false, true])("edits via the full canvas double-click sequence (initially selected: %s)", async selected => {
    await mount(selected);
    await command("view.zoomIn");
    vi.stubGlobal("devicePixelRatio", 2);
    const { document: doc, viewport } = snapshot();
    const scale = (viewport as { scale: number }).scale;
    const closing = doc.pages[0].objects.find(object => object.id === closingId)!;
    if (closing.type !== "bracket") throw new Error("Missing closing bracket");
    const bounds = bracketLabelPlan(closing)!.bounds;
    const rect = { left: 73, top: 41, width: doc.pages[0].width * scale, height: doc.pages[0].height * scale };
    container.querySelector(".page")!.getBoundingClientRect = () => ({ ...rect,
      x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => ({}) });
    const point = { x: rect.left + (closing.x + bounds.x + bounds.width / 2) * scale,
      y: rect.top + (closing.y + bounds.y + bounds.height / 2) * scale };
    // Dispatch through the canvas, never directly to the SVG text. The browser can target
    // the canvas/owner after pointer capture; jsdom has no painted SVG hit testing.
    const canvas = container.querySelector("[data-page-svg-surface]")!;
    for (const detail of [1, 2]) {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        await mouse(canvas, type, type.startsWith("pointer") ? 0 : detail, point);
      }
      expect(editor()).toBeNull();
    }
    await mouse(canvas, "dblclick", 2, point);
    expect(editor()?.value).toBe("n");
    expect(document.activeElement).toBe(editor());
    expect(snapshot().document.pages[0].objects).toEqual(doc.pages[0].objects);
    await key("Escape");
    expect(editor()).toBeNull();
    await command("bracket.label.edit");
    expect(editor()?.value).toBe("n");
  });
  it("edits when Select's pointer capture retargets clicks from the painted label to its owner", async () => {
    await mount(false);
    let captured: Element | undefined;
    Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true,
      value(this: Element) { captured = this; } });
    Object.defineProperty(Element.prototype, "releasePointerCapture", { configurable: true,
      value() { captured = undefined; } });
    Object.defineProperty(Element.prototype, "hasPointerCapture", { configurable: true,
      value(this: Element) { return captured === this; } });
    let clickTarget: Element;
    for (const detail of [1, 2]) {
      const painted = label();
      await mouse(painted, "pointerdown");
      clickTarget = captured!;
      expect(clickTarget).toBe(painted.closest("[data-page-svg-object-visual]"));
      await mouse(painted, "mousedown", detail);
      await mouse(clickTarget, "pointerup");
      await mouse(clickTarget, "mouseup", detail);
      await mouse(clickTarget, "click", detail);
      expect(editor()).toBeNull();
    }
    await mouse(clickTarget!, "dblclick", 2);
    expect(editor()?.value).toBe("n");
    expect(document.activeElement).toBe(editor());
  });
  it("reports the marked atom count and repeat label in the command's status", async () => {
    const doc = insertNativeBracket(applySingleBondToolAtPoint(createPhase4Document("Status"), { x: 140, y: 140 }),
      { x: 100, y: 100 }, "round", { x: 260, y: 200 });
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialPaletteMode: "hidden", initialRulersVisible: false,
      initialCrosshairsVisible: false, nativePalette: true
    })));
    await command("bracket.repeatUnit.toggle");
    expect(container.querySelector("[data-status-message]")?.textContent).toBe('Marked 2 atoms as repeat unit "n"');
    await command("bracket.repeatUnit.toggle");
    expect(container.querySelector("[data-status-message]")?.textContent).toBe('Removed repeat unit "n"');
  });

  it("marks a canvas atom selection through the registered command and restores it with one undo", async () => {
    const doc = applySingleBondToolAtPoint(createPhase4Document("Atom selection"), { x: 140, y: 140 });
    const molecule = doc.pages[0].objects.find(object => object.type === "molecule")!;
    await mountDocument(selectDocumentObjects(doc, doc.pages[0].id, []));
    const selectAtom = async (index: number) => {
      const target = container.querySelector(`.document-object[data-object-id="${molecule.id}"]`)!;
      const atom = molecule.atoms[index];
      const point = window.__CHEMDRAFT_AGENT__!.resolvePoint({ page: atom }).client;
      for (const type of ["pointerdown", "pointerup"]) {
        await mouse(target, type, 0, point, { shiftKey: true });
      }
    };
    await selectAtom(0);
    const before = snapshot();
    expect(before.selectedNativeMoleculePart).toMatchObject({ kind: "atom", atomId: molecule.atoms[0].id });
    await command("bracket.repeatUnit.toggle");
    const marked = snapshot();
    expect(marked.document.pages[0].objects.filter(object => object.type === "bracket")).toHaveLength(2);
    expect(marked.selection.objectIds).toHaveLength(2);
    expect(marked.selectedNativeMoleculePart).toBeUndefined();
    expect(container.querySelector("[data-status-message]")?.textContent).toBe('Marked 1 atom as repeat unit "n"');
    await command("edit.undo");
    expect(snapshot().document).toEqual(before.document);
    expect(snapshot().selectedNativeMoleculePart).toEqual(before.selectedNativeMoleculePart);
    expect(container.querySelector("[data-status-message]")?.textContent).toBe("Undid Mark as Repeat Unit");
    await command("edit.redo");
    expect(snapshot().document).toEqual(marked.document);
    expect(snapshot().selectedNativeMoleculePart).toBeUndefined();
    await command("edit.undo");
    await selectAtom(1);
    const allAtoms = snapshot();
    expect(allAtoms.selectedNativeMoleculePart).toMatchObject({ kind: "parts", atomIds: molecule.atoms.map(atom => atom.id) });
    await command("bracket.repeatUnit.toggle");
    expect(container.querySelector("[data-status-message]")?.textContent).toContain("no crossing bonds");
    expect(snapshot().document).toEqual(allAtoms.document);
    expect(snapshot().selectedNativeMoleculePart).toEqual(allAtoms.selectedNativeMoleculePart);
  });

  it.each(["keep", "enlarge"] as const)("asks before marking atoms at the page edge (%s) and undoes it together", async answer => {
    const doc = applySingleBondToolAtPoint(createPhase4Document("Repeat at edge"), { x: 140, y: 140 });
    const molecule = doc.pages[0].objects.find(object => object.type === "molecule")!;
    const leftmost = molecule.atoms.reduce((left, atom) => atom.x < left.x ? atom : left);
    const dx = 4 - leftmost.x;
    const atEdge = applyPatch(doc, { op: "updateObject", objectId: molecule.id, changes: {
      x: Math.max(0, molecule.x + dx), atoms: molecule.atoms.map(atom => ({ ...atom, x: atom.x + dx }))
    } });
    await mountDocument(selectDocumentObjects(atEdge, doc.pages[0].id, []));
    const target = container.querySelector(`.document-object[data-object-id="${molecule.id}"]`)!;
    const point = window.__CHEMDRAFT_AGENT__!.resolvePoint({ page: { x: 4, y: leftmost.y } }).client;
    await mouse(target, "pointerdown", 0, point, { shiftKey: true });
    await mouse(target, "pointerup", 0, point, { shiftKey: true });
    const before = snapshot();
    expect(before.selectedNativeMoleculePart).toMatchObject({ kind: "atom", atomId: leftmost.id });
    await command("bracket.repeatUnit.toggle");
    expect(pendingPrompt?.prompt.choices).toMatchObject([{ id: "enlarge" }, { id: "keep" }]);
    expect(snapshot().document).toEqual(before.document);
    await act(async () => pendingPrompt!.resolve(answer));
    const after = snapshot();
    const page = after.document.pages[0];
    const bracket = page.objects.find(object => object.type === "bracket" && object.side === "open")!;
    expect(after.selection.objectIds).toHaveLength(2);
    expect(after.selectedNativeMoleculePart).toBeUndefined();
    if (answer === "keep") {
      expect(bracket.x).toBeLessThan(0);
      expect(page.width).toBe(before.document.pages[0].width);
    } else {
      expect(bracket.x).toBeGreaterThanOrEqual(0);
      expect(page.width).toBeGreaterThan(before.document.pages[0].width);
    }
    await command("edit.undo");
    expect(snapshot().document).toEqual(before.document);
    expect(snapshot().selectedNativeMoleculePart).toEqual(before.selectedNativeMoleculePart);
    await command("edit.redo");
    expect(snapshot().document).toEqual(after.document);
  });

  it("removes the bracket and label with the selected molecule on keyboard delete and undoes both", async () => {
    const doc = applySingleBondToolAtPoint(createPhase4Document("Delete repeat"), { x: 140, y: 140 });
    const molecule = doc.pages[0].objects.find(object => object.type === "molecule")!;
    const marked = toggleBracketRepeatUnit(insertNativeBracket(doc, { x: 100, y: 100 }, "square", { x: 260, y: 200 }));
    await mountDocument(selectDocumentObjects(marked, doc.pages[0].id, [molecule.id]));
    const before = snapshot().document;
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    await act(async () => canvas.focus());
    await key(platform === "macos" ? "Backspace" : "Delete");
    expect(snapshot().document.pages[0].objects).toEqual([]);
    expect(container.querySelector(".bracket-repeat-label")).toBeNull();
    await command("edit.undo");
    expect(snapshot().document).toEqual(before);
    expect(container.querySelector(".bracket-repeat-label")?.textContent).toBe("n");
  });
});
