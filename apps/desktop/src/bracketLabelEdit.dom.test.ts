// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { applySingleBondToolAtPoint, createPhase4Document, insertNativeBracket, selectDocumentObjects } from "./documentWorkflow";
import { toggleBracketRepeatUnit } from "./bracketCommands";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { bracketLabelPlan } from "@chemdraft/layout-engine";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("repeat label editing (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let closingId: string;
  const captures = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let descriptors: Array<PropertyDescriptor | undefined>;
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform === "macos" ? "MacIntel" : "Win32");
    descriptors = captures.map(name => Object.getOwnPropertyDescriptor(Element.prototype, name));
    captures.forEach(name => Object.defineProperty(Element.prototype, name, { configurable: true, value: () => false }));
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    captures.forEach((name, index) => {
      if (descriptors[index]) Object.defineProperty(Element.prototype, name, descriptors[index]!);
      else Reflect.deleteProperty(Element.prototype, name);
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
  });
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const editor = () => container.querySelector<HTMLInputElement>("[data-bracket-label-editor]");
  const label = () => container.querySelector<SVGElement>(`.page-svg-visual-layer [data-page-svg-object-visual="${closingId}"] .bracket-repeat-label`)!;
  async function mount(selected: boolean, tool = "tool.select", empty = false) {
    let doc = empty ? createPhase4Document("Placement") : toggleBracketRepeatUnit(insertNativeBracket(createPhase4Document("Label"),
      { x: 100, y: 100 }, "round", { x: 260, y: 200 }));
    closingId = doc.pages[0].objects.find(object => object.type === "bracket" && object.side === "close")?.id ?? "";
    if (!selected) doc = selectDocumentObjects(doc, doc.pages[0].id, []);
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialActiveToolCommandId: tool, initialCrosshairsVisible: false,
      initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true
    })));
    const rect = { left: 0, top: 0, x: 0, y: 0, width: 792, height: 612, right: 792, bottom: 612, toJSON: () => ({}) } as DOMRect;
    container.querySelectorAll(".page, .canvas-region").forEach(element => { element.getBoundingClientRect = () => rect; });
  }
  async function mouse(target: Element, type: string, detail = 0, point = { x: 264, y: 199 }) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type.endsWith("down") ? 1 : 0, detail, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { pointerId: { value: 8 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    await act(async () => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  }
  async function click(count: number) {
    const target = label();
    target.setAttribute("tabindex", "-1");
    // A real pointer press has detail=0. Emulate the companion mousedown's default focus
    // action, which jsdom/agent-bridge dispatch otherwise skips (and can blur a new editor).
    if (!await mouse(target, "pointerdown")) {
      if (!await mouse(target, "mousedown", count)) await act(async () => target.focus());
    }
    for (const type of ["pointerup", "mouseup", "click"]) await mouse(target, type, type === "pointerup" ? 0 : count);
  }
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function key(key: string) {
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  }
  it.each(["round", "square"])("keeps a newly dragged %s pair visibly selected", async kind => {
    await mount(false, `tool.${kind}Bracket`, true);
    const page = container.querySelector(".page")!;
    await mouse(page, "pointerdown", 0, { x: 100, y: 100 });
    await mouse(page, "pointermove", 0, { x: 260, y: 200 });
    await mouse(page, "pointerup", 0, { x: 260, y: 200 });
    const result = snapshot();
    expect(result.activeToolCommandId).toBe("tool.select");
    expect(result.document.selection.objectIds).toEqual(result.document.pages[0].objects.map(object => object.id));
    expect(result.document.selection.objectIds).toHaveLength(2);
    expect(container.querySelector("[data-group-selection]")).not.toBeNull();
  });
  it.each([false, true])("double-clicks the painted label (initially selected: %s) and retains focus while typing", async selected => {
    await mount(selected);
    await click(1);
    // Like existing text objects, a single Select click selects without starting an edit.
    expect(editor()).toBeNull();
    await click(2);
    await mouse(label(), "dblclick", 2);
    expect(editor()?.value).toBe("n");
    expect(document.activeElement).toBe(editor());
    await key("t");
    expect(snapshot().activeToolCommandId).toBe("tool.select");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(editor(), "m");
      editor()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await key("Enter");
    expect(editor()).toBeNull();
    expect(label().textContent).toBe("m");
    await command("edit.undo");
    expect(label().textContent).toBe("n");
    await command("edit.redo");
    expect(label().textContent).toBe("m");
  });
  it("uses the same editor as the context command and cancels with Escape", async () => {
    await mount(true);
    await command("bracket.label.edit");
    expect(editor()?.value).toBe("n");
    await key("Escape");
    expect(editor()).toBeNull();
    expect(label().textContent).toBe("n");
  });
  it.each([false, true])("edits via the full canvas double-click sequence (initially selected: %s)", async selected => {
    await mount(selected);
    await command("view.zoomIn");
    vi.stubGlobal("devicePixelRatio", 2);
    const { document: doc, viewport } = snapshot();
    const scale = (viewport as { scale: number }).scale;
    const closing = doc.pages[0].objects.find(object => object.id === closingId)!;
    if (closing.type !== "bracket") throw new Error("Missing closing bracket");
    const bounds = bracketLabelPlan(closing)!.bounds;
    const rect = { left: 73, top: 41, width: doc.pages[0].width * scale, height: doc.pages[0].height * scale };
    container.querySelector(".page")!.getBoundingClientRect = () => ({ ...rect,
      x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => ({}) });
    const point = { x: rect.left + (closing.x + bounds.x + bounds.width / 2) * scale,
      y: rect.top + (closing.y + bounds.y + bounds.height / 2) * scale };
    // Dispatch through the canvas, never directly to the SVG text. The browser can target
    // the canvas/owner after pointer capture; jsdom has no painted SVG hit testing.
    const canvas = container.querySelector("[data-page-svg-surface]")!;
    for (const detail of [1, 2]) {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        await mouse(canvas, type, type.startsWith("pointer") ? 0 : detail, point);
      }
      expect(editor()).toBeNull();
    }
    await mouse(canvas, "dblclick", 2, point);
    expect(editor()?.value).toBe("n");
    expect(document.activeElement).toBe(editor());
    expect(snapshot().document.pages[0].objects).toEqual(doc.pages[0].objects);
    await key("Escape");
    expect(editor()).toBeNull();
    await command("bracket.label.edit");
    expect(editor()?.value).toBe("n");
  });
  it("edits when Select's pointer capture retargets clicks from the painted label to its owner", async () => {
    await mount(false);
    let captured: Element | undefined;
    Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true,
      value(this: Element) { captured = this; } });
    Object.defineProperty(Element.prototype, "releasePointerCapture", { configurable: true,
      value() { captured = undefined; } });
    Object.defineProperty(Element.prototype, "hasPointerCapture", { configurable: true,
      value(this: Element) { return captured === this; } });
    let clickTarget: Element;
    for (const detail of [1, 2]) {
      const painted = label();
      await mouse(painted, "pointerdown");
      clickTarget = captured!;
      expect(clickTarget).toBe(painted.closest("[data-page-svg-object-visual]"));
      await mouse(painted, "mousedown", detail);
      await mouse(clickTarget, "pointerup");
      await mouse(clickTarget, "mouseup", detail);
      await mouse(clickTarget, "click", detail);
      expect(editor()).toBeNull();
    }
    await mouse(clickTarget!, "dblclick", 2);
    expect(editor()?.value).toBe("n");
    expect(document.activeElement).toBe(editor());
  });
  it("reports the marked atom count and repeat label in the command's status", async () => {
    const doc = insertNativeBracket(applySingleBondToolAtPoint(createPhase4Document("Status"), { x: 140, y: 140 }),
      { x: 100, y: 100 }, "round", { x: 260, y: 200 });
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialPaletteMode: "hidden", initialRulersVisible: false,
      initialCrosshairsVisible: false, nativePalette: true
    })));
    await command("bracket.repeatUnit.toggle");
    expect(container.querySelector("[data-status-message]")?.textContent).toBe('Marked 2 atoms as repeat unit "n"');
    await command("bracket.repeatUnit.toggle");
    expect(container.querySelector("[data-status-message]")?.textContent).toBe('Removed repeat unit "n"');
  });
});
