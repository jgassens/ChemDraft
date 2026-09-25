// @vitest-environment jsdom

// Tester report: while typing a substituent label (OMe, CO2Et) "the text kept getting erased even
// though I hadn't clicked the eraser tool". Once the label editor lost focus mid-word, the rest of
// the word reached the canvas hotkeys: the edit had selected the atom, so "O" relabeled it,
// Backspace stripped it, and "e" armed the eraser (ChemDraft scheme) or applied Et (ChemDraw).

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTemplateMolecule, selectDocumentObjects } from "./documentWorkflow";
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

  function atomElement(atomId: string): string | undefined {
    return molecule().atoms.find((atom) => atom.id === atomId)?.element;
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
});
