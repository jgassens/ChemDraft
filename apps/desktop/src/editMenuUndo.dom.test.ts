// @vitest-environment jsdom

// Tester report: no working Undo. Edit ▸ Undo/Redo were AppKit's predefined items, which send
// undo: to the webview's text undo manager and never reach the drawing's history. They are now
// routed menu commands (edit.undo / edit.redo) delivered as the `chemdraft:native-command` DOM
// event, exactly as Rust's `emit_command_to_main` dispatches every routed menu click.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTemplateMolecule, selectDocumentObjects } from "./documentWorkflow";
import {
  editHistoryDirection,
  installSecondaryWindowEditHistory,
  isTextEditingElement,
  resolveEditHistoryRoute
} from "./editHistoryRouting";
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

describe("edit history routing", () => {
  it("maps only the two history commands", () => {
    expect(editHistoryDirection("edit.undo")).toBe("undo");
    expect(editHistoryDirection("edit.redo")).toBe("redo");
    expect(editHistoryDirection("clipboard.copy")).toBeUndefined();
  });

  it("sends a focused text field's undo to the field, whatever the document history holds", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    for (const element of [input, textarea, editable]) {
      expect(isTextEditingElement(element)).toBe(true);
      expect(resolveEditHistoryRoute("undo", { activeElement: element, canUndo: true, canRedo: true })).toBe("text");
      expect(resolveEditHistoryRoute("redo", { activeElement: element, canUndo: false, canRedo: false })).toBe("text");
    }
  });

  it("treats only real text entry as a text field", () => {
    const textLike = ["", "text", "search", "number", "email", "url", "tel", "password", "TEXT"].map((type) => {
      const input = document.createElement("input");
      if (type) {
        input.setAttribute("type", type);
      }
      return input;
    });
    const editableChild = document.createElement("span");
    const editableHost = document.createElement("div");
    editableHost.setAttribute("contenteditable", "");
    editableHost.append(editableChild);
    for (const element of [...textLike, document.createElement("textarea"), editableHost, editableChild]) {
      expect(isTextEditingElement(element), element.outerHTML).toBe(true);
    }

    // No text to undo: ⌘Z on these must reach the drawing, not vanish into execCommand.
    const nonText = ["checkbox", "radio", "range", "color", "button", "submit", "file"].map((type) => {
      const input = document.createElement("input");
      input.setAttribute("type", type);
      return input;
    });
    const notEditable = document.createElement("div");
    notEditable.setAttribute("contenteditable", "false");
    for (const element of [...nonText, document.createElement("select"), document.createElement("button"), notEditable, document.body]) {
      expect(isTextEditingElement(element), element.outerHTML.slice(0, 60)).toBe(false);
      expect(resolveEditHistoryRoute("undo", { activeElement: element, canUndo: true, canRedo: false })).toBe("document");
    }
    expect(isTextEditingElement(null)).toBe(false);
  });

  it("sends canvas undo to the document, or reports nothing to undo", () => {
    const button = document.createElement("button");
    expect(resolveEditHistoryRoute("undo", { activeElement: document.body, canUndo: true, canRedo: false })).toBe("document");
    expect(resolveEditHistoryRoute("undo", { activeElement: button, canUndo: true, canRedo: false })).toBe("document");
    expect(resolveEditHistoryRoute("redo", { activeElement: null, canUndo: true, canRedo: false })).toBe("nothing");
  });
});

// Rust delivers Edit ▸ Undo / Redo to the key window. In a palette, popover, preferences, or plugin
// panel window, a focused text field undoes its own text; otherwise the drawing is undone.
describe("Edit ▸ Undo / Redo in a secondary window", () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    document.body.replaceChildren();
    Reflect.deleteProperty(document, "execCommand");
  });

  function install() {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const forwardToMain = vi.fn(async (_commandId: string) => undefined);
    uninstall = installSecondaryWindowEditHistory({ forwardToMain });
    return { execCommand, forwardToMain };
  }

  function chooseMenuItem(commandId: string) {
    window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }));
  }

  it("undoes the focused text field's text and leaves the drawing alone", () => {
    const { execCommand, forwardToMain } = install();
    const search = document.createElement("input");
    search.setAttribute("type", "search");
    document.body.append(search);
    search.focus();

    chooseMenuItem("edit.undo");
    chooseMenuItem("edit.redo");
    expect(execCommand.mock.calls).toEqual([["undo"], ["redo"]]);
    expect(forwardToMain).not.toHaveBeenCalled();
  });

  it("forwards to the document window when no text field is focused", () => {
    const { execCommand, forwardToMain } = install();
    const checkbox = document.createElement("input");
    checkbox.setAttribute("type", "checkbox");
    document.body.append(checkbox);
    checkbox.focus();

    chooseMenuItem("edit.undo");
    checkbox.blur();
    chooseMenuItem("edit.redo");
    expect(forwardToMain.mock.calls).toEqual([["edit.undo"], ["edit.redo"]]);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("ignores every other command, and stops listening once uninstalled", () => {
    const { execCommand, forwardToMain } = install();
    chooseMenuItem("edit.selectAll");
    uninstall?.();
    uninstall = undefined;
    chooseMenuItem("edit.undo");
    expect(forwardToMain).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });
});

