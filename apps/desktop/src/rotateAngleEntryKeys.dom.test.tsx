// @vitest-environment jsdom
// Owner report (RC5): right-click a molecule, Rotate Molecule…, type 45, Enter: nothing happened,
// and the typed digits ran keyboard shortcuts. Keys here are dispatched as the browser sends them
// (keydown, then the default text insertion only when the app did not prevent it, then keyup).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChemicalMetadataSchema, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { ensureRdkit, resetRdkitForTesting, setRdkitModuleLoader } from "@chemdraft/rdkit-adapter";
import { chemicalIdentityMolfile, createSmilesMolecule } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { editRotationEntryField, rotationEntryKeyAction } from "./rotationEntryKeys";

// The native popup answers with the "Rotate Molecule…" row, as a user's click would.
const tauri = vi.hoisted(() => ({ choose: "rotate molecule" }));
vi.mock("@tauri-apps/api/core", async importOriginal => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: async (command: string, args?: { items?: Array<{ id?: string; label?: string }> }) => {
    if (command !== "popup_canvas_context_menu") return null;
    return args?.items?.find(item => item.label?.toLowerCase().startsWith(tauri.choose))?.id ?? null;
  } };
});
const runtime = vi.hoisted(() => ({ desktop: false }));
vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  isDesktopRuntime: () => runtime.desktop
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("rotation entry keys", () => {
  it("enters digits, signs and a decimal point, and leaves chords and letters alone", () => {
    const plain = { ctrlKey: false, metaKey: false, altKey: false };
    for (const key of ["0", "4", "9", "-", "+", "."]) expect(rotationEntryKeyAction({ key, ...plain })).toEqual({ kind: "insert", text: key });
    expect(rotationEntryKeyAction({ key: "Enter", ...plain })).toEqual({ kind: "keep" });
    expect(rotationEntryKeyAction({ key: "Escape", ...plain })).toEqual({ kind: "cancel" });
    expect(rotationEntryKeyAction({ key: "Backspace", ...plain })).toEqual({ kind: "delete", backward: true });
    expect(rotationEntryKeyAction({ key: "a", ...plain })).toBeUndefined();
    expect(rotationEntryKeyAction({ key: "4", ...plain, metaKey: true })).toBeUndefined();
    expect(rotationEntryKeyAction({ key: "4", ...plain, ctrlKey: true })).toBeUndefined();
    expect(rotationEntryKeyAction({ key: "4", ...plain, isComposing: true })).toBeUndefined();
  });

  it("edits the field at its selection", () => {
    expect(editRotationEntryField("0", 0, 1, { kind: "insert", text: "4" })).toEqual({ value: "4", caret: 1 });
    expect(editRotationEntryField("4", 1, 1, { kind: "insert", text: "5" })).toEqual({ value: "45", caret: 2 });
    expect(editRotationEntryField("45", 2, 2, { kind: "delete", backward: true })).toEqual({ value: "4", caret: 1 });
    expect(editRotationEntryField("45", 0, 0, { kind: "delete", backward: false })).toEqual({ value: "5", caret: 0 });
  });
});

