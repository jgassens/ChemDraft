// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPatches, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, createNativeSingleBondMolecule, selectDocumentObjects } from "./documentWorkflow";
import { createLayerActions, createQuickActions } from "./commands";
import { createDesktopShortcutRegistry, createMainWindowShortcutCommands } from "./keyboardShortcuts";
import { nudgeDocumentSelection } from "./selectionNudge";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

function fixture(selected = true): ChemDraftDocument {
  let doc = createPhase4Document("Arrow movement");
  const first = createNativeSingleBondMolecule(doc, { x: 200, y: 200 });
  doc = applyPatches(doc, [{ op: "addObject", pageId: doc.pages[0].id, object: first }]);
  const second = createNativeSingleBondMolecule(doc, { x: 350, y: 300 });
  doc = applyPatches(doc, [{ op: "addObject", pageId: doc.pages[0].id, object: second }]);
  return selected ? selectDocumentObjects(doc, doc.pages[0].id, [first.id]) : doc;
}

describe("selection nudge commands", () => {
  it.each(["windows", "macos"] as const)("binds both step sizes in both keybinding schemes on %s", (platform) => {
    const doc = fixture();
    for (const scheme of ["chemdraft", "chemdraw"] as const) {
      const commands = createMainWindowShortcutCommands({
        quickActions: createQuickActions(doc, undefined), layerActions: createLayerActions(doc), toolCommandSpecs: []
      }, scheme);
      const registry = createDesktopShortcutRegistry(commands, platform);
      for (const [key, direction] of [["ArrowLeft", "left"], ["ArrowRight", "right"], ["ArrowUp", "up"], ["ArrowDown", "down"]]) {
        expect(registry.resolve({ key })).toBe(`layout.nudge.${direction}.1`);
        expect(registry.resolve({ key, shiftKey: true })).toBe(`layout.nudge.${direction}.10`);
        expect(registry.resolve({ key, ctrlKey: true })).toBeUndefined();
        expect(registry.resolve({ key, metaKey: true })).toBeUndefined();
        expect(registry.resolve({ key, altKey: true })).toBeUndefined();
      }
    }
  });

  it("does nothing without selection and moves a part's molecule rigidly, only once", () => {
    const doc = fixture(false);
    expect(nudgeDocumentSelection(doc, "layout.nudge.right.1")).toBe(doc);
    const first = doc.pages[0].objects[0] as MoleculeObject;
    const moved = nudgeDocumentSelection(doc, "layout.nudge.right.1", [first.id, first.id]);
    const after = moved.pages[0].objects[0] as MoleculeObject;
    expect(after.x).toBe(first.x + 1);
    expect(after.bonds).toEqual(first.bonds);
    expect(after.atoms).toEqual(first.atoms.map((atom) => ({ ...atom, x: atom.x + 1 })));
    expect(moved.pages[0].objects[1]).toEqual(doc.pages[0].objects[1]);
  });

  it("moves the active page's selection without moving another page", () => {
    const doc = fixture();
    const secondPage = { ...doc.pages[0], id: "page-two", objects: doc.pages[0].objects.map((o) => ({ ...o, id: `second-${o.id}` })) };
    const multi = { ...doc, pages: [...doc.pages, secondPage], selection: { pageId: secondPage.id, objectIds: [secondPage.objects[0].id] } };
    const moved = nudgeDocumentSelection(multi, "layout.nudge.down.10");
    expect(moved.pages[0]).toEqual(doc.pages[0]);
    expect(moved.pages[1].objects[0].y).toBe(secondPage.objects[0].y + 10);
  });

  it("clamps to the page boundary and does not create an edit at the boundary", () => {
    const doc = fixture();
    let moved = doc;
    for (let i = 0; i < 100; i++) moved = nudgeDocumentSelection(moved, "layout.nudge.left.10");
    expect(moved.pages[0].objects[0].x).toBeGreaterThanOrEqual(0);
    expect(nudgeDocumentSelection(moved, "layout.nudge.left.1")).toBe(moved);
  });
});

describe("arrow-key movement in the document window", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__; vi.unstubAllGlobals();
  });
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  async function render(selected = true) {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: fixture(selected), initialActiveToolCommandId: "tool.select", initialRulersVisible: false,
      initialCrosshairsVisible: false, initialPaletteMode: "floating", nativePalette: false
    })));
  }
  async function key(key: string, options: KeyboardEventInit = {}, target: EventTarget = window) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
    await act(async () => { target.dispatchEvent(event); }); return event;
  }
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  it("moves only the selection, retains it, repeats, and supports undo/redo", async () => {
    await render(); const before = snapshot(); const first = before.pages[0].objects[0] as MoleculeObject;
    expect((await key("ArrowRight")).defaultPrevented).toBe(true);
    await key("ArrowRight", { repeat: true });
    await key("ArrowDown", { shiftKey: true });
    let after = snapshot();
    expect(after.pages[0].objects[0].x).toBe(first.x + 2);
    expect(after.pages[0].objects[0].y).toBe(first.y + 10);
    expect(after.pages[0].objects[1]).toEqual(before.pages[0].objects[1]);
    expect(after.selection).toEqual(before.selection);
    expect((after.pages[0].objects[0] as MoleculeObject).bonds).toEqual(first.bonds);
    await command("edit.undo"); expect(snapshot().pages[0].objects[0].y).toBe(first.y);
    await command("edit.redo"); expect(snapshot().pages[0].objects[0].y).toBe(first.y + 10);
    await command("edit.undo"); await command("edit.undo"); await command("edit.undo");
    expect(snapshot().pages[0].objects).toEqual(before.pages[0].objects);
  });
  it("leaves no-selection, composing, modified, and widget arrow keys alone", async () => {
    await render(); const before = snapshot();
    await key("ArrowLeft", { isComposing: true });
    await key("ArrowLeft", { ctrlKey: true });
    for (const tag of ["input", "textarea", "select", "button"]) {
      const widget = document.createElement(tag); container.append(widget); widget.focus();
      expect((await key("ArrowRight", {}, widget)).defaultPrevented).toBe(false); widget.remove();
    }
    const menu = document.createElement("div"); menu.setAttribute("role", "menu"); container.append(menu);
    await key("ArrowDown"); menu.remove();
    expect(snapshot().pages[0].objects).toEqual(before.pages[0].objects);
    await command("edit.selectAll"); await key("ArrowLeft", { shiftKey: true });
    expect(snapshot().pages[0].objects.map((o, i) => o.x - before.pages[0].objects[i].x)).toEqual([-10, -10]);
  });
  it("does not intercept arrows when nothing is selected", async () => {
    await render(false); const before = snapshot();
    expect((await key("ArrowLeft")).defaultPrevented).toBe(false);
    expect(snapshot().pages[0].objects).toEqual(before.pages[0].objects);
  });
});
