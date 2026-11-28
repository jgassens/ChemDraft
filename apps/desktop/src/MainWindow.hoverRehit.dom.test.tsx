// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";
import { coreDrawingToolDefinitions } from "./drawingTools";
import { canonicalCommandId } from "./renamedCommands";
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
    saveKeybindingSettings({ scheme: "chemdraw" });
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

  async function mount(initial = insertNativeSingleBondMolecule(createPhase4Document("Hover re-hit"), { x: 300, y: 300 }), tool = "tool.bond") {
    await act(async () => root.render(createElement(MainWindow, {
      initialActiveToolCommandId: tool,
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
    if (target instanceof Element) {
      target.setPointerCapture = () => {};
      target.releasePointerCapture = () => {};
      target.hasPointerCapture = () => false;
    }
    const event = new MouseEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: type === "pointerdown" ? 1 : 0,
      clientX: point.x, clientY: point.y
    });
    Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    await act(async () => { target.dispatchEvent(event); });
  }

  async function pointerAs(
    type: string, point: { x: number; y: number }, { pointerId, buttons }: { pointerId: number; buttons: number },
    target: EventTarget = container.querySelector(".page")!
  ) {
    if (target instanceof Element) {
      target.setPointerCapture = () => {};
      target.releasePointerCapture = () => {};
      target.hasPointerCapture = () => false;
    }
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { pointerId: { value: pointerId }, pointerType: { value: "touch" }, isPrimary: { value: pointerId === 7 } });
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

  it.each([
    ["b", false, false, "Br"], ["B", true, false, "B"],
    ["B", false, true, "Br"], ["b", true, true, "B"]
  ] as const)("uses physical B (%s, Shift=%s, Caps Lock=%s) as %s", async (key, shiftKey, capsLock, element) => {
    saveKeybindingSettings({ scheme: "chemdraw" });
    await mount();
    await pointer("pointermove", molecule().atoms[0]!);
    const event = new KeyboardEvent("keydown", { key, code: "KeyB", shiftKey, bubbles: true, cancelable: true });
    vi.spyOn(event, "getModifierState").mockImplementation(modifier => modifier === "CapsLock" && capsLock);
    await act(async () => { document.body.dispatchEvent(event); });
    expect(molecule().atoms[0]?.element).toBe(element);
  });

  it("uses an overridden hover key and frees its original key", async () => {
    saveKeybindingSettings({ scheme: "chemdraw", overrides: { chemdraw: { atom: { "atom.setHoveredElement.Br": ["D"] } } } });
    await mount();
    await pointer("pointermove", molecule().atoms[0]!);
    await press("b");
    expect(molecule().atoms[0]?.element).toBe("C");
    await press("D", false, true);
    expect(molecule().atoms[0]?.element).toBe("Br");
  });

  it("reacquires a drawn bond under the Bond tool after 2, then off/on, then 3", async () => {
    await mount(createPhase4Document("Draw then hover"));
    await pointer("pointerdown", { x: 300, y: 300 });
    await pointer("pointermove", { x: 340, y: 300 });
    await pointer("pointerup", { x: 340, y: 300 });
    const bond = molecule().bonds[0]!;
    const [from, to] = molecule().atoms;
    const point = { x: (from!.x + to!.x) / 2, y: (from!.y + to!.y) / 2 };
    const visual = () => container.querySelector(`[data-page-svg-object-visual="${molecule().id}"], [data-object-id="${molecule().id}"]`)!;
    await pointer("pointermove", point, visual());
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
    await press("2");
    expect(molecule().bonds[0]!.order).toBe("double");
    await pointer("pointermove", { x: 500, y: 450 });
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    await pointer("pointermove", point, visual());
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
    await press("3");
    expect(molecule().bonds[0]!.order).toBe("triple");
    expect(snapshot().activeToolCommandId).toBe("tool.bond");
  });

  it.each(["object", "page"])("reacquires hover after drawing from an atom with release on %s", async release => {
    await mount();
    const visual = () => container.querySelector(`[data-page-svg-object-visual="${molecule().id}"], [data-object-id="${molecule().id}"]`)!;
    const atom = molecule().atoms[0]!;
    await pointer("pointermove", atom, visual());
    await pointer("pointerdown", atom, visual());
    const tip = { x: atom.x - 22, y: atom.y + 22 };
    await pointer("pointermove", tip, visual());
    await pointer("pointerup", tip, release === "page" ? container.querySelector(".page")! : visual());
    expect(molecule().bonds).toHaveLength(2);
    const bond = await hoverBond();
    await press("2");
    expect(molecule().bonds.find(candidate => candidate.id === bond.id)!.order).toBe("double");
    await pointer("pointermove", { x: 500, y: 450 });
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    const from = molecule().atoms.find(candidate => candidate.id === bond.fromAtomId)!;
    const to = molecule().atoms.find(candidate => candidate.id === bond.toAtomId)!;
    await pointer("pointermove", { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, visual());
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
    await press("3");
    expect(molecule().bonds.find(candidate => candidate.id === bond.id)!.order).toBe("triple");
  });

  it.each(coreDrawingToolDefinitions.filter(tool => !("disabledReason" in tool && tool.disabledReason)))(
    "reacquires bond hover after key edits under $commandId", async tool => {
      await mount();
      const original = molecule();
      const bond = original.bonds[0]!;
      const [from, to] = original.atoms;
      const point = { x: (from!.x + to!.x) / 2, y: (from!.y + to!.y) / 2 };
      await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(tool.commandId); });
      expect(snapshot().activeToolCommandId, tool.commandId).toBe(canonicalCommandId(tool.commandId));
      const visual = () => container.querySelector(`[data-page-svg-object-visual="${molecule().id}"], [data-object-id="${molecule().id}"]`)!;
      await pointer("pointermove", point, visual());
      await press("1");
      await press("2");
      expect(molecule().bonds[0]!.order, tool.commandId).toBe("double");
      await pointer("pointermove", { x: 500, y: 450 });
      expect(snapshot().hoveredNativeTarget, tool.commandId).toBeUndefined();
      await pointer("pointermove", point, visual());
      expect(snapshot().hoveredNativeTarget, tool.commandId).toMatchObject({ kind: "bond", bondId: bond.id });
      await press("3");
      expect(molecule().bonds[0]!.order, tool.commandId).toBe("triple");
      expect(snapshot().activeToolCommandId, tool.commandId).toBe(canonicalCommandId(tool.commandId));
    }
  );

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

  it("clears the hover when deleting the bond leaves empty canvas under the pointer", async () => {
    await mount();
    const bond = await hoverBond();
    const resolve = vi.spyOn(hitTest, "nativeMoleculeCanvasHoverTarget");
    await press("Delete");
    expect(molecule().bonds.some(candidate => candidate.id === bond.id)).toBe(false);
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    expect(resolve).toHaveBeenCalled();
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

  it("re-hits again once the pointer of a gesture the undo stopped is released", async () => {
    await mount();
    const bond = await hoverBond();
    await press("2");
    await pointer("pointerdown", { x: 500, y: 400 });
    await press("z", true);
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    await pointer("pointerup", { x: 500, y: 400 });
    // No pointer move: the redo re-hits the last canvas position, over the bond.
    await press("z", true, true);
    expect(molecule().bonds.find(candidate => candidate.id === bond.id)!.order).toBe("double");
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
  });

  // Starts a Bond-tool drag on empty canvas with pointer 7 and lets an undo disarm it, leaving
  // pointer 7's button down.
  async function disarmHeldGesture() {
    await mount();
    const bond = await hoverBond();
    await press("2");
    await pointer("pointerdown", { x: 500, y: 400 });
    await press("z", true);
    expect(molecule().bonds.find(candidate => candidate.id === bond.id)!.order).toBe("single");
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    const from = molecule().atoms.find(atom => atom.id === bond.fromAtomId)!;
    const to = molecule().atoms.find(atom => atom.id === bond.toAtomId)!;
    return { bond, midpoint: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 } };
  }

  it("sets no hover from a held pointer's moves after an undo stopped its gesture", async () => {
    const { bond, midpoint } = await disarmHeldGesture();
    await pointerAs("pointermove", midpoint, { pointerId: 7, buttons: 1 });
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    await pointerAs("pointermove", { x: midpoint.x + 1, y: midpoint.y }, { pointerId: 7, buttons: 1 });
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    await pointerAs("pointerup", midpoint, { pointerId: 7, buttons: 0 });
    await pointerAs("pointermove", midpoint, { pointerId: 7, buttons: 0 });
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
  });

  it("keeps a held pointer's hold through another pointer's press and release", async () => {
    const { bond, midpoint } = await disarmHeldGesture();
    await pointerAs("pointerdown", { x: 900, y: 700 }, { pointerId: 9, buttons: 1 }, document.body);
    await pointerAs("pointermove", { x: 901, y: 700 }, { pointerId: 9, buttons: 0 }, document.body);
    await pointerAs("pointerup", { x: 900, y: 700 }, { pointerId: 9, buttons: 0 }, document.body);
    await pointerAs("pointercancel", { x: 900, y: 700 }, { pointerId: 9, buttons: 0 }, document.body);
    await pointerAs("pointermove", midpoint, { pointerId: 7, buttons: 1 });
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    const resolve = vi.spyOn(hitTest, "nativeMoleculeCanvasHoverTarget");
    await press("z", true, true);
    expect(molecule().bonds.find(candidate => candidate.id === bond.id)!.order).toBe("double");
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    resolve.mockRestore();
    await pointerAs("pointerup", midpoint, { pointerId: 7, buttons: 0 });
    // No pointer move: the undo re-hits the last canvas position, over the bond.
    await press("z", true);
    expect(molecule().bonds.find(candidate => candidate.id === bond.id)!.order).toBe("single");
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
  });

  it("ends the hold of a stopped gesture when the window loses focus", async () => {
    const { bond, midpoint } = await disarmHeldGesture();
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    // The release may have happened elsewhere; a later report of the button still down is stale.
    await pointerAs("pointermove", midpoint, { pointerId: 7, buttons: 1 });
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
    await press("z", true, true);
    expect(molecule().bonds.find(candidate => candidate.id === bond.id)!.order).toBe("double");
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
  });

  // 1.2.3 review: an undo that stops a molecule MOVE drag holds that pointer's hover off until its
  // release, as for every other drag an undo stops.
  it("holds hover off for the pointer of a molecule move that an undo stopped", async () => {
    await mount();
    const bond = await hoverBond();
    await press("2");
    await act(async () => { await window.__CHEMDRAFT_AGENT__?.command("tool.select"); });
    const from = molecule().atoms.find(atom => atom.id === bond.fromAtomId)!;
    const to = molecule().atoms.find(atom => atom.id === bond.toAtomId)!;
    const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const atomsBefore = molecule().atoms;
    // Press on the molecule's own element: the whole-object move (`objectDragRef`).
    const moleculeElement = container.querySelector(`[data-object-id="${molecule().id}"]`)!;
    expect(moleculeElement).not.toBeNull();
    await pointerAs("pointerdown", midpoint, { pointerId: 7, buttons: 1 }, moleculeElement);
    await pointerAs("pointermove", { x: midpoint.x + 30, y: midpoint.y + 20 }, { pointerId: 7, buttons: 1 });
    await pointerAs("pointermove", { x: midpoint.x + 40, y: midpoint.y + 25 }, { pointerId: 7, buttons: 1 });
    await press("z", true);
    expect(molecule().bonds.find(candidate => candidate.id === bond.id)!.order).toBe("single");
    expect(molecule().atoms).toEqual(atomsBefore);
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    // The held button's moves over the bond set no hover until the pointer is released.
    await pointerAs("pointermove", midpoint, { pointerId: 7, buttons: 1 });
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    await pointerAs("pointerup", midpoint, { pointerId: 7, buttons: 0 });
    expect(molecule().atoms).toEqual(atomsBefore);
    await pointerAs("pointermove", midpoint, { pointerId: 7, buttons: 0 });
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
  });
});
