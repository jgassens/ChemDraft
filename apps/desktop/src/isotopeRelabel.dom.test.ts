// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type MoleculeObject } from "@chemdraft/chem-core";
import {
  createSmilesMolecule, nativeAtomValidationState, pastedStructureDepictionFromMolfile
} from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe.each(["macos", "windows"] as const)("isotope relabel history (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    saveKeybindingSettings({ scheme: "chemdraft" });
    Object.defineProperty(navigator, "platform", {
      configurable: true, value: platform === "macos" ? "MacIntel" : "Win32"
    });
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let initial = createPhase4Document("Isotope relabel");
    for (const [smiles, point] of [
      ["[13CH3]c1ccccc1", { x: 250, y: 200 }],
      ["CCCC", { x: 500, y: 400 }]
    ] as const) {
      const depiction = pastedStructureDepictionFromMolfile(depictSmiles2D(smiles).molfile);
      const object = createSmilesMolecule(initial, point, depiction, smiles);
      initial = applyPatches(initial, [{ op: "addObject", pageId: initial.pages[0].id, object }]);
    }
    initial = selectDocumentObjects(initial, initial.pages[0].id, []);
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.text",
        initialCrosshairsVisible: false,
        initialDocument: initial,
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });
    const rect = {
      x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612,
      width: 792, height: 612, toJSON: () => ({})
    };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      element.getBoundingClientRect = () => rect;
    }
    expect(molecule(0).atoms[0]).toMatchObject({ element: "C", isotope: 13 });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    saveKeybindingSettings({ scheme: "chemdraft" });
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  });

  function snapshot() {
    return window.__CHEMDRAFT_AGENT__!.snapshot();
  }

  function molecule(index: number): MoleculeObject {
    const object = snapshot().document.pages[0].objects[index];
    if (object?.type !== "molecule") throw new Error("Expected molecule");
    return object;
  }

  function editor() {
    return container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
  }

  async function openEditor(index: number) {
    const object = molecule(index);
    const atom = object.atoms[0]!;
    const wrapper = container.querySelector<HTMLElement>(`[data-object-id="${object.id}"]`)!;
    await act(async () => {
      const event = new MouseEvent("pointerdown", {
        bubbles: true, cancelable: true, button: 0, buttons: 1,
        clientX: atom.x, clientY: atom.y, detail: 1
      });
      Object.defineProperties(event, {
        pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true }
      });
      wrapper.dispatchEvent(event);
    });
    expect(snapshot().activeToolCommandId).toBe("tool.text");
    expect(editor()?.getAttribute("data-atom-id")).toBe(atom.id);
    expect(document.activeElement).toBe(editor());
  }

  async function typeLabel(value: string) {
    const input = editor()!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function press(key: string) {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", {
        key, bubbles: true, cancelable: true
      }));
    });
  }

  async function history(redo = false) {
    await act(async () => {
      container.querySelector<HTMLElement>(".page")!.dispatchEvent(new KeyboardEvent("keydown", {
        key: "z", bubbles: true, cancelable: true, shiftKey: redo,
        metaKey: platform === "macos", ctrlKey: platform === "windows"
      }));
    });
  }

  async function relabel(index: number, label: string) {
    await openEditor(index);
    await typeLabel(label);
    await press("Enter");
    expect(editor()).toBeNull();
  }

  function expectNoUndo() {
    expect(container.querySelector("[data-can-undo]")?.getAttribute("data-can-undo")).toBe("false");
  }

  it("undoes the isotope relabel and separate D label once each, and redoes both", async () => {
    const before = [molecule(0), molecule(1)];
    await relabel(1, "D");
    const withD = molecule(1);
    expect(withD.atoms[0]).toMatchObject({ element: "D", labelLiteral: true });
    expect(withD.atoms[0]).not.toHaveProperty("isotope");
    expect(molecule(0)).toEqual(before[0]);
    await relabel(0, "N");
    const withN = molecule(0);
    expect(withN.atoms[0]).toMatchObject({ element: "N", labelLiteral: true });
    expect(withN.atoms[0]).not.toHaveProperty("isotope");
    expect(nativeAtomValidationState(withN.atoms[0]!, withN.bonds, 0, withN.atoms).valid).toBe(false);
    await history();
    expect(molecule(0)).toEqual(before[0]);
    expect(molecule(1)).toEqual(withD);
    await history();
    expect([molecule(0), molecule(1)]).toEqual(before);
    expectNoUndo();
    await history(true);
    expect(molecule(0)).toEqual(before[0]);
    expect(molecule(1)).toEqual(withD);
    await history(true);
    expect(molecule(0)).toEqual(withN);
    expect(molecule(1)).toEqual(withD);
  });

  it.each(["Escape", "Enter"])("opening and closing with %s keeps the isotope and history", async key => {
    const before = molecule(0);
    await openEditor(0);
    expect(molecule(0)).toEqual(before);
    await press(key);
    expect(editor()).toBeNull();
    expect(molecule(0)).toEqual(before);
    expectNoUndo();
    await history(true);
    expect(molecule(0)).toEqual(before);
    expect(container.querySelector("[data-can-redo]")?.getAttribute("data-can-redo")).toBe("false");
  });

  it("restores the isotope when cancelling a different draft label", async () => {
    const before = molecule(0);
    await openEditor(0);
    await typeLabel("N");
    await press("Escape");
    expect(molecule(0)).toEqual(before);
    expectNoUndo();
  });

  it("keeps carbon-13 when C is explicitly retyped", async () => {
    await relabel(0, "C");
    expect(molecule(0).atoms[0]).toMatchObject({ element: "C", isotope: 13, labelLiteral: true });
  });

  it.each(["D", "T"])("relabels carbon-13 to %s in one reversible step", async label => {
    const before = molecule(0);
    await relabel(0, label);
    const after = molecule(0);
    expect(after.atoms[0]).toMatchObject({ element: label, labelLiteral: true });
    expect(after.atoms[0]).not.toHaveProperty("isotope");
    expect(after.chemistry?.isotopeLabels).toEqual([label === "D" ? "2H" : "3H"]);
    await history();
    expect(molecule(0)).toEqual(before);
    expectNoUndo();
    await history(true);
    expect(molecule(0)).toEqual(after);
  });

  it("hover-relabels carbon-13 to natural-abundance NH2 in one reversible step", async () => {
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("tool.bond"); });
    const before = molecule(0);
    const atom = before.atoms[0]!;
    await act(async () => {
      const event = new MouseEvent("pointermove", {
        bubbles: true, clientX: atom.x, clientY: atom.y, buttons: 0
      });
      Object.defineProperties(event, {
        pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true }
      });
      container.querySelector<HTMLElement>(".page")!.dispatchEvent(event);
    });
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "atom", atomId: atom.id });
    await press("N");
    const after = molecule(0);
    expect(after.atoms[0]).toMatchObject({ element: "N" });
    expect(after.atoms[0]).not.toHaveProperty("isotope");
    expect(after.atoms[0]!.labelLiteral).not.toBe(true);
    expect(after.chemistry?.formula).toBe("C6H7N");
    expect(after.chemistry?.isotopeLabels).toEqual([]);
    expect(nativeAtomValidationState(after.atoms[0]!, after.bonds, 0, after.atoms).valid).toBe(true);
    expect(editor()).toBeNull();
    await history();
    expect(molecule(0)).toEqual(before);
    expectNoUndo();
    await history(true);
    expect(molecule(0)).toEqual(after);
  });
});
