// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { applySingleBondToolAtPoint, createPhase4Document, insertNativeBracket, selectDocumentObjects } from "./documentWorkflow";
import { toggleBracketRepeatUnit } from "./bracketCommands";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { bracketLabelContainsPoint, bracketLabelPlan } from "@chemdraft/layout-engine";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOCUMENT_SESSION_SAVE_DEBOUNCE_MS, type DocumentSessionEnvelope } from "./documentSession";
import { setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";
import { saveAskToSaveBeforeQuit } from "./quitSettings";

const native = vi.hoisted(() => ({
  writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(),
  saveSession: vi.fn<(value: DocumentSessionEnvelope) => Promise<void>>(),
  quitFlush: undefined as undefined | (() => Promise<void>),
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
  listenForQuitFlushRequest: async (handler: () => Promise<void>) => {
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
  cancelQuit: async () => true,
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
  async function mount(selected: boolean, tool = "tool.select", empty = false, end = { x: 260, y: 200 }) {
    let doc = empty ? createPhase4Document("Placement") : toggleBracketRepeatUnit(insertNativeBracket(createPhase4Document("Label"),
      { x: 100, y: 100 }, "round", end));
    closingId = doc.pages[0].objects.find(object => object.type === "bracket" && object.side === "close")?.id ?? "";
    if (!selected) doc = selectDocumentObjects(doc, doc.pages[0].id, []);
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialActiveToolCommandId: tool, initialCrosshairsVisible: false,
      initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true, shortcutPlatform: platform
    })));
    const rect = { left: 0, top: 0, x: 0, y: 0, width: 792, height: 612, right: 792, bottom: 612, toJSON: () => ({}) } as DOMRect;
    container.querySelectorAll(".page, .canvas-region").forEach(element => { element.getBoundingClientRect = () => rect; });
  }
  async function mouse(target: Element, type: string, detail = 0, point = { x: 264, y: 199 }) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type.endsWith("down") || type === "pointermove" ? 1 : 0, detail, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { pointerId: { value: 8 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    await act(async () => {
      target.dispatchEvent(event);
      // Browsers implicitly release capture after dispatching pointerup/cancel; jsdom does not.
      if ((type === "pointerup" || type === "pointercancel") && target.hasPointerCapture(8)) target.releasePointerCapture(8);
    });
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
  function trackPointerCapture() {
    let captured: Element | undefined;
    Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true,
      value(this: Element) { captured = this; } });
    Object.defineProperty(Element.prototype, "releasePointerCapture", { configurable: true,
      value() { captured = undefined; } });
    Object.defineProperty(Element.prototype, "hasPointerCapture", { configurable: true,
      value(this: Element) { return captured === this; } });
    return () => captured;
  }
  const closingBracket = () => {
    const object = snapshot().document.pages[0].objects.find(object => object.id === closingId);
    if (object?.type !== "bracket") throw new Error("Missing closing bracket");
    return object;
  };
  const bottomRightHandle = () => container.querySelector<HTMLButtonElement>(
    `[data-object-controls="${closingId}"] [data-object-resize-corner="bottom-right"]`);
  const stretchEditor = () => container.querySelector('[aria-label="X stretch percent"]');
  async function mountHandleFixture(scale: number) {
    await mount(false, "tool.select", false, { x: 260, y: 164 });
    if (scale !== 1) {
      await act(async () => { container.querySelector(".canvas-region")!.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, ctrlKey: true, deltaY: -Math.log(scale) / 0.002
      })); });
    }
    expect((snapshot().viewport as { scale: number }).scale).toBeCloseTo(scale);
    const page = snapshot().document.pages[0];
    const rect = { left: 73, top: 41, width: page.width * scale, height: page.height * scale };
    container.querySelector(".page")!.getBoundingClientRect = () => ({ ...rect,
      x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => ({}) });
    const client = (point: { x: number; y: number }) => ({ x: rect.left + point.x * scale, y: rect.top + point.y * scale });
    return { client, captured: trackPointerCapture() };
  }
  async function press(target: Element, point: { x: number; y: number }, detail = 0, count = 1) {
    if (!await mouse(target, "pointerdown", detail, point)) {
      if (!await mouse(target, "mousedown", count, point)) await act(async () => {
        if (target instanceof HTMLElement || target instanceof SVGElement) target.focus();
      });
    }
  }
  async function release(target: Element, point: { x: number; y: number }, count = 1) {
    for (const type of ["pointerup", "mouseup", "click"]) await mouse(target, type, type === "pointerup" ? 0 : count, point);
  }
  async function selectByLabel(client: (point: { x: number; y: number }) => { x: number; y: number }, captured: () => Element | undefined) {
    const bracket = closingBracket();
    const bounds = bracketLabelPlan(bracket)!.bounds;
    // Near the label's left edge, inside the fixed 18px handle even at 200% zoom.
    const pagePoint = { x: bracket.x + bounds.x + 1, y: bracket.y + bounds.y + bounds.height / 2 };
    expect(bracketLabelContainsPoint(bracket, pagePoint)).toBe(true);
    const point = client(pagePoint);
    const corner = client({ x: bracket.x + bracket.width, y: bracket.y + bracket.height });
    // App.css places the 18px hit box 8px beyond the frame's bottom/right edges.
    expect(point.x).toBeGreaterThan(corner.x - 10);
    expect(point.x).toBeLessThan(corner.x + 8);
    expect(point.y).toBeGreaterThan(corner.y - 10);
    expect(point.y).toBeLessThan(corner.y + 8);
    expect(snapshot().document.selection.objectIds).toEqual([]);
    expect(bottomRightHandle()).toBeNull();
    await press(label(), point);
    expect(snapshot().document.selection.objectIds).toEqual([closingId]);
    expect(bottomRightHandle()).not.toBeNull();
    expect(container.querySelectorAll(`[data-object-controls="${closingId}"] [data-object-resize-corner]`)).toHaveLength(4);
    expect(captured()).toBe(label().closest("[data-page-svg-object-visual]"));
    await release(captured()!, point);
    expect(captured()).toBeUndefined();
    expect(editor()).toBeNull();
    return { point, pagePoint };
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
  if (platform === "macos") it("keeps Cmd+R owned by the editor and by Show Rulers on the canvas", async () => {
    await openSavedLabel();
    const before = snapshot();
    expect((await key("r", { metaKey: true })).defaultPrevented).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(container.querySelector(".document-rulers-overlay")).toBeNull();
    await key("Escape");
    const event = new KeyboardEvent("keydown", { key: "r", metaKey: true, bubbles: true, cancelable: true });
    await act(async () => { document.body.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector(".document-rulers-overlay")).not.toBeNull();
  });
  if (platform === "windows") {
    it.each([
      ["r", false, ".document-rulers-overlay"],
      ["R", true, ".crosshair-overlay"]
    ] as const)("routes canvas Ctrl+%s to its toggle while preventing reload", async (name, shiftKey, selector) => {
      await mount(false);
      const canvas = container.querySelector(".page")!;
      expect(container.querySelector(selector)).toBeNull();
      for (const visible of [true, false]) {
        const event = new KeyboardEvent("keydown", { key: name, ctrlKey: true, shiftKey, bubbles: true, cancelable: true });
        await act(async () => { canvas.dispatchEvent(event); });
        expect(event.defaultPrevented).toBe(true);
        expect(container.querySelector(selector) !== null).toBe(visible);
      }
    });
    it.each([
      { key: "F5" }, { key: "F5", ctrlKey: true }, { key: "BrowserRefresh" }
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
    } else await act(async () => { await native.quitFlush!(); });
    const session = native.saveSession.mock.calls.at(-1)![0];
    expect(savedLabel(session.contents)).toMatchObject({ label: "m" });
    expect(session.dirty).toBe(true);
    expect(snapshot().file.dirty).toBe(true);
    expect(editor()).toBe(field);
    expect(native.writeFile).not.toHaveBeenCalled();
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
  it.each([0.5, 1, 2].flatMap(scale => [0, 1, 2].map(detail => ({ scale, detail }))))(
    "edits the label on a double-click through its newly mounted handle (zoom $scale, pointer detail $detail)", async ({ scale, detail }) => {
      const { client, captured } = await mountHandleFixture(scale);
      const objects = snapshot().document.pages[0].objects;
      const { point } = await selectByLabel(client, captured);
      const handle = bottomRightHandle()!;
      // A real second press hits this newly mounted HTML button, above the SVG label.
      // Sending both presses to the label/canvas misses the WebKit regression.
      await press(handle, point, detail, 2);
      expect(stretchEditor()).toBeNull();
      expect(container.querySelector("[data-status-message]")?.textContent).not.toBe("Stretch entry");
      // Changed from ordinary object capture/no resize: hand check: a drag in the overlap
      // must resize. Without a recognized second press, start the normal handle gesture.
      if (detail < 2) {
        expect(container.querySelector("[data-status-message]")?.textContent).toBe("Resize selected art object");
        expect(captured()).toBe(container.querySelector(".page"));
        expect(editor()).toBeNull();
      } else {
        expect(captured()).toBeUndefined();
        expect(editor()?.value).toBe("n");
        expect(document.activeElement).toBe(editor());
      }
      const clickTarget = captured() ?? handle;
      for (const type of ["pointerup", "mouseup", "click", "dblclick"]) {
        await mouse(clickTarget, type, type === "pointerup" ? 0 : 2, point);
        expect(stretchEditor()).toBeNull();
        expect(container.querySelector("[data-status-message]")?.textContent).not.toBe("Stretch entry");
      }
      expect(captured()).toBeUndefined();
      expect(editor()?.value).toBe("n");
      expect(document.activeElement).toBe(editor());
      expect(snapshot().document.pages[0].objects).toEqual(objects);
    });
  it.each([0.5, 1, 2])("leaves an overlap click unchanged and edits on a repeated detail-0 handle press (zoom %s)", async scale => {
    const { client, captured } = await mountHandleFixture(scale);
    const { point } = await selectByLabel(client, captured);
    const before = snapshot().document.pages[0].objects;
    const handle = bottomRightHandle()!;
    await press(handle, point, 0);
    expect(captured()).toBe(container.querySelector(".page"));
    await release(captured()!, point);
    expect(captured()).toBeUndefined();
    expect(snapshot().document.pages[0].objects).toEqual(before);
    expect(snapshot().document.selection.objectIds).toEqual([closingId]);
    expect(container.querySelector("[data-can-undo]")?.getAttribute("data-can-undo")).toBe("false");
    expect(editor()).toBeNull();
    expect(stretchEditor()).toBeNull();
    // Both pointerdowns can have detail 0 in WebKit; the recorded handle presses
    // must open the label editor before dblclick, never the Stretch editor.
    await press(handle, point, 0, 2);
    expect(captured()).toBeUndefined();
    expect(editor()?.value).toBe("n");
    expect(document.activeElement).toBe(editor());
    for (const type of ["pointerup", "mouseup", "click", "dblclick"]) {
      await mouse(handle, type, type === "pointerup" ? 0 : 2, point);
      expect(stretchEditor()).toBeNull();
      expect(container.querySelector("[data-status-message]")?.textContent).not.toBe("Stretch entry");
    }
    expect(document.activeElement).toBe(editor());
    expect(snapshot().document.pages[0].objects).toEqual(before);
  });
  it.each([0.5, 1, 2].flatMap(scale => [false, true].map(overlap => ({ scale, overlap }))))(
    "resizes from the handle in one ordinary undo step (zoom $scale, label overlap $overlap)", async ({ scale, overlap }) => {
      const { client, captured } = await mountHandleFixture(scale);
      const labelHit = await selectByLabel(client, captured);
      const before = snapshot().document.pages[0].objects;
      const bracket = closingBracket();
      const pagePoint = overlap ? labelHit.pagePoint : { x: bracket.x + bracket.width, y: bracket.y + bracket.height };
      expect(bracketLabelContainsPoint(bracket, pagePoint)).toBe(overlap);
      const start = client(pagePoint);
      const center = { x: bracket.x + bracket.width / 2, y: bracket.y + bracket.height / 2 };
      const scaledPoint = (factor: number) => client({
        x: center.x + (pagePoint.x - center.x) * factor,
        y: center.y + (pagePoint.y - center.y) * factor
      });
      await press(bottomRightHandle()!, start);
      expect(captured()).toBe(container.querySelector(".page"));
      const captureTarget = captured()!;
      // Several previews must still commit as a single change on release.
      for (const factor of [1.25, 1.5]) {
        await mouse(captureTarget, "pointermove", 0, scaledPoint(factor));
      }
      await release(captureTarget, scaledPoint(1.5));
      expect(captured()).toBeUndefined();
      expect(closingBracket().width).toBeCloseTo(bracket.width * 1.5);
      expect(closingBracket().height).toBeCloseTo(bracket.height * 1.5);
      // Resize preserves the centre; a body move would keep the old dimensions.
      expect(closingBracket().x + closingBracket().width / 2).toBeCloseTo(center.x);
      expect(closingBracket().y + closingBracket().height / 2).toBeCloseTo(center.y);
      expect(editor()).toBeNull();
      expect(stretchEditor()).toBeNull();
      const after = snapshot().document.pages[0].objects;
      await command("edit.undo");
      expect(snapshot().document.pages[0].objects).toEqual(before);
      // Ordinary bracket resizes use the generic history label; the overlap must match.
      expect(container.querySelector("[data-status-message]")?.textContent).toBe("Undid last document change");
      expect(container.querySelector("[data-can-undo]")?.getAttribute("data-can-undo")).toBe("false");
      await command("edit.redo");
      expect(snapshot().document.pages[0].objects).toEqual(after);
    });
  it.each([0.5, 1, 2])("still opens Stretch on a double-press outside the label (zoom %s)", async scale => {
    const { client, captured } = await mountHandleFixture(scale);
    await selectByLabel(client, captured);
    const bracket = closingBracket();
    const pagePoint = { x: bracket.x + bracket.width, y: bracket.y + bracket.height };
    expect(bracketLabelContainsPoint(bracket, pagePoint)).toBe(false);
    const point = client(pagePoint);
    const handle = bottomRightHandle()!;
    await press(handle, point);
    await release(captured()!, point);
    expect(stretchEditor()).toBeNull();
    // WebKit pointerdown can report zero on both presses; the recorded presses still count.
    await press(handle, point, 0, 2);
    expect(container.querySelector("[data-status-message]")?.textContent).toBe("Stretch entry");
    expect(stretchEditor()).not.toBeNull();
    await release(handle, point, 2);
    await mouse(handle, "dblclick", 2, point);
    expect(stretchEditor()).not.toBeNull();
    expect(editor()).toBeNull();
  });
  it.each([0.5, 1, 2])("still moves a bracket dragged from its painted body (zoom %s)", async scale => {
    const { client, captured } = await mountHandleFixture(scale);
    const bracket = closingBracket();
    const point = { x: bracket.x + bracket.width - 4, y: bracket.y + bracket.height / 2 };
    expect(bracketLabelContainsPoint(bracket, point)).toBe(false);
    const body = container.querySelector(`[data-page-svg-object-visual="${closingId}"] path`)!;
    await press(body, client(point));
    const captureTarget = captured()!;
    expect(captureTarget).toBe(body.closest("[data-page-svg-object-visual]"));
    const end = client({ x: point.x + 30, y: point.y + 20 });
    await mouse(captureTarget, "pointermove", 0, end);
    await release(captureTarget, end);
    expect(captured()).toBeUndefined();
    expect(closingBracket()).toMatchObject({ x: bracket.x + 30, y: bracket.y + 20, width: bracket.width, height: bracket.height });
    expect(editor()).toBeNull();
    expect(stretchEditor()).toBeNull();
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
});
