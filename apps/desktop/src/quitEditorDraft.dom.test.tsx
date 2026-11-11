// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTemplateMolecule, insertNativeTextObject } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";
import { loadAskToSaveBeforeQuit, saveAskToSaveBeforeQuit } from "./quitSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

const native = vi.hoisted(() => ({
  promptQuit: undefined as undefined | ((id: number) => Promise<void>),
  quitFlush: undefined as undefined | (() => Promise<void>),
  quit: vi.fn(),
  saveSession: vi.fn()
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
  listenForQuitPromptRequest: async (handler: NonNullable<typeof native.promptQuit>) => {
    native.promptQuit = handler; return () => { native.promptQuit = undefined; };
  },
  listenForQuitFlushRequest: async (handler: NonNullable<typeof native.quitFlush>) => {
    native.quitFlush = handler; return () => { native.quitFlush = undefined; };
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
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => "/tmp/quit-editor.chemdraft" }));
vi.mock("@tauri-apps/plugin-fs", async original => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(), writeTextFile: async () => {}
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["macos", "windows"] as const)("quit with an open editor (%s)", platform => {
  let container: HTMLDivElement, root: Root;
  let pendingPrompt: { prompt: NativePromptOptions; resolve: (id: string) => void } | undefined;
  let restorePrompt: () => void;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const labelEditor = () => container.querySelector<HTMLInputElement>("[data-atom-label-editor]");
  const textEditor = () => container.querySelector<HTMLTextAreaElement>(".text-object-editor");

  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function pointer(target: Element, type: string, x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerdown" ? 1 : 0, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    await act(async () => { target.dispatchEvent(event); });
  }
  async function openEditor(kind: "label" | "text", value?: string) {
    if (kind === "label") {
      await command("tool.atom");
      const molecule = snapshot().document.pages[0].objects.find(object => object.type === "molecule")!;
      const atom = molecule.atoms![0];
      await pointer(container.querySelector(`[data-object-id="${molecule.id}"]`)!, "pointerdown", atom.x, atom.y);
    } else {
      const text = snapshot().document.pages[0].objects.find(object => object.type === "text")!;
      const glyph = container.querySelector(`[data-page-svg-object-visual="${text.id}"] text`)!;
      await act(async () => { glyph.dispatchEvent(new MouseEvent("dblclick", {
        bubbles: true, cancelable: true, detail: 2, clientX: text.x + 5, clientY: text.y + 5
      })); });
    }
    await act(async () => vi.advanceTimersByTimeAsync(100));
    const editor = kind === "label" ? labelEditor() : textEditor();
    expect(editor).not.toBeNull();
    expect(document.activeElement).toBe(editor);
    if (value === undefined) return;
    await act(async () => {
      const prototype = kind === "label" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(editor, value);
      editor!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    });
  }
  async function requestQuit() {
    // These are the shared native requests used by macOS Quit and Windows document-window close.
    // Preserve focus in the editor: a prior blur would hide the dirty-ref ordering bug.
    await act(async () => {
      if (loadAskToSaveBeforeQuit()) await native.promptQuit!(1);
      else await native.quitFlush!();
    });
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
    native.saveSession.mockResolvedValue(undefined);
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    let drawing = insertNativeTemplateMolecule(createPhase4Document("Quit drafts"), { x: 300, y: 300 }, "cyclohexane");
    drawing = insertNativeTextObject(drawing, { x: 100, y: 100 }, "Conditions");
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialCrosshairsVisible={false} initialRulersVisible={false} nativePalette shortcutPlatform={platform} />));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 816, bottom: 1056, width: 816, height: 1056, toJSON: () => ({}) };
    for (const element of container.querySelectorAll(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
    }
    await command("document.save");
    expect(snapshot().file.dirty).toBe(false);
  });
  afterEach(async () => {
    restorePrompt(); await act(async () => root.unmount()); container.remove();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) Reflect.deleteProperty(Element.prototype, method);
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });

  describe.each(["label", "text"] as const)("%s draft", kind => {
    it("requests the save prompt before quitting with a changing draft", async () => {
      await openEditor(kind, kind === "label" ? "N" : "Updated conditions");
      await requestQuit();
      expect(pendingPrompt?.prompt.title).toBe("Save changes before quitting?");
      expect(native.quit).not.toHaveBeenCalled();
      await act(async () => { pendingPrompt!.resolve("cancel"); });
      expect(snapshot().file.dirty).toBe(true);
    });
    it("quits without a prompt for an unchanged draft", async () => {
      await openEditor(kind, kind === "label" ? undefined : "Conditions");
      await requestQuit();
      expect(pendingPrompt).toBeUndefined();
      expect(native.quit).toHaveBeenCalledOnce();
      expect(snapshot().file.dirty).toBe(false);
    });
    it("quits without a prompt when the preference is off", async () => {
      saveAskToSaveBeforeQuit(false);
      await openEditor(kind, kind === "label" ? "N" : "Updated conditions");
      await requestQuit();
      expect(pendingPrompt).toBeUndefined();
      expect(native.quit).toHaveBeenCalledOnce();
      expect(native.saveSession).toHaveBeenCalled();
    });
  });
  it("quits without a prompt for an empty atom-label draft", async () => {
    await openEditor("label", "N");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(labelEditor(), "");
      labelEditor()!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    });
    await requestQuit();
    expect(pendingPrompt).toBeUndefined();
    expect(native.quit).toHaveBeenCalledOnce();
    expect(snapshot().file.dirty).toBe(false);
  });
  it("quits without a prompt for an unchanged nonempty atom label", async () => {
    // An explicitly typed C is literal; typing C over a hidden carbon changes its display.
    await openEditor("label", "C");
    await act(async () => { container.querySelector<HTMLElement>(".canvas-region")!.focus(); });
    await command("document.save");
    expect(snapshot().file.dirty).toBe(false);
    await openEditor("label", "C");
    await requestQuit();
    expect(pendingPrompt).toBeUndefined();
    expect(native.quit).toHaveBeenCalledOnce();
    expect(snapshot().file.dirty).toBe(false);
  });
  it("quits without prompting again for an atom-label draft saved while open", async () => {
    await openEditor("label", "N");
    await command("document.save");
    expect(labelEditor()).not.toBeNull();
    expect(snapshot().file.dirty).toBe(false);
    await requestQuit();
    expect(pendingPrompt).toBeUndefined();
    expect(native.quit).toHaveBeenCalledOnce();
    expect(snapshot().file.dirty).toBe(false);
  });
});
