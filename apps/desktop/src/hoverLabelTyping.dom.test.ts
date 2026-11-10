// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, serializeDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
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
    saveKeybindingSettings({ scheme: "chemdraft" });
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

  it.each(["M", "e"])("keeps OMe on the first atom after drifting to its neighbour before %s", async driftBefore => {
    const before = molecule();
    await hoverAtom(0);
    await press("O");
    if (driftBefore === "M") await hoverAtom(1);
    await press("M");
    expect(editor()?.value).toBe("OM");
    if (driftBefore === "e") await hoverAtom(1);
    await press("e");
    expect(editor()?.value).toBe("OMe");
    expect(snapshot().activeToolCommandId).toBe("tool.bond");
    await press("Enter");
    expect(molecule().atoms).toEqual([{ ...before.atoms[0], element: "OMe", labelLiteral: true }, before.atoms[1]]);
    expect(molecule().bonds).toEqual(before.bonds);
    expect(snapshot().activeToolCommandId).toBe("tool.bond");
    expect(editor()).toBeNull();
  });

  it("commits OMe before routing N to the neighbouring atom in the same molecule", async () => {
    const before = molecule();
    await hoverAtom(0);
    await typeLabel("OMe");
    await hoverAtom(1);
    await press("N");
    const after = molecule();
    expect(after.atoms).toEqual([
      { ...before.atoms[0], element: "OMe", labelLiteral: true },
      { ...before.atoms[1], element: "N" }
    ]);
    expect(after.bonds).toEqual(before.bonds);
    expect(snapshot().activeToolCommandId).toBe("tool.bond");
    expect(editor()).toBeNull();
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
    expect(molecule().atoms).toEqual([after.atoms[0], before.atoms[1]]);
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
    expect(molecule()).toEqual(before);
  });

  it("keeps an isotope refusal and does not replay the key or add an undo entry", async () => {
    const seed = snapshot().document;
    const original = molecule();
    const sulfur = { ...original.atoms[0]!, element: "S", isotope: 34 };
    const oxygen = { ...original.atoms[1]!, id: "oxygen-test", element: "O", x: sulfur.x, y: sulfur.y - 40 };
    const initial = applyPatches(seed, [{ op: "updateObject", objectId: original.id, changes: {
      atoms: [sulfur, original.atoms[1]!, oxygen],
      bonds: [...original.bonds, { id: "oxygen-bond-test", fromAtomId: sulfur.id, toAtomId: oxygen.id, order: "double" }]
    } }]);
    await remountDocument(initial);
    const before = molecule();
    await hoverAtom(0);
    await typeLabel("SH");
    await hoverAtom(1);
    await press("N");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Cannot relabel 34S as SH: the label cannot keep isotope 34; clear the isotope first to relabel");
    expect(molecule()).toEqual(before);
    expect(editor()).toBeNull();
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
    expect(molecule()).toEqual(before);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Nothing to undo");
  });

  it("preserves a successful relabel warning before the replay status", async () => {
    const seed = snapshot().document;
    const original = molecule();
    const extra = { ...original.atoms[1]!, id: "extra-carbon-test", x: original.atoms[0]!.x, y: original.atoms[0]!.y - 40 };
    const initial = applyPatches(seed, [{ op: "updateObject", objectId: original.id, changes: {
      atoms: [...original.atoms, extra],
      bonds: [...original.bonds.map(bond => ({ ...bond, order: "triple" as const })),
        { id: "extra-bond-test", fromAtomId: original.atoms[0]!.id, toAtomId: extra.id, order: "single" }]
    } }]);
    await remountDocument(initial);
    await hoverAtom(0);
    await typeLabel("OMe");
    await hoverAtom(1);
    await press("N");
    expect(molecule().atoms[0]).toMatchObject({ element: "OMe", labelLiteral: true });
    expect(molecule().atoms[1]).toMatchObject({ element: "N" });
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/Relabeled OMe: .+Set hovered atom to N/);
  });

  it("shows a successful relabel warning once when the replay sets no status", async () => {
    const seed = snapshot().document;
    const original = molecule();
    const extra = { ...original.atoms[1]!, id: "extra-carbon-test", x: original.atoms[0]!.x, y: original.atoms[0]!.y - 40 };
    const initial = applyPatches(seed, [{ op: "updateObject", objectId: original.id, changes: {
      atoms: [...original.atoms, extra],
      bonds: [...original.bonds.map(bond => ({ ...bond, order: "triple" as const })),
        { id: "extra-bond-test", fromAtomId: original.atoms[0]!.id, toAtomId: extra.id, order: "single" }]
    } }]);
    await remountDocument(initial);
    await hoverAtom(0);
    await typeLabel("OMe");
    await hoverAtom(1);
    // Consume the replay at the canvas so no shortcut can set a new status.
    const replay = vi.fn((event: Event) => event.stopPropagation());
    container.querySelector(".canvas-region")!.addEventListener("keydown", replay, { once: true });
    await press("N");
    expect(replay).toHaveBeenCalledOnce();
    expect((replay.mock.calls[0]![0] as KeyboardEvent).key).toBe("N");
    expect(molecule().atoms[0]).toMatchObject({ element: "OMe", labelLiteral: true });
    expect(molecule().atoms[1]).toEqual(original.atoms[1]);
    expect(editor()).toBeNull();
    const status = container.querySelector('[role="status"]')?.textContent ?? "";
    expect(status).toMatch(/^Relabeled OMe: /);
    expect(status.match(/Relabeled OMe:/g)).toHaveLength(1);
  });

  describe.each(["isComposing", "ctrlKey", "metaKey", "altKey"] as const)("hover handoff guard %s", guard => {
    it.each(["N", "5"])("leaves the editor open for %s over a neighbouring atom", async key => {
      await hoverAtom(0);
      await typeLabel("OMe");
      await hoverAtom(1);
      const before = snapshot().document;
      const input = editor()!;
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, [guard]: true });
      // Dispatch only the key: composition/text defaults belong to the input and browser.
      await act(async () => { input.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
      expect(editor()).toBe(input);
      expect(input.value).toBe("OMe");
      expect(document.activeElement).toBe(input);
      expect(snapshot().document).toEqual(before);
      expect(snapshot().activeToolCommandId).toBe("tool.bond");
      // The same target still accepts a plain element key once the guard is gone.
      await press("N");
      expect(editor()).toBeNull();
      expect(molecule().atoms.map(atom => atom.element)).toEqual(["OMe", "N"]);
    });
  });

  it.each([["OMe", "N", "N"], ["CF3", "o", "O"]])(
    "commits hover %s before routing %s to another ethane as %s",
    async (label, key, element) => {
      await addEthanes();
      const before = molecule();
      const other = molecule(1);
      await hoverAtom(0);
      await typeLabel(label);
      await hoverAtom(0, 1);
      await press(key);
      expect(molecule().atoms).toEqual([{ ...before.atoms[0], element: label, labelLiteral: true }, before.atoms[1]]);
      expect(molecule().bonds).toEqual(before.bonds);
      expect(molecule(1).atoms).toEqual([{ ...other.atoms[0], element }, other.atoms[1]]);
      expect(molecule(1).bonds).toEqual(other.bonds);
      expect(editor()).toBeNull();
      // Each action owns one undo entry, and the handoff key runs only once.
      await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
      expect(molecule().atoms[0]!.element).toBe(label);
      expect(molecule(1)).toEqual(other);
      await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
      expect(molecule()).toEqual(before);
    }
  );

  it("commits OMe before dispatching digit 5 on another ethane just as without a pending label", async () => {
    await addEthanes();
    await hoverAtom(0);
    await typeLabel("OMe");
    await hoverAtom(0, 1);
    await press("5");
    expect(editor()).toBeNull();
    expect(molecule().atoms[0]).toMatchObject({ element: "OMe", labelLiteral: true });
    const after = molecule(1);
    const labelled = molecule();
    const activeTool = snapshot().activeToolCommandId;
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
    expect(molecule()).toEqual(labelled);
    const beforeDigit = snapshot().document;
    await remountDocument(beforeDigit);
    await hoverAtom(0, 1);
    await press("5");
    expect(molecule(1)).toEqual(after);
    expect(snapshot().activeToolCommandId).toBe(activeTool);
    expect(editor()).toBeNull();
  });

  it("keeps OMe, CF3 and NO2 separate when typed over three ethanes", async () => {
    await addEthanes(2);
    for (const [index, label] of ["OMe", "CF3", "NO2"].entries()) {
      await hoverAtom(0, index);
      await typeLabel(label);
    }
    await press("Enter");
    expect([0, 1, 2].map(index => molecule(index).atoms[0]!.element)).toEqual(["OMe", "CF3", "NO2"]);
    expect(editor()).toBeNull();
  });

  it.each(["empty canvas", "own bond", "another bond"])("continues a multi-letter hover label over %s", async target => {
    await addEthanes();
    const other = molecule(1);
    await hoverAtom(0);
    await typeLabel("OM");
    if (target === "empty canvas") await hoverPoint({ x: 650, y: 450 });
    else await hoverBond(target === "own bond" ? 0 : 1);
    await press("e");
    expect(editor()?.value).toBe("OMe");
    await press("Enter");
    expect(molecule().atoms[0]).toMatchObject({ element: "OMe", labelLiteral: true });
    expect(molecule(1)).toEqual(other);
  });

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

  it.each(["o", "O"])("relabels the current atom for second key %s after moving from the first oxygen", async key => {
    const before = molecule();
    await hoverRelabel();
    const oxygen = molecule().atoms[0]!;
    await hoverAtom(1);
    await press(key);
    expect(molecule().atoms).toEqual([oxygen, { ...before.atoms[1], element: "O" }]);
    expect(molecule().bonds).toEqual(before.bonds);
    expect(molecule().chemistry?.formula).toBe("H2O2");
    expect(editor()).toBeNull();
  });

  it.each([
    ["N", "o", "O"],
    ["C", "o", "O"],
    ["S", "n", "N"],
    ["S", "i", "I"],
    ["c", "o", "O"],
    ["N", "O", "O"],
    ["S", "N", "N"]
  ])("routes %s then %s onto a neighbour as %s instead of completing the first label", async (first, second, element) => {
    const before = molecule();
    await hoverAtom(0);
    await press(first);
    const labelled = molecule().atoms[0]!;
    expect(labelled.element).toBe(first.toUpperCase());
    await hoverAtom(1);
    await press(second);
    expect(molecule().atoms).toEqual([labelled, { ...before.atoms[1], element }]);
    expect(molecule().bonds).toEqual(before.bonds);
    expect(editor()).toBeNull();
  });

  describe.each(["empty canvas", "non-own bond"])("element completion over %s", target => {
    it.each([
      ["S", "i", "Si"],
      ["C", "l", "Cl"],
      ["B", "r", "Br"]
    ])("continues %s with lowercase %s to form %s", async (first, second, symbol) => {
      await remountDocument(insertNativeSingleBondMolecule(snapshot().document, { x: 450, y: 300 }));
      const before = molecule();
      const other = molecule(1);
      await hoverAtom(0);
      await press(first);
      if (target === "non-own bond") {
        await hoverBond(1);
      } else {
        await hoverPoint({ x: 650, y: 450 });
        expect(snapshot().hoveredNativeTarget).toBeUndefined();
      }
      await press(second);
      expect(editor()?.value).toBe(symbol);
      await press("Enter");
      expect(molecule().atoms).toEqual([{ ...before.atoms[0], element: symbol, labelLiteral: true }, before.atoms[1]]);
      expect(molecule().bonds).toEqual(before.bonds);
      expect(molecule(1)).toEqual(other);
      expect(editor()).toBeNull();
    });
  });

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

  it("restores the pointer's bond target for a digit after relabelling its nearer atom without moving", async () => {
    const bond = await hoverBond();
    await press("o");
    const before = molecule();
    expect(before.atoms.filter(atom => atom.element === "O")).toHaveLength(1);
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "atom" });
    await press("2");
    expect(editor()).toBeNull();
    expect(molecule().atoms).toEqual(before.atoms);
    expect(molecule().bonds).toEqual([{ ...bond, order: "double" }]);
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

  function expectIntact(attachments = 0) {
    expect(snapshot().activeToolCommandId).toBe("tool.bond");
    expect(snapshot().document.pages[0].objects).toHaveLength(1);
    expect(molecule().atoms).toHaveLength(6 + attachments);
    expect(molecule().bonds).toHaveLength(6 + attachments);
  }

  function expectSubstituent(label: string, atomId = molecule().atoms[0]!.id) {
    const current = molecule();
    expect(current.atoms.find(atom => atom.id === atomId)).toMatchObject({ element: "C" });
    const substituent = current.atoms[6]!;
    expect(substituent).toMatchObject({ element: label, labelLiteral: true });
    const attachment = current.bonds.filter(bond => bond.fromAtomId === substituent.id || bond.toAtomId === substituent.id);
    expect(attachment).toHaveLength(1);
    expect([attachment[0]!.fromAtomId, attachment[0]!.toAtomId]).toContain(atomId);
    expect(attachment[0]!.order).toBe("single");
    expectIntact(1);
    return substituent;
  }

  function expectOMeSubstituent(atomId = molecule().atoms[0]!.id) {
    return expectSubstituent("OMe", atomId);
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
    // All six labels take one bond: on this ring they attach rather than replace its carbon.
    expect(molecule().atoms.slice(0, 6)).toEqual(before.atoms);
    expect(molecule().atoms[6]).toMatchObject({ element: label, labelLiteral: true });
    expect(molecule().bonds.slice(0, 6)).toEqual(before.bonds);
    expect(molecule().atoms).toHaveLength(7);
    expect(molecule().bonds).toHaveLength(7);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(`Attached ${label} as a substituent`);
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

  it.each(["OM", "OMe", "NMe"])("Escape cancels hover %s on a ring while retaining the first committed key", async label => {
    const before = snapshot().document;
    await hover(0);
    await press(label[0]!);
    const committed = snapshot().document;
    for (const key of label.slice(1)) await press(key);
    await press("Escape");
    expect(editor()).toBeNull();
    expect(snapshot().document).toEqual(committed);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Atom label unchanged");
    expect(container.querySelector('[data-can-undo]')?.getAttribute("data-can-undo")).toBe("true");
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.redo"); });
    expect(snapshot().document).toEqual(committed);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Nothing to redo");
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
    expect(snapshot().document).toEqual(before);
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
    expectOMeSubstituent(near.id);
    expect(molecule().atoms.find((atom) => atom.id === far.id)!.element).toBe("C");
    expect(molecule().bonds.find((candidate) => candidate.id === bond.id)!.order).toBe(bond.order);
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
    expectOMeSubstituent();
    expect(molecule().bonds.find((candidate) => candidate.id === bond.id)!.order).toBe(bond.order);
  });

  it("dispatches a bond digit after drifting onto the labelled atom's own bond", async () => {
    await hover(0);
    await press("N");
    const { bond } = await hoverBond(0, 0.45);
    await press("2");
    expect(editor()).toBeNull();
    expect(molecule().atoms[0]!.element).toBe("N");
    expect(molecule().bonds.find((candidate) => candidate.id === bond.id)!.order).toBe("double");
    expectIntact();
  });

  async function hoverPoint(point: { x: number; y: number }) {
    const page = container.querySelector<HTMLElement>(".page")!;
    await act(async () => {
      const event = new MouseEvent("pointermove", { bubbles: true, clientX: point.x, clientY: point.y, buttons: 0 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      page.dispatchEvent(event);
    });
  }

  it("keeps a label going when the pointer drifts onto a neighbouring atom", async () => {
    await hover(0);
    await press("O");
    await hover(1);
    await press("M");
    expect(editor()?.value).toBe("OM");
    await press("e");
    await press("Enter");
    expectOMeSubstituent();
    expect(molecule().atoms[1]!.element).toBe("C");
    // The label is done: the hover is back on the atom under the pointer.
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "atom", atomId: molecule().atoms[1]!.id });
  });

  it("keeps a label going when the pointer drifts off the molecule onto empty page", async () => {
    await hover(0);
    await press("O");
    await hoverPoint({ x: 40, y: 40 });
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    await press("M");
    await press("e");
    await press("Enter");
    expectOMeSubstituent();
  });

  // A drift straight after the first instant letter, then a capital element letter: the continuing
  // key was re-judged against the labelled atom it had just moved the hover back to, read as a new
  // label there, and CF3 silently became F3.
  it("keeps CF3 when the pointer drifts onto empty page right after the first letter", async () => {
    const before = molecule();
    await hover(0);
    await press("C");
    await hoverPoint({ x: 40, y: 40 });
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    await press("F");
    expect(editor()?.value).toBe("CF");
    await press("3");
    expect(editor()?.value).toBe("CF3");
    await press("Enter");
    expect(molecule().atoms[0]!.element).toBe("C");
    expectSubstituent("CF3");
    expect(molecule().atoms).toHaveLength(7);
    expect(molecule().bonds.slice(0, 6)).toEqual(before.bonds);
    expectIntact(1);
    expect(molecule().atoms.some(atom => atom.element === "F3" || atom.element === "F")).toBe(false);
  });

  it("starts a new label on the neighbouring atom for a capital element letter typed right after the first letter", async () => {
    await hover(0);
    await press("C");
    await hover(1);
    await press("F");
    expect(molecule().atoms[0]!.element).toBe("C");
    expect(molecule().atoms[1]!.element).toBe("F");
    expect(editor()).toBeNull();
    await press("3");
    expect(editor()?.value).toBe("F3");
    await press("Enter");
    expect(molecule().atoms[0]!.element).toBe("C");
    expect(molecule().atoms[1]).toMatchObject({ element: "F3" });
    expectIntact();
  });

  it("keeps a label going over another atom's bond, for a key that cannot start a label", async () => {
    await hover(0);
    await press("O");
    const { bond } = await hoverBond(3, 0.5);
    await press("M");
    expect(editor()?.value).toBe("OM");
    await press("e");
    await press("Enter");
    expectOMeSubstituent();
    expect(molecule().bonds.find((candidate) => candidate.id === bond.id)!.order).toBe(bond.order);
  });

  it("dispatches a digit on the neighbouring atom after a drift", async () => {
    await hover(0);
    await press("N");
    const before = molecule();
    await hover(1);
    await press("2");
    // Digits act on the hovered atom, matching "keys act on the hovered atom", rather than making N2.
    expect(editor()).toBeNull();
    expect(molecule().atoms.slice(0, 6)).toEqual(before.atoms);
    expect(molecule().bonds.slice(0, 6)).toEqual(before.bonds);
    const carbon = before.atoms[1]!;
    const oxygen = molecule().atoms[6]!;
    expect(oxygen.element).toBe("O");
    expect(molecule().bonds[6]).toMatchObject({ fromAtomId: carbon.id, toAtomId: oxygen.id, order: "double" });
    expectIntact(1);
  });

  it("starts a new label for a capital element letter over a neighbour after a drift", async () => {
    await hover(0);
    await press("O");
    await hover(1);
    await press("N");
    expect(molecule().atoms[0]!.element).toBe("O");
    expect(molecule().atoms[1]!.element).toBe("N");
    expect(editor()).toBeNull();
    // And that new label continues on the neighbour.
    await press("a");
    expect(editor()?.value).toBe("Na");
    expectIntact();
  });

  it("labels the nearer end of another atom's bond for a capital element letter after a drift", async () => {
    await hover(0);
    await press("O");
    const { near, far } = await hoverBond(3, 0.4);
    await press("S");
    expect(molecule().atoms[0]!.element).toBe("O");
    expect(molecule().atoms.find((atom) => atom.id === near.id)!.element).toBe("S");
    expect(molecule().atoms.find((atom) => atom.id === far.id)!.element).toBe("C");
    expect(editor()).toBeNull();
    expectIntact();
  });

  it("does not continue a label that was undone before the drift", async () => {
    await hover(0);
    await press("O");
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
    expect(molecule().atoms[0]!.element).toBe("C");
    await hover(1);
    await press("e");
    expect(editor()).toBeNull();
    expect(snapshot().activeToolCommandId).toBe("tool.eraser");
    expect(molecule().atoms.map((atom) => atom.element)).toEqual(["C", "C", "C", "C", "C", "C"]);
  });

  // Now that the pointer leaving the atom no longer ends a continuation, every other change of
  // context must. Each case: "O" on atom 0, the context change, a drift to atom 1, then "e", which
  // must choose the Eraser rather than continue the old label as "Oe".
  async function expectContinuationEnded() {
    await hover(1);
    await press("e");
    expect(editor()).toBeNull();
    expect(snapshot().activeToolCommandId).toBe("tool.eraser");
    expect(molecule().atoms[0]!.element).toBe("O");
    expect(molecule().atoms).toHaveLength(6);
  }

  it("ends a label continuation on undo then redo from the menu", async () => {
    await hover(0);
    await press("O");
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.redo"); });
    expect(molecule().atoms[0]!.element).toBe("O");
    await expectContinuationEnded();
  });

  it("ends a label continuation when a document is opened, even one with the same atoms", async () => {
    await hover(0);
    await press("O");
    const labelled = molecule();
    expect(snapshot().file.dirty).toBe(true);
    // Reopen the document as it stands: same object and atom ids, atom 0 still "O".
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Open native ChemDraft document"]')!;
    const file = new File([serializeDocument(snapshot().document)], "same.chemdraft", { type: "application/json" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await file.text();
    });
    await act(async () => { await Promise.resolve(); });
    expect(snapshot().file.dirty).toBe(false);
    expect(molecule().id).toBe(labelled.id);
    expect(molecule().atoms[0]).toMatchObject({ id: labelled.atoms[0]!.id, element: "O" });
    await expectContinuationEnded();
  });

  it("ends a label continuation when a key goes to a dialog opened from the menu", async () => {
    await hover(0);
    await press("O");
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("page.setSizeCustom"); });
    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Custom page size"]')!;
    expect(dialog).not.toBeNull();
    await press("Tab", dialog);
    const cancel = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Cancel")!;
    await act(async () => { cancel.click(); });
    expect(container.querySelector('[role="dialog"][aria-label="Custom page size"]')).toBeNull();
    await expectContinuationEnded();
  });

  it("ends a label continuation when the window loses focus", async () => {
    await hover(0);
    await press("O");
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    await expectContinuationEnded();
  });

  it("ends a label continuation when the window is hidden", async () => {
    await hover(0);
    await press("O");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
    await expectContinuationEnded();
  });

  it("hovers the bond again once a label typed over it commits, so Delete acts on the bond", async () => {
    const { bond, near } = await hoverBond(0, 0.4);
    await press("O");
    await press("M");
    await press("e");
    await press("Enter");
    const substituent = expectOMeSubstituent(near.id);
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
    // Delete removes the ring bond under the pointer and leaves the OMe attachment intact.
    await press("Delete");
    expect(molecule().bonds.some((candidate) => candidate.id === bond.id)).toBe(false);
    expect(molecule().atoms.find((atom) => atom.id === near.id)).toMatchObject({ element: "C" });
    expect(molecule().atoms.find((atom) => atom.id === substituent.id)).toEqual(substituent);
  });

  it("hovers the bond again when the next key does not continue the label, so Delete acts on the bond", async () => {
    const { bond, far } = await hoverBond(0, 0.6);
    await press("N");
    expect(molecule().atoms.find((atom) => atom.id === far.id)!.element).toBe("N");
    // Delete does not continue a label, so the hover returns to the bond under the pointer first.
    await press("Delete");
    expect(molecule().bonds.some((candidate) => candidate.id === bond.id)).toBe(false);
    expect(molecule().atoms.find((atom) => atom.id === far.id)!.element).toBe("N");
  });

  it("ends a label continuation when the tool changes, by menu command as well as by palette", async () => {
    await hover(0);
    await press("O");
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("tool.select"); });
    await press("M");
    expect(editor()).toBeNull();
    expect(molecule().atoms[0]!.element).toBe("O");
    expect(molecule().atoms).toHaveLength(6);
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
