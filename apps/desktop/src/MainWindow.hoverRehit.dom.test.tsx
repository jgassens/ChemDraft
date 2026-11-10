// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";
import * as hitTest from "./interaction/hitTest";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe.each(["windows", "macos"] as const)("hover re-hit (%s shortcuts)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("localStorage", new MemoryStorage());
    saveKeybindingSettings({ scheme: "chemdraft" });
    originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "windows" ? "Win32" : "MacIntel" });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
    else Reflect.deleteProperty(navigator, "platform");
  });

  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const molecule = (): MoleculeObject => {
    const object = snapshot().document.pages[0].objects[0];
    if (object?.type !== "molecule") throw new Error("Expected molecule");
    return object;
  };

  async function mount() {
    const initial = insertNativeSingleBondMolecule(createPhase4Document("Hover re-hit"), { x: 300, y: 300 });
    await act(async () => root.render(createElement(MainWindow, {
      initialActiveToolCommandId: "tool.bond",
      initialCrosshairsVisible: false,
      initialDocument: selectDocumentObjects(initial, initial.pages[0].id, []),
      initialPaletteMode: "hidden",
      initialRulersVisible: false,
      nativePalette: true
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      element.getBoundingClientRect = () => rect;
      element.setPointerCapture = () => {};
      element.releasePointerCapture = () => {};
      element.hasPointerCapture = () => false;
    }
  }

  async function pointer(type: string, point: { x: number; y: number }, target: EventTarget = container.querySelector(".page")!) {
    const event = new MouseEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: type === "pointerdown" ? 1 : 0,
      clientX: point.x, clientY: point.y
    });
    Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    await act(async () => { target.dispatchEvent(event); });
  }

  async function press(key: string, history = false, shiftKey = false) {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", {
        key, bubbles: true, cancelable: true, shiftKey,
        metaKey: history && platform === "macos", ctrlKey: history && platform === "windows"
      }));
    });
  }

  async function hoverBond() {
    const current = molecule();
    const bond = current.bonds[0]!;
    const from = current.atoms.find(atom => atom.id === bond.fromAtomId)!;
    const to = current.atoms.find(atom => atom.id === bond.toAtomId)!;
    await pointer("pointermove", { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
    return bond;
  }

  it("applies a second bond key without moving the pointer", async () => {
    await mount();
    const bond = await hoverBond();
    await press("2");
    expect(molecule().bonds.find(candidate => candidate.id === bond.id)!.order).toBe("double");
    await press("1");
    expect(molecule().bonds.find(candidate => candidate.id === bond.id)!.order).toBe("single");
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
  });

  it("applies consecutive element keys to the same atom in the compatibility preset", async () => {
    saveKeybindingSettings({ scheme: "chemdraw" });
    await mount();
    const atom = molecule().atoms[0]!;
    await pointer("pointermove", atom);
    await press("n");
    expect(molecule().atoms[0]).toMatchObject({ id: atom.id, element: "N" });
    await press("o");
    expect(molecule().atoms[0]).toMatchObject({ id: atom.id, element: "O" });
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "atom", atomId: atom.id });
  });

  it("keeps default-preset element-key label continuation on the same atom", async () => {
    await mount();
    const atom = molecule().atoms[0]!;
    await pointer("pointermove", atom);
    await press("n");
    await press("o");
    expect(container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]')?.value).toBe("No");
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "atom", atomId: atom.id });
  });

  it("re-hits the original attachment atom after sprouting a ring", async () => {
    await mount();
    const atom = molecule().atoms[0]!;
    await pointer("pointermove", atom);
    await press("6");
    expect(molecule().atoms.length).toBeGreaterThan(2);
    // The ring attaches through a new bond: the original atom stays at the pointer, so the
    // ordinary atom-first hover resolver picks it, rather than a newly sprouted ring atom.
    expect(molecule().atoms.find(candidate => candidate.id === atom.id)).toMatchObject({ x: atom.x, y: atom.y });
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "atom", atomId: atom.id });
    await press("n");
    expect(molecule().atoms.find(candidate => candidate.id === atom.id)!.element).toBe("N");
    expect(molecule().atoms.filter(candidate => candidate.element === "N")).toHaveLength(1);
  });

  it("re-hits after keyboard undo and redo without pointer movement", async () => {
    await mount();
    const bond = await hoverBond();
    await press("2");
    await press("z", true);
    expect(molecule().bonds[0]!.order).toBe("single");
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
    await press("z", true, true);
    expect(molecule().bonds[0]!.order).toBe("double");
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
    await press("1");
    expect(molecule().bonds[0]!.order).toBe("single");
  });

  it("restores the pointer's bond after undoing a hover-label assignment", async () => {
    await mount();
    const bond = await hoverBond();
    await press("n");
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "atom" });
    await press("z", true);
    expect(molecule().atoms.every(atom => atom.element === "C")).toBe(true);
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
    await press("2");
    expect(molecule().bonds[0]!.order).toBe("double");
  });

  it("clears the hover when deleting the bond leaves empty canvas under the pointer", async () => {
    await mount();
    const bond = await hoverBond();
    const resolve = vi.spyOn(hitTest, "nativeMoleculeCanvasHoverTarget");
    await press("Delete");
    expect(molecule().bonds.some(candidate => candidate.id === bond.id)).toBe(false);
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    expect(resolve).toHaveBeenCalled();
  });

  it("does not re-hit while the hover-label editor owns typing", async () => {
    await mount();
    await pointer("pointermove", molecule().atoms[0]!);
    await press("n");
    await press("o");
    const editor = container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]')!;
    expect(editor.value).toBe("No");
    const before = molecule();
    const target = snapshot().hoveredNativeTarget;
    const resolve = vi.spyOn(hitTest, "nativeMoleculeCanvasHoverTarget");
    await press("2");
    expect(document.activeElement).toBe(editor);
    expect(molecule()).toEqual(before);
    expect(snapshot().hoveredNativeTarget).toEqual(target);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not re-hit the old canvas position after the pointer leaves the canvas", async () => {
    await mount();
    await hoverBond();
    await press("2");
    await pointer("pointerout", { x: 900, y: 700 });
    await pointer("pointermove", { x: 900, y: 700 }, document.body);
    const resolve = vi.spyOn(hitTest, "nativeMoleculeCanvasHoverTarget");
    await press("z", true);
    expect(molecule().bonds[0]!.order).toBe("single");
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    const before = molecule();
    await press("2");
    expect(molecule()).toEqual(before);
  });

  it.each(["blur", "hidden"])("waits for pointer movement after %s", async reason => {
    await mount();
    const bond = await hoverBond();
    await press("2");
    await act(async () => {
      if (reason === "blur") window.dispatchEvent(new Event("blur"));
      else {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event("visibilitychange"));
      }
    });
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    const resolve = vi.spyOn(hitTest, "nativeMoleculeCanvasHoverTarget");
    await press("z", true);
    expect(molecule().bonds[0]!.order).toBe("single");
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    await press("2");
    expect(molecule().bonds[0]!.order).toBe("single");
    await hoverBond();
    await press("2");
    expect(molecule().bonds.find(candidate => candidate.id === bond.id)!.order).toBe("double");
  });

  it("does not re-hit during an armed pointer gesture", async () => {
    await mount();
    const bond = await hoverBond();
    await press("2");
    await pointer("pointerdown", { x: 500, y: 400 });
    const resolve = vi.spyOn(hitTest, "nativeMoleculeCanvasHoverTarget");
    await press("z", true);
    expect(molecule().bonds.find(candidate => candidate.id === bond.id)!.order).toBe("single");
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    await pointer("pointercancel", { x: 500, y: 400 });
  });
});
