// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule, pastedStructureDepictionFromMolfile } from "@chemdraft/document-workflow-core";
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

// Relabelling an existing atom with an element and its charge ("Zn2+") through the atom label
// editor sets that element and exactly that charge, as the same text in a free text box does; one
// undo and a cancel both put back the element and the charge the atom had.
describe.each(["macos", "windows"] as const)("relabel an atom with a typed charge (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    saveKeybindingSettings({ scheme: "chemdraw" });
    Object.defineProperty(navigator, "platform", {
      configurable: true, value: platform === "macos" ? "MacIntel" : "Win32"
    });
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let initial = createPhase4Document("Charged relabel");
    for (const [smiles, point] of [
      ["CCCC", { x: 250, y: 200 }],
      ["NCCC", { x: 500, y: 400 }],
      ["C[N+](C)(C)C", { x: 250, y: 450 }],
      ["CC", { x: 550, y: 150 }]
    ] as const) {
      const depiction = pastedStructureDepictionFromMolfile(depictSmiles2D(smiles).molfile);
      const object = createSmilesMolecule(initial, point, depiction, smiles);
      initial = applyPatches(initial, [{ op: "addObject", pageId: initial.pages[0].id, object }]);
    }
    // An atom an older build stored with the charge inside its element string, as the relabel bug did.
    const legacy = initial.pages[0].objects[3] as MoleculeObject;
    initial = applyPatches(initial, [{ op: "updateObject", objectId: legacy.id, changes: {
      atoms: legacy.atoms.map((atom, index) => index === 0 ? { ...atom, element: "Zn2+", labelLiteral: true } : atom)
    } }]);
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
    expect(molecule(0).atoms[0]).toMatchObject({ element: "C", formalCharge: 0 });
    expect(molecule(1).atoms[0]).toMatchObject({ element: "N", formalCharge: 0 });
    expect(chargedNitrogen()).toMatchObject({ element: "N", formalCharge: 1 });
    expect(molecule(3).atoms[0]).toMatchObject({ element: "Zn2+", formalCharge: 0 });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    saveKeybindingSettings({ scheme: "chemdraw" });
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

  function chargedNitrogen() {
    return molecule(2).atoms.find(atom => atom.element === "N");
  }

  function editor() {
    return container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
  }

  async function openEditor(index: number, atomId = molecule(index).atoms[0]!.id) {
    const object = molecule(index);
    const atom = object.atoms.find(candidate => candidate.id === atomId)!;
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

  /** Types the label one character at a time, as a keyboard does: "Z", "Zn", "Zn2", "Zn2+". */
  async function typeLabel(value: string) {
    const characters = Array.from(value);
    for (let length = 1; length <= characters.length; length += 1) {
      const input = editor()!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, characters.slice(0, length).join(""));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
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

  function expectNoUndo() {
    expect(container.querySelector("[data-can-undo]")?.getAttribute("data-can-undo")).toBe("false");
  }

  it("relabels a carbon to Zn2+ as zinc with charge +2, undone in one step and redone", async () => {
    const before = molecule(0);
    await openEditor(0);
    await typeLabel("Zn2+");
    await press("Enter");
    expect(editor()).toBeNull();
    const after = molecule(0);
    expect(after.atoms[0]).toMatchObject({ element: "Zn", formalCharge: 2, labelLiteral: true });
    expect(after.atoms.filter(atom => atom.element === "Zn2+")).toEqual([]);
    expect(after.atoms).toHaveLength(before.atoms.length);
    await history();
    expect(molecule(0)).toEqual(before);
    expect(molecule(0).atoms[0]).toMatchObject({ element: "C", formalCharge: 0 });
    expectNoUndo();
    await history(true);
    expect(molecule(0)).toEqual(after);
  });

  it.each([
    ["Zn+2", "Zn", 2], ["Fe3+", "Fe", 3], ["Cl-", "Cl", -1], ["Na+", "Na", 1],
    ["Zn²⁺", "Zn", 2], ["Cl−", "Cl", -1]
  ] as const)("relabels a carbon typed %s as %s with charge %d", async (label, element, charge) => {
    await openEditor(0);
    await typeLabel(label);
    await press("Enter");
    expect(molecule(0).atoms[0]).toMatchObject({ element, formalCharge: charge });
  });

  it("relabels N to N+ as nitrogen with charge +1", async () => {
    const before = molecule(1);
    await openEditor(1);
    await typeLabel("N+");
    await press("Enter");
    expect(editor()).toBeNull();
    expect(molecule(1).atoms[0]).toMatchObject({ element: "N", formalCharge: 1 });
    await history();
    expect(molecule(1)).toEqual(before);
    expectNoUndo();
  });

  it("cancelling a Zn2+ draft restores the carbon and its charge", async () => {
    const before = molecule(0);
    await openEditor(0);
    await typeLabel("Zn2+");
    // The draft previews the typed atom, charge included.
    expect(molecule(0).atoms[0]).toMatchObject({ element: "Zn", formalCharge: 2 });
    await press("Escape");
    expect(editor()).toBeNull();
    expect(molecule(0)).toEqual(before);
    expectNoUndo();
  });

  it("a draft whose charge is deleted again keeps the starting charge", async () => {
    await openEditor(0);
    await typeLabel("Zn2+");
    const input = editor()!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Zn");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(molecule(0).atoms[0]).toMatchObject({ element: "Zn", formalCharge: 0 });
    await press("Enter");
    expect(molecule(0).atoms[0]).toMatchObject({ element: "Zn", formalCharge: 0 });
  });

  it("an uncharged label over N+ keeps its charge, and cancelling a charged draft restores +1", async () => {
    const before = molecule(2);
    const nitrogen = chargedNitrogen()!;
    await openEditor(2, nitrogen.id);
    await typeLabel("N-");
    expect(molecule(2).atoms.find(atom => atom.id === nitrogen.id)).toMatchObject({ element: "N", formalCharge: -1 });
    await press("Escape");
    expect(molecule(2)).toEqual(before);
    expectNoUndo();
    await openEditor(2, nitrogen.id);
    await typeLabel("P");
    await press("Enter");
    expect(molecule(2).atoms.find(atom => atom.id === nitrogen.id)).toMatchObject({ element: "P", formalCharge: 1 });
  });

  it("keeps an unknown or formula label as typed text with the charge unchanged", async () => {
    await openEditor(1);
    await typeLabel("NH4+");
    await press("Enter");
    const atom = molecule(1).atoms[0]!;
    expect(atom.formalCharge).toBe(0);
    expect(atom.element).not.toBe("N");
  });

  it.each(["Enter", "Escape"])("leaves an older document's element 'Zn2+' as stored when its label is opened and closed with %s", async key => {
    const before = molecule(3);
    await openEditor(3);
    await press(key);
    expect(editor()).toBeNull();
    expect(molecule(3)).toEqual(before);
    expectNoUndo();
  });

  it("retyping an older document's 'Zn2+' label key by key makes it zinc with charge +2", async () => {
    await openEditor(3);
    await typeLabel("Zn2+");
    await press("Enter");
    expect(molecule(3).atoms[0]).toMatchObject({ element: "Zn", formalCharge: 2 });
  });
});
