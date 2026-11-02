// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { Molecule } from "openchemlib";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { insertSmilesMolecule } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { applyNativeAtomElementTarget, createPhase4Document, insertNativeSingleBondMolecule, nativeAtomSproutHotkeyTarget, nativeSingleBondHotkeyAtAtomTarget, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";

// Real DOM event harness promoted from the chemist's hover reproduction tests.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe.each([
  ["windows", "chemdraft"], ["windows", "chemdraw"], ["macos", "chemdraft"], ["macos", "chemdraw"]
] as const)("fragment keys (%s, %s)", (platform, scheme) => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    saveKeybindingSettings({ scheme });
    originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { value: platform === "windows" ? "Win32" : "MacIntel", configurable: true });
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.hasPointerCapture = () => false;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
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
  const molecule = (): MoleculeObject => {
    const object = snapshot().document.pages[0].objects[0];
    if (object?.type !== "molecule") throw new Error("Expected molecule");
    return object;
  };

  async function renderEthane(initial = insertNativeSingleBondMolecule(createPhase4Document("Fragment keys"), { x: 300, y: 300 }), showToolbar = false) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.bond",
        initialCrosshairsVisible: false,
        initialDocument: selectDocumentObjects(initial, initial.pages[0].id, []),
        initialPaletteMode: showToolbar ? "floating" : "hidden",
        initialRulersVisible: false,
        nativePalette: !showToolbar
      }));
    });
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      element.getBoundingClientRect = () => rect;
    }
    await act(async () => { await Promise.resolve(); });
    if (initial.pages[0].objects.length) expect(molecule().atoms).toHaveLength((initial.pages[0].objects[0] as MoleculeObject).atoms.length);
  }

  async function pointer(type: "pointerdown" | "pointermove" | "pointerup", point: { x: number; y: number }) {
    await act(async () => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
        buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector(".page")!.dispatchEvent(event);
    });
  }

  async function hoverPoint(point: { x: number; y: number }) {
    await act(async () => {
      const event = new MouseEvent("pointermove", { bubbles: true, clientX: point.x, clientY: point.y, buttons: 0 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector(".page")!.dispatchEvent(event);
    });
  }

  async function hoverAtom(index: number) {
    const atom = molecule().atoms[index]!;
    await hoverPoint(atom);
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "atom", atomId: atom.id });
    return atom;
  }

  async function hoverBond() {
    const current = molecule();
    const bond = current.bonds[0]!;
    const from = current.atoms.find(atom => atom.id === bond.fromAtomId)!;
    const to = current.atoms.find(atom => atom.id === bond.toAtomId)!;
    await hoverPoint({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
    return bond;
  }


  async function press(key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, shiftKey: /^[A-Z]$/.test(key), ...modifiers });
    await act(async () => { (document.activeElement ?? document.body).dispatchEvent(event); });
    return event;
  }

  function numericSeed(element: "C" | "S" | "P") {
    let drawing = insertNativeSingleBondMolecule(createPhase4Document("Numeric keys"), { x: 300, y: 300 });
    const graph = drawing.pages[0].objects[0] as MoleculeObject;
    const target = { kind: "atom" as const, objectId: graph.id, atomId: graph.atoms[0].id, distanceToPointer: 0 };
    drawing = element === "S"
      ? nativeSingleBondHotkeyAtAtomTarget(drawing, target).document
      : nativeAtomSproutHotkeyTarget(drawing, target, "gemDimethyl").document;
    return applyNativeAtomElementTarget(drawing, target, element);
  }

  it.each(["S", "P"] as const)("key 2 over %s adds oxygen directly through the registry", async element => {
    await renderEthane(numericSeed(element));
    const before = molecule();
    await hoverAtom(0);
    await press("2");
    const after = molecule();
    expect(after.atoms).toHaveLength(before.atoms.length + 1);
    expect(after.atoms.slice(0, before.atoms.length)).toEqual(before.atoms);
    const oxygen = after.atoms.at(-1)!;
    expect(oxygen.element).toBe("O");
    expect(after.bonds.at(-1)).toMatchObject({ fromAtomId: before.atoms[0].id, toAtomId: oxygen.id, order: "double" });
  });

  it("hovering plain sulfur in CSC and pressing 2 adds one undoable oxo", async () => {
    const initial = insertSmilesMolecule(createPhase4Document("Sulfur oxo key"), { x: 300, y: 300 }, depictSmiles2D("CSC"), "CSC");
    await renderEthane(initial);
    const before = molecule();
    const sulfurIndex = before.atoms.findIndex(atom => atom.element === "S");
    expect(before.atoms[sulfurIndex].labelLiteral).toBeUndefined();
    await hoverAtom(sulfurIndex);
    const event = await press("2");
    expect(event.defaultPrevented).toBe(true);
    const after = molecule();
    expect(after.atoms).toHaveLength(before.atoms.length + 1);
    expect(after.atoms.slice(0, before.atoms.length)).toEqual(before.atoms);
    expect(after.bonds.at(-1)).toMatchObject({ fromAtomId: before.atoms[sulfurIndex].id, order: "double" });
    expect(Molecule.fromSmiles(after.structure).getIDCode()).toBe(Molecule.fromSmiles("CS(=O)C").getIDCode());
    expect(container.querySelector("[data-status-message]")?.textContent).toContain("Added carbonyl or oxo");
    await press("z", platform === "macos" ? { metaKey: true } : { ctrlKey: true });
    expect(molecule()).toEqual(before);
    await press("z", platform === "macos" ? { metaKey: true, shiftKey: true } : { ctrlKey: true, shiftKey: true });
    expect(molecule()).toEqual(after);
  });

  it("draws C–C, hover-types terminal S, ends continuation with the Bond toolbar, then adds undoable oxos", async () => {
    await renderEthane(createPhase4Document("Hover-typed terminal sulfur"), true);
    await pointer("pointerdown", { x: 300, y: 300 });
    await pointer("pointermove", { x: 340, y: 300 });
    await pointer("pointerup", { x: 340, y: 300 });
    expect(molecule().atoms).toHaveLength(2);
    expect(molecule().bonds).toHaveLength(1);
    await hoverAtom(1);
    await press("s");
    expect(molecule().atoms[1].element).toBe("S");
    const bondButton = container.querySelector<HTMLButtonElement>('[data-command-id="tool.bond"]');
    expect(bondButton).not.toBeNull();
    await act(async () => {
      bondButton!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
      bondButton!.focus();
      bondButton!.click();
    });
    expect(snapshot().activeToolCommandId).toBe("tool.bond");
    expect(container.querySelector('[data-atom-label-editor="true"]')).toBeNull();
    const before = molecule();
    for (const smiles of ["C[SH]=O", "C[SH](=O)=O"]) {
      await hoverAtom(1);
      await press("2");
      expect(container.querySelector("[data-status-message]")?.textContent).toContain("Added carbonyl or oxo");
      expect(Molecule.fromSmiles(molecule().structure).getIDCode()).toBe(Molecule.fromSmiles(smiles).getIDCode());
    }
    const full = molecule();
    await hoverAtom(1);
    await press("2");
    expect(molecule()).toEqual(full);
    expect(container.querySelector("[data-status-message]")?.textContent)
      .toContain("Cannot add carbonyl or oxo to hovered atom: that atom has no free valence");
    await press("z", platform === "macos" ? { metaKey: true } : { ctrlKey: true });
    expect(molecule().atoms).toHaveLength(before.atoms.length + 1);
    await press("z", platform === "macos" ? { metaKey: true } : { ctrlKey: true });
    expect(molecule()).toEqual(before);
  });

  it("key 9 over a tertiary carbon attaches isopropyl through the registry", async () => {
    await renderEthane(numericSeed("C"));
    const before = molecule();
    await hoverAtom(0);
    await press("9");
    const after = molecule();
    expect(after.atoms).toHaveLength(before.atoms.length + 3);
    expect(after.bonds.filter(bond => [bond.fromAtomId, bond.toAtomId].includes(before.atoms[0].id))).toHaveLength(4);
    expect(after.atoms.slice(0, before.atoms.length)).toEqual(before.atoms);
  });

  it.skipIf(scheme !== "chemdraft")("V over an atom switches to the Selection tool without editing chemistry", async () => {
    await renderEthane();
    const before = molecule();
    await hoverAtom(0);
    expect(snapshot().activeToolCommandId).toBe("tool.bond");
    await press("v");
    expect(snapshot().activeToolCommandId).toBe("tool.select");
    expect(molecule()).toEqual(before);
  });

  it.each([
    ["g", 3, 4], ["u", 4, 5],
    ["z", 2, 2], ["G", 5, 6], ["J", 6, 7]
  ] as const)("key %s over an atom builds one undoable substituent", async (key, atoms, bonds) => {
    await renderEthane();
    const before = molecule();
    await hoverAtom(0);
    const event = await press(key);
    expect(event.defaultPrevented).toBe(true);
    const after = molecule();
    const name = ({ g: "cyclopropyl", u: "cyclobutyl", z: "alkyne", G: "cyclopentadienyl", J: "phenyl" } as const)[key];
    expect(container.querySelector("[data-status-message]")?.textContent).toContain(`Added ${name}`);
    expect(after.atoms).toHaveLength(2 + atoms);
    expect(after.bonds).toHaveLength(1 + bonds);
    expect(after.atoms.slice(0, 2)).toEqual(before.atoms);
    expect(after.bonds[0]).toEqual(before.bonds[0]);
    await press("z", platform === "macos" ? { metaKey: true } : { ctrlKey: true });
    expect(molecule()).toEqual(before);
    await press("z", platform === "macos" ? { metaKey: true, shiftKey: true } : { ctrlKey: true, shiftKey: true });
    expect(molecule()).toEqual(after);
  });

  it.each(["g", "u", "z", "G", "J"])("key %s over a bond uses only its declared bond action", async key => {
    await renderEthane();
    const before = molecule();
    await hoverBond();
    await press(key);
    const added = key === "g" ? 1 : key === "z" ? 3 : 0;
    expect(molecule().atoms).toHaveLength(2 + added);
    expect(molecule().bonds).toHaveLength(1 + (added ? added + 1 : 0));
    expect(molecule().atoms.slice(0, 2)).toEqual(before.atoms);
    expect(molecule().bonds[0]).toEqual(before.bonds[0]);
    if (key === "z") expect(molecule().bonds.filter(bond => bond.order === "double")).toHaveLength(2);
  });
});
