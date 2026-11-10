// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type ChemDraftDocument } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { ToolPalette } from "./ToolPalette";
import { createCustomSwatchActions } from "./commands";
import { CMYK_APPROXIMATION_NOTE, customSwatchCommandId, loadCustomSwatches, saveCustomSwatches, setCustomSwatchSlot } from "./customColorSwatches";
import { CustomColorForm } from "./dialogs/CustomColorForm";
import { DialogWindow } from "./dialogs/DialogWindow";
import { createNativeArtGraphicObject, createNativeSingleBondMolecule, createPhase4Document, insertNativeTextObject, selectDocumentObjects } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import type { DialogDelivery } from "./dialogs/dialogTransport";
import type { DialogMessage } from "./dialogs/dialogProtocol";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { persistCustomSwatches } from "./toolbars/customSwatchSettings";
import { CustomColorSwatchWidget } from "./toolbars/CustomColorSwatchWidget";
import { ToolbarWidgetStateContext } from "./toolbars/toolbarWidgets";
import { PALETTE_TOOLTIP_DOM_EVENT } from "./toolbars/toolbarTooltip";
import type { ToolbarPaletteItemModel } from "./toolsets";

const native = vi.hoisted(() => ({ open: vi.fn(), send: vi.fn(), hostReceive: undefined as ((message: DialogMessage) => void) | undefined,
  receive: undefined as ((delivery: DialogDelivery) => void) | undefined,
  events: new Map<string, Set<(event: { payload: unknown }) => void>>() }));
vi.mock("./dialogs/dialogTransport", () => ({ nativeDialogTransport: {
  subscribe: async (receive: typeof native.receive) => { native.receive = receive; return () => {}; },
  open: native.open, publish: async () => {}, close: async () => {}
}, subscribeDialogHost: async (_id: string, receive: typeof native.hostReceive) => { native.hostReceive = receive; return () => {}; },
  sendDialogMessage: native.send }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
vi.mock("./window-manager", async original => ({ ...await original<typeof import("./window-manager")>(), isDesktopRuntime: () => true,
  loadDocumentSession: async () => undefined, saveDocumentSession: async () => {}, loadToolsetLayoutState: async () => undefined,
  listToolsetWindowStates: async () => [], setToolbarsMenu: async () => {}, setQuitPromptEnabled: async () => {},
  listenForQuitFlushRequest: async () => () => {}, listenForQuitPromptRequest: async () => () => {}, listenForQuitSettings: async () => () => {}
}));
vi.mock("./window-manager/tauriEvents", async original => {
  const listen = async (name: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = native.events.get(name) ?? new Set(); handlers.add(handler); native.events.set(name, handlers);
    return () => { handlers.delete(handler); };
  };
  return { ...await original<typeof import("./window-manager/tauriEvents")>(), listenTauriEvent: listen, listenCurrentWindowEvent: listen };
});
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), isTauri: () => false, invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}) }));

const roots: Root[] = [], hosts: HTMLElement[] = [];
function host() { const element = document.createElement("div"); document.body.append(element); hosts.push(element); const root = createRoot(element); roots.push(root); return { element, root }; }
beforeEach(() => {
  vi.clearAllMocks(); native.events.clear(); native.send.mockResolvedValue(undefined);
  native.open.mockResolvedValue({ hostId: "host", windowLabel: "dialog-main-customColor-1" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("MessageChannel", class {
    port1 = { onmessage: () => {}, close() {} }; port2 = { postMessage: () => { void Promise.resolve().then(() => this.port1.onmessage()); }, close() {} };
  });
  vi.spyOn(window, "focus").mockImplementation(() => {});
  window.history.replaceState(null, "", "/?agentBridge=1");
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const element of hosts.splice(0)) element.remove();
  delete window.__CHEMDRAFT_AGENT__; window.history.replaceState(null, "", "/"); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function input(element: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function command(commandId: string) { await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); }); }
const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
async function mountDrawing(drawing: ChemDraftDocument, platform: "macos" | "windows") {
  const h = host();
  await act(async () => h.root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.select"
    initialPaletteMode="hidden" initialRulersVisible={false} initialCrosshairsVisible={false} nativePalette={false} shortcutPlatform={platform} />));
  return h;
}
function drawing() {
  let document = createPhase4Document("Custom colors");
  const molecule = createNativeSingleBondMolecule(document, { x: 100, y: 100 });
  document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: molecule }]);
  document = insertNativeTextObject(document, { x: 220, y: 200 }, "H2O");
  const arrow = createNativeArtGraphicObject(document, { x: 300, y: 300 }, "tool.art.reactionArrow")!;
  document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: arrow }]);
  const shape = createNativeArtGraphicObject(document, { x: 450, y: 400 }, "tool.art.rect")!;
  document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: shape }]);
  return { document: selectDocumentObjects(document, document.pages[0].id, document.pages[0].objects.map(object => object.id)), molecule, arrow };
}

