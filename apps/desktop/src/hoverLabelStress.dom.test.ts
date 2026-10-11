// @vitest-environment jsdom

// Stress: typing "OMe" with the pointer resting on a bond of a long zigzag chain, where bond hit
// zones crowd the atoms. Every trial starts over a bond and must label one of its atoms while
// leaving the active tool and the existing chain intact. On an internal carbon, #94 attaches
// the one-bond label as a substituent; at a terminal carbon it replaces the atom label.
// HOVER_STRESS_TRIALS raises the trial count for a local run (default 24).

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { applyNativeChainTool, createPhase4Document, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const TRIALS = Number(process.env.HOVER_STRESS_TRIALS ?? 24);

describe("hover label typing over a long chain (stress)", () => {
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
    const chain = applyNativeChainTool(createPhase4Document("Hover stress"), { x: 80, y: 300 }, { x: 700, y: 300 });
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.bond",
        initialCrosshairsVisible: false,
        initialDocument: selectDocumentObjects(chain, chain.pages[0].id, []),
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

  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const molecule = (): MoleculeObject => {
    const object = snapshot().document.pages[0].objects[0];
    if (object?.type !== "molecule") throw new Error("Expected molecule");
    return object;
  };

  function expectedAttachmentCount(before: MoleculeObject, atomId: string) {
    return before.bonds.filter(bond => bond.fromAtomId === atomId || bond.toAtomId === atomId).length > 1 ? 1 : 0;
  }

  function expectOMeResult(before: MoleculeObject, atomId: string) {
    const after = molecule();
    if (expectedAttachmentCount(before, atomId)) {
      expect(after.atoms.slice(0, before.atoms.length)).toEqual(before.atoms);
      const substituent = after.atoms[before.atoms.length]!;
      expect(substituent).toMatchObject({ element: "OMe", labelLiteral: true });
      const attachment = after.bonds[before.bonds.length]!;
      expect(attachment.order).toBe("single");
      expect([attachment.fromAtomId, attachment.toAtomId].sort()).toEqual([atomId, substituent.id].sort());
    } else {
      expect(after.atoms.find(atom => atom.id === atomId)).toMatchObject({ element: "OMe", labelLiteral: true });
      expect(after.atoms.filter(atom => atom.id !== atomId)).toEqual(before.atoms.filter(atom => atom.id !== atomId));
    }
    expect(after.bonds.slice(0, before.bonds.length)).toEqual(before.bonds);
  }

  async function press(key: string, target: EventTarget = document.activeElement ?? document.body) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(event); });
    if (!event.defaultPrevented && target instanceof HTMLInputElement && key.length === 1) {
      const value = target.value + key;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.setSelectionRange(value.length, value.length);
      });
    }
  }

  it(`labels an atom and never switches tools across ${TRIALS} pointer positions along the chain`, async () => {
    const start = molecule();
    let seed = 20261010;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const tally = { trials: 0, overBond: 0, overAtom: 0, overNothing: 0, labelled: 0, toolSwitched: 0, structureChanged: 0 };

    for (let trial = 0; trial < TRIALS; trial++) {
      const current = molecule();
      const bond = current.bonds[Math.floor(random() * current.bonds.length)]!;
      const from = current.atoms.find((atom) => atom.id === bond.fromAtomId)!;
      const to = current.atoms.find((atom) => atom.id === bond.toAtomId)!;
      const page = container.querySelector<HTMLElement>(".page")!;
      const hoverAt = async (fraction: number) => {
        const point = { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction };
        await act(async () => {
          const event = new MouseEvent("pointermove", { bubbles: true, clientX: point.x, clientY: point.y, buttons: 0 });
          Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
          page.dispatchEvent(event);
        });
        return snapshot().hoveredNativeTarget as { kind?: string; bondId?: string } | undefined;
      };
      // Every trial starts with the pointer on the bond itself (the case this guards): a point in the
      // middle 40% of the bond, or its midpoint if that point still resolves to an atom.
      let hovered = await hoverAt(0.3 + random() * 0.4);
      if (hovered?.kind !== "bond") hovered = await hoverAt(0.5);
      expect(hovered).toMatchObject({ kind: "bond", bondId: bond.id });
      tally.trials += 1;
      if (hovered?.kind === "bond") tally.overBond += 1;
      else if (hovered?.kind === "atom") tally.overAtom += 1;
      else tally.overNothing += 1;

      await press("O");
      const labelledId = molecule().atoms.find(atom => atom.element === "O")!.id;
      expect([from.id, to.id]).toContain(labelledId);
      for (const key of ["M", "e"]) await press(key);
      await press("Enter");
      const after = molecule();
      // OMe belongs to the nearer end: a terminal relabel or an internal substituent.
      expectOMeResult(start, labelledId);
      tally.labelled += 1;
      if (snapshot().activeToolCommandId !== "tool.bond") tally.toolSwitched += 1;
      const added = expectedAttachmentCount(start, labelledId);
      if (after.atoms.length !== start.atoms.length + added || after.bonds.length !== start.bonds.length + added) tally.structureChanged += 1;
      if (snapshot().activeToolCommandId !== "tool.bond") {
        await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("tool.bond"); });
      }
      // Undo back to the starting chain so every trial is independent.
      for (let undo = 0; undo < 6 && molecule().atoms.some((atom) => atom.element !== "C"); undo++) {
        await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
      }
      expect(molecule().atoms.every((atom) => atom.element === "C")).toBe(true);
    }

    console.log(`[hover-stress] ${JSON.stringify(tally)}`);
    expect(tally.toolSwitched).toBe(0);
    expect(tally.structureChanged).toBe(0);
    expect(tally.overBond).toBe(tally.trials);
    expect(tally.labelled).toBe(tally.trials);
  }, 120_000);

  async function pointAt(point: { x: number; y: number }) {
    const page = container.querySelector<HTMLElement>(".page")!;
    await act(async () => {
      const event = new MouseEvent("pointermove", { bubbles: true, clientX: point.x, clientY: point.y, buttons: 0 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      page.dispatchEvent(event);
    });
    return snapshot().hoveredNativeTarget as { kind?: string; atomId?: string; bondId?: string } | undefined;
  }

  // Undo back to the plain chain and the Bond tool, so every trial starts the same.
  async function resetTrial() {
    if (snapshot().activeToolCommandId !== "tool.bond") {
      await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("tool.bond"); });
    }
    for (let undo = 0; undo < 6 && molecule().atoms.some((atom) => atom.element !== "C"); undo++) {
      await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
    }
    expect(molecule().atoms.every((atom) => atom.element === "C")).toBe(true);
  }

  const DRIFTS = [0.35, 0.5, 0.65, 1] as const;

  it(`keeps OMe on its atom when the pointer drifts ${DRIFTS.join("/")} of the way to a neighbour after "O" (${TRIALS} trials)`, async () => {
    const start = molecule();
    let seed = 20261011;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    // Per drift: what the pointer landed on (the labelled atom, a bond, the neighbour, nothing) and
    // whether the label stayed on the atom with the tool and structure unchanged.
    const tally = Object.fromEntries(DRIFTS.map((drift) => [drift, { trials: 0, onAtom: 0, onBond: 0, onNeighbour: 0, onNothing: 0, labelled: 0, toolSwitched: 0, structureChanged: 0 }]));

    for (let trial = 0; trial < TRIALS; trial++) {
      const drift = DRIFTS[trial % DRIFTS.length]!;
      const bond = start.bonds[Math.floor(random() * start.bonds.length)]!;
      const [atomId, neighbourId] = random() < 0.5 ? [bond.fromAtomId, bond.toAtomId] : [bond.toAtomId, bond.fromAtomId];
      const atom = start.atoms.find((candidate) => candidate.id === atomId)!;
      const neighbour = start.atoms.find((candidate) => candidate.id === neighbourId)!;
      expect(await pointAt(atom)).toMatchObject({ kind: "atom", atomId: atom.id });
      await press("O");
      expect(molecule().atoms.find((candidate) => candidate.id === atom.id)!.element).toBe("O");

      const landed = await pointAt({ x: atom.x + (neighbour.x - atom.x) * drift, y: atom.y + (neighbour.y - atom.y) * drift });
      const row = tally[drift]!;
      row.trials += 1;
      if (landed?.kind === "atom" && landed.atomId === atom.id) row.onAtom += 1;
      else if (landed?.kind === "atom" && landed.atomId === neighbour.id) row.onNeighbour += 1;
      else if (landed?.kind === "bond") row.onBond += 1;
      else row.onNothing += 1;

      for (const key of ["M", "e"]) await press(key);
      await press("Enter");
      const after = molecule();
      expectOMeResult(start, atom.id);
      row.labelled += 1;
      if (snapshot().activeToolCommandId !== "tool.bond") row.toolSwitched += 1;
      const added = expectedAttachmentCount(start, atom.id);
      if (after.atoms.length !== start.atoms.length + added || after.bonds.length !== start.bonds.length + added) row.structureChanged += 1;
      await resetTrial();
    }

    console.log(`[hover-drift-stress] ${JSON.stringify(tally)}`);
    for (const drift of DRIFTS) {
      const row = tally[drift]!;
      expect(row.labelled, `drift ${drift}`).toBe(row.trials);
      expect(row.toolSwitched, `drift ${drift}`).toBe(0);
      expect(row.structureChanged, `drift ${drift}`).toBe(0);
    }
    // The full drift lands on the neighbouring atom: the case that used to end the label.
    expect(tally[1]!.onNeighbour).toBe(tally[1]!.trials);
  }, 120_000);

  it(`types OMe on the chain with the pointer wandering between keys (${TRIALS} trials)`, async () => {
    // The original report: "OMe" typed onto a long chain, the pointer not quite still. Each trial
    // starts on the chain (an atom or a bond) and moves the pointer up to 0.6 bond lengths in a
    // random direction before every following key, onto neighbours, bonds or empty page.
    const start = molecule();
    const bondLength = Math.hypot(
      start.atoms[1]!.x - start.atoms[0]!.x,
      start.atoms[1]!.y - start.atoms[0]!.y
    );
    let seed = 20261012;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const tally = { trials: 0, startOnAtom: 0, startOnBond: 0, wanderedOffLabelledAtom: 0, labelled: 0, toolSwitched: 0, structureChanged: 0 };

    for (let trial = 0; trial < TRIALS; trial++) {
      const bond = start.bonds[Math.floor(random() * start.bonds.length)]!;
      const from = start.atoms.find((atom) => atom.id === bond.fromAtomId)!;
      const to = start.atoms.find((atom) => atom.id === bond.toAtomId)!;
      const fraction = random();
      let point = { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction };
      const first = await pointAt(point);
      expect(first?.kind === "atom" || first?.kind === "bond").toBe(true);
      tally.trials += 1;
      if (first?.kind === "atom") tally.startOnAtom += 1; else tally.startOnBond += 1;

      await press("O");
      const labelled = molecule().atoms.filter((atom) => atom.element === "O");
      expect(labelled).toHaveLength(1);
      let wandered = false;
      for (const key of ["M", "e"]) {
        const angle = random() * 2 * Math.PI, distance = random() * 0.6 * bondLength;
        point = { x: point.x + Math.cos(angle) * distance, y: point.y + Math.sin(angle) * distance };
        const hovered = await pointAt(point);
        if (!(hovered?.kind === "atom" && hovered.atomId === labelled[0]!.id)) wandered = true;
        await press(key);
      }
      if (wandered) tally.wanderedOffLabelledAtom += 1;
      await press("Enter");
      const after = molecule();
      expectOMeResult(start, labelled[0]!.id);
      tally.labelled += 1;
      if (snapshot().activeToolCommandId !== "tool.bond") tally.toolSwitched += 1;
      const added = expectedAttachmentCount(start, labelled[0]!.id);
      if (after.atoms.length !== start.atoms.length + added || after.bonds.length !== start.bonds.length + added) tally.structureChanged += 1;
      await resetTrial();
    }

    console.log(`[hover-wander-stress] ${JSON.stringify(tally)}`);
    // The drift must actually happen: in most trials the pointer leaves the labelled atom mid-label.
    expect(tally.wanderedOffLabelledAtom).toBeGreaterThanOrEqual(Math.ceil(tally.trials / 2));
    expect(tally.toolSwitched).toBe(0);
    expect(tally.structureChanged).toBe(0);
    expect(tally.labelled).toBe(tally.trials);
  }, 120_000);
});
