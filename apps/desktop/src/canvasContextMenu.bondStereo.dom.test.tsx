// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, MoleculeBond, MoleculeObject } from "@chemdraft/chem-core";
import { applyPatches } from "@chemdraft/chem-core";
import { depictSmiles2D, ensureOclResources, perceiveDoubleBondStereoFromMolfile } from "@chemdraft/ocl-adapter";
import { CommandRegistry } from "@chemdraft/plugin-host";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { MainWindow, ObjectLayerContextMenu } from "./MainWindow";
import { createBondStereoActions, moleculeBondStereoCommandId } from "./commands";
import { applyMoleculeBondStereo, createPhase4Document, getSelectedMolecule, insertNativeMolfileMolecule, selectDocumentObjects } from "./documentWorkflow";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

let container: HTMLDivElement, root: Root, canvas: HTMLElement;
const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
let captures: (PropertyDescriptor | undefined)[];
beforeAll(async () => { await ensureOclResources(); });
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  captures = captureMethods.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
  for (const name of captureMethods) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true, value: name === "hasPointerCapture" ? () => false : () => {}
    });
  }
  window.history.replaceState(null, "", "/?agentBridge=1");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  captures.forEach((descriptor, i) => {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, captureMethods[i], descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, captureMethods[i]);
  });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
});

function drawing(smiles: string, open = false) {
  const doc = insertNativeMolfileMolecule(createPhase4Document("Context E/Z"), { x: 250, y: 250 },
    depictSmiles2D(smiles, { openUnspecifiedDoubleBonds: open }).molfile, "molfile-v2000");
  return { doc: selectDocumentObjects(doc, doc.pages[0].id, []), mol: getSelectedMolecule(doc)! };
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
function bondPoint(mol: MoleculeObject, bond: MoleculeBond) {
  const from = mol.atoms.find(a => a.id === bond.fromAtomId)!, to = mol.atoms.find(a => a.id === bond.toAtomId)!;
  return { clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2 };
}
async function rightClick(mol: MoleculeObject, bond: MoleculeBond) {
  const target = container.querySelector(`[data-object-id="${mol.id}"]`)!;
  await act(async () => { target.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, button: 2, ...bondPoint(mol, bond)
  })); });
}
async function selectBond(mol: MoleculeObject, bond: MoleculeBond) {
  const target = container.querySelector(`[data-object-id="${mol.id}"]`)!;
  await act(async () => {
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
        buttons: type === "pointerdown" ? 1 : 0, shiftKey: true, ...bondPoint(mol, bond) });
      Object.defineProperties(event, { pointerId: { value: 77 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      target.dispatchEvent(event);
    }
  });
}
async function key(value: string, shiftKey = false) {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", {
    key: value, shiftKey, bubbles: true, cancelable: true
  })); });
}
async function command(commandId: string) {
  await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
}
const molecule = () => window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects.find((o): o is MoleculeObject => o.type === "molecule")!;
const menu = () => container.querySelector<HTMLElement>('[aria-label="Object layer options"]')!;
const entry = (value: "either" | "geometry") => menu().querySelector<HTMLButtonElement>(`[data-command-id="${moleculeBondStereoCommandId(value)}"]`);

