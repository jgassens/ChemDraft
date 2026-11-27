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
    saveKeybindingSettings({ scheme: "chemdraw" });
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

  it("retypes the RuMACHO PH arm as PPh2 and commits when focus returns to the canvas", async () => {
    const seed = insertNativeSingleBondMolecule(createPhase4Document("RuMACHO"), { x: 300, y: 300 });
    const original = seed.pages[0].objects[0] as MoleculeObject;
    const source = { id: "p1", element: "PH", labelLiteral: true, x: 278, y: 316 };
    const atoms = [source,
      { id: "c1", element: "C", x: 258, y: 308 }, { id: "c2", element: "C", x: 258, y: 284 },
      { id: "n", element: "NH", labelLiteral: true, x: 278, y: 274 },
      { id: "c3", element: "C", x: 294, y: 256 }, { id: "c4", element: "C", x: 317, y: 260 },
      { id: "p2", element: "PH", labelLiteral: true, x: 330, y: 281 },
      { id: "ru", element: "Ru", x: 300, y: 302 }, { id: "h", element: "H", x: 300, y: 326 },
      { id: "c5", element: "C", x: 326, y: 316, formalCharge: -1 }, { id: "o", element: "O", x: 348, y: 328, formalCharge: 1 }
    ].map(atom => ({ formalCharge: 0, ...atom }));
    const bonds = [
      ["p1", "c1"], ["c1", "c2"], ["c2", "n"], ["n", "c3"], ["c3", "c4"], ["c4", "p2"],
      ["ru", "h"], ["ru", "c5", "dashed"], ["c5", "o", "triple"],
      ["p1", "ru", "dashed"], ["n", "ru", "dashed"], ["p2", "ru", "dashed"]
    ].map(([fromAtomId, toAtomId, style], index) => ({
      id: `bond${index + 1}`, fromAtomId, toAtomId, order: style === "triple" ? "triple" as const : "single" as const,
      ...(style === "dashed" ? { display: { bondStyle: "dashed" as const } } : {})
    }));
    const initial = applyPatches(seed, [{ op: "updateObject", objectId: original.id, changes: { atoms, bonds } }]);
    await act(async () => root.render(createElement(MainWindow, {
      initialActiveToolCommandId: "tool.atom", initialCrosshairsVisible: false,
      initialDocument: selectDocumentObjects(initial, initial.pages[0].id, []),
      initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: true, shortcutPlatform: platform
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    await act(async () => canvas.focus());
    const before = molecule();
    await act(async () => {
      const event = new MouseEvent("pointerdown", {
        bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: source.x, clientY: source.y, detail: 1
      });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector(".native-molecule-object")!.dispatchEvent(event);
    });
    const input = container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]')!;
    expect(input.dataset.atomId).toBe(source.id);
    expect(document.activeElement).toBe(input);
    for (const draft of ["P", "PP", "PPh", "PPh2"]) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, draft);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(input.value).toBe(draft);
    }
    // Focus stays in the document during the transfer, even though jsdom clears activeElement during blur.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await act(async () => canvas.focus());
    expect(document.activeElement).toBe(canvas);
    expect(container.querySelector('[data-atom-label-editor="true"]')).toBeNull();
    const after = molecule();
    expect(after.atoms.map(atom => atom.id)).toEqual(before.atoms.map(atom => atom.id));
    expect(after.atoms.find(atom => atom.id === source.id)).toMatchObject({ element: "PPh2", formalCharge: 0 });
    expect(after.bonds).toEqual(before.bonds);
    expect(after.chemistry?.formula).toBe("C17H21NOP2Ru");
    const expected = "[Ru]12([H])([C-]#[O+])P(CC[NH]1CC[PH]2)(c1ccccc1)c1ccccc1";
    expect(Molecule.fromSmiles(after.structure).getIDCode()).toBe(Molecule.fromSmiles(expected).getIDCode());
    const modifiers = { metaKey: platform === "macos", ctrlKey: platform === "windows" };
    await press("z", modifiers);
    expect(molecule()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    await press("z", { ...modifiers, shiftKey: true });
    expect(molecule()).toEqual(after);
  });

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
      .toContain(`Cannot relabel 13C as ${entry === "editor" ? "SH" : "Ph"}: the label cannot keep isotope 13; clear the isotope first to relabel`);
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

  it("commits SH through the Text tool, with one undo entry", async () => {
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
        initialActiveToolCommandId: "tool.text",
        initialCrosshairsVisible: false,
        initialDocument: selectDocumentObjects(initial, initial.pages[0].id, []),
        initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: true
      }));
    });
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
    const before = molecule();
    await act(async () => {
      const event = new MouseEvent("pointerdown", {
        bubbles: true, cancelable: true, button: 0, buttons: 1,
        clientX: 300, clientY: 300, detail: 1
      });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector<HTMLElement>(`[data-object-id="${original.id}"]`)!.dispatchEvent(event);
    });
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
