// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTemplateMolecule, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("hover label typing", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    saveKeybindingSettings({ scheme: "chemdraft" });
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

  async function press(key: string, target: EventTarget = document.activeElement ?? document.body) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(event); });
    // jsdom dispatches real focus/blur and key events but has no browser text-editing default.
    // Apply that default only when the key actually landed in the focused editor and was allowed.
    if (!event.defaultPrevented && target instanceof HTMLInputElement && (key.length === 1 || key === "Backspace")) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      const from = key === "Backspace" && start === end ? Math.max(0, start - 1) : start;
      const value = target.value.slice(0, from) + (key === "Backspace" ? "" : key) + target.value.slice(end);
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
        target.dispatchEvent(new Event("input", { bubbles: true }));
        const caret = from + (key === "Backspace" ? 0 : key.length);
        target.setSelectionRange(caret, caret);
      });
    }
  }

  function expectIntact() {
    expect(snapshot().activeToolCommandId).toBe("tool.bond");
    expect(snapshot().document.pages[0].objects).toHaveLength(1);
    expect(molecule().atoms).toHaveLength(6);
    expect(molecule().bonds).toHaveLength(6);
  }

  it.each(["OMe", "OEt", "CF3", "NO2", "OBn", "CH3"])("types %s through the existing label editor without erasing", async (label) => {
    const before = molecule();
    await hover(0);
    await press(label[0]!);
    expect(molecule().atoms[0]!.element).toBe(label[0]);
    expect(editor()).toBeNull(); // Single-letter assignment is still immediate.
    await press(label[1]!);
    expect(editor()?.value).toBe(label.slice(0, 2));
    expect(document.activeElement).toBe(editor());
    expect(editor()?.selectionStart).toBe(2);
    for (const key of label.slice(2)) {
      await press(key);
      expectIntact();
    }
    await press("Enter");
    expect(editor()).toBeNull();
    expect(molecule().atoms[0]).toMatchObject({ element: label, labelLiteral: true });
    expect(molecule().bonds).toEqual(before.bonds);
    expect(molecule().atoms.map(({ id, x, y, formalCharge }) => ({ id, x, y, formalCharge })))
      .toEqual(before.atoms.map(({ id, x, y, formalCharge }) => ({ id, x, y, formalCharge })));
    expectIntact();
  });

  it("assigns N to atom A then O to atom B instantly", async () => {
    await hover(0);
    await press("N");
    expect(molecule().atoms[0]!.element).toBe("N");
    await hover(1);
    await press("O");
    expect(molecule().atoms[0]!.element).toBe("N");
    expect(molecule().atoms[1]!.element).toBe("O");
    expect(editor()).toBeNull();
    expectIntact();
  });

  it("Backspace edits the continuation text and deletes no object", async () => {
    await hover(0);
    await press("O");
    await press("M");
    await press("e");
    await press("Backspace");
    expect(editor()?.value).toBe("OM");
    expect(molecule().atoms[0]!.element).toBe("OM");
    await press("e");
    expect(editor()?.value).toBe("OMe");
    expectIntact();
  });

  it("Escape cancels continuation and retains the first instant assignment", async () => {
    await hover(0);
    await press("O");
    await press("M");
    await press("e");
    await press("Escape");
    expect(editor()).toBeNull();
    expect(molecule().atoms[0]).toMatchObject({ element: "O" });
    expect(molecule().atoms[0]!.labelLiteral).not.toBe(true);
    expectIntact();
  });

  it("keeps an unrelated hover key's tool shortcut", async () => {
    await hover(0);
    await press("e");
    expect(snapshot().activeToolCommandId).toBe("tool.eraser");
    expect(molecule().atoms).toHaveLength(6);
    expect(editor()).toBeNull();
  });

  // A bond of `atomIndex` and a point along it, `fraction` of the way from that atom to the other end.
  async function hoverBond(atomIndex: number, fraction: number) {
    const current = molecule();
    const atom = current.atoms[atomIndex]!;
    const bond = current.bonds.find((candidate) => candidate.fromAtomId === atom.id || candidate.toAtomId === atom.id)!;
    const other = current.atoms.find((candidate) => candidate.id === (bond.fromAtomId === atom.id ? bond.toAtomId : bond.fromAtomId))!;
    const page = container.querySelector<HTMLElement>(".page")!;
    const point = { x: atom.x + (other.x - atom.x) * fraction, y: atom.y + (other.y - atom.y) * fraction };
    await act(async () => {
      const event = new MouseEvent("pointermove", { bubbles: true, clientX: point.x, clientY: point.y, buttons: 0 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      page.dispatchEvent(event);
    });
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
    return { bond, near: atom, far: other };
  }

  it("types a label over a bond onto the bond's nearer atom, not into tool shortcuts", async () => {
    const { bond, near, far } = await hoverBond(0, 0.4);
    await press("O");
    expect(molecule().atoms.find((atom) => atom.id === near.id)!.element).toBe("O");
    await press("M");
    await press("e");
    expectIntact();
    await press("Enter");
    expect(molecule().atoms.find((atom) => atom.id === near.id)).toMatchObject({ element: "OMe", labelLiteral: true });
    expect(molecule().atoms.find((atom) => atom.id === far.id)!.element).toBe("C");
    expect(molecule().bonds.find((candidate) => candidate.id === bond.id)!.order).toBe(bond.order);
    expectIntact();
  });

  it("labels the end of the bond nearer the pointer", async () => {
    const { near, far } = await hoverBond(0, 0.6);
    await press("N");
    expect(molecule().atoms.find((atom) => atom.id === far.id)!.element).toBe("N");
    expect(molecule().atoms.find((atom) => atom.id === near.id)!.element).toBe("C");
    expectIntact();
  });

  it("keeps a label going when the pointer drifts onto the labelled atom's own bond", async () => {
    await hover(0);
    await press("O");
    const { bond } = await hoverBond(0, 0.45);
    await press("M");
    expect(editor()?.value).toBe("OM");
    await press("e");
    await press("Enter");
    expect(molecule().atoms[0]).toMatchObject({ element: "OMe", labelLiteral: true });
    expect(molecule().bonds.find((candidate) => candidate.id === bond.id)!.order).toBe(bond.order);
    expectIntact();
  });

  it("keeps a digit in the label, not the bond order, when drifting onto the atom's own bond", async () => {
    await hover(0);
    await press("N");
    const { bond } = await hoverBond(0, 0.45);
    await press("2");
    expect(editor()?.value).toBe("N2");
    expect(molecule().bonds.find((candidate) => candidate.id === bond.id)!.order).toBe(bond.order);
    expectIntact();
  });

  it("over a bond, a bare non-element letter keeps its tool shortcut and a digit its bond order", async () => {
    const { bond } = await hoverBond(0, 0.5);
    await press("2");
    expect(molecule().bonds.find((candidate) => candidate.id === bond.id)!.order).toBe("double");
    expect(editor()).toBeNull();
    await hoverBond(0, 0.5);
    await press("e");
    expect(snapshot().activeToolCommandId).toBe("tool.eraser");
    expect(molecule().atoms).toHaveLength(6);
  });

  it("does not continue after the pointer leaves and returns to the same atom", async () => {
    await hover(0);
    await press("N");
    await hover(1);
    await hover(0);
    await press("O");
    expect(molecule().atoms[0]!.element).toBe("O");
    expect(editor()).toBeNull();
    expectIntact();
  });

  it("resets label continuation when the hovered atom is pressed", async () => {
    await hover(0);
    await press("O");
    const atom = molecule().atoms[0]!;
    const wrapper = container.querySelector<HTMLElement>(`[data-object-id="${molecule().id}"]`)!;
    wrapper.setPointerCapture = () => {};
    wrapper.releasePointerCapture = () => {};
    wrapper.hasPointerCapture = () => false;
    await act(async () => {
      const event = new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        cancelable: true,
        clientX: atom.x,
        clientY: atom.y
      });
      Object.defineProperties(event, { pointerId: { value: 8 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      wrapper.dispatchEvent(event);
    });

    await press("e", window);
    expect(editor()).toBeNull();
    expect(snapshot().activeToolCommandId).toBe("tool.eraser");
  });

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

  it("blocks canvas hotkeys while the open editor has no focus", async () => {
    await hover(0);
    await press("O");
    await press("M");
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await act(async () => { editor()!.blur(); });
    hasFocus.mockRestore();
    expect(document.activeElement).not.toBe(editor());
    for (const key of ["e", "Backspace", "Delete", "Escape", "N"]) {
      await press(key, window);
      expect(editor()?.value).toBe("OM");
      expectIntact();
    }
  });

  it("blocks hotkeys before the continuation input takes its first focus", async () => {
    await hover(0);
    await press("O");
    vi.spyOn(HTMLInputElement.prototype, "focus").mockImplementation(() => {});
    await press("M");
    expect(editor()?.value).toBe("OM");
    expect(document.activeElement).not.toBe(editor());
    await press("e", window);
    await press("Backspace", window);
    await press("Delete", window);
    expect(editor()?.value).toBe("OM");
    expectIntact();
  });

  it("allows Shift between the first letter and continuation", async () => {
    await hover(0);
    await press("O");
    await press("Shift");
    await press("M");
    await press("e");
    expect(editor()?.value).toBe("OMe");
    expectIntact();
  });
});
