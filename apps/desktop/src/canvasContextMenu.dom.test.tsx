// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createNativeSingleBondMolecule, createPhase4Document, selectDocumentObjects } from "./documentWorkflow";
import { saveCompoundLayoutSettings } from "./compoundLayoutSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
let container: HTMLDivElement;
let root: Root;
let canvas: HTMLElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  saveCompoundLayoutSettings({ enabled: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

async function mount(selected: boolean) {
  let drawing = createPhase4Document("Context menu");
  for (let i = 0; i < 3; i++) drawing = applyPatches(drawing, [{ op: "addObject", pageId: drawing.pages[0].id,
    object: createNativeSingleBondMolecule(drawing, { x: 100 + i * 100, y: 100 }) }]);
  drawing = selectDocumentObjects(drawing, drawing.pages[0].id, selected ? drawing.pages[0].objects.map(o => o.id) : []);
  await act(async () => root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.select"
    initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
  canvas = container.querySelector<HTMLElement>('.canvas-region')!;
  canvas.focus();
}
async function key(value: string, shiftKey = false) {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })); });
}
async function open(value: string) { await key(value, value === "F10"); }

describe("MainWindow canvas context menu keyboard", () => {
  it.each([false, true])("opens the appropriate menu from body focus (selected: %s)", async selected => {
    await mount(selected);
    for (const value of ["F10", "ContextMenu"]) {
      canvas.blur();
      expect(document.activeElement).toBe(document.body);
      await open(value);
      const menu = container.querySelector(selected ? '[aria-label="Object layer options"]' : '[aria-label="Page options"]');
      expect(menu).not.toBeNull();
      expect(menu?.contains(document.activeElement)).toBe(true);
      expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
      await key("Escape");
      expect(document.activeElement).toBe(canvas);
    }
  });
  it("does not open a canvas menu from body focus while a modal dialog is present", async () => {
    await mount(false);
    canvas.blur();
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    container.append(dialog);
    expect(document.activeElement).toBe(document.body);
    await key("F10", true);
    expect(container.querySelector('[aria-label="Page options"], [aria-label="Object layer options"]')).toBeNull();
  });
  it("suppresses browser menus outside editable fields without blocking canvas menus", async () => {
    await mount(false);
    const button = container.querySelector<HTMLButtonElement>("button")!;
    const input = document.createElement("input");
    container.append(input);
    for (const target of [document.body, canvas, button, input]) {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      await act(async () => target.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(target !== input);
    }
    const page = container.querySelector(".page")!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => page.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector('[aria-label="Page options"]')).not.toBeNull();
    input.remove();
  });
  it("ignores context-menu keys on controls", async () => {
    await mount(false);
    const button = container.querySelector<HTMLButtonElement>("button")!;
    const input = document.createElement("input");
    container.append(input);
    for (const target of [button, input]) {
      target.focus();
      await open("F10");
      expect(container.querySelector('[aria-label="Page options"], [aria-label="Object layer options"]')).toBeNull();
      expect(document.activeElement).toBe(target);
    }
    input.remove();
  });
  it("keeps editable targets in the text tool and still opens the canvas menu", async () => {
    await mount(false);
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "tool.text" } })));
    const page = container.querySelector(".page")!;
    await act(async () => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerdown" ? 1 : 0, clientX: 220, clientY: 208 });
        Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
        page.dispatchEvent(event);
      }
    });
    const editor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
    expect(editor).not.toBeNull();
    const activeTool = () => container.querySelector("[data-active-tool]")!.getAttribute("data-active-tool");
    const toolBefore = activeTool();
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })));
    const input = document.createElement("input");
    page.append(input);
    for (const target of [editor, input]) {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      await act(async () => target.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(container.querySelector('[aria-label="Page options"], [aria-label="Object layer options"]')).toBeNull();
      expect(container.querySelector(".text-object-editor")).toBe(editor);
      expect(activeTool()).toBe(toolBefore);
    }
    input.remove();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => page.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector('[aria-label="Page options"]')).not.toBeNull();
  });
  it.each(["F10", "ContextMenu"])("opens the page menu with %s and restores focus on Escape", async value => {
    await mount(false); await open(value);
    expect(container.querySelector('[aria-label="Page options"]')).not.toBeNull();
    await key("Escape"); expect(document.activeElement).toBe(canvas);
  });
  it.each(["F10", "ContextMenu"])("opens selected objects with %s and invokes Arrange Row with Return", async value => {
    await mount(true); await open(value);
    expect(container.querySelector('[aria-label="Object layer options"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-context-submenu")).toBe("arrange");
    await key("ArrowRight");
    for (let i = 0; i < 10 && document.activeElement?.getAttribute("data-command-id") !== "layout.arrange.row"; i++) await key("ArrowDown");
    expect(document.activeElement?.getAttribute("data-command-id")).toBe("layout.arrange.row");
    await key("Enter"); expect(document.activeElement).toBe(canvas);
  });
  it("navigates Copy As and invokes a format with Space", async () => {
    await mount(true); await open("ContextMenu");
    for (let i = 0; i < 4; i++) await key("ArrowDown");
    expect(document.activeElement?.getAttribute("data-context-submenu")).toBe("copy-as");
    await key("ArrowRight"); expect(document.activeElement?.closest('[aria-label="Copy As formats"]')).not.toBeNull();
    await key(" "); expect(document.activeElement).toBe(canvas);
  });
  it("ignores Delete in the menu and restores focus if the selection is deleted externally", async () => {
    await mount(true); await open("F10");
    await key("Delete"); expect(container.querySelector('[aria-label="Object layer options"]')).not.toBeNull();
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.deleteHoveredNativeTarget" } })));
    expect(container.querySelector('[aria-label="Object layer options"]')).toBeNull();
    expect(document.activeElement).toBe(canvas);
  });
});
