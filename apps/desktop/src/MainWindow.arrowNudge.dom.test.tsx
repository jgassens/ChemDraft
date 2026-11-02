// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moleculeToMolfileV2000, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import * as OCL from "openchemlib";
import { planTableLayout } from "@chemdraft/layout-engine";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule, insertNativeTextObject, selectDocumentObjects,
  insertTableIntoDocument } from "./documentWorkflow";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("canvas arrow nudge (%s)", platform => {
  let root: Root, container: HTMLDivElement, canvas: HTMLElement;
  const current = () => getAssistantHistoryPort().read("initial")!;
  const molecule = (document = current()) => document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
  const canonical = (document = current()) => OCL.Molecule.fromMolfile(moleculeToMolfileV2000(molecule(document), {
    unknownBondOrders: "refuse", fromDocFrame: true
  }).contents).toSmiles();
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function mount(selected = true, text = false, tool = "tool.select", table = false) {
    let initialDocument = insertNativeSingleBondMolecule(createPhase4Document("Arrow nudge"), { x: 200, y: 200 });
    if (text) initialDocument = insertNativeTextObject(initialDocument, { x: 350, y: 250 }, "Conditions");
    if (table) initialDocument = insertTableIntoDocument(initialDocument, {
      rows: 2, columns: 2, headerRows: 0, preset: "grid", center: { x: 400, y: 350 },
      newId: prefix => `${prefix}-${crypto.randomUUID()}`
    });
    initialDocument = selectDocumentObjects(initialDocument, initialDocument.pages[0].id,
      selected ? [molecule(initialDocument).id] : []);
    await act(async () => root.render(<MainWindow initialDocument={initialDocument} initialActiveToolCommandId={tool}
      initialPaletteMode="hidden" initialRulersVisible={false} initialCrosshairsVisible={false}
      nativePalette={false} shortcutPlatform={platform} />));
    canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
    }
    await act(async () => canvas.focus());
  }
  async function key(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.activeElement!) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    await act(async () => target.dispatchEvent(event));
    return event;
  }
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  const undo = () => key("z", platform === "macos" ? { metaKey: true } : { ctrlKey: true }, canvas);
  const redo = () => key("z", { shiftKey: true, ...(platform === "macos" ? { metaKey: true } : { ctrlKey: true }) }, canvas);
  async function pointer(target: Element, type: string, point: { x: number; y: number }, shiftKey = false) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerdown" ? 1 : 0, clientX: point.x, clientY: point.y, shiftKey });
    Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    await act(async () => target.dispatchEvent(event));
  }
  function expectTranslation(before: ChemDraftDocument, dx: number, dy: number) {
    expect(molecule().atoms).toEqual(molecule(before).atoms.map(atom => ({ ...atom, x: atom.x + dx, y: atom.y + dy })));
    expect(molecule().bonds).toEqual(molecule(before).bonds);
    expect(canonical()).toBe(canonical(before));
  }

  it("selects a molecule, nudges Right three times including auto-repeat, and undoes in one step", async () => {
    await mount(false);
    await key("a", platform === "macos" ? { metaKey: true } : { ctrlKey: true });
    const before = current();
    expect(before.selection.objectIds).toEqual([molecule().id]);
    for (let i = 0; i < 3; i++) expect((await key("ArrowRight", { repeat: i > 0 })).defaultPrevented).toBe(true);
    expectTranslation(before, 3, 0);
    const after = current();
    await undo();
    expect(current().pages).toEqual(before.pages);
    await undo(); // No second nudge entry remains.
    expect(current().pages).toEqual(before.pages);
    await redo();
    expect(current().pages).toEqual(after.pages);
  });
  it("Shift+Down moves ten document units toward positive y", async () => {
    await mount(); const before = current();
    expect((await key("ArrowDown", { shiftKey: true })).defaultPrevented).toBe(true);
    expectTranslation(before, 0, 10);
    await undo(); expect(current().pages).toEqual(before.pages);
  });
  it.each(["idle", "other key", "pointer", "pointer motion", "command", "selection"])("ends the burst on %s", async boundary => {
    await mount(); const before = current();
    await key("ArrowRight");
    if (boundary === "idle") {
      const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 1001);
    } else if (boundary === "other key") await key("a");
    else if (boundary === "command") await command("view.zoomIn");
    else if (boundary === "selection") await command("edit.selectAll");
    else await pointer(container, boundary === "pointer motion" ? "pointermove" : "pointerdown", { x: 0, y: 0 });
    await key("ArrowRight", {}, canvas);
    expectTranslation(before, 2, 0);
    await undo(); expectTranslation(before, 1, 0);
    await undo(); expect(current().pages).toEqual(before.pages);
  });
  it("allows direction/size changes within a burst", async () => {
    await mount(); const before = current();
    await key("ArrowLeft"); await key("ArrowDown", { shiftKey: true }); await key("ArrowUp");
    expectTranslation(before, -1, 9);
    await undo(); expect(current().pages).toEqual(before.pages);
  });
  it.each(["Shift", "Control", "Alt", "Meta", "CapsLock"])("keeps a burst across a %s keydown", async modifier => {
    await mount(); const before = current();
    await key("ArrowRight");
    await key(modifier, modifier === "Shift" ? { shiftKey: true } : {});
    await key("ArrowDown", { shiftKey: true });
    await act(async () => canvas.dispatchEvent(new KeyboardEvent("keyup", { key: modifier, bubbles: true })));
    expectTranslation(before, 1, 10);
    await undo(); expect(current().pages).toEqual(before.pages);
  });
  it("keeps a held key in the same burst while clamped at the page edge", async () => {
    await mount(); const before = current();
    for (let i = 0; i < 20; i++) await key("ArrowLeft", { shiftKey: true, repeat: i > 0 });
    const edge = current();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    for (let i = 1; i <= 3; i++) {
      clock.mockReturnValue(now + 800 * i);
      await key("ArrowLeft", { repeat: true });
      expect(current()).toBe(edge);
    }
    await key("ArrowRight");
    await undo(); expect(current().pages).toEqual(before.pages);
  });
  it("nudges a selected atom fragment without moving the other atom, then undoes the burst", async () => {
    await mount(false);
    const atom = molecule().atoms[0];
    const target = () => container.querySelector(`[data-object-id="${molecule().id}"]`)!;
    await pointer(target(), "pointerdown", atom, true);
    await pointer(target(), "pointerup", atom, true);
    const before = current();
    await key("ArrowRight", {}, canvas); await key("ArrowRight", { repeat: true }, canvas);
    expect(molecule().atoms).toEqual(molecule(before).atoms.map(candidate => candidate.id === atom.id
      ? { ...candidate, x: candidate.x + 2 } : candidate));
    expect(canonical()).toBe(canonical(before));
    await undo(); expect(current().pages).toEqual(before.pages);
  });
  it("leaves empty selections unchanged and adds no undo entry", async () => {
    await mount(false); const before = current();
    for (const keyName of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      expect((await key(keyName)).defaultPrevented).toBe(false);
    }
    expect(current()).toBe(before);
    await undo(); expect(current()).toBe(before);
  });
  it.each(["metaKey", "ctrlKey", "altKey"])("leaves %s+arrows alone", async modifier => {
    await mount(); const before = current();
    for (const shiftKey of [false, true]) {
      expect((await key("ArrowRight", { [modifier]: true, shiftKey })).defaultPrevented).toBe(false);
    }
    expect(current()).toBe(before);
    await undo(); expect(current()).toBe(before);
  });
  it.each(["input", "textarea", "select", "contenteditable", "checkbox"])("leaves focused %s arrow navigation alone", async kind => {
    await mount();
    const control = document.createElement(kind === "contenteditable" ? "div" : kind === "checkbox" ? "input" : kind);
    if (kind === "contenteditable") { control.contentEditable = "true"; control.setAttribute("contenteditable", "true"); control.tabIndex = 0; }
    if (kind === "checkbox") (control as HTMLInputElement).type = "checkbox";
    container.append(control); await act(async () => control.focus());
    const before = current();
    expect((await key("ArrowRight")).defaultPrevented).toBe(false);
    expect((await key("ArrowDown", { shiftKey: true })).defaultPrevented).toBe(false);
    // Even an event dispatched at the canvas cannot bypass the focused-field guard.
    expect((await key("ArrowLeft", {}, canvas)).defaultPrevented).toBe(false);
    expect(current()).toBe(before);
  });
  it.each(["atom", "text"])("keeps arrows available to a real open %s editor", async kind => {
    await mount(true, true, kind === "atom" ? "tool.atom" : "tool.text");
    if (kind === "atom") {
      const atom = molecule().atoms[0];
      await pointer(container.querySelector(`[data-object-id="${molecule().id}"]`)!, "pointerdown", atom);
    } else {
      const text = current().pages[0].objects.find(object => object.type === "text")!;
      const glyph = container.querySelector(`[data-page-svg-object-visual="${text.id}"] text`)!;
      await pointer(glyph, "pointerdown", { x: text.x + 5, y: text.y + 5 });
      await pointer(glyph, "pointerup", { x: text.x + 5, y: text.y + 5 });
    }
    const editor = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      kind === "atom" ? '[data-atom-label-editor="true"]' : ".text-object-editor")!;
    expect(editor).not.toBeNull();
    await act(async () => editor.focus());
    const before = current(); editor.setSelectionRange(0, 0);
    expect((await key("ArrowRight")).defaultPrevented).toBe(false);
    expect((await key("ArrowDown", { shiftKey: true })).defaultPrevented).toBe(false);
    expect(current()).toBe(before);
    expect(document.activeElement).toBe(editor);
    // jsdom has no native caret default action; unprevented real DOM events are the contract here.
  });
  it("keeps table-cell arrow navigation inside the editor", async () => {
    await mount(true, false, "tool.select", true);
    const table = current().pages[0].objects.find(object => object.type === "table")!;
    const box = planTableLayout(table).cells[0].box;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const target = () => container.querySelector("[data-table-hit-target]")!;
    for (let i = 0; i < 2; i++) {
      await pointer(target(), "pointerdown", point); await pointer(target(), "pointerup", point);
    }
    await act(async () => target().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true,
      detail: 2, clientX: point.x, clientY: point.y })));
    const editor = container.querySelector<HTMLTextAreaElement>("[data-table-cell-editor] textarea")!;
    expect(editor).not.toBeNull();
    await act(async () => editor.focus());
    const before = current();
    await key("ArrowRight"); await key("ArrowDown", { shiftKey: true });
    expect(current().pages).toEqual(before.pages);
    expect(container.querySelector("[data-table-cell-editor] textarea")).not.toBeNull();
  });
});
