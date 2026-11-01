// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatches, type MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule, insertNativeTextObject, nativeBondLengthPx, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe.each(["macos", "windows"] as const)("same-head label input (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    saveKeybindingSettings({ scheme: "chemdraft" });
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "macos" ? "MacIntel" : "Win32" });
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    Reflect.deleteProperty(navigator, "platform");
    if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  });

  function molecule(): MoleculeObject {
    return window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects[0] as MoleculeObject;
  }

  async function press(key: string, modifiers = {}) {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", {
        key, bubbles: true, cancelable: true, ...modifiers
      }));
    });
  }

  it.each(["hover", "editor", "text"] as const)("shows the isotope refusal through %s and preserves the chemistry", async entry => {
    const seed = insertNativeSingleBondMolecule(createPhase4Document(), { x: 300, y: 300 });
    const original = seed.pages[0].objects[0] as MoleculeObject;
    const source = { id: "c13", element: "C", isotope: 13, formalCharge: 0, x: 300, y: 300 };
    const neighbors = [
      { id: "c1", element: "C", formalCharge: 0, x: 278, y: 300 },
      { id: "c2", element: "C", formalCharge: 0, x: 311, y: 281 }
    ];
    const blockers = Array.from({ length: 24 }, (_, i) => ({
      id: `blocker${i}`, element: "C", formalCharge: 0,
      x: source.x + nativeBondLengthPx * Math.cos(i * Math.PI / 12),
      y: source.y + nativeBondLengthPx * Math.sin(i * Math.PI / 12)
    }));
    // These paths try to attach a label, then must refuse the crowded relabel fallback.
    const crowded = applyPatches(seed, [{ op: "updateObject", objectId: original.id, changes: {
      atoms: [source, ...neighbors, ...blockers],
      bonds: neighbors.map((a, i) => ({ id: `cc${i}`, fromAtomId: source.id, toAtomId: a.id, order: "single" as const }))
    } }]);
    const initial = entry === "text" ? insertNativeTextObject(crowded, source, "Ph")
      : selectDocumentObjects(crowded, crowded.pages[0].id, []);
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: entry === "editor" ? "tool.text" : "tool.bond", initialCrosshairsVisible: false,
        initialDocument: initial, initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: true
      }));
    });
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
    const before = window.__CHEMDRAFT_AGENT__!.snapshot().document;
    if (entry !== "text") {
      await act(async () => {
        const event = new MouseEvent(entry === "editor" ? "pointerdown" : "pointermove", {
          bubbles: true, cancelable: true, button: 0, buttons: entry === "editor" ? 1 : 0,
          clientX: source.x, clientY: source.y, detail: 1
        });
        Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
        container.querySelector(".page")!.dispatchEvent(event);
      });
    }
    if (entry === "editor") {
      const input = container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]')!;
      expect(input).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "SH");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await press("Enter");
      expect(molecule()).toEqual(before.pages[0].objects[0]);
    } else {
      await act(async () => {
        await window.__CHEMDRAFT_AGENT__!.command(entry === "hover" ? "atom.setHoveredLabel.Ph" : "text.convertToAtomLabel");
      });
      expect(window.__CHEMDRAFT_AGENT__!.snapshot().document).toEqual(before);
    }
    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain(`Cannot relabel 13C as ${entry === "editor" ? "SH" : "Ph"}: the label cannot keep isotope 13`);
    expect(container.querySelector('[role="status"]')?.textContent).not.toContain("Relabeled");
    if (entry === "text") {
      expect(before.pages[0].objects.find(o => o.type === "text")).toMatchObject({ text: "Ph" });
    }
  });

  it("does not report a relabel when an existing SH label is unchanged", async () => {
    const seed = insertNativeSingleBondMolecule(createPhase4Document(), { x: 300, y: 300 });
    const original = seed.pages[0].objects[0] as MoleculeObject;
    const initial = applyPatches(seed, [{ op: "updateObject", objectId: original.id, changes: {
      x: 270, y: 275, width: 60, height: 40,
      atoms: [
        { id: "s", element: "SH", labelLiteral: true, formalCharge: 0, x: 300, y: 300 },
        { id: "c1", element: "C", formalCharge: 0, x: 278, y: 300 },
        { id: "c2", element: "C", formalCharge: 0, x: 311, y: 281 }
      ],
      bonds: [
        { id: "sc1", fromAtomId: "s", toAtomId: "c1", order: "single" },
        { id: "sc2", fromAtomId: "s", toAtomId: "c2", order: "double" }
      ]
    } }]);
    await act(async () => root.render(createElement(MainWindow, {
      initialActiveToolCommandId: "tool.atom", initialCrosshairsVisible: false,
      initialDocument: selectDocumentObjects(initial, initial.pages[0].id, []),
      initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: true
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
    const openEditor = async () => act(async () => {
      const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 300, clientY: 300, detail: 1 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector<HTMLElement>(`[data-object-id="${original.id}"]`)!.dispatchEvent(event);
    });
    await openEditor();
    await act(async () => { vi.advanceTimersByTime(100); });
    const input = container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]')!;
    expect(input.getAttribute("data-atom-id")).toBe("s");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "SH");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Enter");
    expect(container.querySelector('[role="status"]')?.textContent).not.toContain("Relabeled");
  });

  it.each(["hover", "text"] as const)("commits SH through %s, with one undo entry", async entry => {
    const seed = insertNativeSingleBondMolecule(createPhase4Document(), { x: 300, y: 300 });
    const original = seed.pages[0].objects[0] as MoleculeObject;
    const initial = applyPatches(seed, [{ op: "updateObject", objectId: original.id, changes: {
      atoms: [
        { id: "s", element: "S", formalCharge: 0, x: 300, y: 300 },
        { id: "c", element: "C", formalCharge: 0, x: 278, y: 300 },
        { id: "o", element: "O", formalCharge: 0, x: 311, y: 281 }
      ],
      bonds: [
        { id: "sc", fromAtomId: "s", toAtomId: "c", order: "single" },
        { id: "so", fromAtomId: "s", toAtomId: "o", order: "double" }
      ]
    } }]);
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: entry === "text" ? "tool.text" : "tool.bond",
        initialCrosshairsVisible: false,
        initialDocument: selectDocumentObjects(initial, initial.pages[0].id, []),
        initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: true
      }));
    });
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
    const before = molecule();
    await act(async () => {
      const event = new MouseEvent(entry === "text" ? "pointerdown" : "pointermove", {
        bubbles: true, cancelable: true, button: 0, buttons: entry === "text" ? 1 : 0,
        clientX: 300, clientY: 300, detail: 1
      });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector<HTMLElement>(entry === "text" ? `[data-object-id="${original.id}"]` : ".page")!.dispatchEvent(event);
    });
    if (entry === "hover") {
      await press("S");
      await press("H");
    }
    const input = container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]')!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "SH");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Enter");
    const after = molecule();
    expect(after.atoms.map(a => a.id)).toEqual(before.atoms.map(a => a.id));
    expect(after.atoms[0]).toMatchObject({ id: "s", element: "SH", formalCharge: 0 });
    expect(after.bonds).toEqual(before.bonds);
    expect(after.chemistry?.formula).toBe("CH4OS");
    expect(Molecule.fromSmiles(after.structure).toSmiles()).toBe(Molecule.fromSmiles("C[SH]=O").toSmiles());
    await press("z", { metaKey: platform === "macos", ctrlKey: platform === "windows" });
    expect(molecule()).toEqual(before);
    await press("z", { shiftKey: true, metaKey: platform === "macos", ctrlKey: platform === "windows" });
    expect(molecule()).toEqual(after);
  });
});
