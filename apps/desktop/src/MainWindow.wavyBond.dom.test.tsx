// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { applySingleBondToolAtPoint, createPhase4Document, getSelectedMolecule, insertNativeMolfileMolecule } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe("MainWindow wavy bond undo", () => {
  let container: HTMLDivElement, root: Root;
  let platformDescriptor: PropertyDescriptor | undefined;
  const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let captures: (PropertyDescriptor | undefined)[];
  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(navigator, "platform");
    captures = captureMethods.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    for (const name of captureMethods) Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true, value: name === "hasPointerCapture" ? () => false : () => {}
    });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("localStorage", new MemoryStorage());
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    captures.forEach((descriptor, i) => {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, captureMethods[i]!, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, captureMethods[i]!);
    });
    if (platformDescriptor) Object.defineProperty(navigator, "platform", platformDescriptor);
    else Reflect.deleteProperty(navigator, "platform");
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const molecule = () => snapshot().document.pages[0]!.objects.find((o): o is MoleculeObject => o.type === "molecule");
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function click(target: Element, x: number, y: number) {
    await act(async () => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
          buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y });
        Object.defineProperties(event, { pointerId: { value: 77 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
        target.dispatchEvent(event);
      }
    });
  }
  async function bondClick(bondId = molecule()!.bonds[0]!.id) {
    const mol = molecule()!, bond = mol.bonds.find(candidate => candidate.id === bondId)!;
    const from = mol.atoms.find(a => a.id === bond.fromAtomId)!, to = mol.atoms.find(a => a.id === bond.toAtomId)!;
    await click(container.querySelector(`[data-object-id="${mol.id}"]`)!, (from.x + to.x) / 2, (from.y + to.y) / 2);
  }

  for (const platform of ["MacIntel", "Win32"]) {
    for (const route of ["hover 1", "Single Bond click"]) {
      it.each(["wedge", "hashed", "wavy"] as const)(`makes %s plain via ${route} in exactly one labeled undo (${platform})`, async bondStyle => {
        Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
        const seed = applySingleBondToolAtPoint(createPhase4Document("Make plain"), { x: 260, y: 260 }, { bondStyle });
        const mol = getSelectedMolecule(seed)!;
        const bond = mol.bonds[0]!;
        const initialDocument = applyPatches(seed, [{ op: "updateObject", objectId: mol.id, changes: {
          style: { ...mol.style, bondColors: { [bond.id]: "#123456" }, bondStrokeWidths: { [bond.id]: 2.5 } },
          atoms: mol.atoms.map((atom, index) => ({ ...atom, ...(index === 0 ? { isotope: 13 } : { formalCharge: 1 }) })),
          bonds: [{ ...bond, fromAtomId: bond.toAtomId, toAtomId: bond.fromAtomId,
            display: { ...bond.display, depthWeight: 0.4 } }]
        } }]);
        await act(async () => root.render(createElement(MainWindow, {
          initialDocument, initialActiveToolCommandId: route === "hover 1" ? "tool.select" : "tool.bond",
          initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false
        })));
        const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
        for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
        const original = molecule()!;
        if (route === "hover 1") {
          const [from, to] = original.atoms;
          await act(async () => {
            const event = new MouseEvent("pointermove", { bubbles: true, clientX: (from!.x + to!.x) / 2,
              clientY: (from!.y + to!.y) / 2, buttons: 0 });
            Object.defineProperties(event, { pointerId: { value: 77 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
            container.querySelector(".page")!.dispatchEvent(event);
          });
          expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
          await act(async () => {
            document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "1", code: "Digit1", bubbles: true, cancelable: true }));
          });
        } else {
          await bondClick();
        }
        const plain = molecule()!;
        expect(plain.bonds).toEqual([{ ...original.bonds[0], display: { depthWeight: 0.4 } }]);
        expect(plain.atoms).toEqual(original.atoms);
        expect(plain.style).toEqual(original.style);
        expect(container.querySelector('[role="status"]')?.textContent).toBe("Made bond plain");
        await command("edit.undo");
        expect(molecule()).toEqual(original);
        expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Made bond plain");
        expect(container.querySelector('[data-can-undo]')?.getAttribute("data-can-undo")).toBe("false");
        await command("edit.redo");
        expect(molecule()).toEqual(plain);
        expect(container.querySelector('[role="status"]')?.textContent).toBe("Redid Made bond plain");
      });
    }
  }

  it("keeps plain order cycling and explicit Double/Triple Bond tools on a wedge", async () => {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: createPhase4Document("Bond order tools"), initialActiveToolCommandId: "tool.bond",
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
    await click(container.querySelector(".page")!, 260, 260);
    for (const order of ["double", "triple", "single"]) {
      await bondClick();
      expect(molecule()!.bonds[0]!.order).toBe(order);
    }
    await command("tool.wedgeBond");
    await bondClick();
    const wedge = molecule()!;
    for (const [tool, order] of [["tool.doubleBond", "double"], ["tool.tripleBond", "triple"]] as const) {
      await command(tool);
      await bondClick();
      expect(molecule()!.bonds[0]).toMatchObject({ order, display: { bondStyle: "wedge" },
        fromAtomId: wedge.bonds[0]!.fromAtomId, toAtomId: wedge.bonds[0]!.toAtomId });
      await command("edit.undo");
      expect(molecule()).toEqual(wedge);
    }
  });

  it("converts the CH3–CH bond of butan-2-ol with its narrow end on C2 after lazy perception, in one undo", async () => {
    const { depictSmiles2D } = await import("@chemdraft/ocl-adapter");
    const inserted = insertNativeMolfileMolecule(createPhase4Document("Butan-2-ol"), { x: 220, y: 220 },
      depictSmiles2D("CC(O)CC").molfile, "molfile-v2000");
    const mol = getSelectedMolecule(inserted)!;
    const c1 = mol.atoms[0]!.id, c2 = mol.atoms[1]!.id;
    const bond = mol.bonds.find(candidate =>
      [candidate.fromAtomId, candidate.toAtomId].includes(c1) &&
      [candidate.fromAtomId, candidate.toAtomId].includes(c2))!;
    // The stored narrow end points at CH3, so perception must reverse it on conversion.
    const initialDocument = applyPatches(inserted, [{ op: "updateObject", objectId: mol.id, changes: {
      bonds: mol.bonds.map(candidate => candidate.id === bond.id ? { ...candidate, fromAtomId: c1, toAtomId: c2 } : candidate)
    } }]);
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument, initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
    const original = molecule()!;
    await command("tool.wavyBond");
    await bondClick(bond.id);
    // The pointer handler does not await the adapter import; wait for the committed result.
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(molecule()!.bonds.find(candidate => candidate.id === bond.id))
        .toMatchObject({ fromAtomId: c2, toAtomId: c1, display: { bondStyle: "wavy" } });
    });
    expect(container.querySelector('path[data-bond-style="wavy"]')).not.toBeNull();
    await command("edit.undo");
    expect(molecule()).toEqual(original);
  });

  it.each(["MacIntel", "Win32"])("draws/converts/reverses as one undo entry each (%s)", async platform => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: createPhase4Document("Wavy undo"), initialActiveToolCommandId: "tool.wavyBond",
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
    await click(container.querySelector(".page")!, 260, 260);
    const wave = molecule()!;
    expect(wave?.bonds[0]!.display?.bondStyle).toBe("wavy");
    expect(container.querySelector('path[data-bond-style="wavy"]')).not.toBeNull();
    await command("edit.undo"); expect(molecule()).toBeUndefined();
    await command("edit.redo"); expect(molecule()).toEqual(wave);
    await bondClick();
    const reversed = molecule()!;
    expect(reversed.bonds[0]).toMatchObject({ fromAtomId: wave.bonds[0]!.toAtomId, toAtomId: wave.bonds[0]!.fromAtomId });
    await command("edit.undo"); expect(molecule()).toEqual(wave);
    await command("edit.redo"); expect(molecule()).toEqual(reversed);
    await command("tool.wedgeBond"); await bondClick();
    const wedge = molecule()!;
    expect(wedge.bonds[0]!.display?.bondStyle).toBe("wedge");
    await command("edit.undo"); expect(molecule()).toEqual(reversed);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Make bond wedge");
    await command("edit.redo"); expect(molecule()).toEqual(wedge);
    await command("tool.wavyBond"); await bondClick();
    expect(molecule()!.bonds[0]).toEqual({ ...wedge.bonds[0], display: { ...wedge.bonds[0]!.display, bondStyle: "wavy" } });
    await command("edit.undo"); expect(molecule()).toEqual(wedge);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Make bond wavy");
    await command("edit.redo");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Redid Make bond wavy");
    await command("edit.undo"); expect(molecule()).toEqual(wedge);
    await command("edit.undo"); expect(molecule()).toEqual(reversed);
    await command("edit.undo"); expect(molecule()).toEqual(wave);
    await command("edit.undo"); expect(molecule()).toBeUndefined();
    await command("tool.doubleBond"); await click(container.querySelector(".page")!, 260, 260);
    const double = molecule()!;
    expect(double.bonds[0]!.order).toBe("double");
    await command("tool.wavyBond"); await bondClick();
    expect(molecule()).toEqual(double);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Wavy bond requires a single bond");
    await command("edit.undo"); expect(molecule()).toBeUndefined();
  }, 20_000);
});
