// @vitest-environment jsdom
import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, MoleculeBond, MoleculeObject } from "@chemdraft/chem-core";
import { applyPatches } from "@chemdraft/chem-core";
import { depictSmiles2D, ensureOclResources, perceiveDoubleBondStereoFromMolfile } from "@chemdraft/ocl-adapter";
import { CommandRegistry } from "@chemdraft/plugin-host";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { MainWindow, ObjectLayerContextMenu } from "./MainWindow";
import { createBondStereoActions, moleculeBondStereoCommandId } from "./commands";
import { applyMoleculeBondStereo, createPhase4Document, getSelectedMolecule, insertNativeMolfileMolecule, selectDocumentObjects, exportPhase4Svg, exportPhase4Pdf, exportPhase4Cdxml } from "./documentWorkflow";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT, openToolsetPopoverWindow, setToolsetPopoverContent, closeToolsetPopoverWindow,
  currentWindowLogicalPosition, dismissToolsetPopovers, type ToolsetPopoverDismissPayload, type BondStereoPopoverAction } from "./window-manager";
const nativePopover = vi.hoisted(() => ({
  action: undefined as undefined | ((payload: BondStereoPopoverAction) => void),
  request: undefined as undefined | ((id: string) => void),
  dismiss: undefined as undefined | ((payload?: ToolsetPopoverDismissPayload) => void),
  pendingDismisses: [] as (ToolsetPopoverDismissPayload | undefined)[]
}));
vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  dismissToolsetPopovers: vi.fn(async (requestedAt?: number) => {
    nativePopover.pendingDismisses.push(requestedAt === undefined ? undefined : { requestedAt });
  }),
  currentWindowLogicalPosition: vi.fn(async () => ({ x: 100, y: 200 })),
  openToolsetPopoverWindow: vi.fn(async () => {}),
  closeToolsetPopoverWindow: vi.fn(async () => {}),
  setToolsetPopoverContent: vi.fn(async () => {}),
  focusCurrentWindowAndWebview: vi.fn(async () => {}),
  listenForBondStereoPopoverActions: vi.fn(async handler => { nativePopover.action = handler; return () => {}; }),
  listenForToolsetPopoverContentRequests: vi.fn(async handler => { nativePopover.request = handler; return () => {}; }),
  listenForToolsetPopoverDismiss: vi.fn(async handler => { nativePopover.dismiss = handler; return () => {}; })
}));

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