describe.each(["macos", "windows"] as const)("custom swatch application (%s command platform)", platform => {
  it("equals preset blue for molecule, text, reaction arrow and shape, preserving chemistry and one undo", async () => {
    const source = drawing();
    saveCustomSwatches(setCustomSwatchSlot(loadCustomSwatches(), 1, 1, "#1f5fbf"));
    const { element } = await mountDrawing(source.document, platform);
    const before = structuredClone(snapshot());
    await command("text.color.blue");
    const preset = structuredClone(snapshot());
    const presetArrow = element.querySelector(`[data-page-svg-object-visual="${source.arrow.id}"]`)!.innerHTML;
    await command("edit.undo"); expect(snapshot()).toEqual(before);
    await command(customSwatchCommandId(1, 1, "apply"));
    expect(element.querySelector('[role="status"]')?.textContent).toBe("Applied #1F5FBF to selection");
    expect(snapshot()).toEqual(preset);
    const colored = snapshot().pages[0].objects.find(object => object.id === source.molecule.id)!;
    expect(colored.type).toBe("molecule");
    if (colored.type !== "molecule") throw new Error("Missing molecule");
    expect({ atoms: colored.atoms, bonds: colored.bonds, structure: colored.structure })
      .toEqual({ atoms: source.molecule.atoms, bonds: source.molecule.bonds, structure: source.molecule.structure });
    expect(colored.style).toMatchObject({ bondColor: "#1f5fbf", atomLabelColor: "#1f5fbf" });
    expect(element.querySelector(`[data-page-svg-object-visual="${source.arrow.id}"]`)!.innerHTML).toBe(presetArrow);
    expect(presetArrow).toContain('#1f5fbf');
    await command("edit.undo"); expect(snapshot()).toEqual(before);
    expect(element.querySelector('[role="status"]')?.textContent).toBe("Undid Apply Colour #1F5FBF");
    await command("edit.redo");
    expect(element.querySelector('[role="status"]')?.textContent).toBe("Redid Apply Colour #1F5FBF");
  });

  it("colours the selected characters through the same editor path as presets", async () => {
    const initial = insertNativeTextObject(createPhase4Document("Text runs"), { x: 120, y: 140 }, "H2O");
    saveCustomSwatches(setCustomSwatchSlot(loadCustomSwatches(), 2, 2, "#1f5fbf"));
    const { element } = await mountDrawing(initial, platform);
    await act(async () => element.querySelector('[data-page-svg-object-visual][data-object-type="text"]')!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
    const editor = element.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
    expect(editor).not.toBeNull();
    await act(async () => { editor.focus(); editor.setSelectionRange(1, 2); editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowRight" })); });
    const palette = host();
    await act(async () => palette.root.render(<ToolbarWidgetStateContext.Provider value={{ onInvoke: commandId => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }));
    } }}><CustomColorSwatchWidget swatch={2} /></ToolbarWidgetStateContext.Provider>));
    const button = palette.element.querySelectorAll<HTMLButtonElement>("button")[1];
    const press = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => { button.dispatchEvent(press); button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })); button.click(); });
    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(editor);
    const custom = structuredClone(snapshot());
    expect(custom.pages[0].objects[0]).toMatchObject({ type: "text", spans: [
      { text: "H", style: {} }, { text: "2", style: { color: "#1f5fbf" } }, { text: "O", style: {} }
    ] });
    await command("edit.undo");
    const currentEditor = element.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
    await act(async () => { currentEditor.focus(); currentEditor.setSelectionRange(1, 2); currentEditor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowRight" })); });
    await command("text.color.blue"); expect(snapshot()).toEqual(custom);
  });
});

