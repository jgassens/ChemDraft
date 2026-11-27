// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type MoleculeObject } from "@chemdraft/chem-core";
import { Molecule } from "openchemlib";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule, insertNativeTemplateMolecule, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("hover label chemistry and history (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let canvas: HTMLElement;
  const editor = () => container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
  // The bridge is read-only here: all interaction uses DOM pointer and keyboard events.
  const molecule = () => window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects[0] as MoleculeObject;
  const wrapper = () => container.querySelector<HTMLElement>(".native-molecule-object")!;
  const historyModifiers = { metaKey: platform === "macos", ctrlKey: platform === "windows" };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    saveKeybindingSettings({ scheme: "chemdraw" });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  async function mount(initial = insertNativeTemplateMolecule(createPhase4Document("Hover chemistry"), { x: 300, y: 300 }, "benzene"), tool = "tool.bond") {
    await act(async () => root.render(<MainWindow
      initialDocument={selectDocumentObjects(initial, initial.pages[0].id, [])}
      initialActiveToolCommandId={tool} initialPaletteMode="hidden" initialRulersVisible={false}
      initialCrosshairsVisible={false} nativePalette={true} shortcutPlatform={platform}
    />));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
    }
    canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    await act(async () => canvas.focus());
  }

  async function hover(point: { x: number; y: number }) {
    const event = new MouseEvent("pointermove", { bubbles: true, clientX: point.x, clientY: point.y, buttons: 0 });
    Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    await act(async () => wrapper().dispatchEvent(event));
  }

  async function key(key: string, init: KeyboardEventInit = {}) {
    const target = document.activeElement ?? canvas;
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    await act(async () => target.dispatchEvent(event));
    // jsdom has no text-editing default; apply it only when the editor allowed the key.
    if (!event.defaultPrevented && !init.metaKey && !init.ctrlKey && target instanceof HTMLInputElement && key.length === 1) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      const value = target.value.slice(0, start) + key + target.value.slice(end);
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.setSelectionRange(start + key.length, start + key.length);
      });
    }
    await act(async () => (document.activeElement ?? canvas).dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true })));
  }

  async function type(label: string) {
    for (const letter of label) await key(letter);
    if (label.length > 1) expect(editor()?.value).toBe(label);
    await key("Enter");
    expect(editor()).toBeNull();
  }

  async function navigateHistory(direction: "undo" | "redo", via: "menu" | "shortcut") {
    if (via === "menu") {
      // This is the command event delivered by the native Edit menu, without bridge input.
      await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, {
        detail: { commandId: `edit.${direction}` }
      })));
    } else {
      await key("z", { ...historyModifiers, shiftKey: direction === "redo" });
    }
  }

  it("replaces the ring vertex when I is typed into the atom-label editor", async () => {
    await mount(insertNativeTemplateMolecule(createPhase4Document("Edit ring label"), { x: 300, y: 300 }, "cyclohexane"), "tool.atom");
    const before = molecule();
    const source = before.atoms[0]!;
    const event = new MouseEvent("pointerdown", {
      bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: source.x, clientY: source.y, detail: 1
    });
    Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    await act(async () => wrapper().dispatchEvent(event));
    expect(editor()?.dataset.atomId).toBe(source.id);
    expect(document.activeElement).toBe(editor());
    await type("I");
    const after = molecule();
    expect(after.atoms).toEqual([{ ...source, element: "I", labelLiteral: true }, ...before.atoms.slice(1)]);
    expect(after.bonds).toEqual(before.bonds);
    expect(after.bonds.filter(bond => [bond.fromAtomId, bond.toAtomId].includes(source.id))).toHaveLength(2);
    expect(after.chemistry?.formula).toBe("C5H10I");
    expect(Molecule.fromSmiles(after.structure).toSmiles()).toBe(Molecule.fromSmiles("[I]1CCCCC1").toSmiles());
    await navigateHistory("undo", "shortcut");
    expect(molecule()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    await navigateHistory("redo", "shortcut");
    expect(molecule()).toEqual(after);
  });
});
