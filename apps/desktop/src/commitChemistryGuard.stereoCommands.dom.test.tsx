// @vitest-environment jsdom
// The registered bond stereo commands (E/Z unspecified, Use drawn geometry, Use the other geometry)
// change stereo on purpose. They must commit under a chemistry edit scoped to the molecule they
// change, never the preserve-chemistry default, which refuses any stereo change (AGENTS.md
// section 7). Every case states the canonical isomeric SMILES OpenChemLib reads back from the
// app's own stereo-perception molfile, before and after, for the edited molecule and a bystander.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Molecule } from "openchemlib";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { depictSmiles2D, ensureOclResources } from "@chemdraft/ocl-adapter";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeMolfileMolecule, selectDocumentObjects } from "./documentWorkflow";
import { moleculeBondStereoCommandId } from "./commands";
import { DOM_COMMAND_EVENT } from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

const canonical = (molecule: MoleculeObject) => Molecule.fromMolfile(stereoPerceptionMolfile(molecule)).toIsomericSmiles();

describe("bond stereo commands commit as a scoped chemistry edit", () => {
  let container: HTMLDivElement, root: Root;
  const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let captures: (PropertyDescriptor | undefined)[];
  beforeAll(async () => { await ensureOclResources(); });
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    captures = captureMethods.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    for (const name of captureMethods) Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true, value: name === "hasPointerCapture" ? () => false : () => {}
    });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove();
    captures.forEach((descriptor, i) => {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, captureMethods[i], descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, captureMethods[i]);
    });
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });

  async function mount(initialDocument: ChemDraftDocument) {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument, initialActiveToolCommandId: "tool.select", initialCrosshairsVisible: false,
      initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
    const canvas = container.querySelector(".canvas-region")!;
    Object.defineProperties(canvas, { clientWidth: { value: 792 }, clientHeight: { value: 612 } });
    // The flip command needs the lazily imported OpenChemLib E/Z reader; let it arrive.
    for (let i = 0; i < 20; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const molecules = () => snapshot().document.pages[0].objects.filter((o): o is MoleculeObject => o.type === "molecule");
  const status = () => container.querySelector('[role="status"]')?.textContent ?? "";
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function bondClick(mol: MoleculeObject) {
    const bond = mol.bonds.find(b => b.order === "double")!;
    const from = mol.atoms.find(a => a.id === bond.fromAtomId)!, to = mol.atoms.find(a => a.id === bond.toAtomId)!;
    const target = container.querySelector(`[data-object-id="${mol.id}"]`)!;
    await act(async () => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1,
          clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2, shiftKey: true });
        Object.defineProperties(event, { pointerId: { value: 77 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
        target.dispatchEvent(event);
      }
    });
  }
  function twoMolecules(): ChemDraftDocument {
    const one = insertNativeMolfileMolecule(createPhase4Document("Stereo commands"), { x: 200, y: 250 },
      depictSmiles2D("C/C=C/C").molfile, "molfile-v2000");
    const two = insertNativeMolfileMolecule(one, { x: 520, y: 250 }, depictSmiles2D("C/C=C\\CC").molfile, "molfile-v2000");
    return selectDocumentObjects(two, two.pages[0].id, []);
  }

  it.each(["MacIntel", "Win32"])("changes E/Z of the selected bond only, as one undo entry each (%s)", async platform => {
    Object.defineProperty(navigator, "platform", { configurable: true, get: () => platform });
    try {
      await mount(twoMolecules());
      const [a, b] = molecules();
      expect(canonical(a)).toBe("C/C=C/C");
      expect(canonical(b)).toBe("CC/C=C\\C");
      // A bond click selects the bond without changing the drawing.
      await bondClick(a);
      expect(snapshot().selectedNativeMoleculePart).toMatchObject({ kind: "bond", objectId: a.id });
      expect(molecules()).toEqual([a, b]);

      await command(moleculeBondStereoCommandId("either"));
      expect(status()).not.toMatch(/^Cannot/);
      const either = molecules();
      expect(canonical(either[0])).toBe("CC=CC");
      expect(either[1]).toEqual(b);

      await command(moleculeBondStereoCommandId("geometry"));
      expect(status()).not.toMatch(/^Cannot/);
      const geometry = molecules();
      expect(canonical(geometry[0])).toBe("C/C=C/C");
      expect(geometry[1]).toEqual(b);

      await command(moleculeBondStereoCommandId("flipped"));
      expect(status()).not.toMatch(/^Cannot/);
      const flipped = molecules();
      expect(canonical(flipped[0])).toBe("C/C=C\\C");
      expect(flipped[1]).toEqual(b);

      await command("edit.undo"); expect(molecules()).toEqual(geometry);
      await command("edit.undo"); expect(molecules()).toEqual(either);
      await command("edit.undo"); expect(molecules()).toEqual([a, b]);
    } finally {
      Reflect.deleteProperty(navigator, "platform");
    }
  }, 20_000);
});
