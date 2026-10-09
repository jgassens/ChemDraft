// @vitest-environment jsdom

// Tester report: while typing a substituent label (OMe, CO2Et) "the text kept getting erased even
// though I hadn't clicked the eraser tool". Once the label editor lost focus mid-word, the rest of
// the word reached the canvas hotkeys: the edit had selected the atom, so "O" relabeled it,
// Backspace stripped it, and "e" armed the eraser (ChemDraft scheme) or applied Et (ChemDraw).

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule, insertNativeTemplateMolecule, insertNativeTextObject, selectDocumentObjects } from "./documentWorkflow";
import { convertTextToAtomLabelCommandId } from "./commands";
import { saveKeybindingSettings } from "./keybindingSettings";
import { DOM_COMMAND_EVENT } from "./window-manager";

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

  async function renderMainWindow(initialDocument: ChemDraftDocument) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.atom",
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

  it.each(["macos", "windows"] as const)("converts freshly placed text to an atom label (%s)", async (platform) => {
    setShortcutPlatform(platform);
    await renderMainWindow(chainDocument());
    const atom = molecule().atoms[1]!;
    await paletteCommand("tool.text");
    // This takes the real Text-tool placement path, just outside its immediate atom hit target but
    // within the later label-conversion radius.
    await pointerPress(container.querySelector(".page")!, { x: atom.x, y: atom.y + 15 });
    const editor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "OMe");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await act(async () => { editor.blur(); });
    focused.mockRestore();
    await settle();
    expect(bridge().snapshot().document.pages[0].objects).toHaveLength(1);
    expect(atomElement(atom.id)).toBe("OMe");
  });

  it("converts the first fresh text box when a second placement ends its edit", async () => {
    await renderMainWindow(chainDocument());
    const atom = molecule().atoms[1]!;
    await paletteCommand("tool.text");
    await pointerPress(container.querySelector(".page")!, { x: atom.x, y: atom.y + 15 });
    const firstEditor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(firstEditor, "OMe");
      firstEditor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Text placement returns to the prior tool after each stamp, so reactivate it without ending
    // the editor before placing the next caption. Both fresh ids stay pending until their own
    // first commits.
    await paletteCommand("tool.text");
    await pointerPress(container.querySelector(".page")!, { x: 100, y: 100 });
    expect(bridge().snapshot().document.pages[0].objects).toHaveLength(2);
    expect(atomElement(atom.id)).toBe("OMe");
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

  it("reports a spiro benzene template through the real placement handler", async () => {
    const initial = ringDocument();
    await renderMainWindow(initial);
    const ring = molecule();
    const atom = ring.atoms[0]!;
    await paletteCommand("tool.benzene");
    await pointerPress(container.querySelector(`[data-object-id="${ring.id}"]`)! , atom);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Made spiro benzene template");
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
