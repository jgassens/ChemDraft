// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type ChemDraftDocument, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";
import { depictSmiles2D, ensureOclResources } from "@chemdraft/ocl-adapter";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, getSelectedMolecule, insertSmilesMolecule, selectDocumentObjects } from "./documentWorkflow";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { loadStereoEngine } from "./stereoReadout";

// The native popup is one Tauri command on macOS and Windows; capture what it is sent.
const tauri = vi.hoisted(() => ({ popups: [] as Array<{ items: Array<{ kind: string; label?: string; enabled?: boolean }> }> }));
vi.mock("@tauri-apps/api/core", async importOriginal => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: async (command: string, args?: never) => {
    if (command === "popup_canvas_context_menu") tauri.popups.push(args!);
    return null;
  } };
});
// Desktop presentation is switched on only for the right-click itself, so the window mounts as usual.
const runtime = vi.hoisted(() => ({ desktop: false }));
vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  isDesktopRuntime: () => runtime.desktop
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

let container: HTMLDivElement, root: Root, canvas: HTMLElement;
const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
let captures: (PropertyDescriptor | undefined)[];
// The window preloads the engine on mount; awaiting the same cached load keeps the native
// popup's 120 ms readout budget from depending on how fast this host imports OpenChemLib.
beforeAll(async () => { await ensureOclResources(); await loadStereoEngine(); });
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  runtime.desktop = false;
  tauri.popups.length = 0;
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  captures = captureMethods.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
  for (const name of captureMethods) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true, value: name === "hasPointerCapture" ? () => false : () => {}
    });
  }
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  runtime.desktop = false;
  await act(async () => root.unmount()); container.remove();
  captures.forEach((descriptor, i) => {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, captureMethods[i], descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, captureMethods[i]);
  });
  vi.unstubAllGlobals();
});

// (S)-ibuprofen: atom 10 is the wedged centre (checked with `pnpm -s chemdraft stereo`).
const S_IBUPROFEN = "CC(C)Cc1ccc(cc1)[C@H](C)C(=O)O";
// (S)-1-phenylethylamine with its phenyl collapsed to a "Ph" label: atom 1 is the centre. With
// the label as a placeholder the perceiver alone reads R, so the menu must show nothing here.
const S_PHENYLETHYLAMINE = "N[C@@H](C)c1ccccc1";

function add(doc: ChemDraftDocument, smiles: string, x: number, y: number): { doc: ChemDraftDocument; mol: MoleculeObject } {
  const next = insertSmilesMolecule(doc, { x, y }, depictSmiles2D(smiles), smiles);
  return { doc: next, mol: getSelectedMolecule(next)! };
}
function drawing() {
  let doc = createPhase4Document("Stereo readout");
  const ibuprofen = add(doc, S_IBUPROFEN, 220, 170); doc = ibuprofen.doc;
  const butene = add(doc, "C/C=C/C", 220, 450); doc = butene.doc;
  const pea = add(doc, S_PHENYLETHYLAMINE, 600, 300); doc = pea.doc;
  const ring = new Set(pea.mol.atoms.slice(4).map(atom => atom.id));
  const labelled: MoleculeObject = { ...pea.mol,
    atoms: pea.mol.atoms.filter(atom => !ring.has(atom.id)).map((atom, i) => i === 3 ? { ...atom, element: "Ph" } : atom),
    bonds: pea.mol.bonds.filter(bond => !ring.has(bond.fromAtomId) && !ring.has(bond.toAtomId)) };
  doc = applyPatches(doc, [{ op: "updateObject", objectId: pea.mol.id, changes: { atoms: labelled.atoms, bonds: labelled.bonds } }]);
  doc = selectDocumentObjects(doc, doc.pages[0].id, []);
  return { doc, ibuprofen: ibuprofen.mol, butene: butene.mol, labelled };
}

async function mount(doc: ChemDraftDocument, platform: ShortcutPlatform) {
  await act(async () => root.render(<MainWindow initialDocument={doc} initialActiveToolCommandId="tool.select"
    initialPaletteMode="hidden" initialCrosshairsVisible={false} initialRulersVisible={false}
    nativePalette={false} shortcutPlatform={platform} />));
  const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
  for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
  canvas = container.querySelector<HTMLElement>(".canvas-region")!;
  Object.defineProperties(canvas, { clientWidth: { value: 792 }, clientHeight: { value: 612 } });
  canvas.focus();
}
const atomPoint = (mol: MoleculeObject, index: number) => ({ clientX: mol.atoms[index]!.x, clientY: mol.atoms[index]!.y });
function bondPoint(mol: MoleculeObject, bond: MoleculeBond) {
  const from = mol.atoms.find(a => a.id === bond.fromAtomId)!, to = mol.atoms.find(a => a.id === bond.toAtomId)!;
  return { clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2 };
}
async function settle() {
  // The inline row arrives after the engine resolves; the native popup waits for it first.
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function rightClick(mol: MoleculeObject, point: { clientX: number; clientY: number }) {
  const target = container.querySelector(`[data-object-id="${mol.id}"]`)!;
  await act(async () => { target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...point })); });
  await settle();
}
/** Selects exactly the atom or bond under the point, leaving no whole object selected. */
async function select(mol: MoleculeObject, point: { clientX: number; clientY: number }) {
  const target = container.querySelector(`[data-object-id="${mol.id}"]`)!;
  await act(async () => {
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerdown" ? 1 : 0, ...point });
      Object.defineProperties(event, { pointerId: { value: 77 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      target.dispatchEvent(event);
    }
  });
}
async function key(value: string, shiftKey = false) {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })); });
  await settle();
}
const menu = () => container.querySelector<HTMLElement>('[aria-label="Object layer options"]');

