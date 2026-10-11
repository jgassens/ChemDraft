// @vitest-environment jsdom
// A cyano label typed with the Atom Label tool on a ring atom becomes a substituent that keeps the
// reading it was typed with — bond on its left — wherever the open position puts it: CN stays cyano,
// SCN thiocyanate, OCN cyanate (AGENTS.md §7), and on the left of the ring it is drawn turned.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoleculeObject, Point } from "@chemdraft/chem-core";
import { nativeAtomLabelReading, nativeAtomValidationState, nativeLabelBondSide } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTemplateMolecule, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
function benzene() {
  const d = insertNativeTemplateMolecule(createPhase4Document("Cyano ring labels"), { x: 300, y: 300 }, "benzene");
  return selectDocumentObjects(d, d.pages[0].id, []);
}

describe.each(["macos", "windows"] as const)("cyano labels typed on a ring atom (%s)", platform => {
  let container: HTMLDivElement, root: Root;
  const captureNames = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let captureDescriptors: Array<PropertyDescriptor | undefined>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key), clear: () => storage.clear()
    });
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "macos" ? "MacIntel" : "Win32" });
    captureDescriptors = captureNames.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    for (const name of captureNames) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: name === "hasPointerCapture" ? () => false : () => {} });
    saveKeybindingSettings({ scheme: "chemdraft" });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    captureNames.forEach((name, i) => {
      const descriptor = captureDescriptors[i];
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor); else Reflect.deleteProperty(HTMLElement.prototype, name);
    });
    Reflect.deleteProperty(navigator, "platform"); delete window.__CHEMDRAFT_AGENT__;
    window.history.replaceState(null, "", "/"); saveKeybindingSettings({ scheme: "chemdraft" });
  });
  async function mount() {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: benzene(), initialActiveToolCommandId: "tool.atom", initialCrosshairsVisible: false,
      initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const e of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) e.getBoundingClientRect = () => rect;
    await act(async () => { await Promise.resolve(); });
  }
  const molecule = () => window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects.find((o): o is MoleculeObject => o.type === "molecule")!;
  const editor = () => container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
  const status = () => container.querySelector('[role="status"]')?.textContent;
  async function pointer(type: string, point: Point, target: Element) {
    await act(async () => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerdown" ? 1 : 0, clientX: point.x, clientY: point.y });
      Object.defineProperties(e, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } }); target.dispatchEvent(e);
    });
  }
  async function key(key: string) {
    const target = document.activeElement ?? document.body;
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(e); });
    if (!e.defaultPrevented && target instanceof HTMLInputElement && key.length === 1) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, target.value + key);
        target.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
  }
  async function type(index: number, label: string) {
    const atom = molecule().atoms[index]!;
    await pointer("pointerdown", atom, container.querySelector(`[data-object-id="${molecule().id}"]`)!);
    expect(editor()).not.toBeNull();
    for (const char of label) await key(char);
    await key("Enter");
    expect(editor()).toBeNull();
  }

  // Benzene atoms 5 and 6 (indices 4, 5) open to the left; 2 and 3 (indices 1, 2) are their mirror.
  const cases = (["CN", "SCN", "OCN"] as const).flatMap(label => ([[4, "left"], [5, "left"], [1, "right"], [2, "right"]] as const)
    .map(([index, facing]) => [label, index, facing] as const));
  it.each(cases)("%s on benzene atom index %i (facing %s) stays its group, unbadged, drawn the way its bond reads", async (label, index, facing) => {
    await mount();
    const source = molecule().atoms[index]!;
    await type(index, label);
    const after = molecule(), added = after.atoms[6]!;
    expect(after.atoms).toHaveLength(7);
    expect(Math.sign(added.x - source.x)).toBe(facing === "left" ? -1 : 1);
    expect(added).toMatchObject({ element: label, labelLiteral: true, labelBondSide: { side: "left", atomId: source.id } });
    expect(after.structure).toContain({ CN: "C(#N)", SCN: "S(C(#N))", OCN: "O(C(#N))" }[label]);
    expect(after.structure).not.toContain("*");
    const side = nativeLabelBondSide(added, after.bonds.filter(b => b.fromAtomId === added.id || b.toAtomId === added.id), after.atoms);
    expect(nativeAtomLabelReading(added.element, { bonded: true, typed: true, bondSide: side! }).kind).toBe("group");
    expect(nativeAtomValidationState(added, after.bonds, added.formalCharge, after.atoms).valid).toBe(true);
    expect(container.querySelector(`[data-invalid-atom-id="${added.id}"]`)).toBeNull();
    const drawn = facing === "left" ? { CN: "NC", SCN: "NCS", OCN: "NCO" }[label] : label;
    expect(container.querySelector(`[data-atom-label="${drawn}"]`)).not.toBeNull();
    if (drawn !== label) expect(container.querySelector(`[data-atom-label="${label}"]`)).toBeNull();
    expect(status()).toContain(`Attached ${label} as a substituent: ${label} takes one bond and this atom already has 2`);
  });

  it.each([4, 5])("OMe on left-facing benzene atom index %i still reads OMe, drawn MeO", async index => {
    await mount();
    await type(index, "OMe");
    const after = molecule(), added = after.atoms[6]!;
    expect(added).toMatchObject({ element: "OMe", labelLiteral: true });
    expect(added.labelBondSide).toBeUndefined();
    expect(after.structure).toContain("O(C)"); expect(after.structure).not.toContain("*");
    expect(container.querySelector('[data-atom-label="MeO"]')).not.toBeNull();
    expect(container.querySelector(`[data-invalid-atom-id="${added.id}"]`)).toBeNull();
    expect(status()).toContain("Attached OMe as a substituent");
  });

  it("refuses CH2CN on a left-facing atom with a specific relabel status rather than an isomer", async () => {
    await mount();
    await type(4, "CH2CN");
    expect(molecule().atoms).toHaveLength(6);
    expect(molecule().atoms[4]).toMatchObject({ element: "CH2CN" });
    // The relabelled ring atom carries the badge its three bonds earn: the badge selector is live.
    expect(container.querySelector(`[data-invalid-atom-id="${molecule().atoms[4]!.id}"]`)).not.toBeNull();
    expect(status()).toContain("Relabeled CH2CN: the open position puts the bond on the label's right");
  });
});