describe("custom swatch toolbar and native dialog requests", () => {
  it("invokes empty Edit once per press, supports context/keyboard editing, and disables Apply without disabling Edit", async () => {
    const h = host(), invoke = vi.fn();
    const state = loadCustomSwatches();
    const widget = (n: number): ToolbarPaletteItemModel => ({ id: `widget.core.customColorSwatch${n}`, kind: "control", label: `Custom Color Swatch ${n}`,
      primary: { type: "control", controlId: `widget.core.customColorSwatch${n}` }, submenu: null,
      tooltip: { title: "", description: null, shortcut: null, shortcutLabel: null }, layout: { colSpan: 2, rowSpan: 1 } });
    const render = async (hasSelection: boolean) => act(async () => h.root.render(<ToolPalette itemGroups={[[widget(1), widget(3)]]} groups={[]}
      onInvoke={invoke} widgetState={{ onInvoke: invoke, commandSpecs: createCustomSwatchActions(loadCustomSwatches(), hasSelection) }} />));
    await render(true);
    const empty = h.element.querySelector<HTMLButtonElement>('[aria-label="Custom color 1, slot 2: empty. Click to set."]')!;
    expect(empty.textContent).toBe("?");
    await act(async () => { empty.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })); empty.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); empty.click(); });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(customSwatchCommandId(1, 2, "edit"));
    invoke.mockClear();
    await act(async () => { empty.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })); });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(customSwatchCommandId(1, 2, "edit"));
    await act(async () => persistCustomSwatches(setCustomSwatchSlot(state, 1, 2, "#123456")));
    await render(false); invoke.mockClear();
    const set = h.element.querySelector<HTMLButtonElement>('[aria-label="Custom color 1, slot 2: #123456"]')!;
    expect(set.title).toBe("#123456");
    expect(set.getAttribute("aria-disabled")).toBe("true"); expect(set.disabled).toBe(false);
    await act(async () => set.click()); expect(invoke).not.toHaveBeenCalled();
    await act(async () => set.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F10", shiftKey: true })));
    expect(invoke).toHaveBeenLastCalledWith(customSwatchCommandId(1, 2, "edit"));
    await act(async () => set.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ContextMenu" })));
    expect(invoke).toHaveBeenCalledTimes(2);
    await render(true); invoke.mockClear();
    await act(async () => set.click()); expect(invoke).toHaveBeenCalledExactlyOnceWith(customSwatchCommandId(1, 2, "apply"));
    expect(h.element.querySelector('[aria-controls]')).toBeNull();
    expect(h.element.querySelectorAll('[role="group"][aria-label^="Custom Color Swatch"]')).toHaveLength(2);
  });

  it("announces the stored colour to the native floating tooltip", async () => {
    saveCustomSwatches(setCustomSwatchSlot(loadCustomSwatches(), 1, 1, "#123456"));
    document.body.classList.add("palette-window-body");
    const tooltip = vi.fn(); window.addEventListener(PALETTE_TOOLTIP_DOM_EVENT, tooltip);
    try {
      const h = host(); await act(async () => h.root.render(<CustomColorSwatchWidget swatch={1} />));
      await act(async () => h.element.querySelector("button")!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
      expect(tooltip).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ visible: true, title: "#123456" }) }));
    } finally { document.body.classList.remove("palette-window-body"); window.removeEventListener(PALETTE_TOOLTIP_DOM_EVENT, tooltip); }
  });

  it("updates all mounted palettes on persisted settings, storage events, and the native settings notification", async () => {
    for (let n = 0; n < 2; n++) { const h = host(); await act(async () => h.root.render(<CustomColorSwatchWidget swatch={4} />)); }
    const state = setCustomSwatchSlot(loadCustomSwatches(), 4, 1, "#abcdef");
    await act(async () => persistCustomSwatches(state));
    expect(document.querySelectorAll('[aria-label="Custom color 4, slot 1: #abcdef"]')).toHaveLength(2);
    saveCustomSwatches(setCustomSwatchSlot(state, 4, 1, "#112233"));
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "chemdraft.customColorSwatches.v1" })));
    expect(document.querySelectorAll('[aria-label="Custom color 4, slot 1: #112233"]')).toHaveLength(2);
    saveCustomSwatches(setCustomSwatchSlot(state, 4, 1, "#445566"));
    await act(async () => { for (const handler of native.events.get("chemdraft://custom-color-swatches") ?? []) handler({ payload: null }); });
    expect(document.querySelectorAll('[aria-label="Custom color 4, slot 1: #445566"]')).toHaveLength(2);
  });

  it("opens the empty slot dialog once on a right-button press", async () => {
    await mountDrawing(drawing().document, "macos");
    const palette = host();
    await act(async () => palette.root.render(<ToolbarWidgetStateContext.Provider value={{ onInvoke: id => { void command(id); } }}><CustomColorSwatchWidget swatch={1} /></ToolbarWidgetStateContext.Provider>));
    await act(async () => { const button = palette.element.querySelector<HTMLButtonElement>("button")!;
      button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 2 }));
      button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })); });
    expect(native.open).toHaveBeenCalledOnce();
    expect(native.open.mock.calls[0][0]).toMatchObject({ dialogKind: "customColor", data: { swatch: 1, slot: 1, color: null } });
  });

  it("opens the native customColor request, saves without applying, and clears through the registered command", async () => {
    const initial = drawing().document;
    const { element } = await mountDrawing(initial, "windows");
    const palette = host();
    await act(async () => palette.root.render(<ToolbarWidgetStateContext.Provider value={{ onInvoke: id => { void command(id); } }}><CustomColorSwatchWidget swatch={1} /></ToolbarWidgetStateContext.Provider>));
    const before = structuredClone(snapshot());
    await act(async () => palette.element.querySelector<HTMLButtonElement>("button")!.click());
    expect(native.open).toHaveBeenCalledOnce();
    expect(native.open.mock.calls[0][0]).toMatchObject({ dialogKind: "customColor", data: { swatch: 1, slot: 1, color: null } });
    const send = async (type: "action" | "ready", data: unknown) => {
      const opened = native.open.mock.calls.at(-1)![0] as DialogMessage;
      await act(async () => native.receive!({ senderWindowId: "dialog-main-customColor-1", windowLabel: "dialog-main-customColor-1", message: { ...opened, type, data, requestId: crypto.randomUUID() } }));
    };
    await send("ready", {}); await send("action", { action: "apply", hex: "#abcdef" });
    expect(element.querySelector('[role="status"]')?.textContent).toBe("Custom Color 1, Slot 1 set to #ABCDEF");
    expect(loadCustomSwatches()[1].slot1).toBe("#abcdef"); expect(snapshot()).toEqual(before);
    await act(async () => palette.element.querySelector<HTMLButtonElement>("button")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    expect(native.open.mock.calls.at(-1)![0]).toMatchObject({ data: { color: "#abcdef" } });
    await send("ready", {}); await send("action", { action: "clear" });
    expect(element.querySelector('[role="status"]')?.textContent).toBe("Cleared Custom Color 1, Slot 1 (#ABCDEF)");
    expect(loadCustomSwatches()[1].slot1).toBeUndefined(); expect(snapshot()).toEqual(before);
    expect(palette.element.querySelector("button")!.textContent).toBe("?");
  });
});

