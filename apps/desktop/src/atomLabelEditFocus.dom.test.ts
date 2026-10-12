// @vitest-environment jsdom

// Tester report: while typing a substituent label (OMe, CO2Et) "the text kept getting erased even
// though I hadn't clicked the eraser tool". Once the label editor lost focus mid-word, the rest of
// the word reached the canvas hotkeys: the edit had selected the atom, so "O" relabeled it,
// Backspace stripped it, and "e" armed the eraser (ChemDraft scheme) or applied Et (ChemDraw).

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { applyPatches, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeBondLengthPx } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { applyNativeAtomElementTarget, createPhase4Document, insertNativeSingleBondMolecule, insertNativeTemplateMolecule, insertNativeTextObject, selectDocumentObjects } from "./documentWorkflow";
import { convertTextToAtomLabelCommandId } from "./commands";
import { saveKeybindingSettings } from "./keybindingSettings";
import { DOM_COMMAND_EVENT, focusCurrentWindowAndWebview } from "./window-manager";

const nativeFocus = vi.hoisted(() => ({
  invoke: vi.fn(),
  windowSetFocus: vi.fn(),
  webviewSetFocus: vi.fn()
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: nativeFocus.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", setFocus: nativeFocus.windowSetFocus })
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setFocus: nativeFocus.webviewSetFocus })
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => {})
}));
// The flush test writes the editor's keystrokes plainly, without the rule that writes a label typed
// back to its starting text as it started, so that only the flush's own rule can save it correctly.
const labelDraftWrite = vi.hoisted(() => ({ plain: false }));
vi.mock("./documentWorkflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./documentWorkflow")>();
  return {
    ...actual,
    applyNativeAtomLabelDraft: (...args: Parameters<typeof actual.applyNativeAtomLabelDraft>) => labelDraftWrite.plain
      ? actual.applyNativeAtomElementTarget(args[0], args[1], args[2], { literal: true })
      : actual.applyNativeAtomLabelDraft(...args)
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pageRect = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 792,
  bottom: 612,
  width: 792,
  height: 612,
  toJSON: () => ({})
} as DOMRect;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("atom label editor focus", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    nativeFocus.invoke.mockReset().mockResolvedValue(undefined);
    nativeFocus.windowSetFocus.mockReset().mockResolvedValue(undefined);
    nativeFocus.webviewSetFocus.mockReset().mockResolvedValue(undefined);
    saveKeybindingSettings({ scheme: "chemdraft" });
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.hasPointerCapture = () => false;
    window.history.replaceState(null, "", "/?agentBridge=1");

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    labelDraftWrite.plain = false;
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    saveKeybindingSettings({ scheme: "chemdraft" });
    window.history.replaceState(null, "", "/");
    Reflect.deleteProperty(navigator, "platform");
    delete window.__CHEMDRAFT_AGENT__;
    Reflect.deleteProperty(globalThis, "__TAURI__");
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  /** Cyclohexane with nothing selected: the usual state before a label edit starts. */
  function ringDocument(): ChemDraftDocument {
    const withRing = insertNativeTemplateMolecule(createPhase4Document("Label focus"), { x: 300, y: 300 }, "cyclohexane");
    return selectDocumentObjects(withRing, withRing.pages[0].id, []);
  }

  async function renderMainWindow(initialDocument: ChemDraftDocument, initialActiveToolCommandId = "tool.atom") {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId,
        initialCrosshairsVisible: false,
        initialDocument,
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });
    const page = container.querySelector<HTMLElement>(".page");
    if (!page) {
      throw new Error("Expected rendered page.");
    }
    page.getBoundingClientRect = () => pageRect;
    const canvasRegion = container.querySelector<HTMLElement>(".canvas-region");
    if (canvasRegion) {
      canvasRegion.getBoundingClientRect = () => pageRect;
    }
    await settle();
  }

  async function settle() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  function bridge() {
    const agent = window.__CHEMDRAFT_AGENT__;
    if (!agent) {
      throw new Error("Expected agent bridge.");
    }
    return agent;
  }

  function molecule(objectIndex = 0): MoleculeObject {
    const object = bridge().snapshot().document.pages[0].objects[objectIndex];
    if (object?.type !== "molecule") {
      throw new Error("Expected the ring molecule.");
    }
    return object;
  }

  function atomElement(atomId: string, objectIndex = 0): string | undefined {
    return molecule(objectIndex).atoms.find((atom) => atom.id === atomId)?.element;
  }

  function labelEditor(): HTMLInputElement | null {
    return container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
  }

  /** Press an atom with the Atom Label tool, which opens the label editor on it. */
  async function startLabelEdit(objectIndex = 0): Promise<string> {
    const target = molecule(objectIndex);
    const atom = target.atoms[0]!;
    const wrapper = container.querySelector<HTMLElement>(`[data-object-id="${target.id}"]`)!;
    await act(async () => {
      const event = new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        cancelable: true,
        clientX: atom.x,
        clientY: atom.y,
        detail: 1
      });
      Object.defineProperties(event, {
        isPrimary: { value: true },
        pointerId: { value: 7 },
        pointerType: { value: "mouse" }
      });
      wrapper.dispatchEvent(event);
    });
    await settle();
    const editor = labelEditor();
    expect(editor, "the Atom Label tool should open the label editor").not.toBeNull();
    expect(editor?.getAttribute("data-atom-id")).toBe(atom.id);
    return atom.id;
  }

  async function typeIntoEditor(value: string) {
    const editor = labelEditor()!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(editor, value);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /**
   * Blur the editor the way a click elsewhere in the app does: the window keeps focus. jsdom's
   * document.hasFocus() means "some element is focused", which is false mid-blur; a real webview
   * reports window focus, so stub it to what WebKit says in this case.
   */
  async function blurWithinFocusedWindow() {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await act(async () => {
      labelEditor()!.blur();
    });
    hasFocus.mockRestore();
  }

  /**
   * A native palette or popover becoming key: the input blurs while the document itself reports no
   * focus, which is the window being deactivated rather than the user leaving the editor.
   */
  async function loseFocusToAnotherWindow() {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await act(async () => {
      labelEditor()!.blur();
    });
    hasFocus.mockRestore();
  }

  /** What a native palette click delivers: the routed command, as Rust dispatches it. */
  async function paletteCommand(commandId: string) {
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }));
    });
    await settle();
  }

  /** A key press goes where the browser sends it: the focused element, bubbling up to window. */
  async function pressWhereFocused(key: string) {
    const target = document.activeElement ?? document.body;
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }

  async function pressOnWindow(key: string) {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }

  async function pressOnCanvas(init: KeyboardEventInit): Promise<KeyboardEvent> {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    await act(async () => {
      container.querySelector<HTMLElement>(".page")!.dispatchEvent(event);
    });
    return event;
  }

  function setShortcutPlatform(platform: "macos" | "windows") {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: platform === "macos" ? "MacIntel" : "Win32"
    });
  }

  async function pointerPress(element: Element, point: { x: number; y: number }) {
    await act(async () => {
      const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true,
        button: 0, buttons: 1, clientX: point.x, clientY: point.y });
      Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 7 }, pointerType: { value: "mouse" } });
      element.dispatchEvent(event);
    });
    await settle();
  }

  function enableMockDesktop(raised: boolean) {
    Object.defineProperty(globalThis, "__TAURI__", { configurable: true, value: {} });
    nativeFocus.invoke.mockImplementation(async (command: string) =>
      command === "focus_main_document_window_if_app_active" ? raised : undefined
    );
  }

  function expectNoWindowRaise() {
    expect(nativeFocus.invoke.mock.calls.filter(([command]) =>
      command === "focus_main_document_window" || command === "focus_main_document_window_if_app_active"
    )).toEqual([]);
    expect(nativeFocus.windowSetFocus).not.toHaveBeenCalled();
    expect(nativeFocus.webviewSetFocus).not.toHaveBeenCalled();
  }

  async function startInlineEdit(kind: "atom" | "text") {
    if (kind === "atom") {
      await startLabelEdit();
      return labelEditor()!;
    }
    await pointerPress(container.querySelector(".page")!, { x: 100, y: 100 });
    const editor = container.querySelector<HTMLTextAreaElement>(".text-object-editor");
    expect(editor).not.toBeNull();
    return editor!;
  }

  describe.each(["macos", "windows"] as const)("inline activation guard (%s)", (platform) => {
    it.each(["atom", "text"] as const)("hides canvas modifier hints while the %s editor owns focus", async (kind) => {
      setShortcutPlatform(platform);
      await renderMainWindow(ringDocument(), kind === "atom" ? "tool.atom" : "tool.text");
      const editor = await startInlineEdit(kind);
      expect(document.activeElement).toBe(editor);
      await act(async () => {
        editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift", shiftKey: true }));
      });
      expect(container.querySelector("[data-modifier-hint]")).toBeNull();
      expect(document.activeElement).toBe(editor);
      await act(async () => {
        editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift", shiftKey: false }));
      });
      expect(container.querySelector("[data-modifier-hint]")).toBeNull();
      expect(document.activeElement).toBe(editor);
    });

    it.each(["atom", "text"] as const)("window focus restores only the %s editor's DOM focus", async (kind) => {
      setShortcutPlatform(platform);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await renderMainWindow(ringDocument(), kind === "atom" ? "tool.atom" : "tool.text");
      const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      enableMockDesktop(true);
      const editor = await startInlineEdit(kind);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      hasFocus.mockReturnValue(false);
      await act(async () => { editor.blur(); });
      expect(document.activeElement).not.toBe(editor);
      nativeFocus.invoke.mockClear();
      nativeFocus.windowSetFocus.mockClear();
      nativeFocus.webviewSetFocus.mockClear();
      const browserFocus = vi.spyOn(window, "focus").mockImplementation(() => {});
      // Even if hasFocus has not caught up to the event, this path must restore only DOM focus.
      await act(async () => { window.dispatchEvent(new FocusEvent("focus")); });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(document.activeElement).toBe(editor);
      expectNoWindowRaise();
      expect(browserFocus).not.toHaveBeenCalled();
    });

    it.each(["atom", "text"] as const)("focused document schedules %s DOM retries without raising", async (kind) => {
      setShortcutPlatform(platform);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await renderMainWindow(ringDocument(), kind === "atom" ? "tool.atom" : "tool.text");
      const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      enableMockDesktop(true);
      const browserFocus = vi.spyOn(window, "focus").mockImplementation(() => {});
      const editor = await startInlineEdit(kind);
      expect(document.activeElement).toBe(editor);
      // Keep the edit open through blur, then model an already focused document for the retries.
      hasFocus.mockReturnValue(false);
      await act(async () => { editor.blur(); });
      hasFocus.mockReturnValue(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(document.activeElement).toBe(editor);
      expectNoWindowRaise();
      expect(browserFocus).not.toHaveBeenCalled();
    });

    it.each([false, true])("unfocused document follows the native activation decision (%s)", async (raised) => {
      setShortcutPlatform(platform);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await renderMainWindow(ringDocument());
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      enableMockDesktop(raised);
      const browserFocus = vi.spyOn(window, "focus").mockImplementation(() => {});
      const editor = await startInlineEdit("atom");
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      const focusCommands = nativeFocus.invoke.mock.calls.filter(([command]) =>
        command.startsWith("focus_main_document_window")
      );
      expect(focusCommands).toHaveLength(4);
      expect(focusCommands.every(([command]) => command === "focus_main_document_window_if_app_active")).toBe(true);
      expect(nativeFocus.windowSetFocus).toHaveBeenCalledTimes(raised ? 4 : 0);
      expect(nativeFocus.webviewSetFocus).toHaveBeenCalledTimes(raised ? 4 : 0);
      expect(document.activeElement).toBe(editor);
      expect(browserFocus).not.toHaveBeenCalled();
    });
  });

  it("refuses JS activation if the guarded native command fails", async () => {
    enableMockDesktop(false);
    nativeFocus.invoke.mockRejectedValue(new Error("Native focus unavailable"));
    await focusCurrentWindowAndWebview({ onlyIfAppActive: true });
    expect(nativeFocus.windowSetFocus).not.toHaveBeenCalled();
    expect(nativeFocus.webviewSetFocus).not.toHaveBeenCalled();
  });

  it("preserves unguarded activation and its fallback for other callers", async () => {
    enableMockDesktop(false);
    nativeFocus.invoke.mockRejectedValue(new Error("Native focus unavailable"));
    await focusCurrentWindowAndWebview();
    expect(nativeFocus.invoke).toHaveBeenCalledWith("focus_main_document_window");
    expect(nativeFocus.windowSetFocus).toHaveBeenCalledTimes(1);
    expect(nativeFocus.webviewSetFocus).toHaveBeenCalledTimes(1);
  });

  function chainDocument() {
    return insertNativeSingleBondMolecule(createPhase4Document("Text label conversion"), { x: 300, y: 300 });
  }

  it.each(["macos", "windows"] as const)("Text click on a plain carbon needs no prior hover (%s)", async (platform) => {
    setShortcutPlatform(platform);
    await renderMainWindow(chainDocument());
    const atom = molecule().atoms[1]!;
    await paletteCommand("tool.text");
    expect(bridge().snapshot().hoveredNativeTarget).toBeUndefined();
    // Dispatch on the page itself: an invisible carbon vertex need not have a DOM glyph.
    await pointerPress(container.querySelector(".page")!, atom);
    expect(labelEditor()?.getAttribute("data-atom-id")).toBe(atom.id);
    expect(container.querySelector(".text-object-editor")).toBeNull();
    expect(bridge().snapshot().document.pages[0].objects).toHaveLength(1);
  });

  it.each(["macos", "windows"] as const)("Text click inside the 8 px atom-label conversion reach edits the atom instead of placing text (%s)", async (platform) => {
    setShortcutPlatform(platform);
    await renderMainWindow(chainDocument());
    const atom = molecule().atoms[1]!;
    await paletteCommand("tool.text");
    // The Text tool's atom-first hit test and fresh-text conversion both use the 8 px atom
    // radius. Therefore a real Text-tool placement cannot leave a new text anchor within that
    // conversion reach: the same click opens the atom-label editor first.
    await pointerPress(container.querySelector(".page")!, { x: atom.x, y: atom.y + 7 });
    expect(labelEditor()?.getAttribute("data-atom-id")).toBe(atom.id);
    expect(container.querySelector(".text-object-editor")).toBeNull();
    expect(bridge().snapshot().document.pages[0].objects).toHaveLength(1);
  });

  it.each(["macos", "windows"] as const)("keeps fresh text near, but outside, the atom hit radius (%s)", async (platform) => {
    setShortcutPlatform(platform);
    await renderMainWindow(chainDocument());
    const originalAtom = { ...molecule().atoms[1]! };
    const textPoint = { x: originalAtom.x, y: originalAtom.y + nativeBondLengthPx * (2 / 3) };
    await paletteCommand("tool.text");
    await pointerPress(container.querySelector(".page")!, textPoint);
    const editor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "OMe");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await act(async () => { editor.blur(); });
    focused.mockRestore();
    await settle();

    const objects = bridge().snapshot().document.pages[0].objects;
    expect(objects).toHaveLength(2);
    expect(objects.find((object) => object.type === "text")).toMatchObject({ type: "text", text: "OMe", x: textPoint.x, y: textPoint.y });
    expect(molecule().atoms.find((atom) => atom.id === originalAtom.id)).toEqual(originalAtom);
  });

  it("commits the first of two fresh Text-tool placements when the second placement ends its edit", async () => {
    // Start with Text active so its first stamp stays active for the next click. The second
    // pointer handler then registers its fresh id before React observes the first editor ending.
    await renderMainWindow(chainDocument(), "tool.text");
    // Both captions go through real Text-tool placement. The first one is an exact element in
    // open space, so its first commit takes the automatic standalone-atom path.
    await pointerPress(container.querySelector(".page")!, { x: 100, y: 100 });
    const firstEditor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(firstEditor, "N");
      firstEditor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // React observes the first editor ending after this second placement has registered its own
    // fresh id. A single-slot ref loses the first id here; the Set commits it to an atom.
    await pointerPress(container.querySelector(".page")!, { x: 150, y: 100 });

    const objects = bridge().snapshot().document.pages[0].objects;
    expect(objects.filter((object) => object.type === "molecule")).toHaveLength(2);
    expect(objects.find((object) => object.type === "text")).toMatchObject({
      type: "text", text: "Text", x: 150, y: 100
    });
    expect(objects.some((object) => object.type === "text" && object.text === "N")).toBe(false);
  });

  it.each(["OMe", "CH3", "NO2", "   "])("keeps re-edited existing text %j on a chain end as text", async (label) => {
    const base = chainDocument();
    const original = base.pages[0].objects[0] as MoleculeObject;
    const atom = original.atoms[1]!;
    const initial = insertNativeTextObject(base, atom, "Placeholder");
    const textId = initial.selection.objectIds[0]!;
    await renderMainWindow(initial);
    await paletteCommand("tool.text");
    await pointerPress(container.querySelector(`[data-object-id="${textId}"]`)!, atom);
    const editor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
    expect(editor).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, label);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await act(async () => { editor.blur(); });
    focused.mockRestore();
    await settle();
    expect(bridge().snapshot().document.pages[0].objects).toHaveLength(2);
    expect(bridge().snapshot().document.pages[0].objects.find((object) => object.id === textId))
      .toMatchObject({ type: "text", text: label });
    expect(atomElement(atom.id)).toBe("C");
    expect(molecule().bonds).toEqual(original.bonds);
  });

  it("runs the explicit command as one labelled undo entry", async () => {
    const base = chainDocument();
    const atom = (base.pages[0].objects[0] as MoleculeObject).atoms[1]!;
    const initial = insertNativeTextObject(base, { x: atom.x, y: atom.y + 15 }, "OMe");
    await renderMainWindow(initial);
    await paletteCommand(convertTextToAtomLabelCommandId);
    expect(bridge().snapshot().document.pages[0].objects).toHaveLength(1);
    expect(atomElement(atom.id)).toBe("OMe");
    expect(bridge().snapshot().selectedNativeMoleculePart).toMatchObject({ kind: "atom", atomId: atom.id });
    await paletteCommand("edit.undo");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Undid Convert Text to Atom Label");
    expect(atomElement(atom.id)).toBe("C");
    expect(bridge().snapshot().document.pages[0].objects).toHaveLength(2);
    await paletteCommand("edit.undo");
    expect(bridge().snapshot().document.pages[0].objects).toHaveLength(2);
  });

  it("explains a refused explicit conversion without changing the document", async () => {
    const initial = insertNativeTextObject(chainDocument(), { x: 100, y: 100 }, "OMe");
    await renderMainWindow(initial);
    const before = bridge().snapshot().document;
    await paletteCommand(convertTextToAtomLabelCommandId);
    expect(bridge().snapshot().document).toEqual(before);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("No atom within one bond length");
  });

  it.each(["OMe", "CH3", "NO2"])("keeps committed %s in open space as text", async (label) => {
    const initial = insertNativeTextObject(chainDocument(), { x: 100, y: 100 }, label);
    const textId = initial.selection.objectIds[0]!;
    await renderMainWindow(initial);
    await paletteCommand("tool.text");
    await pointerPress(container.querySelector(`[data-object-id="${textId}"]`)!, { x: 100, y: 100 });
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await act(async () => { container.querySelector<HTMLTextAreaElement>(".text-object-editor")!.blur(); });
    focused.mockRestore();
    await settle();
    expect(bridge().snapshot().document.pages[0].objects.find((object) => object.id === textId)).toMatchObject({ type: "text", text: label });
    expect(molecule().atoms).toHaveLength(2);
  });

  it("reports a fused benzene template through the real placement handler", async () => {
    const initial = ringDocument();
    await renderMainWindow(initial);
    const ring = molecule();
    const bond = ring.bonds[0]!;
    const from = ring.atoms.find((atom) => atom.id === bond.fromAtomId)!;
    const to = ring.atoms.find((atom) => atom.id === bond.toAtomId)!;
    await paletteCommand("tool.benzene");
    await pointerPress(container.querySelector(`[data-object-id="${ring.id}"]`)! , {
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Fused benzene template");
  });

  it("reports a spiro cyclohexane template through the real placement handler", async () => {
    // Spiro benzene on a ring carbon would leave it five-valent, so the guard places it
    // separately; a saturated spiro ring is the legal case.
    const initial = ringDocument();
    await renderMainWindow(initial);
    const ring = molecule();
    const atom = ring.atoms[0]!;
    await paletteCommand("tool.cyclohexane");
    await pointerPress(container.querySelector(`[data-object-id="${ring.id}"]`)! , atom);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Made spiro cyclohexane template");
  });

  it("reports a separately placed benzene fallback through the real placement handler", async () => {
    const initial = ringDocument();
    const ring = initial.pages[0].objects[0] as MoleculeObject;
    const atom = ring.atoms[0]!;
    const saturated: MoleculeObject = {
      ...ring,
      atoms: [
        ...ring.atoms,
        { id: "atom_fallback_1", element: "C", x: atom.x + 30, y: atom.y, formalCharge: 0 },
        { id: "atom_fallback_2", element: "C", x: atom.x - 30, y: atom.y, formalCharge: 0 }
      ],
      bonds: [
        ...ring.bonds,
        { id: "bond_fallback_1", fromAtomId: atom.id, toAtomId: "atom_fallback_1", order: "single" },
        { id: "bond_fallback_2", fromAtomId: atom.id, toAtomId: "atom_fallback_2", order: "single" }
      ]
    };
    await renderMainWindow(applyPatches(initial, [{ op: "updateObject", objectId: ring.id, changes: saturated }]));
    await paletteCommand("tool.benzene");
    await pointerPress(container.querySelector(`[data-object-id="${ring.id}"]`)! , atom);
    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain("Placed benzene separately: that atom has no free valence");
  });

  it.each([
    ["macOS", "macos", { metaKey: true }],
    ["Windows", "windows", { ctrlKey: true }]
  ] as const)("routes %s canvas undo, but not Backspace, while an inline editor awaits focus", async (_name, platform, modifiers) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setShortcutPlatform(platform);
    const firstRing = insertNativeTemplateMolecule(createPhase4Document("Pending editor undo"), { x: 200, y: 300 }, "cyclohexane");
    const firstRingId = firstRing.pages[0].objects[0]!.id;
    const twoRings = insertNativeTemplateMolecule(firstRing, { x: 500, y: 300 }, "cyclohexane");
    await renderMainWindow(selectDocumentObjects(twoRings, twoRings.pages[0].id, [firstRingId]));
    await pressOnCanvas({ key: "Delete" });
    expect(bridge().snapshot().document.pages[0].objects).toHaveLength(1);

    const atomId = await startLabelEdit();
    await act(async () => { vi.advanceTimersByTime(100); });
    await loseFocusToAnotherWindow();
    expect(labelEditor()).not.toBeNull();
    expect(document.activeElement).not.toBe(labelEditor());

    await pressOnCanvas({ key: "Backspace" });
    expect(atomElement(atomId)).toBe("C");
    expect(molecule().atoms).toHaveLength(6);

    await pressOnCanvas({ key: "z", ...modifiers });
    expect(bridge().snapshot().document.pages[0].objects).toHaveLength(2);
  });

  /**
   * Sol rr5: SCN written with its bond on the left, then turned round (its neighbour now on its
   * right), so a label written now would read from the drawing as the N-bonded isomer.
   */
  function turnedThiocyanate(extraEthane = false): ChemDraftDocument {
    const start = createPhase4Document("Turned SCN");
    const molecule: MoleculeObject = {
      id: "scn", type: "molecule", x: 260, y: 280, width: 80, height: 40, rotation: 0, style: {},
      structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
      atoms: [
        { id: "s1", element: "SCN", x: 280, y: 300, formalCharge: 0, labelLiteral: true, labelBondSide: { side: "left", atomId: "c1" } },
        { id: "c1", element: "C", x: 310, y: 300, formalCharge: 0 }
      ],
      bonds: [{ id: "b1", fromAtomId: "c1", toAtomId: "s1", order: "single" }]
    };
    const withMolecule = applyPatches(start, [{ op: "addObject", pageId: start.pages[0].id, object: molecule }]);
    const document = extraEthane ? insertNativeSingleBondMolecule(withMolecule, { x: 500, y: 300 }) : withMolecule;
    return selectDocumentObjects(document, document.pages[0].id, []);
  }

  const thiocyanateSide = () => molecule().atoms.find((atom) => atom.id === "s1")?.labelBondSide?.side;

  describe("a session that ends on its starting text keeps a cyano label's bond side, however it closes", () => {
    const side = thiocyanateSide;

    /** One session types O, then SCN again. */
    async function retypeSameLabel() {
      expect(side()).toBe("left");
      await startLabelEdit();
      await typeIntoEditor("O");
      expect(side(), "O carries no record").toBeUndefined();
      await typeIntoEditor("SCN");
      // The keystroke that brings the label back writes it as it started, so the document never
      // holds a side re-read from the turned-round drawing, mid-session or after.
      expect(side(), "typed back, the label is written as it started").toBe("left");
    }

    it.each([
      ["Enter", () => pressWhereFocused("Enter")],
      ["Escape", () => pressWhereFocused("Escape")],
      ["a blur or click elsewhere in the app", () => blurWithinFocusedWindow()],
      ["a tool picked in the native palette", () => paletteCommand("tool.text")]
    ] as const)("closed by %s", async (_name, close) => {
      await renderMainWindow(turnedThiocyanate());
      await retypeSameLabel();
      await close();
      await settle();
      expect(labelEditor()).toBeNull();
      expect(atomElement("s1")).toBe("SCN");
      expect(side()).toBe("left");
    });

    it("closed by moving straight to another atom's edit", async () => {
      await renderMainWindow(turnedThiocyanate(true));
      await retypeSameLabel();
      await startLabelEdit(1);
      expect(labelEditor()?.getAttribute("data-atom-id")).toBe(molecule(1).atoms[0]!.id);
      expect(side()).toBe("left");
    });

    it("closed by a canvas undo: the state undo lands on is left exactly as it was", async () => {
      // While the editor holds focus, Ctrl+Z is the text field's own undo; a canvas undo reaches the
      // document once focus has gone to another window (the path tested above for Backspace).
      setShortcutPlatform("windows");
      // A committed change to undo first: delete the extra ethane.
      const document = turnedThiocyanate(true);
      const ethaneId = document.pages[0].objects[1]!.id;
      await renderMainWindow(selectDocumentObjects(document, document.pages[0].id, [ethaneId]));
      await pressOnCanvas({ key: "Delete" });
      expect(bridge().snapshot().document.pages[0].objects).toHaveLength(1);
      await retypeSameLabel();
      await loseFocusToAnotherWindow();
      await pressOnCanvas({ key: "z", ctrlKey: true });
      await settle();
      expect(labelEditor()).toBeNull();
      const restored = bridge().snapshot().document.pages[0].objects;
      expect(restored).toHaveLength(2);
      expect(molecule()).toEqual(document.pages[0].objects[0]);
    });

    it.each(["macos", "windows"] as const)("a delayed focus retry cannot reroute a canvas undo to text (%s)", async platform => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      setShortcutPlatform(platform);
      const documentBefore = turnedThiocyanate(true);
      const ethaneId = documentBefore.pages[0].objects[1]!.id;
      await renderMainWindow(selectDocumentObjects(documentBefore, documentBefore.pages[0].id, [ethaneId]));
      await pressOnCanvas({ key: "Delete" });
      expect(bridge().snapshot().document.pages[0].objects).toHaveLength(1);
      await retypeSameLabel();
      const editor = labelEditor()!;
      await loseFocusToAnotherWindow();
      expect(document.activeElement).not.toBe(editor);
      // Under load the editor's startup retry can run between blur and the canvas key. Force
      // that ordering rather than relying on real time: the event target still owns the key.
      await act(async () => { await vi.advanceTimersByTimeAsync(80); });
      expect(document.activeElement).toBe(editor);
      const undo = await pressOnCanvas({ key: "z", [platform === "macos" ? "metaKey" : "ctrlKey"]: true });
      expect(undo.defaultPrevented).toBe(true);
      expect(labelEditor()).toBeNull();
      expect(bridge().snapshot().document.pages[0].objects).toHaveLength(2);
      expect(molecule()).toEqual(documentBefore.pages[0].objects[0]);
      // Later focus/resume work must not reopen the ended session or modify the restored state.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
        window.dispatchEvent(new Event("focus"));
      });
      expect(labelEditor()).toBeNull();
      expect(molecule()).toEqual(documentBefore.pages[0].objects[0]);
    });

    it("closed by switching to a new document: nothing is written into it", async () => {
      await renderMainWindow(turnedThiocyanate());
      await retypeSameLabel();
      await paletteCommand("document.new");
      await settle();
      expect(labelEditor()).toBeNull();
      expect(bridge().snapshot().document.pages[0].objects.filter((object) => object.type === "molecule")).toEqual([]);
    });

    it("saved while the session is still open: the file holds the label as the close will leave it", async () => {
      // Every flush (Save, export, the session autosave, the quit and window-close flush) writes the
      // document as if the open edit had closed (documentForFlush). Save is the one reachable without
      // the desktop runtime: off it, Save downloads the file, captured here. The keystroke rule already
      // leaves the present document as the close will (tested above), so here keystrokes are written
      // plainly: the present holds the side re-read from the turned-round drawing, and only the
      // flush's own rule can save the starting one.
      labelDraftWrite.plain = true;
      const saved: Blob[] = [];
      const createObjectURL = vi.fn((blob: Blob) => { saved.push(blob); return "blob:saved"; });
      Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      await renderMainWindow(turnedThiocyanate());
      await startLabelEdit();
      await typeIntoEditor("O");
      await typeIntoEditor("SCN");
      expect(side(), "written plainly, the present document holds the drawing's side").toBe("right");
      await paletteCommand("document.save");
      await settle();
      // The edit stays open, and the saved file holds the label with the side it was written with.
      expect(labelEditor()).not.toBeNull();
      expect(saved).toHaveLength(1);
      const reopened = openChemDraftPayload(await saved[0]!.text()).document!;
      const savedMolecule = reopened.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
      expect(savedMolecule.atoms.find((atom) => atom.id === "s1")).toMatchObject({
        element: "SCN", labelBondSide: { side: "left", atomId: "c1" }
      });
    });

    it("a commit made while the session is open: its undo entry keeps the starting record", async () => {
      await renderMainWindow(turnedThiocyanate());
      await retypeSameLabel();
      // The edited molecule is selected; recolouring it commits while the label edit is open.
      await paletteCommand("object.color.red");
      expect(side()).toBe("left");
      await paletteCommand("edit.undo");
      expect(atomElement("s1")).toBe("SCN");
      expect(side()).toBe("left");
    });

    it("restarted on the same atom: the session keeps the label it started from", async () => {
      await renderMainWindow(turnedThiocyanate());
      await startLabelEdit();
      await typeIntoEditor("O");
      await startLabelEdit();
      await typeIntoEditor("SCN");
      await pressWhereFocused("Enter");
      await settle();
      expect(atomElement("s1")).toBe("SCN");
      expect(side()).toBe("left");
    });

    it("a session that ends on other text is a new label, read from the drawing", async () => {
      await renderMainWindow(turnedThiocyanate());
      await startLabelEdit();
      await typeIntoEditor("OCN");
      await pressWhereFocused("Enter");
      await settle();
      expect(atomElement("s1")).toBe("OCN");
      expect(side()).toBe("right");
    });
  });

  describe("a label edit closed by a press that commits before the close", () => {
    // Fable rr6: a press that closes the edit and commits takes the present document as its start
    // (its undo entry) before the close runs. The Atom Label tool's presses commit nothing, and the
    // Bond tool opens the editor only by hover typing, whose session starts on a single element letter
    // that carries no record; tool hotkeys are blocked while an edit is open, and a palette tool pick
    // closes it first. The Text tool is the one that both opens the editor on an atom and, pressed on
    // empty canvas, commits a new text box from the open session's document.
    it("undoing the commit restores the label with its starting record", async () => {
      await renderMainWindow(turnedThiocyanate(), "tool.text");
      await startLabelEdit();
      await typeIntoEditor("O");
      await typeIntoEditor("SCN");
      await pointerPress(container.querySelector(".page")!, { x: 600, y: 480 });
      expect(labelEditor()).toBeNull();
      expect(bridge().snapshot().document.pages[0].objects.map((object) => object.type)).toEqual(["molecule", "text"]);
      expect(thiocyanateSide()).toBe("left");
      // Leave the new text box's editor the way a click elsewhere does, then undo its placement.
      const textEditor = container.querySelector<HTMLTextAreaElement>(".text-object-editor");
      if (textEditor) {
        const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
        await act(async () => { textEditor.blur(); });
        hasFocus.mockRestore();
        await settle();
      }
      await paletteCommand("edit.undo");
      expect(bridge().snapshot().document.pages[0].objects.map((object) => object.type)).toEqual(["molecule"]);
      expect(atomElement("s1")).toBe("SCN");
      expect(thiocyanateSide(), "the commit's undo entry was taken mid-session").toBe("left");
    });
  });

  describe("every other label keeps the editor's usual typed (literal) behaviour", () => {
    it("a C typed on a hidden carbon becomes a typed C", async () => {
      await renderMainWindow(ringDocument());
      const atomId = await startLabelEdit();
      expect(molecule().atoms.find((atom) => atom.id === atomId)?.labelLiteral).toBeUndefined();
      await typeIntoEditor("C");
      await pressWhereFocused("Enter");
      await settle();
      expect(molecule().atoms.find((atom) => atom.id === atomId)).toMatchObject({ element: "C", labelLiteral: true });
    });

    it("one session can make an element label literal by typing its own text", async () => {
      const ring = ringDocument();
      const ringId = ring.pages[0].objects[0]!.id;
      const ringAtomId = (ring.pages[0].objects[0] as MoleculeObject).atoms[0]!.id;
      // A hotkey nitrogen: an element atom, not literal.
      const withNitrogen = applyNativeAtomElementTarget(ring, { objectId: ringId, kind: "atom", atomId: ringAtomId, distanceToPointer: 0 }, "N");
      await renderMainWindow(selectDocumentObjects(withNitrogen, withNitrogen.pages[0].id, []));
      expect(molecule().atoms[0]!.labelLiteral).toBeUndefined();
      await startLabelEdit();
      await typeIntoEditor("N");
      await pressWhereFocused("Enter");
      await settle();
      expect(molecule().atoms[0]).toMatchObject({ element: "N", labelLiteral: true });
    });
  });

  it("focuses the label editor when an edit starts", async () => {
    await renderMainWindow(ringDocument());
    await startLabelEdit();
    expect(document.activeElement).toBe(labelEditor());
  });

  it("leaves no atom for hotkeys to hit after a blur-ended edit (ChemDraft scheme)", async () => {
    await renderMainWindow(ringDocument());
    const atomId = await startLabelEdit();
    expect(bridge().snapshot().selectedNativeMoleculePart).toMatchObject({ kind: "atom", atomId });

    await typeIntoEditor("N");
    expect(atomElement(atomId)).toBe("N");

    await blurWithinFocusedWindow();
    expect(labelEditor()).toBeNull();
    // The label typed so far is kept.
    expect(atomElement(atomId)).toBe("N");
    // The pre-edit selection (nothing) is back, so single-key hotkeys have no atom to act on.
    expect(bridge().snapshot().selectedNativeMoleculePart).toBeUndefined();
    expect(bridge().snapshot().selection.objectIds).toEqual([]);

    await pressOnWindow("O");
    await pressOnWindow("Backspace");
    expect(atomElement(atomId)).toBe("N");
    expect(molecule().atoms).toHaveLength(6);
  });

  it("does not apply Et to the edited atom after a blur-ended edit (ChemDraw scheme)", async () => {
    saveKeybindingSettings({ scheme: "chemdraw" });
    await renderMainWindow(ringDocument());
    const atomId = await startLabelEdit();
    await typeIntoEditor("O");
    await blurWithinFocusedWindow();

    await pressOnWindow("e");
    await pressOnWindow("O");
    await pressOnWindow("Backspace");
    expect(atomElement(atomId)).toBe("O");
    expect(molecule().atoms).toHaveLength(6);
  });

  it("keeps putting focus back in the editor while the window settles", async () => {
    // Only setTimeout is faked: the retries are timers, React's scheduler is not.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await renderMainWindow(ringDocument());
    await startLabelEdit();

    // A palette still holding key status takes focus away just after the editor mounts.
    await loseFocusToAnotherWindow();
    expect(labelEditor()).not.toBeNull();
    expect(document.activeElement).not.toBe(labelEditor());

    // The scheduled retries (scheduleInlineEditorFocus) put it back.
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(document.activeElement).toBe(labelEditor());
  });

  it("keeps the edit open when the window, not the user, takes focus away", async () => {
    // A native palette or popover becoming key blurs the input with the document unfocused. The
    // edit must survive, so the rest of the word ("e" of OMe) still goes into the label.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await renderMainWindow(ringDocument());
    const atomId = await startLabelEdit();
    await typeIntoEditor("OM");

    await loseFocusToAnotherWindow();
    expect(labelEditor()).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // The next key goes wherever focus is. That must be exactly the editor — anywhere else, "e"
    // reaches the canvas hotkeys and arms the eraser.
    const editor = labelEditor()!;
    expect(document.activeElement).toBe(editor);
    await pressWhereFocused("e");
    await typeIntoEditor("OMe");
    expect(bridge().snapshot().activeToolCommandId).toBe("tool.atom");
    expect(labelEditor()).toBe(editor);
    expect(editor.value).toBe("OMe");
    expect(molecule().atoms.find((atom) => atom.id === atomId)?.element).not.toBe("C");
  });

  describe.each(["macos", "windows"] as const)("text placeholder (%s)", (platform) => {
    beforeEach(() => {
      // Existing objects need the same controlled startup retries as freshly placed text.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    async function insertTextEditor() {
      setShortcutPlatform(platform);
      await renderMainWindow(ringDocument(), "tool.text");
      return await startInlineEdit("text") as HTMLTextAreaElement;
    }

    // jsdom skips keyboard default actions. Apply the browser's replacement at the actual DOM
    // selection after keydown, then dispatch input; assigning the whole intended word would hide
    // a spurious select-all between keystrokes.
    async function typeCharacters(editor: HTMLTextAreaElement, text: string) {
      for (const key of text) {
        await act(async () => {
          const allowed = editor.dispatchEvent(new KeyboardEvent("keydown", {
            key, bubbles: true, cancelable: true
          }));
          expect(allowed).toBe(true);
          const start = editor.selectionStart;
          const nextValue = editor.value.slice(0, start) + key + editor.value.slice(editor.selectionEnd);
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, nextValue);
          editor.setSelectionRange(start + 1, start + 1);
          editor.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => { vi.advanceTimersByTime(100); });
      }
    }

    async function refocusAfterNativeBlur(editor: HTMLTextAreaElement) {
      // Opening the editor schedules DOM focus at 0/16/80 ms. Exhaust those retries before
      // testing a later native blur, so none can race act() and refocus before the assertion.
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(document.activeElement).toBe(editor);
      const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
      await act(async () => { editor.blur(); });
      expect(document.activeElement).not.toBe(editor);
      // Time passing in an unfocused document must leave the editor blurred until window focus.
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(document.activeElement).not.toBe(editor);
      hasFocus.mockRestore();
      await act(async () => { window.dispatchEvent(new FocusEvent("focus")); });
      expect(document.activeElement).toBe(editor);
    }

    it("keeps every character when typing Text on top", async () => {
      const editor = await insertTextEditor();
      await typeCharacters(editor, "Text on top");
      expect(editor.value).toBe("Text on top");
      expect(bridge().snapshot().document.pages[0].objects.find((object) => object.type === "text"))
        .toMatchObject({ text: "Text on top" });
    });

    it("replaces a fresh placeholder with the first key", async () => {
      const editor = await insertTextEditor();
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([0, 4]);
      await typeCharacters(editor, "Z");
      expect(editor.value).toBe("Z");
    });

    it("does not select typed Text again on blur and refocus", async () => {
      const editor = await insertTextEditor();
      await typeCharacters(editor, "Text");
      await refocusAfterNativeBlur(editor);
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([4, 4]);
      await typeCharacters(editor, " on top");
      expect(editor.value).toBe("Text on top");
    });

    it("treats pasted Text as user content even when its value matches the placeholder", async () => {
      const editor = await insertTextEditor();
      await act(async () => {
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(paste, "clipboardData", { value: { getData: () => "Text" } });
        editor.dispatchEvent(paste);
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      });
      await act(async () => { vi.advanceTimersByTime(100); });
      await refocusAfterNativeBlur(editor);
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([4, 4]);
      await typeCharacters(editor, " on top");
      expect(editor.value).toBe("Text on top");
    });

    it("opens an existing Text object with an ordinary caret", async () => {
      setShortcutPlatform(platform);
      const initial = insertNativeTextObject(ringDocument(), { x: 200, y: 200 }, "Text");
      const textId = initial.selection.objectIds[0]!;
      await renderMainWindow(initial, "tool.text");
      await pointerPress(container.querySelector(`[data-object-id="${textId}"]`)!, { x: 210, y: 210 });
      const editor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
      expect(editor).not.toBeNull();
      expect(editor.selectionStart).toBe(editor.selectionEnd);
      const caret = editor.selectionStart;
      await refocusAfterNativeBlur(editor);
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([caret, caret]);
    });

    it.each(["keyboard", "mouse"] as const)("ends placeholder selection after a %s caret move", async (input) => {
      const editor = await insertTextEditor();
      await act(async () => {
        editor.dispatchEvent(input === "keyboard"
          ? new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })
          : new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
        // The browser's default caret movement, which synthetic DOM events omit.
        editor.setSelectionRange(4, 4);
        editor.dispatchEvent(new Event("select", { bubbles: true }));
      });
      await act(async () => { vi.advanceTimersByTime(100); });
      await refocusAfterNativeBlur(editor);
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([4, 4]);
      await typeCharacters(editor, " on top");
      expect(editor.value).toBe("Text on top");
    });
  });

  it("keeps a text-box edit open across native window blur and resumes on window focus", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const initialDocument = insertNativeTextObject(ringDocument(), { x: 200, y: 200 }, "Substituent");
    const textId = initialDocument.selection.objectIds[0]!;
    await renderMainWindow(initialDocument);
    await paletteCommand("tool.text");
    await act(async () => {
      const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 210, clientY: 210 });
      Object.defineProperties(event, {
        isPrimary: { value: true }, pointerId: { value: 7 }, pointerType: { value: "mouse" }
      });
      container.querySelector(`[data-object-id="${textId}"]`)!
        .dispatchEvent(event);
    });
    const textEditor = () => container.querySelector<HTMLTextAreaElement>(".text-object-editor");
    const editor = textEditor()!;
    expect(editor).not.toBeNull();
    expect(document.activeElement).toBe(editor);
    const toolBeforeBlur = bridge().snapshot().activeToolCommandId;
    // Exhaust startup retries before losing focus: recovery must also work much later.
    await act(async () => { vi.advanceTimersByTime(100); });
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await act(async () => { editor.blur(); });
    hasFocus.mockRestore();
    expect(textEditor()).toBe(editor);
    expect(document.activeElement).not.toBe(editor);
    for (const key of ["e", "Backspace", "Delete", "Escape"]) {
      await pressOnWindow(key);
      expect(textEditor()).toBe(editor);
      expect(bridge().snapshot().activeToolCommandId).toBe(toolBeforeBlur);
      expect(bridge().snapshot().document.pages[0].objects).toHaveLength(2);
    }
    await act(async () => { window.dispatchEvent(new FocusEvent("focus")); });
    expect(document.activeElement).toBe(editor);
    await pressWhereFocused("e");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Substituente");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(textEditor()?.value).toBe("Substituente");
    expect(bridge().snapshot().document.pages[0].objects.find((object) => object.id === textId))
      .toMatchObject({ type: "text", text: "Substituente" });
    expect(bridge().snapshot().activeToolCommandId).toBe(toolBeforeBlur);
    // An actual move elsewhere within the focused document still ends the edit.
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await act(async () => { editor.blur(); });
    focused.mockRestore();
    expect(textEditor()).toBeNull();
  });

  it("leaves no atom selected when a palette tool click closes the edit", async () => {
    // The window lost focus to the palette, so the edit stayed open; picking a tool there closes it
    // directly, without a blur. The atom must not stay selected for Backspace to strip.
    await renderMainWindow(ringDocument());
    const atomId = await startLabelEdit();
    await typeIntoEditor("N");
    await loseFocusToAnotherWindow();
    expect(labelEditor()).not.toBeNull();

    await paletteCommand("tool.select");
    expect(bridge().snapshot().activeToolCommandId).toBe("tool.select");
    expect(labelEditor()).toBeNull();
    expect(atomElement(atomId)).toBe("N");
    expect(bridge().snapshot().selectedNativeMoleculePart).toBeUndefined();
    expect(bridge().snapshot().selection.objectIds).toEqual([]);

    await pressOnWindow("Backspace");
    await pressOnWindow("Delete");
    expect(atomElement(atomId)).toBe("N");
    expect(molecule().atoms).toHaveLength(6);
  });

  it("moving straight to another atom's label keeps the selection from before the first edit", async () => {
    // Two rings, so the second edit's atom is on a different molecule from the first: the restore
    // drops only the edited molecule, and would otherwise hand the first edit's atom back.
    const oneRing = insertNativeTemplateMolecule(createPhase4Document("Label focus"), { x: 200, y: 300 }, "cyclohexane");
    const twoRings = insertNativeTemplateMolecule(oneRing, { x: 500, y: 300 }, "cyclohexane");
    await renderMainWindow(selectDocumentObjects(twoRings, twoRings.pages[0].id, []));
    await startLabelEdit(0);
    const secondAtomId = await startLabelEdit(1);
    expect(bridge().snapshot().selectedNativeMoleculePart).toMatchObject({ kind: "atom", atomId: secondAtomId });

    await blurWithinFocusedWindow();
    expect(labelEditor()).toBeNull();
    // Not the first edit's atom: the selection before either edit, which was nothing.
    expect(bridge().snapshot().selectedNativeMoleculePart).toBeUndefined();
    expect(bridge().snapshot().selection.objectIds).toEqual([]);
  });

  it("finishes the edit on Tab without letting focus wander", async () => {
    await renderMainWindow(ringDocument());
    const atomId = await startLabelEdit();
    await typeIntoEditor("N");

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => {
      labelEditor()!.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(labelEditor()).toBeNull();
    expect(atomElement(atomId)).toBe("N");
  });

  it("keeps Enter's committed atom selected, as before", async () => {
    await renderMainWindow(ringDocument());
    const atomId = await startLabelEdit();
    await typeIntoEditor("N");
    await act(async () => {
      labelEditor()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(labelEditor()).toBeNull();
    expect(atomElement(atomId)).toBe("N");
    expect(bridge().snapshot().selectedNativeMoleculePart).toMatchObject({ kind: "atom", atomId });
  });

  it("Escape reverts the typed label but keeps the atom selected, like a commit", async () => {
    await renderMainWindow(ringDocument());
    const objectId = molecule().id;
    const atomId = await startLabelEdit();
    await typeIntoEditor("N");
    expect(atomElement(atomId)).toBe("N");

    await act(async () => {
      labelEditor()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(labelEditor()).toBeNull();
    // Reverted, not left as the typed draft.
    expect(atomElement(atomId)).toBe("C");
    // A cancel keeps the edited atom selected, the same as Enter's commit (cancelAtomLabelEdit sets
    // atomLabelEditKeepsSelectionRef just like finishAtomLabelEdit's "commit" branch does); only some
    // OTHER path closing the edit — blur, a tool switch, undo — restores the pre-edit selection.
    expect(bridge().snapshot().selectedNativeMoleculePart).toMatchObject({ kind: "atom", atomId });
    expect(bridge().snapshot().selection.objectIds).toEqual([objectId]);
  });

  it("a cancelled edit's kept selection correctly seeds the next edit's own restore", async () => {
    // Regression guard for cancelAtomLabelEdit's activeAtomLabelEditRef check, mirroring the one
    // finishAtomLabelEdit already has: without it, a cancel call that ever ran against a no-longer-
    // open edit would leave a stray value in atomLabelEditKeepsSelectionRef for a later, unrelated
    // edit's close to trip over. This chains two edits through a cancel to exercise that path.
    const oneRing = insertNativeTemplateMolecule(createPhase4Document("Label focus"), { x: 200, y: 300 }, "cyclohexane");
    const twoRings = insertNativeTemplateMolecule(oneRing, { x: 500, y: 300 }, "cyclohexane");
    const firstRingId = twoRings.pages[0].objects[0]!.id;
    await renderMainWindow(selectDocumentObjects(twoRings, twoRings.pages[0].id, []));

    const firstAtomId = await startLabelEdit(0);
    await typeIntoEditor("N");
    await act(async () => {
      labelEditor()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(labelEditor()).toBeNull();
    expect(atomElement(firstAtomId, 0)).toBe("C");
    // The cancelled edit's ring stays selected.
    expect(bridge().snapshot().selection.objectIds).toEqual([firstRingId]);

    // A second, unrelated edit on the other ring, ended by blur rather than Escape.
    const secondAtomId = await startLabelEdit(1);
    await typeIntoEditor("O");
    await blurWithinFocusedWindow();

    expect(labelEditor()).toBeNull();
    expect(atomElement(secondAtomId, 1)).toBe("O");
    // The second edit's own restore ran cleanly, putting back exactly what was selected right before
    // IT started (the first ring, left selected by the cancel) — not corrupted by the earlier cancel.
    expect(bridge().snapshot().selection.objectIds).toEqual([firstRingId]);
  });

  it("undo during an open label edit keeps its own selection, not the edit's pre-edit one", async () => {
    // Regression guard for restoreSelectionAfterAtomLabelEdit: restoreDocumentHistory closes the edit
    // (clearing activeAtomLabelEdit) without clearing selectedNativeMoleculePart, so the part-only
    // check alone would still think nothing has replaced the edit's selection and clobber undo's own.
    //
    // Timers are faked so the editor's focus retries (scheduleInlineEditorFocus: 0/16/80 ms) run at
    // a point this test chooses. With real timers, a slow runner could fire one between the blur and
    // the undo, putting focus back in the input so edit.undo routed to the field's own text undo.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const oneRing = insertNativeTemplateMolecule(createPhase4Document("Label focus"), { x: 200, y: 300 }, "cyclohexane");
    const twoRings = insertNativeTemplateMolecule(oneRing, { x: 500, y: 300 }, "cyclohexane");
    const firstRingId = twoRings.pages[0].objects[0]!.id;
    await renderMainWindow(selectDocumentObjects(twoRings, twoRings.pages[0].id, [firstRingId]));

    // One undo step: delete the selected ring, leaving the other alone with nothing selected.
    await pressOnWindow("Delete");
    expect(bridge().snapshot().document.pages[0].objects).toHaveLength(1);
    expect(bridge().snapshot().selection.objectIds).toEqual([]);

    // Edit the remaining ring's label. Its own selection (itself) differs from what undoing the
    // delete will restore (the first ring, selected).
    const remainingRingId = bridge().snapshot().document.pages[0].objects[0]!.id;
    await startLabelEdit(0);
    expect(bridge().snapshot().selection.objectIds).toEqual([remainingRingId]);
    // A person reaches the menu long after the editor's startup focus retries have run out.
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // Blurred but still open — exactly what choosing Edit ▸ Undo from the menu looks like mid-word,
    // since the window loses key status to deliver the click.
    await loseFocusToAnotherWindow();
    expect(labelEditor()).not.toBeNull();
    // However long the menu click takes to arrive, nothing may pull focus back into the editor.
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(document.activeElement).not.toBe(labelEditor());

    await paletteCommand("edit.undo");

    expect(labelEditor()).toBeNull();
    expect(bridge().snapshot().document.pages[0].objects).toHaveLength(2);
    // Undo's own selection (the first ring) must survive, not be overwritten with the selection from
    // before the label edit started (nothing, at that point).
    expect(bridge().snapshot().selection.objectIds).toEqual([firstRingId]);
  });
});
