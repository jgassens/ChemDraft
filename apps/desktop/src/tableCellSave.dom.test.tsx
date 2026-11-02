// @vitest-environment jsdom
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
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => "/tmp/table.chemdraft" }));
vi.mock("@tauri-apps/plugin-fs", async original => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(), writeTextFile: native.writeFile
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["macos", "windows"] as const)("open table draft persistence (%s)", platform => {
  let container: HTMLDivElement, root: Root;
  let pendingPrompt: { prompt: NativePromptOptions; resolve: (id: string) => void } | undefined;
  let restorePrompt: () => void;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const currentTable = () => snapshot().document.pages[0].objects[0] as TableObject;
  const editor = () => container.querySelector<HTMLTextAreaElement>("[data-table-cell-editor] textarea")!;
  const persistedTable = (contents: string) => openChemDraftPayload(contents).document!.pages[0].objects[0] as TableObject;
  type Target = "cell" | "caption" | "footnote";
  const value = (table: TableObject, target: Target) => target === "cell" ? table.rows[1].cells[0]
    : target === "caption" ? table.caption! : table.footnotes[0];
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function type(text: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), text);
      editor().setSelectionRange(text.length, text.length);
      editor().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    });
  }
  async function click(button: HTMLElement) {
    await act(async () => {
      button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      button.focus();
      button.click();
    });
  }
  async function startComposition() {
    await act(async () => { editor().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    await type("Hello未");
  }
  async function addOtherTab() {
    await command("document.new");
    await command("document.previousTab");
  }
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
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
    const drawing = deserializeDocument(readFileSync("packages/fixtures/tables/sharpless-reagent-table.json", "utf8"));
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialCrosshairsVisible={false} initialRulersVisible={false} nativePalette shortcutPlatform={platform} />));
    const page = container.querySelector<HTMLElement>(".page")!;
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0,
      right: 816, bottom: 1056, width: 816, height: 1056, toJSON: () => ({}) });
    // Establish a clean saved file, so opening an editor cannot hide a missing dirty transition.
    await command("document.save");
    expect(snapshot().file.dirty).toBe(false);
    native.writeFile.mockClear(); native.saveSession.mockClear();
  });
  afterEach(async () => {
    restorePrompt(); await act(async () => root.unmount()); container.remove();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) Reflect.deleteProperty(Element.prototype, method);
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });
  async function open(target: Target) {
    const layout = planTableLayout(currentTable());
    const box = target === "cell" ? layout.cells.find(cell => cell.rowIndex === 1 && cell.columnIndex === 0)!.box
      : target === "caption" ? layout.captionBox! : layout.footnoteBoxes[0];
    const scale = (snapshot().viewport as { scale: number }).scale;
    const x = (box.x + box.width / 2) * scale, y = (box.y + box.height / 2) * scale;
    const hit = container.querySelector("[data-table-hit-target]")!;
    const page = container.querySelector(".page")!;
    for (const eventTarget of [hit, page, hit, page]) {
      const event = new MouseEvent(eventTarget === hit ? "pointerdown" : "pointerup", {
        bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y
      });
      Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
      await act(async () => { eventTarget.dispatchEvent(event); });
    }
    await act(async () => { hit.dispatchEvent(new MouseEvent("dblclick", {
      bubbles: true, cancelable: true, detail: 2, clientX: x, clientY: y
    })); });
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(editor()).toBe(document.activeElement);
    await type("Hello");
  }

  describe.each(["cell", "caption", "footnote"] as const)("%s", target => {
    it("marks a saved draft changed after Escape and prompts on quit", async () => {
      const original = value(currentTable(), target).text;
      await open(target);
      await command("document.save");
      expect(snapshot().file.dirty).toBe(false);
      await act(async () => { editor().dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true
      })); });
      expect(editor()).toBeNull();
      expect(value(currentTable(), target).text).toBe(original);
      expect(snapshot().file.dirty).toBe(true);
      await act(async () => { await native.promptQuit!(1); });
      expect(pendingPrompt?.prompt.title).toBe("Save changes before quitting?");
      expect(native.quit).not.toHaveBeenCalled();
      await act(async () => { pendingPrompt!.resolve("cancel"); });
      await command("edit.undo");
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Nothing to undo");
    });
    it("keeps a committed saved draft clean, and later changes dirty", async () => {
      await open(target);
      await command("document.save");
      await act(async () => { container.querySelector<HTMLElement>(".canvas-region")!.focus(); });
      expect(value(currentTable(), target).text).toBe("Hello");
      expect(snapshot().file.dirty).toBe(false);
      await open(target);
      await type("Hello again");
      await act(async () => { container.querySelector<HTMLElement>(".canvas-region")!.focus(); });
      expect(snapshot().file.dirty).toBe(true);
    });
    it.each(["cancel", "commit", "switch"] as const)("keeps dirty state correct when an in-flight save finishes after %s", async finish => {
      if (finish === "switch") await addOtherTab();
      const original = value(currentTable(), target).text;
      await open(target);
      let finishWrite!: () => void;
      native.writeFile.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
      await command("document.save");
      if (finish === "cancel") await act(async () => { editor().dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true
      })); });
      else if (finish === "commit") await act(async () => { container.querySelector<HTMLElement>(".canvas-region")!.focus(); });
      else await command("document.nextTab");
      await act(async () => { finishWrite(); });
      if (finish === "switch") await command("document.previousTab");
      expect(value(persistedTable(native.writeFile.mock.calls.at(-1)![1]), target).text).toBe("Hello");
      expect(value(currentTable(), target).text).toBe(finish === "cancel" ? original : "Hello");
      expect(snapshot().file.dirty).toBe(finish === "cancel");
    });
    describe.each(["native command", "pointer"] as const)("tab switch via %s", route => {
      it.each([false, true])("commits the draft into the tab and session (saved while open: %s)", async saved => {
        await addOtherTab();
        const original = value(currentTable(), target).text;
        await open(target);
        if (saved) await command("document.save");
        if (route === "native command") await command("document.nextTab");
        else await click(container.querySelectorAll<HTMLElement>('[role="tab"]')[1]);
        expect(editor()).toBeNull();
        const firstTab = container.querySelectorAll('[role="tab"]')[0];
        expect(firstTab.querySelector('[aria-label="Unsaved changes"]') !== null).toBe(!saved);
        await act(async () => { await native.quitFlush!(); });
        const session = native.saveSession.mock.calls.at(-1)![0].tabs![0];
        expect(value(persistedTable(session.contents), target).text).toBe("Hello");
        expect(session.dirty).toBe(!saved);
        await command("document.previousTab");
        expect(value(currentTable(), target).text).toBe("Hello");
        expect(snapshot().file.dirty).toBe(!saved);
        await command("document.save");
        expect(value(persistedTable(native.writeFile.mock.calls.at(-1)![1]), target).text).toBe("Hello");
        await command("edit.undo");
        expect(value(currentTable(), target).text).toBe(original);
        expect(container.querySelector('[role="status"]')?.textContent).toContain(
          target === "cell" ? "Undid Edit cell" : target === "caption" ? "Undid Edit caption" : "Undid Edit footnotes");
        await command("edit.undo");
        expect(container.querySelector('[role="status"]')?.textContent).toContain("Nothing to undo");
      });
    });
    it("commits pre-composition text when a native command switches tabs", async () => {
      await addOtherTab();
      await open(target);
      await startComposition();
      await command("document.nextTab");
      await act(async () => { await native.quitFlush!(); });
      const session = native.saveSession.mock.calls.at(-1)![0].tabs![0];
      expect(value(persistedTable(session.contents), target).text).toBe("Hello");
      expect(session.dirty).toBe(true);
      await command("document.previousTab");
      expect(value(currentTable(), target).text).toBe("Hello");
      expect(snapshot().file.dirty).toBe(true);
    });
    it.each([false, true])("commits before closing and saves the draft (composing: %s)", async composing => {
      await addOtherTab();
      await open(target);
      if (composing) await startComposition();
      await command("document.closeTab");
      expect(editor()).toBeNull();
      expect(value(currentTable(), target).text).toBe("Hello");
      expect(snapshot().file.dirty).toBe(true);
      expect(pendingPrompt?.prompt.title).toBe("Save changes before closing?");
      await act(async () => { pendingPrompt!.resolve("cancel"); });
      expect(value(currentTable(), target).text).toBe("Hello");
      await command("document.closeTab");
      await act(async () => { pendingPrompt!.resolve("save"); });
      expect(value(persistedTable(native.writeFile.mock.calls.at(-1)![1]), target).text).toBe("Hello");
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    });
    it("closes a draft saved while open without losing text or prompting", async () => {
      await addOtherTab();
      await open(target);
      await command("document.save");
      await command("document.closeTab");
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
      expect(pendingPrompt).toBeUndefined();
      expect(value(persistedTable(native.writeFile.mock.calls.at(-1)![1]), target).text).toBe("Hello");
    });
    it("saves the draft through the native menu without closing or moving the caret", async () => {
      await open(target);
      const textarea = editor(); textarea.setSelectionRange(2, 2);
      const chord = new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true,
        metaKey: platform === "macos", ctrlKey: platform === "windows" });
      await act(async () => { textarea.dispatchEvent(chord); });
      expect(chord.defaultPrevented).toBe(false);
      await command("document.save");
      expect.soft(value(persistedTable(native.writeFile.mock.calls.at(-1)![1]), target).text, "saved file contains the open draft").toBe("Hello");
      expect(editor()).toBe(textarea); expect(document.activeElement).toBe(textarea);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 2]);
      expect(snapshot().file.dirty).toBe(false);
    });
    it("marks open typing changed and offers Save on quit", async () => {
      await open(target);
      expect.soft(snapshot().file.dirty, "open typing marks the file changed").toBe(true);
      await act(async () => { await native.promptQuit!(1); });
      expect.soft(pendingPrompt?.prompt.title, "quit offers to save the open draft").toBe("Save changes before quitting?");
      expect.soft(native.quit, "quit waits for the answer").not.toHaveBeenCalled();
      if (pendingPrompt?.prompt.title === "Save changes before quitting?" && snapshot().file.dirty) {
        await act(async () => { pendingPrompt!.resolve("save"); });
        expect(value(persistedTable(native.writeFile.mock.calls.at(-1)![1]), target).text).toBe("Hello");
        expect(native.quit).toHaveBeenCalled();
      }
    });
    it("includes open typing in the debounced session autosave", async () => {
      await open(target);
      await act(async () => vi.advanceTimersByTimeAsync(DOCUMENT_SESSION_SAVE_DEBOUNCE_MS + 100));
      expect(native.saveSession).toHaveBeenCalled();
      expect(value(persistedTable(native.saveSession.mock.calls.at(-1)![0].contents), target).text,
        "autosaved session contains the open draft").toBe("Hello");
      expect(document.activeElement).toBe(editor());
    });
    it("includes open typing in the quit session flush", async () => {
      await open(target);
      await act(async () => { await native.quitFlush!(); });
      expect(value(persistedTable(native.saveSession.mock.calls.at(-1)![0].contents), target).text,
        "quit session contains the open draft").toBe("Hello");
    });
    it("keeps one labelled undo step at edit completion, including formatting saved while open", async () => {
      const original = value(currentTable(), target).text;
      await open(target);
      editor().select();
      await command("text.italic");
      await command("document.save");
      const saved = value(persistedTable(native.writeFile.mock.calls.at(-1)![1]), target);
      expect(saved.text).toBe("Hello");
      expect(saved.spans.some(span => span.style.fontStyle === "italic")).toBe(true);
      // Saving reads the scratch draft; it never commits it into document/history.
      expect(value(currentTable(), target).text).toBe(original);
      await act(async () => { container.querySelector<HTMLElement>(".canvas-region")!.focus(); });
      expect(editor()).toBeNull();
      expect(value(currentTable(), target)).toEqual(saved);
      await command("edit.undo");
      expect(value(currentTable(), target).text).toBe(original);
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        target === "cell" ? "Undid Edit cell" : target === "caption" ? "Undid Edit caption" : "Undid Edit footnotes");
      await command("edit.redo");
      expect(value(currentTable(), target)).toEqual(saved);
      await command("edit.undo"); await command("edit.undo");
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Nothing to undo");
    });
    it("saves pre-composition text without blocking IME, then autosaves the completed input", async () => {
      await open(target);
      const textarea = editor();
      await act(async () => { textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
      await type("Hello未");
      await command("document.save");
      expect(value(persistedTable(native.writeFile.mock.calls.at(-1)![1]), target).text).toBe("Hello");
      expect(editor()).toBe(textarea); expect(document.activeElement).toBe(textarea);
      expect(textarea.value).toBe("Hello未"); expect(textarea.selectionStart).toBe(6);
      await act(async () => { await native.quitFlush!(); });
      expect(value(persistedTable(native.saveSession.mock.calls.at(-1)![0].contents), target).text).toBe("Hello");
      await act(async () => { textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "完" })); });
      await type("Hello完");
      expect(snapshot().file.dirty).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(DOCUMENT_SESSION_SAVE_DEBOUNCE_MS + 100));
      expect(value(persistedTable(native.saveSession.mock.calls.at(-1)![0].contents), target).text).toBe("Hello完");
      await command("document.save");
      expect(value(persistedTable(native.writeFile.mock.calls.at(-1)![1]), target).text).toBe("Hello完");
    });
    it("marks later typing dirty after Save and keeps autosave current on successive keystrokes", async () => {
      await open(target);
      await command("document.save");
      expect(snapshot().file.dirty).toBe(false);
      await type("Hello again");
      expect(snapshot().file.dirty).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(DOCUMENT_SESSION_SAVE_DEBOUNCE_MS + 100));
      await type("Hello again!");
      await act(async () => vi.advanceTimersByTimeAsync(DOCUMENT_SESSION_SAVE_DEBOUNCE_MS + 100));
      expect(value(persistedTable(native.saveSession.mock.calls.at(-1)![0].contents), target).text).toBe("Hello again!");
    });
  });
  it("does not mark newer typing clean when an earlier save finishes", async () => {
    await open("cell");
    let finishWrite!: () => void;
    native.writeFile.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    await command("document.save");
    await type("Hello after save started");
    await act(async () => { finishWrite(); });
    expect(value(persistedTable(native.writeFile.mock.calls.at(-1)![1]), "cell").text).toBe("Hello");
    expect(snapshot().file.dirty).toBe(true);
    await command("document.save");
    expect(value(persistedTable(native.writeFile.mock.calls.at(-1)![1]), "cell").text).toBe("Hello after save started");
    expect(snapshot().file.dirty).toBe(false);
  });
});
