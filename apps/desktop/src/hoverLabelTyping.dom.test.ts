// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule, insertNativeTemplateMolecule, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe.each(["windows", "macos"] as const)("hover label target changes (%s shortcut platform)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    saveKeybindingSettings({ scheme: "chemdraw" });
    originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { value: platform === "windows" ? "Win32" : "MacIntel", configurable: true });
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const initial = insertNativeSingleBondMolecule(createPhase4Document("Hover target changes"), { x: 300, y: 300 });
    await renderDocument(initial);
  });

  async function renderDocument(initial: ChemDraftDocument) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.bond",
        initialCrosshairsVisible: false,
        initialDocument: selectDocumentObjects(initial, initial.pages[0].id, []),
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      element.getBoundingClientRect = () => rect;
    }
    await act(async () => { await Promise.resolve(); });
  }

  async function remountDocument(initial: ChemDraftDocument) {
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await renderDocument(initial);
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
    if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
    else Reflect.deleteProperty(navigator, "platform");
  });

  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const molecule = (index = 0): MoleculeObject => {
    const object = snapshot().document.pages[0].objects[index];
    if (object?.type !== "molecule") throw new Error("Expected molecule");
    return object;
  };
  const editor = () => container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');

  async function hoverPoint(point: { x: number; y: number }) {
    await act(async () => {
      const event = new MouseEvent("pointermove", { bubbles: true, clientX: point.x, clientY: point.y, buttons: 0 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector(".page")!.dispatchEvent(event);
    });
  }

  async function hoverAtom(index: number, objectIndex = 0) {
    const atom = molecule(objectIndex).atoms[index]!;
    await hoverPoint(atom);
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "atom", atomId: atom.id });
  }

  async function hoverBond(objectIndex = 0) {
    const current = molecule(objectIndex);
    const bond = current.bonds[0]!;
    const from = current.atoms.find(atom => atom.id === bond.fromAtomId)!;
    const to = current.atoms.find(atom => atom.id === bond.toAtomId)!;
    await hoverPoint({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
    return bond;
  }

  async function press(key: string, target: EventTarget = document.activeElement ?? document.body) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => {
      target.dispatchEvent(event);
    });
    // jsdom has no text-editing default; apply it only when the editor allowed the key.
    if (!event.defaultPrevented && target instanceof HTMLInputElement && key.length === 1) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      const value = target.value.slice(0, start) + key + target.value.slice(end);
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.setSelectionRange(start + key.length, start + key.length);
      });
    }
  }

  it.each([["w", "wedge"], ["W", "hashed"]] as const)("sets a hovered bond with %s and undoes it once", async (key, style) => {
    const original = await hoverBond();
    await press(key, window);
    expect(molecule().bonds[0]).toMatchObject({ fromAtomId: original.fromAtomId, toAtomId: original.toAtomId, display: { bondStyle: style } });
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
    expect(molecule().bonds[0]).toEqual(original);
  });

  async function typeLabel(label: string) {
    for (const key of label) await press(key);
    expect(editor()?.value).toBe(label);
    expect(document.activeElement).toBe(editor());
  }

  async function addEthanes(count = 1) {
    let current = snapshot().document;
    for (let index = 1; index <= count; index++) {
      current = insertNativeSingleBondMolecule(current, { x: 300 + index * 150, y: 300 });
    }
    await remountDocument(current);
  }

  it("keeps typing in an explicitly opened label editor over another atom", async () => {
    await addEthanes();
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("tool.atom"); });
    const atom = molecule().atoms[0]!;
    await act(async () => {
      const event = new MouseEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, clientX: atom.x, clientY: atom.y });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector(`[data-object-id="${molecule().id}"]`)!.dispatchEvent(event);
    });
    expect(editor()).not.toBeNull();
    await typeLabel("OMe");
    const other = molecule(1);
    await hoverAtom(0, 1);
    await press("N");
    expect(editor()?.value).toBe("OMeN");
    expect(molecule(1)).toEqual(other);
  });

  async function hoverRelabel() {
    await hoverAtom(0);
    await press("o");
    expect(molecule().atoms.map(atom => atom.element)).toEqual(["O", "C"]);
    expect(editor()).toBeNull();
    expect(document.activeElement).not.toBeInstanceOf(HTMLInputElement);
  }

  it("dispatches digit 3 on the neighbouring atom just as without a prior hover relabel", async () => {
    await hoverRelabel();
    const before = snapshot().document;
    const oxygen = molecule().atoms[0]!;
    await hoverAtom(1);
    await press("3");
    expect(editor()).toBeNull();
    expect(molecule().atoms[0]).toEqual(oxygen);
    const after = molecule();
    const activeTool = snapshot().activeToolCommandId;
    // Remount the same chemistry to run the digit with no pending hover-label continuation.
    await remountDocument(before);
    await hoverAtom(1);
    await press("3");
    expect(editor()).toBeNull();
    expect(molecule()).toEqual(after);
    expect(snapshot().activeToolCommandId).toBe(activeTool);
  });

  it.each(["1", "3"])("dispatches bond digit %s on C-O just as without a prior hover relabel", async key => {
    await hoverRelabel();
    const before = snapshot().document;
    await hoverBond();
    await press(key);
    expect(editor()).toBeNull();
    const after = molecule();
    await remountDocument(before);
    await hoverBond();
    await press(key);
    expect(editor()).toBeNull();
    expect(molecule()).toEqual(after);
    if (key === "1") expect(molecule().bonds[0]!.order).toBe("single");
  });

  it.each(["2", "4", "5", "6", "7", "8"])("dispatches bond key %s after a hover relabel", async key => {
    await hoverRelabel();
    const before = molecule();
    const bond = await hoverBond();
    await press(key);
    expect(editor()).toBeNull();
    expect(molecule().atoms.slice(0, 2)).toEqual(before.atoms);
    expect(molecule().atoms.filter(atom => atom.element === "O")).toHaveLength(1);
    if (key === "2") {
      expect(molecule().atoms).toHaveLength(2);
      expect(molecule().bonds).toEqual([{ ...bond, order: "double" }]);
    } else {
      expect(molecule().atoms).toHaveLength(Number(key));
      expect(molecule().bonds).toHaveLength(Number(key));
      expect(molecule().bonds.find(candidate => candidate.id === bond.id)).toEqual(bond);
      expect(molecule().bonds.every(candidate => candidate.order === "single")).toBe(true);
      if (key === "5") expect(molecule().chemistry?.formula).toBe("C4H8O");
    }
  });

  it("keeps canvas focus without mounting an editor after DOM pointer and keyboard events on the second atom (not the agent bridge)", async () => {
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    await act(async () => { canvas.focus(); });
    expect(document.activeElement).toBe(canvas);
    await hoverAtom(0);
    await press("o", canvas);
    expect(editor()).toBeNull();
    await hoverAtom(1);
    await press("o", canvas);
    expect(molecule().atoms.map(atom => atom.element)).toEqual(["O", "O"]);
    expect(editor()).toBeNull();
    expect(document.activeElement).toBe(canvas);
  });
});