describe("CustomColorForm", () => {
  it("reports a fresh content measurement when mode or validation changes", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.textContent?.includes(CMYK_APPROXIMATION_NOTE) ? 390 : this.textContent?.includes("whole number") || this.textContent?.includes("Server error") ? 350 : 300;
      return { top: 0, height } as DOMRect;
    });
    const h = host();
    await act(async () => h.root.render(<DialogWindow hostId="color-host" />));
    const message = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "customColor",
      sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot", data: { title: "Color", swatch: 4, slot: 2, color: null } } as DialogMessage;
    await act(async () => native.hostReceive!(message));
    const ready = () => native.send.mock.calls.filter(([, sent]) => sent.type === "ready").map(([, sent]) => sent.data.contentHeight);
    expect(ready()).toEqual([300]);
    await act(async () => { const select = h.element.querySelector("select")!; select.value = "RGB"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await input(h.element.querySelector<HTMLInputElement>("input")!, "300");
    expect(ready().at(-1)).toBe(350);
    await act(async () => { const select = h.element.querySelector("select")!; select.value = "CMYK"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(ready().at(-1)).toBe(390);
    await act(async () => { const select = h.element.querySelector("select")!; select.value = "Hex"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(ready().at(-1)).toBe(300);
  });

  it("requests a new measurement when a host error appears or clears", async () => {
    const h = host(), onReady = vi.fn();
    const render = (error?: string) => act(async () => h.root.render(<CustomColorForm initial={{ title: "Color", swatch: 1, slot: 1, color: null }}
      onSubmit={() => {}} onCancel={() => {}} onClear={() => {}} onReady={onReady} error={error} />));
    await render(); expect(onReady).toHaveBeenCalledTimes(1);
    await render("A long host error that can wrap"); expect(onReady).toHaveBeenCalledTimes(2);
    await render(); expect(onReady).toHaveBeenCalledTimes(3);
  });

  it("routes a native snapshot to the lazy form and sends a normalized OK action after ready", async () => {
    const h = host();
    await act(async () => h.root.render(<DialogWindow hostId="color-host" />));
    await act(async () => native.hostReceive!({ protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "customColor",
      sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot", data: { title: "Color", swatch: 4, slot: 2, color: null } }));
    await act(async () => { await document.fonts?.ready; await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(h.element.querySelector('form[aria-label="Custom Color"]')).not.toBeNull();
    expect(native.send.mock.calls.filter(([, message]) => message.type === "ready")).toHaveLength(1);
    await input(h.element.querySelector<HTMLInputElement>("input")!, "#aBc");
    await act(async () => h.element.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
    expect(native.send).toHaveBeenLastCalledWith("color-host", expect.objectContaining({ dialogKind: "customColor", type: "action", data: { action: "apply", hex: "#aabbcc" } }));
  });

  it("prefills modes, previews live, displays parser errors and the CMYK approximation note", async () => {
    const h = host(), submit = vi.fn();
    await act(async () => h.root.render(<CustomColorForm initial={{ title: "Color", swatch: 2, slot: 1, color: "#1f5fbf" }} onSubmit={submit} onCancel={() => {}} onClear={() => {}} />));
    const field = (name: string) => [...h.element.querySelectorAll("label")].find(label => label.textContent === name)?.querySelector<HTMLInputElement>("input")!;
    const mode = async (value: string) => act(async () => { const select = h.element.querySelector("select")!; select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const ok = () => h.element.querySelector<HTMLButtonElement>('[type="submit"]')!;
    expect(field("Hex color").value).toBe("#1f5fbf");
    await input(field("Hex color"), "#abc"); expect(h.element.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("Color preview: #aabbcc");
    await input(field("Hex color"), "#abcd"); expect(h.element.textContent).toContain("Hex color alpha is not supported"); expect(ok().disabled).toBe(true);
    await mode("RGB"); expect(field("Red").value).toBe("170");
    await input(field("Red"), "300"); expect(h.element.textContent).toContain("Red must be a whole number from 0 to 255, got 300"); expect(ok().disabled).toBe(true);
    await input(field("Red"), "255"); expect(ok().disabled).toBe(false);
    await mode("CMYK"); expect(h.element.textContent).toContain(CMYK_APPROXIMATION_NOTE);
    await input(field("Cyan"), "101"); expect(h.element.textContent).toContain("Cyan must be a percentage from 0 to 100, got 101"); expect(ok().disabled).toBe(true);
    for (const label of ["Cyan", "Magenta", "Yellow", "Black"]) await input(field(label), "0");
    expect(h.element.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("Color preview: #ffffff");
    await act(async () => ok().click()); expect(submit).toHaveBeenCalledExactlyOnceWith("#ffffff");
  });

  it.each(["macos", "windows"] as const)("supports Cancel and the local close shortcut on %s, and only offers Clear for set slots", async platform => {
    const h = host(), cancel = vi.fn(), clear = vi.fn();
    const render = (color: string | null) => act(async () => h.root.render(<CustomColorForm key={String(color)} initial={{ title: "Color", swatch: 1, slot: 2, color }}
      platform={platform} onSubmit={() => {}} onCancel={cancel} onClear={clear} />));
    await render(null); expect([...h.element.querySelectorAll("button")].some(button => button.textContent === "Clear")).toBe(false);
    await act(async () => h.element.querySelector("form")!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    await act(async () => h.element.querySelector("form")!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "w", metaKey: platform === "macos", ctrlKey: platform === "windows" })));
    expect(cancel).toHaveBeenCalledTimes(2);
    await render("#123456"); await act(async () => [...h.element.querySelectorAll("button")].find(button => button.textContent === "Clear")!.click());
    expect(clear).toHaveBeenCalledOnce();
  });
});
