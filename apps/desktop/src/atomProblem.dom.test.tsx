// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Molecule } from "openchemlib";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { atomProblem, nativeAtomLabelReading, nativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { AtomProblemMarker } from "./AtomProblemMarker";
import { atomProblemCommandId } from "./atomProblemCommands";
import { problemDocument, problemMolecule } from "./testSupport/atomProblemFixtures";
import { MemoryStorage } from "./testSupport/memoryStorage";
import type { DialogDelivery } from "./dialogs/dialogTransport";
import { dialogEnvelope, type DialogMessage, type DialogSnapshot } from "./dialogs/dialogProtocol";

const native = vi.hoisted(() => ({ receive: undefined as ((delivery: DialogDelivery) => void) | undefined,
  open: vi.fn(), publish: vi.fn(), close: vi.fn() }));
vi.mock("./dialogs/dialogTransport", () => ({ nativeDialogTransport: {
  subscribe: async (receive: typeof native.receive) => { native.receive = receive; return () => { native.receive = undefined; }; },
  open: native.open, publish: native.publish, close: native.close
} }));
vi.mock("./window-manager", async original => ({ ...await original<typeof import("./window-manager")>(), isDesktopRuntime: () => true }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

let root: Root, container: HTMLDivElement;
let snapshot: DialogSnapshot;
const target = { objectId: "problem_molecule", atomId: "a0" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.spyOn(window, "focus").mockImplementation(() => {});
  window.history.replaceState(null, "", "/?agentBridge=1");
  native.open.mockImplementation(async (s: DialogSnapshot) => { snapshot = s; return { hostId: "opaque", windowLabel: "dialog-main-atomProblem-1" }; });
  native.publish.mockImplementation(async (_id: string, s: DialogMessage) => { if (s.type === "snapshot") snapshot = s; });
  native.close.mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.__CHEMDRAFT_AGENT__;
  window.history.replaceState(null, "", "/");
});
async function mount(document: ChemDraftDocument) {
  await act(async () => root.render(createElement(MainWindow, { initialDocument: document, initialActiveToolCommandId: "tool.select",
    initialCrosshairsVisible: false, initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true })));
}
const current = () => window.__CHEMDRAFT_AGENT__!.snapshot();
const molecule = () => current().document.pages[0]!.objects.find(o => o.id === target.objectId) as MoleculeObject;
const badge = () => container.querySelector<SVGGElement>(`[data-invalid-atom-id="${target.atomId}"]`)!;
async function command(id: string) { await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(id); }); }
async function deliver(type: "ready" | "action", data: object) {
  await act(async () => { native.receive!({ senderWindowId: "dialog-main-atomProblem-1", windowLabel: "dialog-main-atomProblem-1",
    message: { ...dialogEnvelope(snapshot), requestId: crypto.randomUUID(), type, data } }); });
}
describe.each(["MacIntel", "Win32"])("problem marker (%s shortcut host)", platform => {
  it.each(["click", "Enter", " "])("%s activates its registered command once without editing", async activation => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    await mount(problemDocument());
    const before = current().document;
    expect(badge().getAttribute("tabindex")).toBe("0");
    await act(async () => {
      badge().focus();
      expect(document.activeElement).toBe(badge());
      badge().dispatchEvent(activation === "click" ? new MouseEvent("click", { bubbles: true })
        : new KeyboardEvent("keydown", { key: activation, bubbles: true, cancelable: true }));
    });
    expect(native.open).toHaveBeenCalledTimes(1);
    expect(snapshot.dialogKind).toBe("atomProblem");
    expect(badge().dataset.commandId).toBe(atomProblemCommandId(target));
    expect(current().document).toEqual(before);
    expect(container.querySelector("main")!.dataset.canUndo).toBe("false");
    expect(container.querySelector('[role="dialog"][aria-label="Atom problem"]')).toBeNull();
  });
});
it.each([
  ["hydrogens", problemMolecule("S", ["O", "C"], ["double", "single"]), "C[SH]=O", 0, 1],
  ["hydrogens", problemMolecule("OH2"), "CO", 0, 1],
  ["charge", problemMolecule("N", ["Ru", "C", "C"], ["double", "single", "single"]), "C[N+](C)=[Ru]", 1, undefined]
] as const)("native %s is one labelled Undo, leaves the atom selected, and updates the problem", async (action, source, smiles, charge, hydrogens) => {
  await mount(problemDocument(source));
  const beforeAtoms = molecule().atoms;
  await command(atomProblemCommandId(target));
  await deliver("ready", {});
  expect(snapshot.dialogKind).toBe("atomProblem");
  if (snapshot.dialogKind !== "atomProblem") throw new Error("Expected problem window");
  await deliver("action", { action, targetVersion: snapshot.data.targetVersion });
  expect(container.querySelector('[role="status"]')!.textContent).toContain(action === "charge"
    ? 'Formal charge set to +1 for "N"' : `Explicit hydrogens set to 1 for "${source.atoms[0]!.element}"`);
  expect(molecule().atoms[0]!.formalCharge).toBe(charge);
  if (hydrogens !== undefined) expect(nativeAtomLabelReading(molecule().atoms[0]!.element)).toMatchObject({ kind: "spelled", hydrogens });
  expect(Molecule.fromSmiles(nativeSingleBondGraphSmiles(molecule().atoms, molecule().bonds)).toIsomericSmiles()).toBe(Molecule.fromSmiles(smiles).toIsomericSmiles());
  expect(current().selectedNativeMoleculePart).toMatchObject({ kind: "atom", ...target });
  expect(current().selection.objectIds).toEqual([target.objectId]);
  expect(badge()).toBeNull();
  expect(native.close).toHaveBeenCalledTimes(1);
  await command("edit.undo");
  expect(container.querySelector('[role="status"]')!.textContent).toContain(action === "charge" ? "Undid Set formal charge to +1" : "Undid Set explicit hydrogens to 1");
  expect(molecule().atoms).toEqual(beforeAtoms);
  expect(badge()).not.toBeNull();
  expect(container.querySelector("main")!.dataset.canUndo).toBe("false");
  await command("edit.redo");
  expect(badge()).toBeNull();
});
it("Ignore hides only the badge; context-menu Restore works for a suppressed invalid atom in one Undo", async () => {
  await mount(problemDocument());
  await command(atomProblemCommandId(target)); await deliver("ready", {});
  if (snapshot.dialogKind !== "atomProblem") throw new Error("Expected problem window");
  await deliver("action", { action: "ignore", targetVersion: snapshot.data.targetVersion });
  expect(container.querySelector('[role="status"]')!.textContent).toContain('Warning ignored for "C"');
  expect(badge()).toBeNull();
  expect(atomProblem(molecule(), "a0")!.state).toMatchObject({ valid: false, warningSuppressed: true });
  expect(native.close).toHaveBeenCalledTimes(1);
  const atom = molecule().atoms[0]!;
  const page = container.querySelector<HTMLElement>(".page")!;
  page.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) });
  const object = container.querySelector(`[data-object-id="${target.objectId}"]`)!;
  await act(async () => { object.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: atom.x, clientY: atom.y })); });
  const menu = container.querySelector<HTMLButtonElement>(`[role="menuitem"][data-command-id="${atomProblemCommandId(target)}"]`);
  expect(menu).not.toBeNull();
  await act(async () => menu!.click());
  expect(native.open).toHaveBeenCalledTimes(2);
  await deliver("ready", {});
  const version = snapshot.data.targetVersion;
  await deliver("action", { action: "restore", targetVersion: version });
  expect(container.querySelector('[role="status"]')!.textContent).toContain('Warning restored for "C"');
  expect(badge()).not.toBeNull();
  expect(atomProblem(molecule(), "a0")!.state.valid).toBe(false);
  expect(native.close).toHaveBeenCalledTimes(1);
  expect(snapshot.data.fixes).toEqual(expect.arrayContaining([{ action: "ignore", label: "Ignore warning" }]));
  await command("edit.undo"); expect(badge()).toBeNull();
  expect(container.querySelector('[role="status"]')!.textContent).toContain("Undid Restore warning");
  await command("edit.undo"); expect(badge()).not.toBeNull();
  expect(container.querySelector('[role="status"]')!.textContent).toContain("Undid Ignore warning");
  expect(container.querySelector("main")!.dataset.canUndo).toBe("false");
});
describe.each(["MacIntel", "Win32"])("problem completion (%s)", platform => {
  it("updates the same window while the restored warning remains, then closes after its fix", async () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    const source = problemMolecule("N", Array(4).fill("C"));
    source.atoms[0]!.warningSuppressed = true;
    await mount(problemDocument(source));
    await command(atomProblemCommandId(target));
    await deliver("ready", {});
    if (snapshot.dialogKind !== "atomProblem") throw new Error("Expected problem window");
    const version = snapshot.data.targetVersion;
    await deliver("action", { action: "restore", targetVersion: version });
    expect(native.close).not.toHaveBeenCalled();
    expect(native.open).toHaveBeenCalledTimes(1);
    expect(snapshot.data.targetVersion).toBeGreaterThan(version);
    expect(snapshot.data.fixes.map(fix => fix.action)).toContain("charge");
    expect(snapshot.data.fixes.map(fix => fix.action)).toContain("ignore");
    expect(snapshot.data.fixes.map(fix => fix.action)).not.toContain("restore");
    await deliver("action", { action: "charge", targetVersion: snapshot.data.targetVersion });
    expect(native.close).toHaveBeenCalledExactlyOnceWith("opaque", "close");
  });
  it.each([
    ["ignore", problemMolecule("N", Array(4).fill("C"))],
    ["ignore", problemMolecule("OH2")],
    ["charge", problemMolecule("N", Array(4).fill("C"))],
    ["hydrogens", problemMolecule("OH2")]
  ] as const)("closes after %s even when the warning offers a suggested fix", async (action, source) => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    await mount(problemDocument(source));
    await command(atomProblemCommandId(target));
    await deliver("ready", {});
    if (snapshot.dialogKind !== "atomProblem") throw new Error("Expected problem window");
    expect(snapshot.data.fixes.some(fix => fix.action === "charge" || fix.action === "hydrogens")).toBe(true);
    await deliver("action", { action, targetVersion: snapshot.data.targetVersion });
    expect(badge()).toBeNull();
    expect(native.close).toHaveBeenCalledExactlyOnceWith("opaque", "close");
  });
});
it("stops drawing gestures at the marker even with the bond tool active", async () => {
  await mount(problemDocument()); await command("tool.bond.single");
  const before = current().document;
  await act(async () => {
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 169, clientY: 151 });
      Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } }); badge().dispatchEvent(event);
    }
    badge().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(current().document).toEqual(before);
  expect(native.open).toHaveBeenCalledTimes(1);
});
it("closes after the target is deleted", async () => {
  await mount(problemDocument());
  await command(atomProblemCommandId(target)); await deliver("ready", {});
  await command("edit.selectAll");
  await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
  expect(current().document.pages[0]!.objects).toHaveLength(0);
  expect(native.close).toHaveBeenCalledTimes(1);
});
it("applies to the originating inactive tab with its atom selection and one Undo", async () => {
  await mount(problemDocument(problemMolecule("N", Array(4).fill("C"))));
  await command(atomProblemCommandId(target)); await deliver("ready", {});
  if (snapshot.dialogKind !== "atomProblem") throw new Error("Expected problem window");
  const version = snapshot.data.targetVersion;
  await command("document.new");
  expect(current().document.pages[0]!.objects).toHaveLength(0);
  await deliver("action", { action: "charge", targetVersion: version });
  expect(current().document.pages[0]!.objects).toHaveLength(0);
  await command("document.activateTab.initial");
  expect(container.querySelector('[role="status"]')!.textContent).toContain('Formal charge set to +1 for "N"');
  expect(molecule().atoms[0]!.formalCharge).toBe(1);
  expect(current().selectedNativeMoleculePart).toMatchObject({ kind: "atom", ...target });
  await command("edit.undo");
  expect(molecule().atoms[0]!.formalCharge).toBe(0);
  expect(container.querySelector("main")!.dataset.canUndo).toBe("false");
});
it.each(["dialog", "context command"])("reports the drawn label for an ignored warning through the %s", async route => {
  await mount(problemDocument(problemMolecule("Phe")));
  if (route === "dialog") {
    await command(atomProblemCommandId(target)); await deliver("ready", {});
    if (snapshot.dialogKind !== "atomProblem") throw new Error("Expected problem window");
    await deliver("action", { action: "ignore", targetVersion: snapshot.data.targetVersion });
  } else await command(atomProblemCommandId(target, "ignore"));
  expect(container.querySelector('[role="status"]')!.textContent).toContain('Warning ignored for "Phe"');
});
it("the standalone SVG marker consumes key repeat and Space scrolling", async () => {
  const invoke = vi.fn();
  await act(async () => root.render(createElement("svg", null, createElement(AtomProblemMarker, { target, x: 1, y: 2, invoke }))));
  const event = new KeyboardEvent("keydown", { key: " ", repeat: true, bubbles: true, cancelable: true });
  await act(async () => badge().dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true); expect(invoke).not.toHaveBeenCalled();
});