type Path = "inline" | "native";
const READOUT = /^(Stereocenter|Double bond): /;
/** The read-only row the menu showed, or undefined when it showed none; the menu is then closed. */
async function readout(path: Path): Promise<string | undefined> {
  if (path === "native") {
    expect(menu()).toBeNull();
    expect(tauri.popups).toHaveLength(1);
    const items = tauri.popups.pop()!.items;
    const rows = items.filter(item => READOUT.test(item.label ?? ""));
    if (rows.length === 0) return undefined;
    // Exactly one row, first, disabled (so it can never route a command), then a separator.
    expect(rows).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "item", enabled: false });
    expect(items[1]).toEqual({ kind: "separator" });
    return items[0]!.label;
  }
  const open = menu()!;
  expect(open).not.toBeNull();
  const rows = [...open.querySelectorAll<HTMLElement>(".object-context-menu-title")].filter(row => READOUT.test(row.textContent ?? ""));
  let label: string | undefined;
  if (rows.length > 0) {
    expect(rows).toHaveLength(1);
    const first = open.firstElementChild as HTMLElement;
    expect(first).toBe(rows[0]);
    expect(first.tagName).toBe("DIV");
    expect(first.nextElementSibling?.getAttribute("role")).toBe("separator");
    label = first.textContent ?? undefined;
  }
  // Focus stays on a real command, never on the read-only row.
  expect(document.activeElement?.closest('[aria-label="Object layer options"]')).toBe(open);
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
  await key("Escape");
  expect(menu()).toBeNull();
  return label;
}

describe.each<ShortcutPlatform>(["macos", "windows"])("canvas stereo readout in MainWindow (%s)", platform => {
  it.each<Path>(["inline", "native"])("right-click shows the engine's R/S and E/Z, and nothing next to a label (%s menu)", async path => {
    const { doc, ibuprofen, butene, labelled } = drawing();
    expect(labelled.atoms.map(atom => atom.element)).toEqual(["N", "C", "C", "Ph"]);
    await mount(doc, platform);
    runtime.desktop = path === "native";

    await rightClick(ibuprofen, atomPoint(ibuprofen, 10));
    expect(await readout(path)).toBe("Stereocenter: S");

    const double = butene.bonds.find(bond => bond.order === "double")!;
    await rightClick(butene, bondPoint(butene, double));
    expect(await readout(path)).toBe("Double bond: E");

    // A non-stereogenic atom in the same plain molecule: no row.
    await rightClick(ibuprofen, atomPoint(ibuprofen, 0));
    expect(await readout(path)).toBeUndefined();

    // The centre next to "Ph" gets no row, while the plain molecule beside it keeps its row.
    await rightClick(labelled, atomPoint(labelled, 1));
    expect(await readout(path)).toBeUndefined();
    await rightClick(ibuprofen, atomPoint(ibuprofen, 10));
    expect(await readout(path)).toBe("Stereocenter: S");
  });

  it.each<Path>(["inline", "native"])("right-clicking a stereocentre inside a kept selection shows its R/S (%s menu)", async path => {
    const { doc, ibuprofen } = drawing();
    const centre = ibuprofen.atoms[10]!;
    const incident = ibuprofen.bonds.find(bond => bond.fromAtomId === centre.id || bond.toAtomId === centre.id)!;
    await mount(doc, platform);
    runtime.desktop = path === "native";

    // A selected bond that ends at the centre is kept, but the readout still describes the atom.
    runtime.desktop = false;
    await select(ibuprofen, bondPoint(ibuprofen, incident));
    runtime.desktop = path === "native";
    await rightClick(ibuprofen, atomPoint(ibuprofen, 10));
    expect(await readout(path)).toBe("Stereocenter: S");

    // The whole molecule selected: right-clicking the centre still shows its R/S.
    runtime.desktop = false;
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.selectAll" } })); });
    runtime.desktop = path === "native";
    await rightClick(ibuprofen, atomPoint(ibuprofen, 10));
    expect(await readout(path)).toBe("Stereocenter: S");
  });

  it("the keyboard menu shows the row for one selected atom or bond, and not for a whole object", async () => {
    const { doc, ibuprofen, butene } = drawing();
    await mount(doc, platform);
    await select(ibuprofen, atomPoint(ibuprofen, 10));
    canvas.focus(); await key("F10", true);
    expect(await readout("inline")).toBe("Stereocenter: S");
    await select(butene, bondPoint(butene, butene.bonds.find(bond => bond.order === "double")!));
    canvas.focus(); await key("F10", true);
    expect(await readout("inline")).toBe("Double bond: E");
    // After a right-click the atom stays the selected part, so the keyboard menu agrees with it.
    await rightClick(ibuprofen, atomPoint(ibuprofen, 10));
    expect(await readout("inline")).toBe("Stereocenter: S");
    canvas.focus(); await key("F10", true);
    expect(await readout("inline")).toBe("Stereocenter: S");
    // Whole objects selected, no single atom or bond: no row.
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.selectAll" } })); });
    canvas.focus(); await key("F10", true);
    expect(await readout("inline")).toBeUndefined();
  });
});