describe("hover label typing", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    saveKeybindingSettings({ scheme: "chemdraw" });
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const withRing = insertNativeTemplateMolecule(createPhase4Document("Hover typing"), { x: 300, y: 300 }, "cyclohexane");
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.bond",
        initialCrosshairsVisible: false,
        initialDocument: selectDocumentObjects(withRing, withRing.pages[0].id, []),
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      element.getBoundingClientRect = () => rect;
    }
    await act(async () => { await Promise.resolve(); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  function snapshot() {
    return window.__CHEMDRAFT_AGENT__!.snapshot();
  }

  function molecule(): MoleculeObject {
    const object = snapshot().document.pages[0].objects[0];
    if (object?.type !== "molecule") throw new Error("Expected molecule");
    return object;
  }

  function editor() {
    return container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
  }

  async function hover(atomIndex: number) {
    const atom = molecule().atoms[atomIndex]!;
    const page = container.querySelector<HTMLElement>(".page")!;
    await act(async () => {
      const event = new MouseEvent("pointermove", { bubbles: true, clientX: atom.x, clientY: atom.y, buttons: 0 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      page.dispatchEvent(event);
    });
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "atom", atomId: atom.id });
  }

  function expectIntact() {
    expect(snapshot().activeToolCommandId).toBe("tool.bond");
    expect(snapshot().document.pages[0].objects).toHaveLength(1);
    expect(molecule().atoms).toHaveLength(6);
    expect(molecule().bonds).toHaveLength(6);
  }

  it("ignores an IME composition key while hovering an atom", async () => {
    await hover(0);
    // WebKit exposes the actual character here, which previously entered hover-label typing.
    const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    Object.defineProperty(event, "isComposing", { value: true });
    await act(async () => { window.dispatchEvent(event); });

    expect(molecule().atoms[0]!.element).toBe("C");
    expect(editor()).toBeNull();
    expectIntact();
  });
});
