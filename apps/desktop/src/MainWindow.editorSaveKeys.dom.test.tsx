// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deserializeDocument, type MoleculeObject, type TableObject, type TextObject } from "@chemdraft/chem-core";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { planTableLayout } from "@chemdraft/layout-engine";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule, insertNativeTextObject } from "./documentWorkflow";
import { type DocumentSessionEnvelope } from "./documentSession";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";
import { saveAskToSaveBeforeQuit } from "./quitSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

const native = vi.hoisted(() => ({
  writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(),
  saveDialog: vi.fn<() => Promise<string>>(),
  saveSession: vi.fn<(value: DocumentSessionEnvelope) => Promise<void>>(),
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
  listenForQuitPromptRequest: async (handler: (id: number) => Promise<void>) => {
    native.promptQuit = handler; return () => { native.promptQuit = undefined; };
  },
  listenForQuitSettings: async () => () => {},
  setQuitPromptEnabled: async () => {},
  prepareQuitPrompt: async () => true,
  resumeQuitAfterPrompt: async () => true,
  reportQuitPromptShowing: async () => true,
  cancelQuit: async () => true,
  confirmPromptedQuit: native.quit
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.saveDialog }));
vi.mock("@tauri-apps/plugin-fs", async original => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(), writeTextFile: native.writeFile
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["macos", "windows"] as const)("inline editor app shortcuts (%s)", platform => {
  describe.each(["text box", "table cell", "atom label"] as const)("%s", kind => {
    let container: HTMLDivElement, root: Root;
    let pendingPrompt: { prompt: NativePromptOptions; resolve: (id: string) => void } | undefined;
    let restorePrompt: () => void;
    const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
    const editor = () => container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      ".text-object-editor, [data-table-cell-editor] textarea, [data-atom-label-editor]")!;
    const persisted = () => openChemDraftPayload(native.writeFile.mock.calls.at(-1)![1]).document!;
    const contents = (drawing = snapshot().document) => {
      const object = drawing.pages[0].objects[0];
      if (kind === "table cell") return (object as TableObject).rows[1].cells[0].text;
      if (kind === "atom label") return (object as MoleculeObject).atoms[0].element;
      return (object as TextObject).text;
    };
    const modifiers = () => ({ metaKey: platform === "macos", ctrlKey: platform === "windows" });
    async function command(commandId: string) {
      await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
    }
    async function key(key: string, extra: KeyboardEventInit = {}) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers(), ...extra });
      await act(async () => { editor().dispatchEvent(event); });
      return event;
    }
    async function type(text: string, inputType = "insertText") {
      const field = editor();
      await act(async () => {
        const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, text);
        field.setSelectionRange(text.length, text.length);
        field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: text }));
      });
    }
    async function pointer(target: Element, type: string, x: number, y: number) {
      const scale = (snapshot().viewport as { scale: number }).scale;
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
        buttons: type === "pointerdown" ? 1 : 0, clientX: x * scale, clientY: y * scale });
      Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
      await act(async () => { target.dispatchEvent(event); });
    }
    async function open() {
      if (kind === "table cell") {
        const table = snapshot().document.pages[0].objects[0] as TableObject;
        const box = planTableLayout(table).cells.find(cell => cell.rowIndex === 1 && cell.columnIndex === 0)!.box;
        const hit = container.querySelector("[data-table-hit-target]")!;
        const page = container.querySelector(".page")!;
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        for (let i = 0; i < 2; i++) {
          await pointer(hit, "pointerdown", x, y); await pointer(page, "pointerup", x, y);
        }
        const scale = (snapshot().viewport as { scale: number }).scale;
        await act(async () => { hit.dispatchEvent(new MouseEvent("dblclick", {
          bubbles: true, cancelable: true, detail: 2, clientX: x * scale, clientY: y * scale
        })); });
      } else if (kind === "text box") {
        await command("tool.text");
        const text = snapshot().document.pages[0].objects[0] as TextObject;
        const glyph = container.querySelector(`[data-page-svg-object-visual="${text.id}"] text`)!;
        await pointer(glyph, "pointerdown", text.x + 10, text.y + 8);
        await pointer(glyph, "pointerup", text.x + 10, text.y + 8);
      } else {
        await command("tool.atom");
        const molecule = snapshot().document.pages[0].objects[0] as MoleculeObject;
        const atom = molecule.atoms[0];
        await pointer(container.querySelector(`[data-object-id="${molecule.id}"]`)!, "pointerdown", atom.x, atom.y);
      }
      await act(async () => vi.advanceTimersByTimeAsync(100));
      expect(editor()).not.toBeNull();
      expect(document.activeElement).toBe(editor());
    }
    beforeEach(async () => {
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
      native.writeFile.mockResolvedValue(); native.saveSession.mockResolvedValue();
      native.saveDialog.mockResolvedValue("/tmp/editor.chemdraft");
      window.history.replaceState(null, "", "/?agentBridge=1");
      container = document.createElement("div"); document.body.append(container); root = createRoot(container);
      const source = kind === "table cell"
        ? deserializeDocument(readFileSync("packages/fixtures/tables/sharpless-reagent-table.json", "utf8"))
        : kind === "text box" ? insertNativeTextObject(createPhase4Document(), { x: 220, y: 200 }, "Original")
          : insertNativeSingleBondMolecule(createPhase4Document(), { x: 100, y: 100 });
      await act(async () => root.render(<MainWindow initialDocument={source} initialActiveToolCommandId="tool.select"
        initialPaletteMode="hidden" initialCrosshairsVisible={false} initialRulersVisible={false} nativePalette shortcutPlatform={platform} />));
      for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
        vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0,
          right: 816, bottom: 1056, width: 816, height: 1056, toJSON: () => ({}) });
      }
      await command("document.save");
      expect(snapshot().file.dirty).toBe(false);
      native.writeFile.mockClear(); native.saveDialog.mockClear(); native.saveSession.mockClear();
      await open();
    });
    afterEach(async () => {
      restorePrompt(); await act(async () => root.unmount()); container.remove();
      vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
      for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) Reflect.deleteProperty(Element.prototype, method);
      window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
    });

    it.each([false, true])("saves the open draft once through the registered command (Save As: %s)", async saveAs => {
      const draft = kind === "atom label" ? "OMe" : "abc";
      await type(draft);
      const field = editor(); field.setSelectionRange(1, 1);
      const chord = await key(saveAs ? "S" : "s", { shiftKey: saveAs });
      expect(chord.defaultPrevented).toBe(true);
      // A native menu accelerator is only eligible as the unhandled key's default action. Emulate
      // that fallback too: a missing preventDefault would invoke Save a second time on macOS.
      if (platform === "macos" && !chord.defaultPrevented) await command(saveAs ? "document.saveAs" : "document.save");
      expect(native.writeFile).toHaveBeenCalledTimes(1);
      expect(native.saveDialog).toHaveBeenCalledTimes(saveAs ? 1 : 0);
      expect(contents(persisted())).toBe(draft);
      expect(editor()).toBe(field); expect(document.activeElement).toBe(field);
      expect([field.selectionStart, field.selectionEnd]).toEqual([1, 1]);
      expect(snapshot().file.dirty).toBe(false);
    });

    it("retains editor-local select/copy/paste/undo and leaves document history alone", async () => {
      const original = editor().value;
      const draft = kind === "atom label" ? "OMe" : "abc";
      await type(draft);
      const field = editor(), beforeUndo = snapshot().document;
      expect((await key("a")).defaultPrevented).toBe(kind !== "atom label");
      expect((await key("c")).defaultPrevented).toBe(false);
      expect((await key("v")).defaultPrevented).toBe(false);
      expect((await key("z")).defaultPrevented).toBe(false);
      expect(editor()).toBe(field); expect(field.value).toBe(draft);
      expect(snapshot().document).toEqual(beforeUndo);
      expect(native.writeFile).not.toHaveBeenCalled();
      // jsdom has no native editing undo stack. Deliver the browser's historyUndo input after
      // verifying that the real key event was left available to that default action.
      await type(original, "historyUndo");
      expect(editor()).toBe(field); expect(field.value).toBe(original);
      if (kind === "atom label") {
        // An empty implicit-carbon draft is restored by the shared flush rather than the preview.
        await command("document.save");
        expect(contents(persisted())).toBe(original || "C");
      } else expect(contents()).toBe(kind === "table cell" ? contents(beforeUndo) : original);
    });

    it("preserves the native quit route and flushes the draft before quitting", async () => {
      const draft = kind === "atom label" ? "OMe" : "abc";
      await type(draft);
      const chord = await key("q");
      expect(chord.defaultPrevented).toBe(false);
      expect(editor().value).toBe(draft);
      expect(native.writeFile).not.toHaveBeenCalled();
      expect(native.quit).not.toHaveBeenCalled();
      // lib.rs registers Cmd+Q only on macOS. Windows has Exit without an accelerator, so Ctrl+Q
      // must stay unbound; exercise its native Exit request explicitly instead.
      expect(pendingPrompt).toBeUndefined();
      await act(async () => { await native.promptQuit!(1); });
      // Atom-label finalization now reconciles dirty state before the quit guard reads it,
      // so every changing editor draft must wait for the save choice.
      expect(pendingPrompt?.prompt.title).toBe("Save changes before quitting?");
      expect(native.writeFile).not.toHaveBeenCalled();
      expect(native.quit).not.toHaveBeenCalled();
      await act(async () => { pendingPrompt!.resolve("save"); });
      expect(native.writeFile).toHaveBeenCalledTimes(1);
      expect(contents(persisted())).toBe(draft);
      expect(native.saveSession).toHaveBeenCalledTimes(1);
      expect(contents(openChemDraftPayload(native.saveSession.mock.calls[0][0].contents).document!)).toBe(draft);
      expect(native.quit).toHaveBeenCalledTimes(1);
      expect(native.writeFile.mock.invocationCallOrder[0]).toBeLessThan(native.quit.mock.invocationCallOrder[0]);
      expect(native.saveSession.mock.invocationCallOrder[0]).toBeLessThan(native.quit.mock.invocationCallOrder[0]);
    });
  });
});
