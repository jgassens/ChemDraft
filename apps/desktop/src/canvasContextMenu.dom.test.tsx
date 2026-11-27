// @vitest-environment jsdom
import { act, useEffect, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createNativeSingleBondMolecule, createPhase4Document, selectDocumentObjects } from "./documentWorkflow";
import { saveCompoundLayoutSettings } from "./compoundLayoutSettings";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { buildObjectCanvasMenu } from "./canvasContextMenuModel";

// Transparent unless a test installs a handler, so the MainWindow tests keep the real module.
const tauri = vi.hoisted(() => ({ handler: undefined as undefined | ((command: string, args: unknown) => unknown) }));
vi.mock("@tauri-apps/api/core", async importOriginal => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: (command: string, args?: never, options?: never) =>
    tauri.handler ? Promise.resolve(tauri.handler(command, args)) : actual.invoke(command, args, options) };
});

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

describe.each<ShortcutPlatform>(["macos", "windows"])("keyboard menu with nothing selected over an atom at the page centre (%s)", platform => {
  it.each(["F10", "ContextMenu"])("opens the page menu with %s, not the object menu", async value => {
    let drawing = createPhase4Document("Centre atom");
    drawing = applyPatches(drawing, [{ op: "addObject", pageId: drawing.pages[0].id,
      object: createNativeSingleBondMolecule(drawing, { x: 396, y: 306 }) }]);
    drawing = selectDocumentObjects(drawing, drawing.pages[0].id, []);
    const molecule = drawing.pages[0].objects[0]!;
    if (molecule.type !== "molecule") throw new Error("expected a molecule");
    const atom = molecule.atoms[0]!;
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} shortcutPlatform={platform} />));
    // The page centre is exactly on the first atom.
    const rect = { x: 0, y: 0, left: 0, top: 0, right: atom.x * 2, bottom: atom.y * 2,
      width: atom.x * 2, height: atom.y * 2, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
    canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    canvas.focus(); canvas.blur();
    expect(document.activeElement).toBe(document.body);
    await open(value);
    expect(container.querySelector('[aria-label="Page options"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Object layer options"]')).toBeNull();
  });
});

