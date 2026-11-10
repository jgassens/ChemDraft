// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type MoleculeObject } from "@chemdraft/chem-core";
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
    saveKeybindingSettings({ scheme: "chemdraft" });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  async function mount(initial = insertNativeTemplateMolecule(createPhase4Document("Hover chemistry"), { x: 300, y: 300 }, "benzene")) {
    await act(async () => root.render(<MainWindow
      initialDocument={selectDocumentObjects(initial, initial.pages[0].id, [])}
      initialActiveToolCommandId="tool.bond" initialPaletteMode="hidden" initialRulersVisible={false}
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

  it.each((["menu", "shortcut"] as const).flatMap(via =>
    (["pointerleave", "pointercancel", "blur", "outside move", "canvas moved"] as const).map(exit => ({ via, exit }))
  ))("does not revive an outside hover after $via undo/redo ($exit)", async ({ via, exit }) => {
    await mount();
    const before = molecule();
    await hover(before.atoms[0]!);
    await type("OMe");
    const committed = molecule();
    await hover(before.atoms[0]!);
    expect(wrapper().dataset.deleteHoverAtomId).toBe(before.atoms[0]!.id);

    await act(async () => {
      if (exit === "canvas moved") {
        // No pointer event: layout can also leave the saved client point outside the canvas.
        vi.mocked(canvas.getBoundingClientRect).mockReturnValue({
          x: 900, y: 0, left: 900, top: 0, right: 1692, bottom: 612,
          width: 792, height: 612, toJSON: () => ({})
        });
      } else if (exit === "outside move") {
        document.body.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 850, clientY: 300 }));
      } else if (exit === "blur") {
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("focus"));
      } else {
        // pointerleave does not bubble; pointercancel can arrive from a captured pointer.
        canvas.dispatchEvent(new MouseEvent(exit, { bubbles: exit === "pointercancel", clientX: 850, clientY: 300 }));
      }
    });

    for (const [direction, expected] of [["undo", before], ["redo", committed]] as const) {
      await navigateHistory(direction, via);
      expect(molecule()).toEqual(expected);
      expect(wrapper().dataset.deleteHoverAtomId).toBeUndefined();
      await key("N");
      expect(editor()).toBeNull();
      expect(molecule()).toEqual(expected);
    }
  });

  it.each(["menu", "shortcut"] as const)("keeps an on-canvas hover usable after %s undo", async via => {
    await mount();
    const before = molecule();
    await hover(before.atoms[0]!);
    await type("OMe");
    await navigateHistory("undo", via);
    expect(molecule()).toEqual(before);
    expect(wrapper().dataset.deleteHoverAtomId).toBe(before.atoms[0]!.id);
    await key("N");
    expect(molecule().atoms[0]).toMatchObject({ id: before.atoms[0]!.id, element: "N" });
    expect(molecule().bonds).toEqual(before.bonds);
  });

  it.each(["benzene", "cyclohexane"] as const)("attaches monovalent labels to a %s carbon, preserving the ring", async template => {
    // Separate mounts keep every label's source chemistry identical.
    for (const label of ["Cl", "Br", "F", "I", "OMe", "CF3"]) {
      if (canvas) {
        await act(async () => root.unmount()); root = createRoot(container);
      }
      await mount(insertNativeTemplateMolecule(createPhase4Document(label), { x: 300, y: 300 }, template));
      const before = molecule();
      await hover(before.atoms[0]!);
      await type(label);
      const after = molecule();
      expect(after.atoms.slice(0, 6), label).toEqual(before.atoms);
      expect(after.bonds.slice(0, 6), label).toEqual(before.bonds);
      expect(after.atoms, label).toHaveLength(7);
      expect(after.bonds, label).toHaveLength(7);
      expect(after.atoms[6], label).toMatchObject({ element: label, formalCharge: 0 });
      expect(after.bonds[6], label).toMatchObject({ fromAtomId: before.atoms[0]!.id, toAtomId: after.atoms[6]!.id, order: "single" });
      const hydrogenCount = template === "benzene" ? 5 : 11;
      const formula = label === "OMe" ? `C7H${hydrogenCount + 3}O` : label === "CF3" ? `C7H${hydrogenCount}F3` : `C6H${hydrogenCount}${label}`;
      expect(after.chemistry?.formula, label).toBe(formula);
      expect(container.querySelector("[data-invalid-atom-id]"), label).toBeNull();
      await key("z", historyModifiers);
      expect(molecule()).toEqual(before);
      await key("z", { ...historyModifiers, shiftKey: true });
      expect(molecule()).toEqual(after);
    }
  });

  it("retyping Cl on an existing Cl ring atom is a plain relabel with no new atom", async () => {
    const initial = insertNativeTemplateMolecule(createPhase4Document("Retype chlorine"), { x: 300, y: 300 }, "cyclohexane");
    const ring = initial.pages[0].objects[0] as MoleculeObject;
    await mount(applyPatches(initial, [{ op: "updateObject", objectId: ring.id, changes: {
      atoms: ring.atoms.map((atom, i) => i === 0 ? { ...atom, element: "Cl" } : atom)
    } }]));
    const before = molecule();
    await hover(before.atoms[0]!);
    await type("Cl");
    const after = molecule();
    expect(after.atoms).toEqual([{ ...before.atoms[0], labelLiteral: true }, ...before.atoms.slice(1)]);
    expect(after.bonds).toEqual(before.bonds);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Labeled atom Cl");
    await key("z", historyModifiers);
    expect(molecule()).toEqual(before);
    await key("z", { ...historyModifiers, shiftKey: true });
    expect(molecule()).toEqual(after);
  });

  it.each(["N", "O"])("relabels a ring %s atom to Cl without attaching a substituent", async element => {
    const initial = insertNativeTemplateMolecule(createPhase4Document("Relabel heteroatom"), { x: 300, y: 300 }, "cyclohexane");
    const ring = initial.pages[0].objects[0] as MoleculeObject;
    await mount(applyPatches(initial, [{ op: "updateObject", objectId: ring.id, changes: {
      atoms: ring.atoms.map((atom, i) => i === 0 ? { ...atom, element } : atom)
    } }]));
    const before = molecule();
    await hover(before.atoms[0]!);
    await type("Cl");
    expect(molecule().atoms).toEqual([{ ...before.atoms[0], element: "Cl", labelLiteral: true }, ...before.atoms.slice(1)]);
    expect(molecule().bonds).toEqual(before.bonds);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Labeled atom Cl");
  });

  it("relabels a terminal carbon to Cl without inserting an atom or changing its bond", async () => {
    await mount(insertNativeSingleBondMolecule(createPhase4Document("Chloromethane"), { x: 300, y: 300 }));
    const before = molecule();
    await hover(before.atoms[0]!);
    await type("Cl");
    expect(molecule().atoms).toEqual([{ ...before.atoms[0], element: "Cl", labelLiteral: true }, before.atoms[1]]);
    expect(molecule().bonds).toEqual(before.bonds);
    expect(molecule().chemistry?.formula).toBe("CH3Cl");
    expect(container.querySelector("[data-invalid-atom-id]")).toBeNull();
  });

  it("shows the valence (!) badge when a saturated source cannot accept a Cl substituent", async () => {
    const initial = insertNativeTemplateMolecule(createPhase4Document("Saturated carbon"), { x: 300, y: 300 }, "cyclohexane");
    const ring = initial.pages[0].objects[0] as MoleculeObject;
    const source = ring.atoms[0]!;
    await mount(applyPatches(initial, [{ op: "updateObject", objectId: ring.id, changes: {
      atoms: [...ring.atoms, ...[-1, 1].map((sign, i) => ({ id: `extra_${i}`, element: "C", formalCharge: 0, x: source.x + sign * 25, y: source.y - 25 }))],
      bonds: [...ring.bonds, ...[0, 1].map(i => ({ id: `extra_bond_${i}`, fromAtomId: source.id, toAtomId: `extra_${i}`, order: "single" as const }))]
    } }]));
    const before = molecule();
    expect(container.querySelector(`[data-invalid-atom-id="${source.id}"]`)).toBeNull();
    await hover(source);
    await type("Cl");
    expect(molecule().atoms).toHaveLength(before.atoms.length);
    expect(molecule().bonds).toEqual(before.bonds);
    expect(molecule().atoms[0]).toMatchObject({ element: "Cl", formalCharge: 0 });
    const badge = container.querySelector(`[data-invalid-atom-id="${source.id}"]`);
    expect(badge?.querySelector("text")?.textContent).toBe("!");
    expect(badge?.querySelector("title")?.textContent).toContain("valence 4");
  });

  it.each((platform === "windows" ? ["shift-z", "y"] : ["shift-z"]).flatMap(redo =>
    [false, true].map(drift => ({ redo, drift }))
  ))("re-hit-tests after undo/redo ($redo, drift=$drift), then follows the pointer for the next OMe", async ({ redo, drift }) => {
    await mount();
    const before = molecule();
    await hover(before.atoms[0]!);
    await type("OMe");
    const first = molecule();
    // Also cover a move before navigation: redo must re-hit-test without another event.
    if (drift) await hover(before.atoms[1]!);
    const pointerAtom = before.atoms[drift ? 1 : 0]!;
    await key("z", historyModifiers);
    expect(molecule()).toEqual(before);
    expect(wrapper().dataset.deleteHoverAtomId).toBe(pointerAtom.id);
    await key(redo === "y" ? "y" : "z", { ...historyModifiers, shiftKey: redo !== "y" });
    expect(molecule()).toEqual(first);
    expect(wrapper().dataset.deleteHoverAtomId).toBe(pointerAtom.id);
    await hover(before.atoms[3]!);
    expect(wrapper().dataset.deleteHoverAtomId).toBe(before.atoms[3]!.id);
    await type("OMe");
    expect(molecule().atoms.slice(0, 6)).toEqual(before.atoms);
    expect(molecule().atoms.slice(6).map(atom => atom.element)).toEqual(["OMe", "OMe"]);
    expect(molecule().bonds[7]).toMatchObject({ fromAtomId: before.atoms[3]!.id, order: "single" });
    expect(molecule().bonds.slice(0, 7)).toEqual(first.bonds);
  });
});
