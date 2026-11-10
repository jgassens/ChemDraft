// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";
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
  async function bondClick() {
    const mol = molecule()!, bond = mol.bonds[0]!;
    const from = mol.atoms.find(a => a.id === bond.fromAtomId)!, to = mol.atoms.find(a => a.id === bond.toAtomId)!;
    await click(container.querySelector(`[data-object-id="${mol.id}"]`)!, (from.x + to.x) / 2, (from.y + to.y) / 2);
  }

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
    await command("edit.redo"); expect(molecule()).toEqual(wedge);
    await command("tool.wavyBond"); await bondClick();
    expect(molecule()!.bonds[0]).toEqual({ ...wedge.bonds[0], display: { ...wedge.bonds[0]!.display, bondStyle: "wavy" } });
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