describe("stereo readout row", () => {
  const items = buildObjectCanvasMenu({ objectIndex: 0, objectCount: 1, targetKind: "atom" });
  const deferred = () => {
    let resolve!: (label: string | undefined) => void;
    const promise = new Promise<string | undefined>(done => { resolve = done; });
    return { promise, resolve };
  };
  afterEach(() => { tauri.handler = undefined; });

  it("inline menu opens at once, then fills the read-only row without moving focus", async () => {
    const readout = deferred();
    const onInvoke = vi.fn();
    await act(async () => root.render(<CanvasContextMenu items={items} position={{ x: 10, y: 10 }} label="Object layer options"
      targetKind="atom" onInvoke={onInvoke} onDismiss={() => {}} loadStereoReadout={() => readout.promise} />));
    const menu = container.querySelector('[aria-label="Object layer options"]')!;
    expect(menu).not.toBeNull();
    expect(menu.querySelector(".object-context-menu-title")?.textContent).not.toBe("Stereocenter: R");
    expect(document.activeElement?.getAttribute("data-command-id")).toBe("clipboard.cut");
    await key("ArrowDown");
    expect(document.activeElement?.getAttribute("data-command-id")).toBe("clipboard.copy");
    await act(async () => readout.resolve("Stereocenter: R"));
    const first = menu.firstElementChild!;
    expect(first.className).toBe("object-context-menu-title");
    expect(first.textContent).toBe("Stereocenter: R");
    expect(first.tagName).toBe("DIV");
    expect(first.nextElementSibling?.getAttribute("role")).toBe("separator");
    expect(document.activeElement?.getAttribute("data-command-id")).toBe("clipboard.copy");
    await act(async () => (first as HTMLElement).click());
    expect(onInvoke).not.toHaveBeenCalled();
  });

  it("re-measures an open flyout once the late row arrives and the root clamp has applied", async () => {
    const readout = deferred();
    // jsdom has no layout: the root is 100px tall without the row and 140px with it; the Copy As
    // trigger sits 100px below the root's top (plus the row); its flyout is 300px tall.
    const hasRow = (menu: Element) => menu.firstElementChild?.textContent === "Stereocenter: R";
    const rect = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rootMenu = this.closest<HTMLElement>('[aria-label="Object layer options"]');
      if (!rootMenu) return rect(0, 0);
      if (this === rootMenu) return rect(parseFloat(rootMenu.style.top), hasRow(rootMenu) ? 140 : 100);
      if (this.classList.contains("object-context-menu-flyout")) return rect(0, 300);
      if (this.classList.contains("object-context-menu-submenu"))
        return rect(parseFloat(rootMenu.style.top) + (hasRow(rootMenu) ? 140 : 100), 24);
      return rect(0, 0);
    });
    try {
      // Window 768 tall. The 100px root fits at y=640, so it is not clamped until the row makes it 140px.
      expect(window.innerHeight).toBe(768);
      await act(async () => root.render(<CanvasContextMenu items={items} position={{ x: 10, y: 640 }} label="Object layer options"
        targetKind="atom" onInvoke={() => {}} onDismiss={() => {}} loadStereoReadout={() => readout.promise} />));
      const menu = container.querySelector<HTMLElement>('[aria-label="Object layer options"]')!;
      expect(menu.style.top).toBe("640px");
      const trigger = menu.querySelector<HTMLButtonElement>('[data-context-submenu="copy-as"]')!;
      await act(async () => trigger.click());
      const flyout = () => menu.querySelector<HTMLElement>(".object-context-menu-flyout")!;
      // Trigger top 740: 740 + 300 + 8 - 768 = 280.
      expect(flyout().style.top).toBe("-280px");
      trigger.focus();
      await act(async () => readout.resolve("Stereocenter: R"));
      // The root clamps to 768 - 140 - 8 = 620, the trigger to 760: 760 + 308 - 768 = 300. A stale
      // offset stays -280; one measured before the clamp (trigger at 780) would be -320.
      expect(menu.style.top).toBe("620px");
      expect(flyout().style.top).toBe("-300px");
      expect(document.activeElement).toBe(trigger);
    } finally {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockRestore();
    }
  });

  it("keeps every row of the HTML menu inside the window near the bottom and right edges", async () => {
    const rect = (left: number, top: number) => ({ left, top, width: 200, height: 300, right: left + 200, bottom: top + 300, x: left, y: top, toJSON() {} }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("aria-label") === "Object layer options"
        ? rect(parseFloat(this.style.left), parseFloat(this.style.top)) : rect(0, 0);
    });
    try {
      expect([window.innerWidth, window.innerHeight]).toEqual([1024, 768]);
      await act(async () => root.render(<CanvasContextMenu items={items} position={{ x: 1000, y: 740 }} label="Object layer options"
        targetKind="atom" onInvoke={() => {}} onDismiss={() => {}} />));
      const menu = container.querySelector<HTMLElement>('[aria-label="Object layer options"]')!;
      expect([menu.style.left, menu.style.top]).toEqual(["816px", "460px"]);
    } finally {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockRestore();
    }
  });

  it("native popup is never presented when the menu unmounts during the readout wait", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const calls: string[] = [];
    tauri.handler = command => { if (command === "popup_canvas_context_menu") calls.push(command); return null; };
    const closed = vi.fn();
    window.addEventListener("chemdraft:native-canvas-menu-closed", closed);
    const readout = deferred();
    try {
      await act(async () => root.render(<CanvasContextMenu items={items} position={{ x: 10, y: 10 }} label="Object layer options"
        targetKind="atom" onInvoke={() => {}} onDismiss={() => {}} loadStereoReadout={() => readout.promise} />));
      await act(async () => root.render(<></>));
      await act(async () => { readout.resolve("Stereocenter: R"); await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(calls).toEqual([]);
      expect(closed).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("chemdraft:native-canvas-menu-closed", closed);
    }
  });

  it("native popup is never presented when the readout settles between the unmount commit and passive cleanup", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const calls: string[] = [];
    tauri.handler = command => { if (command === "popup_canvas_context_menu") calls.push(command); return null; };
    const closed = vi.fn();
    window.addEventListener("chemdraft:native-canvas-menu-closed", closed);
    const readout = deferred();
    const order: string[] = [];
    void readout.promise.then(() => order.push("readout settled"));
    // Replaces the menu in one commit: its layout effect runs after the menu's deletion is committed,
    // and its passive effect runs in the same flush as the menu's passive cleanup.
    function ResolveDuringCommit() {
      useLayoutEffect(() => { order.push("commit"); readout.resolve("Stereocenter: R"); }, []);
      useEffect(() => { order.push("passive"); }, []);
      return null;
    }
    const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    try {
      await act(async () => root.render(<CanvasContextMenu items={items} position={{ x: 10, y: 10 }} label="Object layer options"
        targetKind="atom" onInvoke={() => {}} onDismiss={() => {}} loadStereoReadout={() => readout.promise} />));
      // Outside act, React commits in a Scheduler task, requests a paint, and flushes passive effects
      // in a later task, so microtasks (the readout continuation) run in between, as in the app.
      env.IS_REACT_ACT_ENVIRONMENT = false;
      root.render(<ResolveDuringCommit />);
      await vi.waitFor(() => expect(order).toContain("passive"));
      for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(order).toEqual(["commit", "readout settled", "passive"]);
      expect(calls).toEqual([]);
      expect(closed).not.toHaveBeenCalled();
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = true;
      window.removeEventListener("chemdraft:native-canvas-menu-closed", closed);
    }
  });

  it.each([undefined, "unavailable"])("inline menu omits the row when the readout is %s", async outcome => {
    await act(async () => root.render(<CanvasContextMenu items={items} position={{ x: 10, y: 10 }} label="Object layer options"
      targetKind="atom" onInvoke={() => {}} onDismiss={() => {}}
      loadStereoReadout={() => outcome ? Promise.reject(new Error(outcome)) : Promise.resolve(undefined)} />));
    const menu = container.querySelector('[aria-label="Object layer options"]')!;
    expect(menu.firstElementChild?.getAttribute("data-command-id")).toBe("clipboard.cut");
  });

  it("native menu (macOS and Windows share one command) carries the row first", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const calls: Array<{ command: string; args: { items: Array<{ label?: string; enabled?: boolean }> } }> = [];
    // Only the popup is under test; a MainWindow from an earlier test may still be issuing its own invokes.
    tauri.handler = (command, args) => {
      if (command === "popup_canvas_context_menu") calls.push({ command, args: args as never });
      return null;
    };
    const onDismiss = vi.fn();
    await act(async () => root.render(<CanvasContextMenu items={items} position={{ x: 10, y: 10 }} label="Object layer options"
      targetKind="bond" onInvoke={() => {}} onDismiss={onDismiss} loadStereoReadout={async () => "Double bond: E"} />));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("popup_canvas_context_menu");
    expect(calls[0]!.args.items[0]).toMatchObject({ label: "Double bond: E", enabled: false });
    expect(calls[0]!.args.items[2]).toMatchObject({ label: "Cut" });
    expect(container.querySelector('[aria-label="Object layer options"]')).toBeNull();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