describe.each<ShortcutPlatform>(["macos", "windows"])("canvas bond stereo menu (%s)", platform => {
  it.each(["CC=CC", "C/C=C\\C"])("confirms an either bond with the perceived geometry and one undo entry (%s)", async smiles => {
    const { doc, mol } = drawing(smiles, true);
    const bond = mol.bonds.find(b => b.order === "double")!;
    const openDoc = applyMoleculeBondStereo(doc, [{ objectId: mol.id, bondId: bond.id }], "either", perceiveDoubleBondStereoFromMolfile);
    await mount(openDoc, platform);
    const original = molecule();
    const invoke = vi.spyOn(CommandRegistry.prototype, "invoke");
    await rightClick(original, bond);
    const expected = smiles === "CC=CC" ? "E" : "Z";
    expect(entry("either")?.textContent).toBe("Mark E/Z as unspecified");
    expect(entry("either")?.disabled).toBe(false);
    expect(entry("geometry")?.textContent).toBe(`Use drawn geometry (${expected})`);
    expect(entry("geometry")?.disabled).toBe(false);
    await act(async () => entry("geometry")!.click());
    expect(invoke.mock.calls.filter(([id]) => id === moleculeBondStereoCommandId("geometry"))).toHaveLength(1);
    expect(molecule().bonds.find(b => b.id === bond.id)?.stereo).toBeUndefined();
    expect(menu()).toBeNull(); expect(document.activeElement).toBe(canvas);
    await command("edit.undo"); expect(molecule()).toEqual(original);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Use drawn geometry");
    await command("edit.redo"); expect(molecule().bonds.find(b => b.id === bond.id)?.stereo).toBeUndefined();
  });

  it("shows only Mark E/Z as unspecified for defined stereogenic geometry and dispatches it once", async () => {
    const { doc, mol } = drawing("C/C=C/C"), bond = mol.bonds.find(b => b.order === "double")!;
    await mount(doc, platform);
    const invoke = vi.spyOn(CommandRegistry.prototype, "invoke");
    await rightClick(mol, bond);
    expect(entry("geometry")).toBeNull();
    expect(entry("either")?.textContent).toBe("Mark E/Z as unspecified");
    expect(entry("either")?.disabled).toBe(false);
    await act(async () => entry("either")!.click());
    expect(invoke.mock.calls.filter(([id]) => id === moleculeBondStereoCommandId("either"))).toHaveLength(1);
    expect(molecule().bonds.find(b => b.id === bond.id)?.stereo).toBe("either");
    await command("edit.undo"); expect(molecule()).toEqual(mol);
  });

  it.each([
    ["CC=C(C)C", "This double bond is not stereogenic (equivalent substituents or a small ring)"],
    ["CC=O", "E/Z unspecified requires a stereogenic carbon–carbon double bond"]
  ])("disables non-stereogenic %s with the inspector's reason and skips it with arrows", async (smiles, reason) => {
    const { doc, mol } = drawing(smiles), bond = mol.bonds.find(b => b.order === "double")!;
    await mount(doc, platform); await rightClick(mol, bond);
    const disabled = entry("either")!;
    expect(disabled).not.toBeNull(); expect(disabled.disabled).toBe(true); expect(disabled.title).toBe(reason);
    expect(entry("geometry")).toBeNull();
    await act(async () => disabled.click()); expect(molecule()).toEqual(mol);
    for (let i = 0; i < menu().querySelectorAll('button[role="menuitem"]').length + 1; i++) {
      await key("ArrowDown"); expect(document.activeElement).not.toBe(disabled);
    }
    await key("Escape"); expect(document.activeElement).toBe(canvas);
  });

  it.each(["CC", "C#C", "c1ccccc1"])("hides both commands on non-double bonds (%s)", async smiles => {
    const { doc, mol } = drawing(smiles);
    // OCL depicts benzene with Kekulé orders; exercise the native aromatic order explicitly.
    const targetDoc = smiles === "c1ccccc1" ? applyPatches(doc, [{ op: "updateObject", objectId: mol.id,
      changes: { bonds: mol.bonds.map(b => ({ ...b, order: "aromatic" })) } }]) : doc;
    await mount(targetDoc, platform); await rightClick(mol, mol.bonds[0]);
    expect(menu()).not.toBeNull(); expect(entry("either")).toBeNull(); expect(entry("geometry")).toBeNull();
  });

  it.each([false, true])("opens with Shift+F10 and activates stereo through arrows and Enter (open: %s)", async open => {
    const { doc, mol } = drawing("CC=CC", open), bond = mol.bonds.find(b => b.order === "double")!;
    await mount(doc, platform); await selectBond(mol, bond);
    canvas.focus(); await key("F10", true);
    const value = open ? "geometry" : "either";
    expect(entry(value)?.disabled).toBe(false);
    const invoke = vi.spyOn(CommandRegistry.prototype, "invoke");
    for (let i = 0; i < 20 && document.activeElement !== entry(value); i++) await key("ArrowDown");
    expect(document.activeElement).toBe(entry(value));
    await key("Enter");
    expect(menu()).toBeNull(); expect(document.activeElement).toBe(canvas);
    expect(invoke.mock.calls.filter(([id]) => id === moleculeBondStereoCommandId(value))).toHaveLength(1);
    expect(molecule().bonds.find(b => b.id === bond.id)?.stereo).toBe(open ? undefined : "either");
  });

  it("hides both commands when multiple bonds are selected", async () => {
    const { doc, mol } = drawing("CC=CC", true), bond = mol.bonds.find(b => b.order === "double")!;
    await mount(doc, platform); await selectBond(mol, bond); await selectBond(mol, mol.bonds.find(b => b.order === "single")!);
    canvas.focus(); await key("F10", true);
    expect(menu()).not.toBeNull(); expect(entry("either")).toBeNull(); expect(entry("geometry")).toBeNull();
    await key("Escape"); await rightClick(mol, bond);
    expect(menu()).not.toBeNull(); expect(entry("either")).toBeNull(); expect(entry("geometry")).toBeNull();
  });
});

it("uses the command's plain geometry title while perception is loading", async () => {
  await act(async () => root.render(<ObjectLayerContextMenu objectId="m" objectIndex={0} objectCount={1}
    targetKind="bond" position={{ x: 100, y: 100 }} onInvoke={() => {}}
    bondStereoActions={createBondStereoActions({ eitherDisabledReason: "E/Z perception is still loading" })} />));
  expect(entry("geometry")?.textContent).toBe("Use drawn geometry"); expect(entry("geometry")?.disabled).toBe(false);
  expect(entry("either")?.title).toBe("E/Z perception is still loading"); expect(entry("either")?.disabled).toBe(true);
});
