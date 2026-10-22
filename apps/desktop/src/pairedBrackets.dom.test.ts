// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BracketObject, ChemDraftDocument } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@scena/react-ruler", () => ({ default: () => null }));

describe("paired bracket drawing", () => {
  let container: HTMLDivElement;
  let root: Root;
  let captured: Element | undefined;
  const methods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  const originals = methods.map(method => Object.getOwnPropertyDescriptor(Element.prototype, method));
  beforeEach(() => {
    captured = undefined;
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true, value: function(this: Element) { captured = this; } });
    Object.defineProperty(Element.prototype, "releasePointerCapture", { configurable: true, value: function(this: Element) { if (captured === this) captured = undefined; } });
    Object.defineProperty(Element.prototype, "hasPointerCapture", { configurable: true, value: function(this: Element) { return captured === this; } });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); delete window.__CHEMDRAFT_AGENT__;
    window.history.replaceState(null, "", "/"); vi.restoreAllMocks(); vi.unstubAllGlobals();
    methods.forEach((method, index) => {
      if (originals[index]) Object.defineProperty(Element.prototype, method, originals[index]!);
      else Reflect.deleteProperty(Element.prototype, method);
    });
  });
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const page = () => container.querySelector<HTMLElement>(".page")!;
  const brackets = () => snapshot().pages[0].objects.filter((object): object is BracketObject => object.type === "bracket");
  async function mount(tool: string, initialDocument: ChemDraftDocument = createPhase4Document("Bracket gesture"), showPalette = false) {
    await act(async () => root.render(createElement(MainWindow, { initialDocument, initialActiveToolCommandId: tool,
      initialPaletteMode: showPalette ? "floating" : "hidden", initialRulersVisible: false,
      initialCrosshairsVisible: false, nativePalette: !showPalette })));
    page().getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 816, bottom: 1056,
      width: 816, height: 1056, toJSON: () => ({}) });
  }
  async function pointer(target: EventTarget, type: string, x: number, y: number) {
    const scale = (window.__CHEMDRAFT_AGENT__!.snapshot().viewport as { scale: number }).scale;
    await act(async () => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
        buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1, clientX: x * scale, clientY: y * scale });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      target.dispatchEvent(event);
    });
  }
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }

  async function typeLabel(text: string) {
    const input = container.ownerDocument.querySelector<HTMLInputElement>(".bracket-label-editor")!;
    expect(input).not.toBeNull();
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  }

  it.each(["square", "curly"] as const)("edits a %s label in one undo entry, cancels and clears it", async kind => {
    await mount(kind === "square" ? "tool.pairedSquareBracket" : "tool.pairedCurlyBracket");
    await pointer(page(), "pointerdown", 200, 200);
    await pointer(captured ?? page(), "pointerup", 200, 200);
    await command("tool.select");
    const before = snapshot();
    const input = await typeLabel("5–10");
    expect(brackets()[0].label).toBeUndefined();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true })));
    expect(brackets()[0].label).toBeUndefined();
    expect(document.activeElement).toBe(input);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(brackets()[0].label).toBe("5–10");
    expect(document.querySelector(".bracket-label")?.textContent).toBe("5–10");
    await command("edit.undo"); expect(snapshot()).toEqual(before);
    await command("edit.redo"); expect(brackets()[0].label).toBe("5–10");
    const cancel = await typeLabel("discard");
    await act(async () => cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(brackets()[0].label).toBe("5–10");
    const clear = await typeLabel("");
    await act(async () => clear.blur());
    expect(brackets()[0].label).toBe("");
    expect(document.querySelector(".bracket-label")).toBeNull();
  });

  it("commits before a click away deselects the pair and leaves the molecule unchanged", async () => {
    const doc = insertNativeSingleBondMolecule(createPhase4Document("Label chemistry"), { x: 400, y: 400 });
    const molecule = doc.pages[0].objects[0];
    await mount("tool.pairedSquareBracket", doc);
    await pointer(page(), "pointerdown", 200, 200);
    await pointer(captured ?? page(), "pointerup", 200, 200);
    await command("tool.select");
    await typeLabel("n");
    await pointer(page(), "pointerdown", 600, 600);
    await pointer(captured ?? page(), "pointerup", 600, 600);
    expect(brackets()[0].label).toBe("n");
    expect(snapshot().pages[0].objects.find(object => object.id === molecule.id)).toEqual(molecule);
    await command("edit.undo");
    expect(brackets()).toHaveLength(1);
    expect(brackets()[0].label).toBeUndefined();
  });

  it("offers separate paired tools beside the single tools and activates them from the palette", async () => {
    await mount("tool.select", undefined, true);
    for (const tool of ["tool.bracket", "tool.squareBracket", "tool.pairedCurlyBracket", "tool.pairedSquareBracket"]) {
      expect(container.querySelector(`[data-command-id="${tool}"]`)).not.toBeNull();
    }
    await act(async () => container.querySelector('[data-command-id="tool.pairedSquareBracket"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await pointer(page(), "pointerdown", 200, 200);
    await pointer(captured ?? page(), "pointerup", 200, 200);
    expect(brackets()).toHaveLength(1);
    expect(brackets()[0]).toMatchObject({ paired: true, bracketKind: "square" });
  });

  it.each(["square", "curly"] as const)("clicks a default %s pair into one undo entry", async kind => {
    await mount(kind === "square" ? "tool.pairedSquareBracket" : "tool.pairedCurlyBracket");
    const before = snapshot();
    await pointer(page(), "pointerdown", 200, 200);
    expect(brackets()).toHaveLength(0);
    await pointer(captured ?? page(), "pointerup", 200, 200);
    expect(brackets()).toHaveLength(1);
    expect(brackets()[0]).toMatchObject({ paired: true, bracketKind: kind, x: 140, y: 160, width: 120, height: 80 });
    const after = snapshot();
    expect(container.querySelector(".bracket-glyph-path")?.getAttribute("d")?.match(/M /g)).toHaveLength(2);
    await command("edit.undo"); expect(snapshot()).toEqual(before);
    await command("edit.redo"); expect(snapshot()).toEqual(after);
  });

  it.each(["square", "curly"] as const)("draws and previews a %s pair in reverse, using the actual release", async kind => {
    await mount(kind === "square" ? "tool.pairedSquareBracket" : "tool.pairedCurlyBracket");
    await pointer(page(), "pointerdown", 300, 300);
    await pointer(captured ?? page(), "pointermove", 200, 200);
    expect(brackets()[0]).toMatchObject({ x: 200, y: 200, width: 100, height: 100 });
    await pointer(captured ?? page(), "pointerup", 100, 100);
    expect(brackets()).toHaveLength(1);
    expect(brackets()[0]).toMatchObject({ x: 100, y: 100, width: 200, height: 200, paired: true, bracketKind: kind });
  });

  it("follows pointer capture when the drag begins on an existing molecule", async () => {
    const initial = insertNativeSingleBondMolecule(createPhase4Document("Existing molecule"), { x: 200, y: 200 });
    await mount("tool.pairedSquareBracket", initial);
    const molecule = snapshot().pages[0].objects[0];
    const target = container.querySelector(`[data-object-id="${molecule.id}"]`)!;
    await pointer(target, "pointerdown", 200, 200);
    expect(captured).toBe(target);
    await pointer(captured!, "pointermove", 400, 400);
    await pointer(captured ?? page(), "pointerup", 420, 420);
    expect(brackets()[0]).toMatchObject({ paired: true, x: 200, y: 200, width: 220, height: 220 });
    expect(snapshot().pages[0].objects.find(object => object.id === molecule.id)).toEqual(molecule);
  });

  it.each(["escape", "pointercancel"])("cancels a live pair with %s without leaving an undo entry", async cancel => {
    await mount("tool.pairedCurlyBracket");
    const before = snapshot();
    await pointer(page(), "pointerdown", 100, 100);
    await pointer(captured ?? page(), "pointermove", 300, 300);
    expect(brackets()).toHaveLength(1);
    if (cancel === "escape") {
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    } else await pointer(captured ?? page(), "pointercancel", 300, 300);
    expect(snapshot()).toEqual(before);
    await command("edit.undo"); expect(snapshot()).toEqual(before);
  });

  it.each(["tool.bracket", "tool.squareBracket"])("keeps %s as a single bracket", async tool => {
    await mount(tool);
    await pointer(page(), "pointerdown", 200, 200);
    await pointer(page(), "pointerup", 200, 200);
    expect(brackets()).toHaveLength(1);
    expect(brackets()[0]).toMatchObject({ width: 16, height: 64 });
    expect(brackets()[0].paired).toBeUndefined();
    expect(container.querySelector(".bracket-glyph-path")?.getAttribute("d")?.match(/M /g)).toHaveLength(1);
  });
});