describe("Edit menu Undo / Redo", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
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
    Reflect.deleteProperty(document, "execCommand");
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  /** Two rings, the first selected, so two separate deletions make two undo steps. */
  function twoRingDocument(): ChemDraftDocument {
    const oneRing = insertNativeTemplateMolecule(createPhase4Document("Edit menu undo"), { x: 200, y: 300 }, "cyclohexane");
    const twoRings = insertNativeTemplateMolecule(oneRing, { x: 500, y: 300 }, "cyclohexane");
    const firstRingId = twoRings.pages[0].objects[0]!.id;
    return selectDocumentObjects(twoRings, twoRings.pages[0].id, [firstRingId]);
  }

  async function renderMainWindow(initialDocument: ChemDraftDocument) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.select",
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
    await settle();
  }

  async function settle() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  function objectCount(): number {
    const agent = window.__CHEMDRAFT_AGENT__;
    if (!agent) {
      throw new Error("Expected agent bridge.");
    }
    return agent.snapshot().document.pages[0].objects.length;
  }

  function statusText(): string {
    return container.querySelector(".status-bar")?.textContent ?? container.textContent ?? "";
  }

  async function press(init: KeyboardEventInit, target: EventTarget = window): Promise<KeyboardEvent> {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    await act(async () => {
      target.dispatchEvent(event);
    });
    await settle();
    return event;
  }

  /** What Rust's `emit_command_to_main` evaluates in the webview for a routed menu click. */
  async function chooseMenuItem(commandId: string) {
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }));
    });
    await settle();
  }

  /** Delete the selected ring, then select-all and delete the other: two undo steps, zero objects. */
  async function deleteBothRingsSeparately() {
    await press({ key: "Delete" });
    expect(objectCount()).toBe(1);
    await chooseMenuItem("edit.selectAll");
    await press({ key: "Delete" });
    expect(objectCount()).toBe(0);
  }

  it("Edit ▸ Undo and Edit ▸ Redo undo and redo the drawing", async () => {
    await renderMainWindow(twoRingDocument());
    await deleteBothRingsSeparately();

    await chooseMenuItem("edit.undo");
    expect(objectCount()).toBe(1);
    await chooseMenuItem("edit.undo");
    expect(objectCount()).toBe(2);
    await chooseMenuItem("edit.redo");
    expect(objectCount()).toBe(1);
  });

  it("choosing Undo with nothing to undo is harmless and says so", async () => {
    await renderMainWindow(twoRingDocument());
    await chooseMenuItem("edit.undo");
    expect(objectCount()).toBe(2);
    expect(statusText()).toContain("Nothing to undo");
    expect(statusText()).not.toContain("disabled");
  });

  it("one ⌘Z press undoes exactly one step, and claims the key so the menu does not fire again", async () => {
    await renderMainWindow(twoRingDocument());
    await deleteBothRingsSeparately();

    // WebKit skips the menu's key equivalent when the page cancels the keydown; that is what keeps
    // the ⌘Z accelerator on Edit ▸ Undo from undoing a second time.
    const undo = await press({ key: "z", metaKey: true });
    expect(undo.defaultPrevented).toBe(true);
    expect(objectCount()).toBe(1);

    const redo = await press({ key: "z", metaKey: true, shiftKey: true });
    expect(redo.defaultPrevented).toBe(true);
    expect(objectCount()).toBe(0);
  });

  it("with a text field focused, ⌘Z and Edit ▸ Undo do native text undo and leave the drawing alone", async () => {
    await renderMainWindow(twoRingDocument());
    await deleteBothRingsSeparately();

    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const field = document.createElement("input");
    container.append(field);
    field.focus();
    expect(document.activeElement).toBe(field);

    // The keydown is left to the system, so the native menu's ⌘Z equivalent delivers it once…
    const keydown = await press({ key: "z", metaKey: true }, field);
    expect(keydown.defaultPrevented).toBe(false);
    expect(objectCount()).toBe(0);

    // …as this routed menu command, which goes to the field's own undo stack.
    await chooseMenuItem("edit.undo");
    await chooseMenuItem("edit.redo");
    expect(execCommand.mock.calls).toEqual([["undo"], ["redo"]]);
    expect(objectCount()).toBe(0);

    field.blur();
    await chooseMenuItem("edit.undo");
    expect(objectCount()).toBe(1);
    expect(execCommand).toHaveBeenCalledTimes(2);
  });
});
