// @vitest-environment jsdom
// Saving while a text box or table cell is still being edited, then typing more. Keep assertions in the safe direction:
// a failing dirty/prompt assertion means the release is affected, not an expected failure.
// Findings: new text boxes ARE affected through File > Save on both platforms,
// and through macOS native accelerator delivery. Table cells are NOT affected.
// Windows Ctrl+S in either editor does not reach Save. Recovery autosave/quit flush
// do not mark either editor clean. Escape cancels table drafts; text Escape commits.
// AppKit/WebView2 themselves are outside jsdom: accelerator delivery is modeled
// explicitly below; all editing/focus/blur/pointer events exercise the actual UI.
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deserializeDocument, type TableObject } from "@chemdraft/chem-core";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { planTableLayout } from "@chemdraft/layout-engine";
import { MainWindow } from "./MainWindow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { DOCUMENT_SESSION_SAVE_DEBOUNCE_MS, type DocumentSessionEnvelope } from "./documentSession";
import { createPhase4Document, insertNativeTextObject } from "./documentWorkflow";
import { setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";
import { saveAskToSaveBeforeQuit } from "./quitSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

const native = vi.hoisted(() => ({
  saveSession: vi.fn<(value: DocumentSessionEnvelope) => Promise<void>>(),
  writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(),
  quitFlush: undefined as undefined | (() => Promise<void>),
  promptQuit: undefined as undefined | ((id: number) => Promise<void>),
  quit: vi.fn()
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
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
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => "/tmp/mid-edit.chemdraft" }));
vi.mock("@tauri-apps/plugin-fs", async original => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(), writeTextFile: native.writeFile
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["macos", "windows"] as const)("save mid-edit (%s)", platform => {
  let container: HTMLDivElement, root: Root;
  let pendingPrompt: { prompt: NativePromptOptions; resolve: (id: string) => void } | undefined;
  let restorePrompt: () => void;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const editor = () => container.querySelector<HTMLTextAreaElement>(".text-object-editor, [data-table-cell-editor] textarea");
  const table = () => snapshot().document.pages[0].objects.find(object => object.type === "table") as TableObject;
  type Kind = "text box" | "table cell";
  type Route = "File > Save" | "File > Save As" | "native accelerator" | "session autosave" | "quit session flush";
  const contentsText = (contents: string, kind: Kind) => {
    const objects = openChemDraftPayload(contents).document!.pages[0].objects;
    return kind === "text box" ? objects.find(object => object.type === "text")!.text
      : (objects.find(object => object.type === "table") as TableObject).rows[1].cells[0].text;
  };
  const currentText = (kind: Kind) => kind === "text box"
    ? snapshot().document.pages[0].objects.find(object => object.type === "text")!.text
    : table().rows[1].cells[0].text;
  async function command(commandId: string) {
    // This is the event Rust emits for native menu clicks AND native accelerators
    // (lib.rs dispatch_dom_toolset_event), not an agent-bridge command call.
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function key(key: string, modifiers: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
    await act(async () => { editor()!.dispatchEvent(event); });
    return event;
  }
  async function type(text: string) {
    await act(async () => {
      const textarea = editor()!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
      textarea.setSelectionRange(text.length, text.length);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    });
  }
  async function pointer(target: Element, eventType: string, x: number, y: number) {
    const event = new MouseEvent(eventType, { bubbles: true, cancelable: true, button: 0,
      buttons: eventType === "pointerdown" ? 1 : 0, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    await act(async () => { target.dispatchEvent(event); });
    // jsdom lacks the pointer focus default. Apply it only when the handler allows it.
    if (eventType === "pointerdown" && !event.defaultPrevented && editor() && target !== editor()) {
      await act(async () => { container.querySelector<HTMLElement>(".canvas-region")!.focus(); });
    }
  }
  async function mount(kind: Kind, existingText = false) {
    let drawing = kind === "text box" ? createPhase4Document("Mid-edit save")
      : deserializeDocument(readFileSync("packages/fixtures/tables/sharpless-reagent-table.json", "utf8"));
    if (existingText) drawing = insertNativeTextObject(drawing, { x: 220, y: 200 }, "Original");
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialCrosshairsVisible={false} initialRulersVisible={false} nativePalette shortcutPlatform={platform} />));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 816, bottom: 1056,
      width: 816, height: 1056, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
    }
    await command("document.save");
    expect(snapshot().file.dirty, "initial saved document is clean").toBe(false);
    // Close Tab is disabled with a single tab in this release. Keep a second,
    // clean tab so this exercises an actual reachable tab-close command.
    await command("document.new");
    await command("document.previousTab");
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    native.writeFile.mockClear(); native.saveSession.mockClear();
    const page = container.querySelector(".page")!;
    if (kind === "text box") {
      await command("tool.text");
      const target = existingText ? container.querySelector('[data-page-svg-object-visual] text')! : page;
      await pointer(target, "pointerdown", 220, 200);
      await pointer(target, "pointerup", 220, 200);
    } else {
      const box = planTableLayout(table()).cells.find(cell => cell.rowIndex === 1 && cell.columnIndex === 0)!.box;
      const scale = (snapshot().viewport as { scale: number }).scale;
      const x = (box.x + box.width / 2) * scale, y = (box.y + box.height / 2) * scale;
      const hit = container.querySelector("[data-table-hit-target]")!;
      for (const target of [hit, page, hit, page]) await pointer(target, target === hit ? "pointerdown" : "pointerup", x, y);
      await act(async () => { hit.dispatchEvent(new MouseEvent("dblclick", {
        bubbles: true, cancelable: true, detail: 2, clientX: x, clientY: y
      })); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(editor(), "real editor opened").not.toBeNull();
    expect(document.activeElement).toBe(editor());
    await type("Hello");
    expect(snapshot().file.dirty, "Hello makes document dirty before save").toBe(true);
  }
  async function saveWhileEditing(route: Route, kind: Kind) {
    const textarea = editor()!;
    if (route === "native accelerator") {
      const event = await key("s", platform === "macos" ? { metaKey: true } : { ctrlKey: true });
      expect(event.defaultPrevented, "editor leaves save chord available to native default").toBe(false);
      expect(native.writeFile, "the editor does not dispatch Save from its JS key handler").not.toHaveBeenCalled();
      // jsdom cannot execute AppKit defaults. Model its menu accelerator delivery at
      // the actual Rust -> DOM boundary. WebView2 has no such fallback (keyboardShortcuts.ts).
      expect(platform).toBe("macos");
      await command("document.save");
    } else if (route === "File > Save") await command("document.save");
    else if (route === "File > Save As") await command("document.saveAs");
    else if (route === "session autosave") {
      await act(async () => { await vi.advanceTimersByTimeAsync(DOCUMENT_SESSION_SAVE_DEBOUNCE_MS + 100); });
    } else await act(async () => { await native.quitFlush!(); });
    expect(editor(), "save/flush keeps the same editor").toBe(textarea);
    expect(document.activeElement, "save/flush retains editor focus").toBe(textarea);
    if (route === "File > Save" || route === "File > Save As" || route === "native accelerator") {
      expect(native.writeFile).toHaveBeenCalledTimes(1);
      expect(contentsText(native.writeFile.mock.calls[0][1], kind), "file has Hello at save").toBe("Hello");
      expect(snapshot().file.dirty, "explicit save marks open draft clean").toBe(false);
    } else {
      expect(native.writeFile, "session persistence never writes the user's file").not.toHaveBeenCalled();
      const session = native.saveSession.mock.calls.at(-1)![0];
      expect(contentsText(session.contents, kind), "recovery session contains open Hello draft").toBe("Hello");
      expect(session.dirty, "session flush preserves dirty flag").toBe(true);
      expect(snapshot().file.dirty, "session flush does not establish a clean baseline").toBe(true);
      native.quit.mockClear(); // quit-flush acknowledgement is separate from a prompted quit request.
    }
  }
  async function endEdit(ending: "Escape" | "click-away" | "tool switch") {
    if (ending === "Escape") await key("Escape");
    else if (ending === "tool switch") await command("tool.bond");
    else {
      const page = container.querySelector(".page")!;
      await pointer(page, "pointerdown", 700, 900);
      await pointer(page, "pointerup", 700, 900);
    }
    expect(editor(), "edit has ended").toBeNull();
  }
  async function assertPrompt(boundary: "close" | "quit") {
    if (boundary === "close") await command("document.closeTab");
    else await act(async () => { await native.promptQuit!(1); });
    expect.soft(pendingPrompt?.prompt.title, `${boundary} must prompt for unsaved extra character`).toBe(
      boundary === "close" ? "Save changes before closing?" : "Save changes before quitting?");
    if (boundary === "close") expect.soft(container.querySelectorAll('[role="tab"]'), "close must retain unsaved tab pending choice").toHaveLength(2);
    if (boundary === "quit") expect.soft(native.quit, "quit must wait for save choice").not.toHaveBeenCalled();
    if (pendingPrompt) await act(async () => { pendingPrompt!.resolve("cancel"); });
  }
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(window, "focus").mockImplementation(() => {});
    for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
      Object.defineProperty(Element.prototype, method, { configurable: true, value: () => false });
    }
    pendingPrompt = undefined;
    restorePrompt = setNativePromptProvider(prompt => new Promise(resolve => { pendingPrompt = { prompt, resolve }; }));
    saveAskToSaveBeforeQuit(true);
    native.saveSession.mockResolvedValue(); native.writeFile.mockResolvedValue();
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    restorePrompt(); await act(async () => { root.unmount(); }); container.remove();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) Reflect.deleteProperty(Element.prototype, method);
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });

  describe.each([false, true])("text box (existing: %s)", existing => {
    describe.each(["File > Save", "File > Save As"] as const)("%s", route => {
      it.each(["Escape", "click-away", "tool switch"] as const)("stays clean without more typing after %s", async ending => {
        await mount("text box", existing);
        const textarea = editor()!;
        textarea.setSelectionRange(2, 2);
        await saveWhileEditing(route, "text box");
        expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 2]);
        await endEdit(ending);
        expect(currentText("text box")).toBe("Hello");
        expect(snapshot().file.dirty).toBe(false);
        await command("document.closeTab");
        expect(pendingPrompt).toBeUndefined();
        expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
        expect(native.writeFile).toHaveBeenCalledTimes(1);
      });
      it.each(["Escape", "click-away", "tool switch"] as const)("marks later typing dirty and prompts after %s", async ending => {
        await mount("text box", existing);
        await saveWhileEditing(route, "text box");
        await type("Hellox");
        expect(snapshot().file.dirty).toBe(true);
        await endEdit(ending);
        expect(currentText("text box")).toBe("Hellox");
        expect(snapshot().file.dirty).toBe(true);
        await assertPrompt("close");
        await assertPrompt("quit");
        expect(native.writeFile).toHaveBeenCalledTimes(1);
        expect(contentsText(native.writeFile.mock.calls[0][1], "text box")).toBe("Hello");
      });
    });
    it("compares against the saved text when typing returns to the session's starting content", async () => {
      await mount("text box", existing);
      await saveWhileEditing("File > Save", "text box");
      await type(existing ? "Original" : "");
      await endEdit("Escape");
      expect(snapshot().file.dirty).toBe(true);
      await assertPrompt("close");
    });
    it.each([false, true])("reconciles a pending save with the latest content (changed: %s)", async changed => {
      await mount("text box", existing);
      let finishWrite!: () => void;
      native.writeFile.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
      await command("document.save");
      expect(contentsText(native.writeFile.mock.calls[0][1], "text box")).toBe("Hello");
      if (changed) await type("Hellox");
      await endEdit("Escape");
      await act(async () => { finishWrite(); });
      expect(currentText("text box")).toBe(changed ? "Hellox" : "Hello");
      expect(snapshot().file.dirty).toBe(changed);
      if (changed) await assertPrompt("quit");
    });
  });

  describe.each(["text box", "table cell"] as const)("%s", kind => {
    const routes: Route[] = ["File > Save", "session autosave", "quit session flush"];
    if (platform === "macos") routes.push("native accelerator");
    describe.each(routes)("%s", route => {
      for (const ending of ["Escape", "click-away"] as const) {
        it.each(["close", "quit"] as const)(`retained extra typing stays dirty after ${ending} and prompts on %s`, async boundary => {
          await mount(kind);
          const original = currentText(kind);
          await saveWhileEditing(route, kind);
          await type("Hellox");
          expect(editor()!.value).toBe("Hellox");
          expect.soft(snapshot().file.dirty, "extra typing after save must immediately mark dirty").toBe(true);
          await endEdit(ending);
          // Table Escape intentionally cancels to pre-edit content. That still differs
          // from the explicitly saved Hello and must therefore prompt after an explicit save.
          const canceledUnsavedTable = kind === "table cell" && ending === "Escape"
            && (route === "session autosave" || route === "quit session flush");
          expect(currentText(kind)).toBe(kind === "table cell" && ending === "Escape" ? original : "Hellox");
          expect.soft(snapshot().file.dirty, "ending edit must preserve unsaved changes").toBe(!canceledUnsavedTable);
          if (canceledUnsavedTable) {
            // No user-file save occurred, and Escape discarded all draft changes: clean is correct.
            if (boundary === "close") await command("document.closeTab");
            else await act(async () => { await native.promptQuit!(1); });
            expect(pendingPrompt).toBeUndefined();
            if (boundary === "quit") expect(native.quit).toHaveBeenCalledTimes(1);
          } else await assertPrompt(boundary);
          if (native.writeFile.mock.calls.length) expect(contentsText(native.writeFile.mock.calls[0][1], kind)).toBe("Hello");
        });
      }
    });
    if (platform === "windows") it("Ctrl+S inside editor is NOT REACHABLE as Save (the editor keeps the key)", async () => {
      await mount(kind);
      const textarea = editor();
      const event = await key("s", { ctrlKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(native.writeFile).not.toHaveBeenCalled();
      expect(editor()).toBe(textarea);
      expect(snapshot().file.dirty).toBe(true);
    });
  });
});
