// @vitest-environment jsdom

// Stress: typing "OMe" with the pointer resting on a bond of a long zigzag chain, where bond hit
// zones crowd the atoms. Every trial starts over a bond and must label one of its atoms while
// leaving the active tool and the chain's structure alone.
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

      for (const key of ["O", "M", "e"]) {
        await press(key);
      }
      await press("Enter");
      const after = molecule();
      // Exactly one atom changed, it now reads "OMe", and it is an end of the bond the pointer was on.
      const changed = after.atoms.filter((atom) => start.atoms.find((old) => old.id === atom.id)?.element !== atom.element);
      if (changed.length === 1 && changed[0]!.element === "OMe" && (changed[0]!.id === from.id || changed[0]!.id === to.id)) {
        tally.labelled += 1;
      }
      if (snapshot().activeToolCommandId !== "tool.bond") tally.toolSwitched += 1;
      if (after.atoms.length !== start.atoms.length || after.bonds.length !== start.bonds.length) tally.structureChanged += 1;
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
});
