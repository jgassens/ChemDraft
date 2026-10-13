// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { OPEN_MODAL_DIALOG_SELECTOR } from "@chemdraft/shortcut-engine";
import { MainWindow } from "./MainWindow";
import * as workflow from "./documentWorkflow";
import * as hints from "./modifierHints";
import { saveKeybindingSettings } from "./keybindingSettings";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";
import { StructureRecognitionInstallDialog } from "./plugins/StructureRecognitionInstallDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe("MainWindow drag and modal performance", () => {
  let container: HTMLDivElement;
  let root: Root;
  let extraRoot: Root | undefined;
  let originalPlatform: string;

  beforeEach(() => {
    originalPlatform = navigator.platform;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.hasPointerCapture = () => false;
    saveKeybindingSettings({ scheme: "chemdraft" });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { extraRoot?.unmount(); root.unmount(); });
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "platform", { configurable: true, value: originalPlatform });
  });

  function rings(n: number) {
    let doc = workflow.createPhase4Document("Drag regression");
    for (let i = 0; i < n; i++) doc = workflow.insertNativeTemplateMolecule(doc, { x: 300, y: 300 }, "benzene");
    return workflow.selectDocumentObjects(doc, doc.pages[0].id, doc.pages[0].objects.map((object) => object.id));
  }

  async function mount(doc = rings(2)) {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden",
      initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false
    })));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({})
    });
  }

  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  function key(key: string, primary = false, shiftKey = false) {
    const mac = detectDesktopShortcutPlatform() === "macos";
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key, metaKey: primary && mac, ctrlKey: primary && !mac, shiftKey, bubbles: true, cancelable: true
    }));
  }
  function pointer(target: EventTarget, type: string, point: { x: number; y: number }) {
    const event = new MouseEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1,
      clientX: point.x, clientY: point.y
    });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    target.dispatchEvent(event);
  }

  async function previewDrag(dx: number, dy: number) {
    const start = snapshot();
    const molecule = [...start.pages[0].objects].reverse().find((object) => object.type === "molecule") as MoleculeObject;
    const point = molecule.atoms[0];
    const target = container.querySelector(`[data-object-id="${molecule.id}"]`)!;
    await act(async () => pointer(target, "pointerdown", point));
    const dragStart = snapshot();
    await act(async () => pointer(target, "pointermove", { x: point.x + dx, y: point.y + dy }));
    return { start: dragStart, molecule, point, target, preview: snapshot() };
  }

  // Molecule previews now retain paint rather than replacing the present document each frame.
  // Release runs the same movement function once; movement/history assertions stay intact.
  it.each([1, 2])("commits a retained preview once for %i molecule(s), with identical movement, undo and redo", async (n) => {
    await mount(rings(n));
    const drag = await previewDrag(30, 20);
    const ids = drag.start.selection.objectIds;
    const expected = workflow.normalizeCommittedDocument(n > 1
      ? workflow.moveDocumentObjects(drag.start, ids, 30, 20)
      : workflow.moveDocumentObject(drag.start, drag.molecule.id, { x: drag.molecule.x + 30, y: drag.molecule.y + 20 }));
    expect(drag.preview).toBe(drag.start);
    const move = vi.spyOn(workflow, n > 1 ? "moveDocumentObjects" : "moveDocumentObject");
    await act(async () => pointer(drag.target, "pointerup", { x: drag.point.x + 30, y: drag.point.y + 20 }));
    expect(move).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(expected);
    const committed = snapshot();
    await act(async () => key("z", true));
    expect(snapshot()).toEqual(drag.start);
    await act(async () => key("z", true, true));
    expect(snapshot()).toBe(committed);
  });

  it.each([1, 2])("commits a page-clamped preview for %i molecule(s) when release moves farther beyond the edge", async (n) => {
    await mount(rings(n));
    const drag = await previewDrag(1000, 1000);
    const move = vi.spyOn(workflow, n > 1 ? "moveDocumentObjects" : "moveDocumentObject");
    await act(async () => pointer(drag.target, "pointerup", { x: drag.point.x + 2000, y: drag.point.y + 2000 }));
    expect(move).toHaveBeenCalledTimes(1);
    move.mockRestore();
    const expected = n > 1 ? workflow.moveDocumentObjects(drag.start, drag.start.selection.objectIds, 2000, 2000)
      : workflow.moveDocumentObject(drag.start, drag.molecule.id, { x: drag.molecule.x + 2000, y: drag.molecule.y + 2000 });
    expect(snapshot()).toEqual(workflow.normalizeCommittedDocument(expected));
  });

  it("rebuilds for a changed release delta and cancels a later preview without committing it", async () => {
    await mount();
    const drag = await previewDrag(30, 20);
    const move = vi.spyOn(workflow, "moveDocumentObjects");
    await act(async () => pointer(drag.target, "pointerup", { x: drag.point.x + 35, y: drag.point.y + 25 }));
    expect(move).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(workflow.normalizeCommittedDocument(workflow.moveDocumentObjects(drag.start, drag.start.selection.objectIds, 35, 25)));
    const next = await previewDrag(10, 10);
    await act(async () => pointer(next.target, "pointercancel", { x: next.point.x + 10, y: next.point.y + 10 }));
    expect(snapshot()).toEqual(next.start);
  });

  it("reuses a return-to-origin preview without adding an undo entry", async () => {
    await mount();
    const drag = await previewDrag(30, 20);
    await act(async () => pointer(drag.target, "pointermove", drag.point));
    const preview = snapshot();
    expect(preview).toBe(drag.start);
    const move = vi.spyOn(workflow, "moveDocumentObjects");
    await act(async () => pointer(drag.target, "pointerup", drag.point));
    expect(move).toHaveBeenCalledTimes(1);
    expect(snapshot()).toBe(preview);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  // Heavy DOM drag-frame regression can exceed Vitest's default on busy CI hosts.
  it("does not search the document or recompute unchanged modifier hints on drag frames", async () => {
    await mount(rings(64));
    const drag = await previewDrag(10, 10);
    const query = vi.spyOn(document, "querySelector");
    const queryAll = vi.spyOn(document, "querySelectorAll");
    const hint = vi.spyOn(hints, "modifierHint");
    for (const delta of [20, 30, 40]) {
      await act(async () => pointer(drag.target, "pointermove", { x: drag.point.x + delta, y: drag.point.y + delta }));
    }
    expect(query.mock.calls.filter(([selector]) => selector === OPEN_MODAL_DIALOG_SELECTOR)).toHaveLength(0);
    expect(queryAll.mock.calls.filter(([selector]) => selector === OPEN_MODAL_DIALOG_SELECTOR)).toHaveLength(0);
    expect(hint).not.toHaveBeenCalled();
  }, 20_000);

  it.each(["MacIntel", "Win32"])("blocks %s keyboard undo and clipboard in a same-turn modal, then unblocks immediately on close", async (platform) => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    await mount();
    const drag = await previewDrag(30, 20);
    await act(async () => pointer(drag.target, "pointerup", { x: drag.point.x + 30, y: drag.point.y + 20 }));
    const committed = snapshot();
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    const setData = vi.fn();
    function copy() {
      const event = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { setData } });
      document.body.dispatchEvent(event);
    }
    try {
      await act(async () => { document.body.append(modal); key("z", true); copy(); });
      expect(snapshot()).toBe(committed);
      expect(setData).not.toHaveBeenCalled();
      await act(async () => { modal.remove(); copy(); key("z", true); });
      expect(setData).toHaveBeenCalled();
      expect(snapshot()).toEqual(drag.start);
    } finally { modal.remove(); }
  });

  it("blocks body-targeted undo during a real plugin install dialog and unblocks on close", async () => {
    await mount();
    const drag = await previewDrag(30, 20);
    await act(async () => pointer(drag.target, "pointerup", { x: drag.point.x + 30, y: drag.point.y + 20 }));
    const committed = snapshot();
    const host = document.createElement("div");
    container.append(host);
    extraRoot = createRoot(host);
    await act(async () => extraRoot!.render(createElement(StructureRecognitionInstallDialog, {
      request: { id: 1, pluginId: "org.chemdraft.ocsr.molscribe", pluginName: "MolScribe OCSR",
        status: { state: "notInstalled", requiredDiskBytes: 2e9, freeDiskBytes: 3e9 }, installing: false, ownsInstall: false },
      onInstall: vi.fn(), onCancel: vi.fn(), onDecline: vi.fn()
    })));
    await act(async () => key("z", true));
    expect(snapshot()).toBe(committed);
    await act(async () => { extraRoot!.unmount(); extraRoot = undefined; key("z", true); });
    expect(snapshot()).toEqual(drag.start);
  });

  it("refreshes hints on modal lifecycle changes without requiring a pointer or key event", async () => {
    await mount();
    await act(async () => pointer(container.querySelector(".page")!, "pointermove", { x: 100, y: 100 }));
    const text = container.querySelector("[data-modifier-hint]")?.textContent;
    expect(text).toBeTruthy();
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    try {
      await act(async () => { document.body.append(modal); });
      expect(container.querySelector("[data-modifier-hint]")).toBeNull();
      await act(async () => { modal.remove(); });
      expect(container.querySelector("[data-modifier-hint]")?.textContent).toBe(text);
    } finally { modal.remove(); }
  });

  it("preserves anchored charge marks and chemistry when committing a clamped group preview", async () => {
    const initial = rings(2);
    const molecule = initial.pages[0].objects[0] as MoleculeObject;
    const charged = workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(initial, 1,
      { objectId: molecule.id, kind: "atom", atomId: molecule.atoms[0].id, distanceToPointer: 0 }));
    const selected = workflow.selectDocumentObjects(charged, charged.pages[0].id, initial.selection.objectIds);
    await mount(selected);
    const drag = await previewDrag(-1000, -1000);
    const expected = workflow.normalizeCommittedDocument(workflow.moveDocumentObjects(drag.start, drag.start.selection.objectIds, -2000, -2000));
    const move = vi.spyOn(workflow, "moveDocumentObjects");
    await act(async () => pointer(drag.target, "pointerup", { x: drag.point.x - 2000, y: drag.point.y - 2000 }));
    expect(move).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(expected);
  });
});
