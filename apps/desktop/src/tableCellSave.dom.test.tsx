// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deserializeDocument, type ChemDraftDocument, type TableObject } from "@chemdraft/chem-core";
import { importCdx, openChemDraftPayload } from "@chemdraft/cdx-compat";
import { planTableLayout } from "@chemdraft/layout-engine";
import { MainWindow } from "./MainWindow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { buildDocumentSessionEnvelope, DOCUMENT_SESSION_SAVE_DEBOUNCE_MS, type DocumentSessionEnvelope } from "./documentSession";
import { createNativeSavePayload, createPhase4Document } from "./documentWorkflow";
import { writeClipboardTextItems, writeClipboardImage } from "./clipboard";
import { rasterizeSvgNative } from "./nativeRasterExport";
import { setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";
import { saveAskToSaveBeforeQuit } from "./quitSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

const native = vi.hoisted(() => ({
  loadSession: vi.fn<() => Promise<unknown>>(),
  pendingOpen: [] as { path: string; displayName: string; contents: string }[],
  open: undefined as undefined | (() => void),
  saveSession: vi.fn<(value: DocumentSessionEnvelope) => Promise<void>>(),
  savePath: vi.fn<() => Promise<string>>(),
  writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(),
  writeBytes: vi.fn<(path: string, bytes: Uint8Array) => Promise<void>>(),
  quitFlush: undefined as undefined | (() => Promise<void>),
  promptQuit: undefined as undefined | ((id: number) => Promise<void>),
  quit: vi.fn()
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => true,
  loadDocumentSession: native.loadSession,
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
vi.mock("./window-manager/tauriEvents", async original => ({
  ...await original<typeof import("./window-manager/tauriEvents")>(),
  listenTauriEvent: async (name: string, handler: (event: { payload: null }) => void) => {
    if (name !== "chemdraft://open-document") return () => {};
    native.open = () => handler({ payload: null });
    return () => { native.open = undefined; };
  }
}));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: vi.fn(async (command: string) => command === "take_pending_open_document" ? native.pendingOpen.splice(0) : undefined)
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.savePath }));
vi.mock("@tauri-apps/plugin-fs", async original => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(), writeTextFile: native.writeFile, writeFile: native.writeBytes
}));
vi.mock("./clipboard", async original => ({
  ...await original<typeof import("./clipboard")>(),
  writeClipboardTextItems: vi.fn(), writeClipboardImage: vi.fn()
}));
vi.mock("./nativeRasterExport", () => ({ rasterizeSvgNative: vi.fn() }));

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
  const drawing = () => deserializeDocument(readFileSync("packages/fixtures/tables/sharpless-reagent-table.json", "utf8"));
  async function mount(source: ChemDraftDocument) {
    await act(async () => root.render(<MainWindow initialDocument={source} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialCrosshairsVisible={false} initialRulersVisible={false} nativePalette shortcutPlatform={platform} />));
    const page = container.querySelector<HTMLElement>(".page")!;
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0,
      right: 816, bottom: 1056, width: 816, height: 1056, toJSON: () => ({}) });
  }
  async function remount(source: ChemDraftDocument) {
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount(source);
  }
  beforeEach(async () => {
    vi.clearAllMocks();
    native.pendingOpen.length = 0;
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
    native.savePath.mockResolvedValue("/tmp/table.chemdraft"); native.writeBytes.mockResolvedValue();
    native.loadSession.mockResolvedValue(undefined);
    vi.mocked(writeClipboardTextItems).mockResolvedValue(true);
    vi.mocked(writeClipboardImage).mockResolvedValue(true);
    vi.mocked(rasterizeSvgNative).mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), width: 10, height: 10, warnings: [] });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await mount(drawing());
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
  async function open(target: Target, text = "Hello") {
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
    await type(text);
  }

  describe.each(["cell", "caption", "footnote"] as const)("%s", target => {
    it.each(["opened", "restored", "restored dirty"] as const)("Escape restores the original dirty state of a file %s without saving this session", async source => {
      const payload = createNativeSavePayload(drawing());
      if (source !== "opened") native.loadSession.mockResolvedValueOnce(
        buildDocumentSessionEnvelope(payload, { path: "/tmp/opened-table.chemdraft", dirty: source === "restored dirty" }, "opened-table.chemdraft", false));
      await remount(createPhase4Document());
      if (source === "opened") {
        await act(async () => {
          native.pendingOpen.push({ path: "/tmp/opened-table.chemdraft", displayName: "opened-table.chemdraft", contents: payload.contents });
          native.open!();
        });
        await act(async () => {
          await vi.waitFor(() => expect(snapshot().file.path).toBe("/tmp/opened-table.chemdraft"));
        });
      }
      native.writeFile.mockClear();
      const original = value(currentTable(), target).text;
      expect(snapshot().file.dirty).toBe(source === "restored dirty");
      await open(target);
      expect(snapshot().file.dirty).toBe(true);
      await act(async () => { editor().dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true
      })); });
      expect(editor()).toBeNull();
      expect(value(currentTable(), target).text).toBe(original);
      expect(snapshot().file.dirty).toBe(source === "restored dirty");
      expect(native.writeFile).not.toHaveBeenCalled();
    });
    it.each(["svg", "png"] as const)("Copy As %s includes the open draft and leaves editing/history intact", async format => {
      const original = value(currentTable(), target).text;
      await open(target, "Unsaved draft for copying");
      const textarea = editor(); textarea.setSelectionRange(3, 3);
      await command(`clipboard.copyAs.${format}`);
      const svg = format === "svg"
        ? vi.mocked(writeClipboardTextItems).mock.calls.at(-1)![0].find(item => item.type === "image/svg+xml")!.text
        : vi.mocked(rasterizeSvgNative).mock.calls.at(-1)![0];
      expect(svg).toContain("Unsaved draft for copying");
      if (format === "png") expect(writeClipboardImage).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
      expect(editor()).toBe(textarea); expect(document.activeElement).toBe(textarea);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 3]);
      expect(value(currentTable(), target).text).toBe(original);
      expect(snapshot().file.dirty).toBe(true);
      await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true
      })); });
      expect(snapshot().file.dirty).toBe(false);
      await command("edit.undo");
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Nothing to undo");
    });
    it.each(["native command", "pointer"] as const)("aborts a tab switch via %s when the draft exceeds the table limit", async route => {
      const source = drawing();
      const table = source.pages[0].objects[0] as TableObject;
      table.columns = table.columns.slice(0, 2).map(column => ({ ...column, width: { mode: "fixed", px: 200 }, formula: "off" }));
      table.rows = Array.from({ length: 100 }, (_, index) => ({ id: `row-${index}`,
        cells: [{ text: "x".repeat(1000), spans: [] }, { text: "y".repeat(1000), spans: [] }] }));
      const noteLength = table.caption!.text.length + table.footnotes.reduce((total, note) => total + note.text.length, 0);
      table.rows.at(-1)!.cells[1].text = "y".repeat(1000 - noteLength);
      await remount(source);
      await addOtherTab();
      const original = value(currentTable(), target).text;
      await open(target, original + "z");
      const textarea = editor();
      const firstTab = container.querySelectorAll<HTMLElement>('[role="tab"]')[0];
      if (route === "native command") await command("document.nextTab");
      else await click(container.querySelectorAll<HTMLElement>('[role="tab"]')[1]);
      expect(firstTab.getAttribute("aria-selected")).toBe("true");
      expect(editor()).toBe(textarea);
      expect(textarea.value).toBe(original + "z");
      expect(value(currentTable(), target).text).toBe(original);
      expect(container.querySelector('[role="status"]')?.textContent)
        .toBe("maxTableCharacters is 200000; actual value is 200001");
      // Correcting the input allows the same navigation to complete, with the text retained.
      await type(original.slice(0, -1) + "z");
      await command("document.nextTab");
      expect(editor()).toBeNull();
      await command("document.previousTab");
      expect(value(currentTable(), target).text).toBe(original.slice(0, -1) + "z");
    });
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
      await command("document.save");
      expect(native.writeFile).toHaveBeenCalledTimes(1);
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
  it.each(["save", "quit"] as const)("writes the open table draft as CDX bytes on %s", async route => {
    native.savePath.mockResolvedValueOnce("/tmp/table.cdx");
    await command("document.saveAs");
    native.writeBytes.mockClear(); native.writeFile.mockClear();
    const original = value(currentTable(), "cell").text;
    await open("cell", "Draft saved as binary");
    if (route === "quit") {
      await act(async () => { await native.promptQuit!(1); });
      expect(pendingPrompt?.prompt.title).toBe("Save changes before quitting?");
      await act(async () => { pendingPrompt!.resolve("save"); });
      expect(native.quit).toHaveBeenCalled();
    } else {
      const textarea = editor(); textarea.setSelectionRange(3, 3);
      await command("document.save");
      expect(editor()).toBe(textarea); expect(document.activeElement).toBe(textarea);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 3]);
      expect(value(currentTable(), "cell").text).toBe(original);
      expect(snapshot().file.dirty).toBe(false);
    }
    expect(native.writeFile).not.toHaveBeenCalled();
    expect(native.writeBytes).toHaveBeenCalledTimes(1);
    const [path, bytes] = native.writeBytes.mock.calls[0];
    expect(path).toBe("/tmp/table.cdx");
    const reopened = importCdx(bytes);
    expect(reopened.source).toBe("native-payload");
    expect(value(reopened.document!.pages[0].objects[0] as TableObject, "cell").text).toBe("Draft saved as binary");
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
