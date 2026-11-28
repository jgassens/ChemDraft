// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type MoleculeObject } from "@chemdraft/chem-core";
import { Molecule } from "openchemlib";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { insertSmilesMolecule, nativeAtomValidationState } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { applyNativeAtomElementTarget, createPhase4Document, insertNativeSingleBondMolecule, nativeAtomSproutHotkeyTarget, nativeBondLengthPx, nativeSingleBondHotkeyAtAtomTarget, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

// Real DOM event harness promoted from the chemist's hover reproduction tests.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe.each(["windows", "macos"] as const)("fragment keys (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", new MemoryStorage());
    saveKeybindingSettings({ scheme: "chemdraw" });
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
    vi.unstubAllGlobals();
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

  async function pointer(
    type: "pointerdown" | "pointermove" | "pointerup",
    point: { x: number; y: number },
    target: Element = container.querySelector(".page")!
  ) {
    await act(async () => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
        buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      target.dispatchEvent(event);
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

  function bondMidpoint(bond: MoleculeObject["bonds"][number]) {
    const atoms = molecule().atoms;
    const from = atoms.find(atom => atom.id === bond.fromAtomId)!;
    const to = atoms.find(atom => atom.id === bond.toAtomId)!;
    return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  }

  async function hoverBond(bond = molecule().bonds[0]!) {
    await hoverPoint(bondMidpoint(bond));
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
    return bond;
  }

  async function press(key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, shiftKey: /^[A-Z]$/.test(key), ...modifiers });
    await act(async () => { (document.activeElement ?? document.body).dispatchEvent(event); });
    return event;
  }

  async function expectOneUndo(before: MoleculeObject) {
    await press("z", { metaKey: platform === "macos", ctrlKey: platform === "windows" });
    expect(molecule()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  }

  it.each([
    ["CCC", 2, "CC(C)c1ccccc1", "C9H12", 9, 9],
    ["CC", 1, "Cc1ccccc1", "C7H8", 7, 7]
  ] as const)("key 3 on %s at a carbon with %i bonds produces the expected benzene derivative", async (smiles, degree, product, formula, atoms, bonds) => {
    const initial = insertSmilesMolecule(createPhase4Document("Benzene hotkey"), { x: 300, y: 300 }, depictSmiles2D(smiles), smiles);
    await renderEthane(initial);
    const before = molecule();
    const incidentBonds = (m: MoleculeObject, atomId: string) => m.bonds.filter(bond =>
      bond.fromAtomId === atomId || bond.toAtomId === atomId);
    const source = await hoverAtom(before.atoms.findIndex(atom => incidentBonds(before, atom.id).length === degree));
    expect((await press("3")).defaultPrevented).toBe(true);
    const after = molecule();
    expect(after.atoms).toHaveLength(atoms);
    expect(after.bonds).toHaveLength(bonds);
    expect(after.bonds.slice(0, before.bonds.length)).toEqual(before.bonds);
    const center = after.atoms.find(atom => atom.id === source.id)!;
    expect(incidentBonds(after, center.id)).toHaveLength(3);
    expect(nativeAtomValidationState(center, after.bonds, center.formalCharge, after.atoms).valid).toBe(true);
    expect(Molecule.fromSmiles(after.structure).toSmiles()).toBe(Molecule.fromSmiles(product).toSmiles());
    expect(after.chemistry?.formula).toBe(formula);
    await expectOneUndo(before);
  });

  it("key 3 adds phenyl to a cyclohexadiene methylene without changing the original ring", async () => {
    const smiles = "C1=CCC=CC1";
    const initial = insertSmilesMolecule(createPhase4Document("Diene hotkey"), { x: 300, y: 300 }, depictSmiles2D(smiles), smiles);
    await renderEthane(initial);
    const before = molecule();
    await hoverAtom(before.atoms.findIndex(atom => before.bonds.filter(bond =>
      bond.fromAtomId === atom.id || bond.toAtomId === atom.id).every(bond => bond.order === "single")));
    await press("3");
    const after = molecule();
    expect(after.chemistry?.formula).toBe("C12H12");
    expect(after.bonds.slice(0, before.bonds.length)).toEqual(before.bonds);
    expect(after.bonds.slice(before.bonds.length).filter(bond => bond.order === "double")).toHaveLength(3);
    await expectOneUndo(before);
  });

  it("key 3 refuses to overfill a propane carbon labeled CH2", async () => {
    const smiles = "CCC";
    const initial = insertSmilesMolecule(createPhase4Document("Labeled carbon hotkey"), { x: 300, y: 300 }, depictSmiles2D(smiles), smiles);
    const graph = initial.pages[0].objects[0] as MoleculeObject;
    const index = graph.atoms.findIndex(atom => graph.bonds.every(bond => bond.fromAtomId === atom.id || bond.toAtomId === atom.id));
    const atoms = graph.atoms.map((atom, i) => i === index ? { ...atom, element: "CH2", labelLiteral: true } : atom);
    await renderEthane(applyPatches(initial, [{ op: "updateObject", objectId: graph.id, changes: { atoms } }]));
    const before = molecule();
    await hoverAtom(index);
    await press("3");
    expect(molecule()).toEqual(before);
    expect(container.querySelector("[data-status-message]")?.textContent).toContain("that atom has no free valence");
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it("key 3 refuses a fully bonded carbon without adding an undo entry", async () => {
    const smiles = "CC(C)(C)C";
    const initial = insertSmilesMolecule(createPhase4Document("Benzene hotkey"), { x: 300, y: 300 }, depictSmiles2D(smiles), smiles);
    await renderEthane(initial);
    const before = molecule();
    await hoverAtom(before.atoms.findIndex(atom => before.bonds.filter(bond =>
      bond.fromAtomId === atom.id || bond.toAtomId === atom.id).length === 4));
    await press("3");
    expect(molecule()).toEqual(before);
    expect(container.querySelector("[data-status-message]")?.textContent).toContain("that atom has no free valence");
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it.each(["horizontal", "rotated", "page edge"] as const)("key 0 uses the same growth as 1 at a %s alkyne", async placement => {
    const smiles = "CC#C";
    const initial = insertSmilesMolecule(createPhase4Document("Propyne hotkey"), { x: 300, y: 300 }, depictSmiles2D(smiles), smiles);
    const graph = initial.pages[0].objects[0] as MoleculeObject;
    const triple = graph.bonds.find(bond => bond.order === "triple")!;
    const methyl = graph.atoms.find(atom => atom.id !== triple.fromAtomId && atom.id !== triple.toAtomId)!;
    const single = graph.bonds.find(bond => bond.order === "single")!;
    const neighborId = single.fromAtomId === methyl.id ? single.toAtomId : single.fromAtomId;
    const terminalId = triple.fromAtomId === neighborId ? triple.toAtomId : triple.fromAtomId;
    const angle = placement === "rotated" ? Math.PI / 5 : 0;
    const tip = { x: placement === "page edge" ? initial.pages[0].width - 2 : 300, y: 300 };
    const atoms = graph.atoms.map(atom => {
      const distance = atom.id === terminalId ? 0 : atom.id === neighborId ? nativeBondLengthPx : 2 * nativeBondLengthPx;
      return { ...atom, x: tip.x - distance * Math.cos(angle), y: tip.y - distance * Math.sin(angle) };
    });
    await renderEthane(applyPatches(initial, [{ op: "updateObject", objectId: graph.id, changes: { atoms } }]));
    const before = molecule();
    const terminalIndex = before.atoms.findIndex(atom => atom.id === terminalId);
    await hoverAtom(terminalIndex);
    await press("1");
    const singleGrowth = molecule();
    await expectOneUndo(before);
    const terminal = await hoverAtom(terminalIndex);
    await press("0");
    const after = molecule();
    expect(after.atoms).toHaveLength(4);
    expect(after.bonds).toHaveLength(3);
    expect(after.bonds.slice(0, 2)).toEqual(before.bonds);
    const added = after.atoms.at(-1)!;
    expect(after.bonds.at(-1)).toMatchObject({ fromAtomId: terminalId, toAtomId: added.id, order: "single" });
    if (placement !== "page edge") {
      const neighbor = before.atoms.find(atom => atom.id === neighborId)!;
      const ab = { x: neighbor.x - terminal.x, y: neighbor.y - terminal.y };
      const ac = { x: added.x - terminal.x, y: added.y - terminal.y };
      const cosine = (ab.x * ac.x + ab.y * ac.y) / (Math.hypot(ab.x, ab.y) * Math.hypot(ac.x, ac.y));
      expect(cosine).toBeCloseTo(-1, 8);
    }
    expect(after.atoms).toEqual(singleGrowth.atoms);
    expect(after.bonds).toEqual(singleGrowth.bonds);
    expect(Molecule.fromSmiles(after.structure).toSmiles()).toBe(Molecule.fromSmiles("CC#CC").toSmiles());
    expect(after.chemistry?.formula).toBe("C4H6");
    await expectOneUndo(before);
  });

  it("repeated 0 presses still grow and close a saturated six-membered ring", async () => {
    await renderEthane();
    for (let index = 1; index < 5; index += 1) {
      await hoverAtom(index);
      await press("0");
      expect(molecule().atoms).toHaveLength(index + 2);
    }
    const open = molecule();
    expect(open.bonds).toHaveLength(5);
    await hoverAtom(5);
    await press("0");
    const ring = molecule();
    expect(ring.atoms).toEqual(open.atoms);
    expect(ring.bonds).toHaveLength(6);
    expect(ring.bonds.at(-1)).toMatchObject({ fromAtomId: open.atoms[5].id, toAtomId: open.atoms[0].id, order: "single" });
    expect(Molecule.fromSmiles(ring.structure).toSmiles()).toBe(Molecule.fromSmiles("C1CCCCC1").toSmiles());
    expect(ring.chemistry?.formula).toBe("C6H12");
    await press("z", { metaKey: platform === "macos", ctrlKey: platform === "windows" });
    expect(molecule()).toEqual(open);
  });

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

  it("hovering plain phosphorus in CP and pressing 2 retains both H, refuses another oxo, and undoes exactly", async () => {
    const initial = insertSmilesMolecule(createPhase4Document("Phosphorus oxo key"), { x: 300, y: 300 }, depictSmiles2D("CP"), "CP");
    await renderEthane(initial);
    const before = molecule();
    const phosphorusIndex = before.atoms.findIndex(atom => atom.element === "P");
    expect(before.atoms[phosphorusIndex].labelLiteral).toBeUndefined();
    await hoverAtom(phosphorusIndex);
    expect((await press("2")).defaultPrevented).toBe(true);
    const after = molecule();
    expect(after.atoms).toHaveLength(before.atoms.length + 1);
    expect(Molecule.fromSmiles(after.structure).getIDCode()).toBe(Molecule.fromSmiles("C[PH2]=O").getIDCode());
    expect(after.chemistry?.formula).toBe("CH5OP");
    expect(Molecule.fromSmiles(after.structure).getMolecularFormula().formula).toBe("CH5OP");
    expect(container.querySelector("[data-status-message]")?.textContent).toContain("Added carbonyl or oxo");
    await hoverAtom(phosphorusIndex);
    await press("2");
    expect(molecule()).toEqual(after);
    expect(container.querySelector("[data-status-message]")?.textContent)
      .toContain("Cannot add carbonyl or oxo to hovered atom: that atom has no free valence");
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
    await press("z", platform === "macos" ? { metaKey: true } : { ctrlKey: true });
    expect(molecule()).toEqual(before);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Add branched alkyl");
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it("labels key 9 over a bond as one chair-ring fusion undo", async () => {
    await renderEthane();
    const before = molecule();
    await hoverBond();
    await press("9");
    expect(molecule().atoms).toHaveLength(before.atoms.length + 4);
    await press("z", platform === "macos" ? { metaKey: true } : { ctrlKey: true });
    expect(molecule()).toEqual(before);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Fuse chair cyclohexane ring");
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it("labels the wedge shortcut on a bond", async () => {
    await renderEthane();
    const before = molecule();
    await hoverBond();
    await press("w");
    expect(molecule().bonds[0]?.display?.bondStyle).toBe("wedge");
    await press("z", platform === "macos" ? { metaKey: true } : { ctrlKey: true });
    expect(molecule()).toEqual(before);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Make bond wedge");
  });

  it("V adds cyclopropyl over an atom and fuses cyclopropane over a bond", async () => {
    await renderEthane();
    const before = molecule();
    await hoverAtom(0);
    expect((await press("v")).defaultPrevented).toBe(true);
    expect(molecule().atoms).toHaveLength(before.atoms.length + 3);
    expect(molecule().bonds).toHaveLength(before.bonds.length + 4);
    expect(container.querySelector("[data-status-message]")?.textContent).toContain("Added cyclopropyl");
    await expectOneUndo(before);
    await hoverBond();
    expect((await press("v")).defaultPrevented).toBe(true);
    expect(molecule().atoms).toHaveLength(before.atoms.length + 1);
    expect(molecule().bonds).toHaveLength(before.bonds.length + 2);
    await expectOneUndo(before);
  });

  it("V over empty canvas leaves the tool and chemistry unchanged", async () => {
    await renderEthane();
    const before = snapshot().document;
    await hoverPoint({ x: 50, y: 50 });
    expect((await press("v")).defaultPrevented).toBe(false);
    expect(snapshot().activeToolCommandId).toBe("tool.bond");
    expect(snapshot().document).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it.each([
    ["g", 1], ["u", 2], ["v", 1],
    ["z", 3], ["G", 0], ["J", 0]
  ] as const)("key %s over empty canvas with a selected ethane bond (added atoms: %i)", async (key, added) => {
    await renderEthane();
    const before = molecule();
    const bond = before.bonds[0]!;
    const midpoint = bondMidpoint(bond);
    await press("Escape");
    expect(snapshot().activeToolCommandId).toBe("tool.select");
    const target = container.querySelector(`[data-object-id="${before.id}"]`)!;
    await pointer("pointerdown", midpoint, target);
    await pointer("pointerup", midpoint, target);
    await hoverPoint({ x: 50, y: 50 });
    expect(snapshot().hoveredNativeTarget).toBeUndefined();
    expect(snapshot().selectedNativeMoleculePart).toMatchObject({ kind: "bond", bondId: bond.id });

    await press(key);
    if (added) {
      expect(molecule().atoms).toHaveLength(before.atoms.length + added);
      expect(molecule().bonds).toHaveLength(before.bonds.length + added + 1);
      expect(molecule().bonds[0]).toEqual(bond);
      await expectOneUndo(before);
    } else {
      expect(molecule()).toEqual(before);
    }
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
    const added = key === "g" ? 1 : key === "u" ? 2 : key === "z" ? 3 : 0;
    expect(molecule().atoms).toHaveLength(2 + added);
    expect(molecule().bonds).toHaveLength(1 + (added ? added + 1 : 0));
    expect(molecule().atoms.slice(0, 2)).toEqual(before.atoms);
    expect(molecule().bonds[0]).toEqual(before.bonds[0]);
    if (key === "z") expect(molecule().bonds.filter(bond => bond.order === "double")).toHaveLength(2);
    if (added) await expectOneUndo(before);
  });

  it("adds one radical to the hovered carbon, replacing one implicit hydrogen and preserving charge in one undo step", async () => {
    await renderEthane();
    const before = molecule();
    const beforeObjects = snapshot().document.pages[0].objects;
    expect(Molecule.fromSmiles(before.structure).getMolecularFormula().formula).toBe("C2H6");
    await hoverAtom(0);
    await press(".");
    expect(molecule().atoms[0]).toEqual({ ...before.atoms[0], markRadicals: 1 });
    expect(molecule().atoms[1]).toEqual(before.atoms[1]);
    expect(molecule().bonds).toEqual(before.bonds);
    expect(Molecule.fromSmiles(molecule().structure).getMolecularFormula().formula).toBe("C2H5");
    expect(molecule().atoms.map(atom => atom.formalCharge)).toEqual(before.atoms.map(atom => atom.formalCharge));
    expect((molecule().atoms[0].markRadicals ?? 0) - (before.atoms[0].markRadicals ?? 0)).toBe(1);
    const doc = snapshot().document;
    const mark = doc.pages[0].objects.find(object => object.type === "electron-mark");
    expect(mark).toMatchObject({ type: "electron-mark", markKind: "radical-dot" });
    expect(doc.selection.objectIds).toContain(mark!.id);
    await expectOneUndo(before);
    expect(snapshot().document.pages[0].objects).toEqual(beforeObjects);
  });

  it("does not place a radical over a bond or empty canvas", async () => {
    await renderEthane();
    const before = snapshot().document;
    await hoverBond();
    await press(".");
    await hoverPoint({ x: 50, y: 50 });
    await press(".");
    expect(snapshot().document).toEqual(before);
  });

  it.each([
    ["[Na+]", "Na", true],
    ["CC(C)(C)C", "C", false]
  ] as const)("warns when placing a radical on %s with no implicit hydrogen to replace", async (smiles, element, valid) => {
    const initial = insertSmilesMolecule(createPhase4Document("Radical warning"), { x: 300, y: 300 }, depictSmiles2D(smiles), smiles);
    await renderEthane(initial);
    const before = molecule();
    const index = before.atoms.findIndex(atom => atom.element === element && (element !== "C" ||
      before.bonds.filter(bond => bond.fromAtomId === atom.id || bond.toAtomId === atom.id).length === 4));
    await hoverAtom(index);
    expect((await press(".")).defaultPrevented).toBe(true);
    const after = molecule();
    const atom = after.atoms[index]!;
    expect(atom).toEqual({ ...before.atoms[index], markRadicals: 1 });
    expect(after.bonds).toEqual(before.bonds);
    expect(after.chemistry?.formula).toBe(before.chemistry?.formula);
    expect(nativeAtomValidationState(atom, after.bonds, atom.formalCharge, after.atoms).valid).toBe(valid);
    const status = () => container.querySelector("[data-status-message]")?.textContent;
    if (!valid) {
      expect(status()).toContain("C has unsupported valence 5");
      await hoverPoint({ x: 50, y: 50 });
    }
    expect(status()).toContain(`Warning — ${element} has no implicit hydrogen to replace`);
    await expectOneUndo(before);
  });

  it("does not invoke the hover keys while a label editor is open", async () => {
    await renderEthane();
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("tool.atom"); });
    const atom = molecule().atoms[0]!;
    await act(async () => {
      const event = new MouseEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, clientX: atom.x, clientY: atom.y });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector(`[data-object-id="${molecule().id}"]`)!.dispatchEvent(event);
    });
    expect(container.querySelector('[data-atom-label-editor="true"]')).not.toBeNull();
    const before = snapshot().document;
    for (const key of ["v", "u", "."]) await press(key);
    expect(snapshot().document).toEqual(before);
  });
});