describe.each(["macos", "windows"] as const)("typed rotation angle (%s)", platform => {
  const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
  let container: HTMLDivElement;
  let root: Root;
  let reachedWindow: string[];
  const recordWindowKey = (event: KeyboardEvent) => { reachedWindow.push(event.key); };
  const pointerMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  const pointerDescriptors = pointerMethods.map(method => Object.getOwnPropertyDescriptor(Element.prototype, method));
  const SMILES = "[13CH3][C@H](O)C(=O)[O-]";

  beforeAll(() => {
    const vendor = resolve("packages/rdkit-adapter/vendor");
    const glue = resolve(vendor, "RDKit_minimal.js");
    const wasmBinary = new Uint8Array(readFileSync(resolve(vendor, "RDKit_minimal.wasm")));
    const factory = new Function("require", "__dirname", `${readFileSync(glue, "utf8")}\n;return initRDKitModule;`)(createRequire(glue), vendor);
    setRdkitModuleLoader(() => factory({ wasmBinary }));
  });
  afterAll(resetRdkitForTesting);

  function drawing(): ChemDraftDocument {
    const doc = createPhase4Document("Typed rotation");
    const molecule = createSmilesMolecule(doc, { x: 300, y: 300 }, depictSmiles2D(SMILES), SMILES) as MoleculeObject;
    molecule.id = "rotate-me";
    molecule.chemistry = ChemicalMetadataSchema.parse({ isotopeLabels: ["13C"], totalCharge: -1 });
    doc.pages[0].objects = [molecule];
    doc.selection.objectIds = [molecule.id];
    return doc;
  }
  beforeEach(() => {
    runtime.desktop = false;
    tauri.choose = "rotate molecule";
    reachedWindow = [];
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "macos" ? "MacIntel" : "Win32" });
    for (const method of pointerMethods) {
      Object.defineProperty(Element.prototype, method, { configurable: true,
        value: method === "hasPointerCapture" ? () => false : () => {} });
    }
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    window.addEventListener("keydown", recordWindowKey);
  });
  afterEach(async () => {
    window.removeEventListener("keydown", recordWindowKey);
    runtime.desktop = false;
    await act(async () => root.unmount());
    container.remove();
    if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform); else Reflect.deleteProperty(navigator, "platform");
    delete window.__CHEMDRAFT_AGENT__;
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    pointerMethods.forEach((method, index) => {
      const descriptor = pointerDescriptors[index];
      if (descriptor) Object.defineProperty(Element.prototype, method, descriptor);
      else Reflect.deleteProperty(Element.prototype, method);
    });
  });

  async function mount() {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: drawing(), initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden",
      initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false, shortcutPlatform: platform
    })));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({})
    });
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const molecule = () => snapshot().document.pages[0].objects[0] as MoleculeObject;
  const field = () => container.querySelector<HTMLInputElement>('[aria-label="Z rotation degrees"]');
  const status = () => container.querySelector('[role="status"]')?.textContent;
  const settle = async (ms = 0) => { await act(async () => { await new Promise(done => setTimeout(done, ms)); }); };
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  /** One key as the browser sends it to whatever has focus. */
  async function key(name: string) {
    await act(async () => {
      const target = (document.activeElement ?? document.body) as HTMLElement;
      const down = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
      target.dispatchEvent(down);
      if (!down.defaultPrevented && name.length === 1 && target instanceof HTMLInputElement) {
        const start = target.selectionStart ?? target.value.length, end = target.selectionEnd ?? start;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
          .call(target, target.value.slice(0, start) + name + target.value.slice(end));
        target.setSelectionRange(start + 1, start + 1);
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }
      target.dispatchEvent(new KeyboardEvent("keyup", { key: name, bubbles: true, cancelable: true }));
    });
  }
  async function typeKeys(text: string) { for (const character of text) await key(character); }
  async function canonical(object: MoleculeObject) {
    const mol = (await ensureRdkit()).get_mol(chemicalIdentityMolfile(object), JSON.stringify({ removeHs: false }))!;
    try { return mol.get_smiles!(); } finally { mol.delete(); }
  }
  /** Same chemistry: elements, charges, isotopes and bonds unchanged; canonical SMILES (with stereo) equal. */
  async function expectSameChemistry(before: MoleculeObject, after: MoleculeObject) {
    const graph = (object: MoleculeObject) => ({
      atoms: object.atoms.map(({ x, y, ...atom }) => atom), bonds: object.bonds, chemistry: object.chemistry
    });
    expect(graph(after)).toEqual(graph(before));
    const smiles = await canonical(before);
    expect(smiles).toContain("@");
    expect(await canonical(after)).toBe(smiles);
  }
  const direction = (object: MoleculeObject) => Math.atan2(
    object.atoms[1].y - object.atoms[0].y, object.atoms[1].x - object.atoms[0].x) * 180 / Math.PI;
  const turned = (before: MoleculeObject, after: MoleculeObject) =>
    ((direction(after) - direction(before)) % 360 + 540) % 360 - 180;

  it("right-click, Rotate Molecule…, type 45, Enter: rotates once with one undo entry and keeps chemistry", async () => {
    await mount();
    const before = molecule();
    const tool = snapshot().activeToolCommandId;
    const scale = (snapshot().viewport as { scale: number }).scale;
    runtime.desktop = true;
    await act(async () => container.querySelector(".native-molecule-object")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,
        button: 2, clientX: before.atoms[0].x * scale, clientY: before.atoms[0].y * scale })));
    for (let tries = 0; tries < 40 && !field(); tries++) await settle(10);
    runtime.desktop = false;
    expect(field()).not.toBeNull();
    await settle(300);
    expect(document.activeElement).toBe(field());
    await typeKeys("45");
    expect(field()!.value).toBe("45");
    expect(reachedWindow).toEqual([]);
    expect(snapshot().activeToolCommandId).toBe(tool);
    await key("Enter");
    expect(field()).toBeNull();
    const after = molecule();
    expect(turned(before, after)).toBeCloseTo(45, 6);
    await expectSameChemistry(before, after);
    expect(snapshot().document.selection.objectIds).toEqual([before.id]);
    await command("edit.undo");
    expect(molecule()).toEqual(before);
    expect(status()).toBe("Undid Rotate molecule");
  });

  it("routes digits, minus and decimal point into the entry when focus was left on the canvas", async () => {
    await mount();
    const before = molecule();
    const tool = snapshot().activeToolCommandId;
    await command("layout.rotateMolecule");
    await settle(300);
    // A native menu closing, or the handle press, can put focus back on the canvas.
    await act(async () => container.querySelector<HTMLElement>(".canvas-region")!.focus());
    expect(document.activeElement).not.toBe(field());
    await typeKeys("-12.5");
    expect(field()!.value).toBe("-12.5");
    expect(document.activeElement).toBe(field());
    expect(reachedWindow).toEqual([]);
    expect(snapshot().activeToolCommandId).toBe(tool);
    expect(molecule().atoms.length).toBe(before.atoms.length);
    // Enter with focus on the canvas again still keeps the typed angle.
    await act(async () => container.querySelector<HTMLElement>(".canvas-region")!.focus());
    await key("Enter");
    expect(reachedWindow).toEqual([]);
    expect(field()).toBeNull();
    expect(turned(before, molecule())).toBeCloseTo(-12.5, 6);
    await expectSameChemistry(before, molecule());
  });

  it("Esc cancels the typed angle and leaves the molecule as it was", async () => {
    await mount();
    const before = molecule();
    await command("layout.rotateMolecule");
    await settle(300);
    await typeKeys("45");
    expect(molecule().atoms).not.toEqual(before.atoms);
    await key("Escape");
    expect(field()).toBeNull();
    expect(molecule()).toEqual(before);
    expect(reachedWindow).toEqual([]);
  });

  it("double-clicking the rotate handle opens the same entry with focus in it", async () => {
    await mount();
    const before = molecule();
    // The rotate handle shows while Shift is held.
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true })));
    const handle = container.querySelector<HTMLElement>('[data-selection-rotate-handle="true"]');
    expect(handle).not.toBeNull();
    // Chromium focuses a pressed button: the handle, not the entry, has focus after the clicks.
    await act(async () => { handle!.focus(); handle!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })); });
    await act(async () => handle!.focus());
    await act(async () => window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true })));
    reachedWindow = [];
    expect(field()).not.toBeNull();
    await settle(300);
    expect(document.activeElement).toBe(field());
    await typeKeys("45");
    await key("Enter");
    expect(turned(before, molecule())).toBeCloseTo(45, 6);
    await expectSameChemistry(before, molecule());
    expect(reachedWindow).toEqual([]);
  });
});