let container: HTMLDivElement, root: Root, canvas: HTMLElement;
const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
let captures: (PropertyDescriptor | undefined)[];
beforeAll(async () => { await ensureOclResources(); });
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  nativePopover.pendingDismisses.length = 0;
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
async function mount(doc: ChemDraftDocument, platform: ShortcutPlatform, nativePalette = false) {
  await act(async () => root.render(<MainWindow initialDocument={doc} initialActiveToolCommandId="tool.select"
    initialPaletteMode="hidden" initialCrosshairsVisible={false} initialRulersVisible={false}
    nativePalette={nativePalette} shortcutPlatform={platform} />));
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
    // Already-open bonds omit the redundant action: macOS paints disabled context items
    // like enabled ones. Disabled-with-reason remains for actual inapplicability below.
    expect(entry("either")).toBeNull();
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
    const { doc, mol } = drawing(open ? "CC=CC" : "C/C=C/C", open), bond = mol.bonds.find(b => b.order === "double")!;
    if (!open) expect(bond.stereo).toBeUndefined();
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


describe.each<ShortcutPlatform>(["macos", "windows"])("native badge popover (%s)", platform => {
  async function openBadge(keyboard?: "Enter" | " ") {
    const { doc, mol } = drawing("CC=CC", true);
    const bond = mol.bonds.find(b => b.stereo === "either")!;
    await mount(doc, platform);
    let badge = container.querySelector<SVGGElement>("[data-unspecified-bond-id]")!;
    badge.getBoundingClientRect = () => ({ left: 30, bottom: 50 }) as DOMRect;
    expect(badge.getAttribute("role")).toBe("button");
    expect(badge.getAttribute("tabindex")).toBe("0");
    expect(badge.closest('[aria-hidden="true"]')).toBeNull();
    expect(badge.querySelector("title")?.textContent).toContain("E/Z was not specified");
    if (keyboard) {
      await selectBond(mol, bond);
      badge = container.querySelector<SVGGElement>("[data-unspecified-bond-id]")!;
      badge.getBoundingClientRect = () => ({ left: 30, bottom: 50 }) as DOMRect;
      canvas.focus(); await key("Tab");
      expect(document.activeElement).toBe(badge);
      await key(keyboard);
    } else await act(async () => {
      for (const type of ["pointerdown", "pointerup", "click"]) {
        badge.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
      }
    });
    expect(currentWindowLogicalPosition).toHaveBeenCalledWith("inner");
    expect(openToolsetPopoverWindow).toHaveBeenCalledWith("core.bondStereo", "flyout", 130, 254, keyboard ? "focus" : "preserve");
    const content = vi.mocked(setToolsetPopoverContent).mock.calls.at(-1)![1];
    expect(setToolsetPopoverContent).toHaveBeenLastCalledWith("core.bondStereo", expect.anything(), { x: 130, y: 254 });
    if (content.kind !== "flyout") throw new Error("Expected flyout");
    expect(content.flyout).toMatchObject({ variant: "bondStereo", title: "E/Z not specified", keyboardOpen: !!keyboard });
    expect(content.flyout.commands.map(c => c.title)).toEqual(["Use drawn geometry (E)", "Use the other geometry (Z)"]);
    await act(async () => nativePopover.request?.("core.bondStereo"));
    expect(vi.mocked(setToolsetPopoverContent).mock.calls.at(-1)![1]).toEqual(content);
    return { original: molecule(), bond, content };
  }
  it("survives the opening press's delayed broadcast, but closes on a later press", async () => {
    const { doc } = drawing("CC=CC", true);
    // Use MainWindow's real window-capture listener, queuing its asynchronous
    // broadcast separately from the badge's React capture/click handlers.
    await mount(doc, platform, true);
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    const badge = container.querySelector<SVGGElement>("[data-unspecified-bond-id]")!;
    badge.getBoundingClientRect = () => ({ left: 30, bottom: 50 }) as DOMRect;
    await act(async () => badge.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 })));
    expect(dismissToolsetPopovers).toHaveBeenCalledTimes(1);
    expect(openToolsetPopoverWindow).not.toHaveBeenCalled();
    now.mockReturnValue(200);
    await act(async () => {
      badge.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
      badge.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    expect(openToolsetPopoverWindow).toHaveBeenCalledTimes(1);
    expect(setToolsetPopoverContent).toHaveBeenCalledTimes(1);
    const originalContent = vi.mocked(setToolsetPopoverContent).mock.calls[0][1];
    await act(async () => nativePopover.dismiss?.(nativePopover.pendingDismisses.shift()));
    expect(closeToolsetPopoverWindow).not.toHaveBeenCalled();
    // A live session must still answer startup content requests after the stale event.
    await act(async () => nativePopover.request?.("core.bondStereo"));
    expect(setToolsetPopoverContent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(setToolsetPopoverContent).mock.calls[1][1]).toEqual(originalContent);
    expect(dismissToolsetPopovers).toHaveBeenCalledWith(performance.timeOrigin + 100);

    now.mockReturnValue(300);
    // A later press in another palette reaches this window only via its broadcast.
    await dismissToolsetPopovers(performance.timeOrigin + performance.now());
    await act(async () => nativePopover.dismiss?.(nativePopover.pendingDismisses.shift()));
    expect(closeToolsetPopoverWindow).toHaveBeenCalledWith("core.bondStereo");
    await act(async () => nativePopover.request?.("core.bondStereo"));
    expect(setToolsetPopoverContent).toHaveBeenCalledTimes(2);
  });
  it.each(["geometry", "flipped"] as const)("%s invokes once, selects the bond and records exactly one labelled undo step", async action => {
    const { original, bond, content } = await openBadge();
    const invoke = vi.spyOn(CommandRegistry.prototype, "invoke");
    const payload = { sessionId: content.flyout.id!, action };
    await act(async () => { nativePopover.action?.(payload); nativePopover.action?.(payload); });
    expect(invoke.mock.calls.filter(([id]) => id === moleculeBondStereoCommandId(action))).toHaveLength(1);
    expect(molecule().bonds.find(b => b.id === bond.id)?.stereo).toBeUndefined();
    expect(perceiveDoubleBondStereoFromMolfile(molecule().structure)[0].descriptor).toBe(action === "geometry" ? "E" : "Z");
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().selectedNativeMoleculePart).toMatchObject({ kind: "bond", bondId: bond.id });
    expect(document.activeElement).toBe(canvas);
    await command("edit.undo"); expect(molecule()).toEqual(original);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(action === "geometry" ? "Undid Use drawn geometry" : "Undid Use the other geometry");
    await command("edit.undo"); expect(molecule()).toEqual(original);
    await command("edit.redo");
    expect(molecule().bonds.find(b => b.id === bond.id)?.stereo).toBeUndefined();
  });
  it.each(["keep", "escape", "click-away", "palette-away"] as const)("%s closes, returns canvas focus and does not edit or record undo", async action => {
    const { original, content } = await openBadge(action === "escape" ? "Enter" : undefined);
    await act(async () => {
      if (action === "keep") nativePopover.action?.({ sessionId: content.flyout.id!, action: "keep" });
      if (action === "escape") canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      if (action === "click-away") canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      if (action === "palette-away") nativePopover.dismiss?.();
    });
    expect(closeToolsetPopoverWindow).toHaveBeenCalledWith("core.bondStereo");
    expect(document.activeElement).toBe(canvas); expect(molecule()).toEqual(original);
    await command("edit.undo"); expect(molecule()).toEqual(original);
  });
  it("opens with Space through the canvas Tab path and never exports the badge/popover", async () => {
    await openBadge(" ");
    const doc = window.__CHEMDRAFT_AGENT__!.snapshot().document;
    vi.stubGlobal("getComputedStyle", window.getComputedStyle.bind(window));
    const pdf = await exportPhase4Pdf(doc, { compress: false });
    for (const output of [exportPhase4Svg(doc).contents, exportPhase4Cdxml(doc).contents, new TextDecoder().decode(pdf.bytes)]) {
      expect(output).not.toContain("native-bond-stereo-marker"); expect(output).not.toContain("E/Z not specified");
      expect(output).not.toContain("This double bond"); expect(output).not.toMatch(/>!<|\(!\) Tj/);
    }
    expect(container.querySelector('[role="dialog"][aria-label="E/Z not specified"]')).toBeNull();
    const css = readFileSync(resolve("apps/desktop/src/App.css"), "utf8");
    expect(css).toMatch(/@media print\s*\{\s*\.native-bond-stereo-marker\s*\{\s*display: none !important/);
  });

  it("cancels a cold open before opening a new session, without stale content or writes", async () => {
    const { doc } = drawing("CC=CC", true);
    await mount(doc, platform);
    let finishOpen!: () => void;
    vi.mocked(openToolsetPopoverWindow).mockImplementationOnce(() => new Promise<void>(resolve => { finishOpen = resolve; }));
    const clickBadge = () => container.querySelector<SVGGElement>("[data-unspecified-bond-id]")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await act(async () => { clickBadge(); });
    expect(setToolsetPopoverContent).not.toHaveBeenCalled();
    await act(async () => canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    await act(async () => { clickBadge(); });
    expect(openToolsetPopoverWindow).toHaveBeenCalledTimes(1);
    await act(async () => finishOpen());
    expect(openToolsetPopoverWindow).toHaveBeenCalledTimes(2);
    expect(setToolsetPopoverContent).toHaveBeenCalledTimes(1);
    const content = vi.mocked(setToolsetPopoverContent).mock.calls[0][1];
    if (content.kind !== "flyout") throw new Error("Expected flyout");
    await act(async () => nativePopover.action?.({ sessionId: "stale-session", action: "flipped" }));
    expect(molecule().bonds.some(bond => bond.stereo === "either")).toBe(true);
    await act(async () => nativePopover.action?.({ sessionId: content.flyout.id!, action: "geometry" }));
    expect(molecule().bonds.every(bond => bond.stereo === undefined)).toBe(true);
  });

  it("dismisses on a document edit and rejects the old action", async () => {
    const { content } = await openBadge();
    await command("edit.selectAll");
    const current = molecule();
    const invoke = vi.spyOn(CommandRegistry.prototype, "invoke");
    await act(async () => nativePopover.action?.({ sessionId: content.flyout.id!, action: "flipped" }));
    expect(invoke.mock.calls.filter(([id]) => id === moleculeBondStereoCommandId("flipped"))).toHaveLength(0);
    expect(molecule()).toEqual(current);
  });
});
