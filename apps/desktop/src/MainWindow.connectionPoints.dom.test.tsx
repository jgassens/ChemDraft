// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { applyPatch, MoleculeObjectSchema } from "@chemdraft/chem-core";
import { PluginApiVersion, type PluginCommandContext } from "@chemdraft/plugin-api";
import { ensureRdkit, resetRdkitForTesting, setRdkitModuleLoader } from "@chemdraft/rdkit-adapter";
import appConfig from "../src-tauri/tauri.conf.json";
import appCancelled from "./appHandoff/__fixtures__/wire/choose-app-cancelled.json";
import appChosen from "./appHandoff/__fixtures__/wire/choose-app-chosen.json";
import overlappingChoice from "./appHandoff/__fixtures__/wire/choose-app-request-overlapping.json";
import retryChoice from "./appHandoff/__fixtures__/wire/choose-app-request-retry.json";
import type { ListenForAppHandoff } from "./appHandoff/nativeMenu";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { createPhase4Document } from "./documentWorkflow";
import { MainWindow } from "./MainWindow";
import { deferred } from "./testSupport/deferred";
import { installDomRdkitLoader } from "./testSupport/rdkitIdentity";
import { DOM_COMMAND_EVENT } from "./window-manager";

const captured = vi.hoisted(() => ({ runtime: undefined as import("./plugins/createPluginRuntime").DesktopPluginRuntime | undefined }));
const host = vi.hoisted(() => ({ native: false, getVersion: vi.fn(), transport: vi.fn() }));
const handoffRecord = { id: "org.chemdraft.handoff.crystalBuilder", version: "1", source: "catalog" as const,
  repository: "jgassens/ChemDraft-CrystalBuilder-Plugin", checksumVerified: true };
vi.mock("@tauri-apps/api/app", () => ({ getVersion: host.getVersion }));
vi.mock("./plugins/pluginStagingFs", async original => ({
  ...await original<typeof import("./plugins/pluginStagingFs")>(),
  isTauriHost: () => host.native
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./plugins/createPluginRuntime", async original => {
  const actual = await original<typeof import("./plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: import("./plugins/createPluginRuntime").DesktopPluginRuntimeOptions) =>
    captured.runtime = actual.createPluginRuntime({ ...options, appHandoffTransport: host.transport,
      appHandoffProvenance: { forRegistration: () => handoffRecord, forCall: () => handoffRecord } }) };
});
vi.mock("./chemistry3d/client", async original => {
  const actual = await original<typeof import("./chemistry3d/client")>();
  const { auditHandoffGraph } = await import("./chemistry3d/handoffAudit");
  return { ...actual, runHandoffGraphInConformerWorker: auditHandoffGraph };
});
vi.mock("./depiction2d/identityClient", async () => {
  const { inspectStructureInWorker } = await import("./depiction2d/identityInspect");
  return { inspectStructureOffThread: async (...[, value, stereoReference, signal, details]: Parameters<
    typeof import("./depiction2d/identityClient").inspectStructureOffThread>) => {
    signal?.throwIfAborted();
    return inspectStructureInWorker(await ensureRdkit(), value, stereoReference, details);
  } };
});

class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
let container: HTMLDivElement;
let root: Root;
const commandId = "plugin.test.mark";
const source = MoleculeObjectSchema.parse({
  type: "molecule", id: "linker", x: 90, y: 80, width: 80, height: 50, structure: "CCC", structureFormat: "smiles",
  atoms: [{ id: "a", element: "C", x: 100, y: 100 }, { id: "b", element: "C", x: 120, y: 112 },
    { id: "c", element: "C", x: 140, y: 100 }, { id: "no-valence", element: "He", x: 210, y: 170 }],
  bonds: [{ id: "ab", fromAtomId: "a", toAtomId: "b", order: "single" },
    { id: "bc", fromAtomId: "b", toAtomId: "c", order: "single" }]
});
const aromaticSource = MoleculeObjectSchema.parse({
  ...source, structure: "c1ccccc1",
  atoms: [[100, 100], [120, 112], [140, 100], [140, 76], [120, 64], [100, 76]].map(([x, y], i) =>
    ({ id: "abcdef"[i], element: "C", x, y })),
  bonds: [..."abcdef"].map((id, i) => ({
    id: `ring-${id}`, fromAtomId: id, toAtomId: "bcdefa"[i], order: i % 2 === 0 ? "double" : "single"
  }))
});

const present = () => getAssistantHistoryPort().read("initial")!;
const drawn = () => present().pages[0]!.objects.find(object => object.id === source.id) as typeof source;
const nativeSelection = () => [...container.querySelectorAll("[data-selected-atom-id]")]
  .map(element => element.getAttribute("data-selected-atom-id"));

beforeAll(() => installDomRdkitLoader(setRdkitModuleLoader));
afterAll(() => resetRdkitForTesting());
beforeEach(() => {
  host.native = false;
  host.getVersion.mockReset();
  host.transport.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLElement.prototype.hasPointerCapture = () => false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(molecule: typeof source, listenForAppHandoff?: ListenForAppHandoff, other?: typeof source) {
  const empty = createPhase4Document("Mark connection points");
  const pageId = empty.pages[0]!.id;
  const first = applyPatch(empty, { op: "addObject", pageId, object: molecule });
  const initialDocument = other ? applyPatch(first, { op: "addObject", pageId, object: other }) : first;
  await act(async () => root.render(createElement(MainWindow, { initialDocument, initialPaletteMode: "hidden",
    initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false, listenForAppHandoff })));
  container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) });
}

async function selectAtom(id: string) {
  const atom = drawn().atoms.find(atom => atom.id === id)!;
  await click(container.querySelector(`[data-object-id="${source.id}"]`)!, atom);
  expect(nativeSelection()).toEqual([id]);
}

async function marqueeAtom(id: string) {
  const { x, y } = drawn().atoms.find(atom => atom.id === id)!;
  const page = container.querySelector(".page")!;
  await act(async () => {
    for (const [type, offset] of [["pointerdown", -8], ["pointermove", 8], ["pointerup", 8]] as const) {
      page.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 42, button: 0, isPrimary: true,
        clientX: x + offset, clientY: y + offset, pointerType: "mouse", buttons: type === "pointerup" ? 0 : 1 }));
    }
  });
  expect(present().selection.objectIds).toEqual([]);
  expect(nativeSelection()).toContain(id);
}

async function click(target: Element, point: { x: number; y: number }) {
  await act(async () => {
    for (const type of ["pointerdown", "pointerup"]) {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 42, button: 0, isPrimary: true,
        clientX: point.x, clientY: point.y, pointerType: "mouse", buttons: type === "pointerdown" ? 1 : 0 }));
    }
  });
}

function register(handler: (context: PluginCommandContext) => unknown, apiVersion: string = PluginApiVersion) {
  const runtime = captured.runtime!;
  runtime.registerPlugin({ id: "org.test.mark", name: "Marker", version: "1", apiVersion, entry: "test.js",
    permissions: ["document.write", "selection.read", "chemistry.compute"],
    contributes: { commands: [{ id: commandId, title: "Mark" }] } },
  { commandHandlers: { [commandId]: handler } });
  return runtime;
}

async function menu(commandId: string) {
  await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
}

const otherMolecule = { ...aromaticSource, id: "other", x: aromaticSource.x + 200,
  atoms: aromaticSource.atoms.map(atom => ({ ...atom, id: `other-${atom.id}`, x: atom.x + 200 })),
  bonds: aromaticSource.bonds.map(bond => ({ ...bond,
    fromAtomId: `other-${bond.fromAtomId}`, toAtomId: `other-${bond.toAtomId}` })) };
const otherAtomIds = otherMolecule.atoms.map(atom => atom.id);
const drawnOther = () => present().pages[0]!.objects.find(object => object.id === otherMolecule.id);

/** Two clicks on the other molecule select it as a whole object; Shift adds it to the selection. */
async function selectOtherMolecule(shiftKey = false) {
  const { x, y } = otherMolecule.atoms[0]!;
  for (let count = 0; count < 2; count++) {
    // The first click re-renders the molecule; dispatch the second on the current element.
    const target = container.querySelector(`[data-object-id="${otherMolecule.id}"]`)!;
    await act(async () => {
      for (const type of ["pointerdown", "pointerup"]) {
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 42, button: 0, isPrimary: true, shiftKey,
          clientX: x, clientY: y, pointerType: "mouse", buttons: type === "pointerdown" ? 1 : 0 }));
      }
    });
  }
}

/** Marks `anchors` on the source molecule and returns the new marker atom IDs. */
async function markAnchors(anchors: string[]) {
  const existing = new Set(drawn().atoms.map(atom => atom.id));
  await act(async () => {
    const runtime = register(context => context.documents.addConnectionPoints!({ objectId: source.id, anchors }));
    await runtime.invokeCommand(commandId);
  });
  const markers = drawn().atoms.filter(atom => !existing.has(atom.id)).map(atom => atom.id);
  expect(markers).toHaveLength(anchors.length);
  expect(nativeSelection()).toEqual(markers);
  return markers;
}

it("captures selected atom IDs at command start and restores the single marking entry exactly", async () => {
  host.native = true;
  const runningVersion = "1.9.99";
  expect(runningVersion).not.toBe(appConfig.version);
  host.getVersion.mockResolvedValue(runningVersion);
  await render(aromaticSource);
  await selectAtom("a");
  const started = deferred<void>();
  const proceed = deferred<void>();
  let invocation!: Promise<unknown>;
  await act(async () => {
    const runtime = register(async context => {
      started.resolve();
      await proceed.promise;
      const selected = (await context.selection!.getSelection()).molecules[0]!;
      const result = await context.chemistry!.handoffGraph!({ objectId: selected.objectId });
      expect(context.host).toEqual({ name: "ChemDraft", version: runningVersion });
      expect(selected.selectedAtomIds).toEqual(["a"]);
      expect(result.graph.atoms.find(atom => atom.atomId === selected.selectedAtomIds![0])?.element).toBe("C");
      return context.documents.addConnectionPoints!({ objectId: selected.objectId, anchors: ["a", "c"] });
    });
    invocation = runtime.invokeCommand(commandId);
    await started.promise;
  });
  await selectAtom("c");
  const before = structuredClone(present());
  await act(async () => {
    proceed.resolve();
    await expect(invocation).resolves.toEqual({ applied: true, objectIds: [source.id] });
  });
  const after = structuredClone(present());
  const markerIds = drawn().atoms.filter(atom => atom.element === "X").map(atom => atom.id);
  expect(markerIds).toHaveLength(2);
  expect(nativeSelection()).toEqual(markerIds);
  expect(drawn().bonds.slice(aromaticSource.bonds.length)).toMatchObject([{ fromAtomId: "a", toAtomId: markerIds[0], order: "single" },
    { fromAtomId: "c", toAtomId: markerIds[1], order: "single" }]);
  const marked = (await ensureRdkit()).get_mol(drawn().structure);
  try { expect(marked?.get_smiles?.()).toBe("*c1cccc(*)c1"); } finally { marked?.delete(); }
  await click(container.querySelector(".page")!, { x: 400, y: 400 });
  expect(present().selection.objectIds).toEqual([]);
  await menu("edit.undo");
  expect(present()).toEqual(before);
  expect(nativeSelection()).toEqual(["c"]);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Mark connection points");
  await menu("edit.undo");
  expect(present()).toEqual(before);
  await menu("edit.redo");
  expect(present()).toEqual(after);
  expect(nativeSelection()).toEqual(markerIds);
});

it.each(["web", "native timeout"] as const)("omits host identity for %s", async mode => {
  host.native = mode === "native timeout";
  const lateVersion = deferred<string>();
  host.getVersion.mockReturnValue(lateVersion.promise);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await render(source);
    const handler = vi.fn((context: PluginCommandContext) => context.host);
    const runtime = register(handler);
    const invocation = runtime.invokeCommand(commandId);
    if (host.native) expect(handler).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    await expect(invocation).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
    expect(host.getVersion).toHaveBeenCalledTimes(Number(host.native));
    lateVersion.resolve("1.9.99");
    await vi.runOnlyPendingTimersAsync();
    await expect(runtime.invokeCommand(commandId)).resolves.toEqual(host.native
      ? { name: "ChemDraft", version: "1.9.99" } : undefined);
    expect(host.getVersion).toHaveBeenCalledTimes(Number(host.native));
  } finally {
    vi.useRealTimers();
  }
});

it.each(["none", "undo", "another picker"] as const)("clears only the picker refusal when a retry succeeds (newer status: %s)", async newerStatus => {
  const handoffCommand = "plugin.crystalBuilder.chooseApp";
  const invocation = { pluginId: handoffRecord.id, commandId: handoffCommand, nonce: "2".repeat(32) };
  const overlappingInvocation = { ...invocation, nonce: "3".repeat(32) };
  const retry = deferred<void>();
  const cancelled = deferred<void>();
  let click!: (proof: typeof invocation) => Promise<void>;
  await render(source, dispatch => { click = dispatch; return () => {}; });
  host.transport.mockResolvedValueOnce(appCancelled);
  let first = true;
  let command!: Promise<void>;
  await act(async () => {
    captured.runtime!.registerPlugin({ id: handoffRecord.id, version: handoffRecord.version,
      name: "Crystal Builder Plugin", apiVersion: PluginApiVersion,
      entry: "test.js", permissions: ["apps.handoff", "native.execute"],
      contributes: { commands: [{ id: handoffCommand, title: "Choose app" }],
        menus: [{ id: "menu.crystalBuilder.chooseApp", commandId: handoffCommand, title: "Choose app" }] } },
    { execution: "worker", commandHandlers: { [handoffCommand]: async ({ apps }) => {
      if (!first) {
        expect(await apps!.chooseApp(overlappingChoice)).toEqual(appCancelled);
        return;
      }
      first = false;
      expect(await apps!.chooseApp({ purpose: "Choose an app" })).toEqual(appCancelled);
      cancelled.resolve();
      await retry.promise;
      expect(await apps!.chooseApp(retryChoice)).toEqual(appChosen);
    } } });
    command = click(invocation);
    await cancelled.promise;
  });
  const status = () => container.querySelector('[role="status"]')?.textContent;
  expect(status()).toBe("App selection cancelled.");
  if (newerStatus === "undo") {
    await menu("edit.undo");
    expect(status()).toBe("Nothing to undo");
  } else if (newerStatus === "another picker") {
    host.transport.mockResolvedValueOnce(appCancelled);
    await act(async () => { await click(overlappingInvocation); });
    expect(host.transport).toHaveBeenLastCalledWith(overlappingInvocation, "chooseApp", overlappingChoice);
    expect(status()).toBe("App selection cancelled.");
  }
  const expectedStatus = newerStatus === "none" ? "" : status();
  host.transport.mockResolvedValueOnce(appChosen);
  await act(async () => { retry.resolve(); await command; });
  expect(host.transport).toHaveBeenCalledTimes(newerStatus === "another picker" ? 3 : 2);
  expect(host.transport).toHaveBeenLastCalledWith(invocation, "chooseApp", retryChoice);
  expect(status()).toBe(expectedStatus);
});

it.each([
  ["unrecognized label", "FakeAbbr", "written as R-group placeholder"],
  ["multiline label", "Abbrev\nFile approved.\u2028End\u200b\u0007", "Abbrev File approved. End"],
  ["long label", "Abbrev" + "z".repeat(550), "…"]
])("attributes unsupported-label warnings from the captured selection (%s)", async (_name, label, expected) => {
  const handoffCommand = "plugin.crystalBuilder.sendMolecule";
  const invocation = { pluginId: handoffRecord.id, commandId: handoffCommand, nonce: "2".repeat(32) };
  let click!: () => Promise<void>;
  await render({ ...source, structure: "", atoms: [{ ...source.atoms[0]!, element: label }], bonds: [] },
    dispatch => { click = () => dispatch(invocation); return () => {}; });
  await selectAtom("a");
  host.transport.mockResolvedValue({ status: "sent" });
  await act(async () => {
    captured.runtime!.registerPlugin({ id: handoffRecord.id, version: handoffRecord.version,
      name: "Crystal Builder Plugin", apiVersion: PluginApiVersion,
      entry: "test.js", permissions: ["apps.handoff", "native.execute", "selection.read"],
      contributes: { commands: [{ id: handoffCommand, title: "Send" }],
        menus: [{ id: "menu.crystalBuilder.sendMolecule", commandId: handoffCommand, title: "Send" }] } },
    { execution: "worker", commandHandlers: { [handoffCommand]: async context => {
      expect((await context.selection!.getSelection()).molecules[0]?.selectedAtomIds).toEqual(["a"]);
      await context.apps!.sendFile({ appId: "chosen", fileName: "model", extension: "cif", text: "data" });
      return { ok: true, data: { status: "File opened." } };
    } } });
    await click();
  });
  expect(host.transport).toHaveBeenCalledOnce();
  const lines = [...container.querySelectorAll("[data-status-message] .status-message-line")].map(el => el.textContent);
  expect(lines).toEqual([
    "Opened the handoff file in the chosen app.",
    "Plugin (Crystal Builder Plugin): File opened.",
    expect.stringMatching(/^Selection warning: Atom label "/)
  ]);
  expect(lines[2]).toContain(expected);
  expect(lines[2]).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
  expect([...lines[2]!.slice("Selection warning: ".length)].length).toBeLessThanOrEqual(501);
});

it("refuses an RDKit valence failure in a batch without changing the drawing or selection", async () => {
  await render({ ...aromaticSource, structure: "c1ccccc1.[He]", atoms: [...aromaticSource.atoms, source.atoms[3]!] });
  await selectAtom("a");
  const before = present();
  await act(async () => {
    const runtime = register(context => context.documents.addConnectionPoints!({ objectId: source.id, anchors: ["a", "no-valence"] }));
    await expect(runtime.invokeCommand(commandId)).rejects.toThrow(/Atom "no-valence" has no free valence/);
  });
  expect(present()).toBe(before);
  expect(nativeSelection()).toEqual(["a"]);
  await menu("edit.undo");
  expect(present()).toBe(before);
});

it("reads live marked content under fixed IDs and undoes and redoes two separate marks", async () => {
  await render(aromaticSource);
  await marqueeAtom("a");
  const before = present();
  const beforeSelection = nativeSelection();
  let markCount = 0;
  const handler = async (context: PluginCommandContext) => {
    const selection = await context.selection!.getSelection();
    const [selected] = selection.molecules;
    const anchor = selected!.selectedAtomIds![0]!;
    expect(selected!.selectedAtomIds).toEqual([markCount === 0 ? "a" : "c"]);
    const request = { objectId: selected!.objectId };
    const graph = () => context.chemistry!.handoffGraph!(request);
    expect((await graph()).graph.atoms.filter(atom => atom.isConnectionPoint)).toHaveLength(markCount);
    expect(await context.documents.addConnectionPoints!({ ...request, anchors: [anchor] })).toEqual({ applied: true, objectIds: [source.id] });
    markCount++;
    expect((await graph()).graph.atoms.filter(atom => atom.isConnectionPoint)).toHaveLength(markCount);
    const updated = await context.selection!.getSelection();
    expect(updated.objectIds).toEqual(selection.objectIds);
    expect(updated.molecules[0]!.selectedAtomIds).toEqual([anchor]);
    expect(updated.molecules[0]!.connectionPoints).toHaveLength(markCount);
    if (markCount === 1) {
      const marked = present();
      await expect(context.documents.addConnectionPoints!({ ...request, anchors: ["c"] })).rejects.toThrow(/changed/);
      expect(present()).toEqual(marked);
    }
  };
  let runtime!: ReturnType<typeof register>;
  await act(async () => {
    runtime = register(handler);
    await runtime.invokeCommand(commandId);
  });
  const first = present();
  await selectAtom("c");
  const beforeSecond = present();
  await act(async () => { await runtime.invokeCommand(commandId); });
  const second = present();
  const ids = drawn().atoms.filter(atom => atom.element === "X").map(atom => atom.id);
  expect(ids).toHaveLength(2);
  expect(nativeSelection()).toEqual([ids[1]]);
  await menu("edit.undo");
  expect(present()).toEqual(beforeSecond);
  expect(nativeSelection()).toEqual(["c"]);
  await menu("edit.undo");
  expect(present()).toEqual(before);
  expect(nativeSelection()).toEqual(beforeSelection);
  await menu("edit.redo");
  expect(present()).toEqual(first);
  expect(nativeSelection()).toEqual([ids[0]]);
  await menu("edit.redo");
  expect(present()).toEqual(second);
  expect(nativeSelection()).toEqual([ids[1]]);
});

it("preserves an atom selection through an ordinary nudge, undo, and redo", async () => {
  await render(aromaticSource);
  await selectAtom("a");
  const originalX = drawn().atoms[0]!.x;
  await menu("selection.nudge.right.large");
  expect(drawn().atoms[0]!.x).toBe(originalX + 10);
  expect(nativeSelection()).toEqual(["a"]);
  await menu("edit.undo");
  expect(drawn().atoms[0]!.x).toBe(originalX);
  expect(nativeSelection()).toEqual(["a"]);
  await menu("edit.redo");
  expect(drawn().atoms[0]!.x).toBe(originalX + 10);
  expect(nativeSelection()).toEqual(["a"]);
});

it("keeps the redone markers selected through redo of a later whole-object edit, as a live atom selection is kept", async () => {
  await render(aromaticSource, undefined, otherMolecule);
  await selectAtom("a");
  const [markerId] = await markAnchors(["a"]);
  await selectOtherMolecule();
  expect(present().selection.objectIds).toEqual([otherMolecule.id]);
  expect(nativeSelection()).toEqual(otherAtomIds);
  await menu("selection.nudge.right.large");
  const after = present();
  expect(drawnOther()?.x).toBe(otherMolecule.x + 10);
  await menu("edit.undo");
  await menu("edit.undo");
  expect(nativeSelection()).toEqual(["a"]);
  await menu("edit.redo");
  expect(nativeSelection()).toEqual([markerId]);
  await menu("edit.redo");
  expect(present()).toEqual(after);
  // Redoing an ordinary edit keeps the live parts that still exist (origin/main's behaviour, pinned
  // without any mark in the next test), so the markers stay selected beside the redone object.
  expect(nativeSelection()).toEqual([markerId, ...otherAtomIds]);
  const ring = drawn().atoms.filter(atom => atom.id !== markerId);
  const other = drawnOther();
  await menu("edit.forwardDeleteHoveredNativeTarget");
  // Delete acts on the selected marker first (its label), never on the ring.
  expect(drawn().atoms.filter(atom => atom.id !== markerId)).toEqual(ring);
  expect(drawn().atoms.find(atom => atom.id === markerId)?.element).not.toBe("X");
  expect(drawnOther()).toEqual(other);
});

it("keeps a live atom selection through redo of a whole-object edit with no mark anywhere (origin/main)", async () => {
  await render(aromaticSource, undefined, otherMolecule);
  await selectOtherMolecule();
  await menu("selection.nudge.right.large");
  const after = present();
  await menu("edit.undo");
  await selectAtom("a");
  await menu("edit.redo");
  expect(present()).toEqual(after);
  expect(nativeSelection()).toEqual(["a", ...otherAtomIds]);
  const other = drawnOther();
  await menu("edit.forwardDeleteHoveredNativeTarget");
  expect(drawn().atoms.map(atom => atom.id)).toEqual([..."bcdef"]);
  expect(drawnOther()).toEqual(other);
});

it("marks, nudges the marker with another molecule added to the selection, undoes and redoes; Delete acts on the selection only", async () => {
  await render(aromaticSource, undefined, otherMolecule);
  await selectAtom("a");
  const [markerId] = await markAnchors(["a"]);
  await selectOtherMolecule(true);
  expect(present().selection.objectIds).toEqual([source.id, otherMolecule.id]);
  expect(nativeSelection()).toEqual([markerId, ...otherAtomIds]);
  const ring = drawn().atoms.filter(atom => atom.id !== markerId);
  const markerX = drawn().atoms.find(atom => atom.id === markerId)!.x;
  await menu("selection.nudge.right.large");
  const nudged = present();
  expect(drawn().atoms.find(atom => atom.id === markerId)!.x).toBe(markerX + 10);
  expect(drawn().atoms.filter(atom => atom.id !== markerId)).toEqual(ring);
  expect(drawnOther()?.x).toBe(otherMolecule.x + 10);
  await menu("edit.undo");
  expect(drawn().atoms.find(atom => atom.id === markerId)!.x).toBe(markerX);
  expect(nativeSelection()).toEqual([markerId, ...otherAtomIds]);
  await menu("edit.redo");
  expect(present()).toEqual(nudged);
  expect(present().selection.objectIds).toEqual([source.id, otherMolecule.id]);
  expect(nativeSelection()).toEqual([markerId, ...otherAtomIds]);
  const other = drawnOther();
  await menu("edit.forwardDeleteHoveredNativeTarget");
  // Delete takes the selected marker's label first; no ring atom changes.
  expect(drawn().atoms.filter(atom => atom.id !== markerId)).toEqual(ring);
  expect(drawn().atoms.find(atom => atom.id === markerId)?.element).not.toBe("X");
  expect(drawnOther()).toEqual(other);
});

it.each([false, true])("selects an atom, nudges it, undoes and redoes (earlier mark: %s); Delete removes that atom only", async withMark => {
  await render(aromaticSource);
  let markers: string[] = [];
  if (withMark) {
    await selectAtom("a");
    markers = await markAnchors(["a"]);
  }
  await selectAtom("d");
  const dX = () => drawn().atoms.find(atom => atom.id === "d")!.x;
  const originalX = dX();
  await menu("selection.nudge.right.large");
  const nudged = present();
  expect(dX()).toBe(originalX + 10);
  await menu("edit.undo");
  expect(dX()).toBe(originalX);
  expect(nativeSelection()).toEqual(["d"]);
  await menu("edit.redo");
  expect(present()).toEqual(nudged);
  expect(nativeSelection()).toEqual(["d"]);
  const others = drawn().atoms.filter(atom => atom.id !== "d");
  await menu("edit.forwardDeleteHoveredNativeTarget");
  expect(drawn().atoms).toEqual(others);
  expect(drawn().atoms.map(atom => atom.id)).toEqual([..."abcef", ...markers]);
});

it("preserves live whole-object selection for a pre-0.1.28 plugin", async () => {
  await render({ ...source, atoms: source.atoms.filter(atom => atom.element !== "He") });
  const inspect = deferred<void>();
  const firstRead = deferred<void>();
  let initial: unknown;
  let final: Awaited<ReturnType<NonNullable<PluginCommandContext["selection"]>["getSelection"]>> | undefined;
  let invocation!: Promise<unknown>;
  await marqueeAtom("a");
  await act(async () => {
    const runtime = register(async context => {
      initial = await context.selection!.getSelection();
      firstRead.resolve();
      await inspect.promise;
      final = await context.selection!.getSelection();
    }, "^0.1.27");
    invocation = runtime.invokeCommand(commandId);
    await firstRead.promise;
  });
  await click(container.querySelector(`[data-object-id="${source.id}"]`)!, { x: 110, y: 106 });
  expect(present().selection.objectIds).toEqual([source.id]);
  await act(async () => { inspect.resolve(); await invocation; });
  expect(initial).toEqual({ objectIds: [], molecules: [] });
  expect(final?.objectIds).toEqual([source.id]);
  expect(final?.molecules[0]).toMatchObject({ objectId: source.id });
  expect(final?.molecules[0]).not.toHaveProperty("selectedAtomIds");
});

it.each([["A", 1], ["L", 1], ["*", 3]] as const)("refuses a retained CTAB symbol %s at the wrong identity or anchor %i", async (symbol, anchorIndex) => {
  const atoms = source.atoms.filter(atom => atom.element !== "He");
  await render({ ...source, atoms: [...atoms, { element: "X", id: "x0", x: 85, y: 115, formalCharge: 0 }],
    bonds: [...source.bonds, { id: "xa", fromAtomId: "a", toAtomId: "x0", order: "single" }],
    structureFormat: "molfile-v2000", structure: ["", "   ChemDraft", "", "  4  3  0  0  0  0  0  0  0  0999 V2000",
      ...[...atoms, { element: symbol, x: 85, y: 115 }].map(atom =>
        `${atom.x.toFixed(4).padStart(10)}${(-atom.y).toFixed(4).padStart(10)}    0.0000 ${atom.element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`),
      "  1  2  1  0  0  0  0", "  2  3  1  0  0  0  0", `  ${anchorIndex}  4  1  0  0  0  0`, "M  END", ""].join("\n") });
  await selectAtom("c");
  const before = present();
  await act(async () => {
    const runtime = register(context => context.documents.addConnectionPoints!({ objectId: source.id, anchors: ["c"] }));
    await expect(runtime.invokeCommand(commandId)).rejects.toThrow(/stored molfile-v2000.*cannot verify/);
  });
  expect(present()).toBe(before);
});

it("redoes a mark to its markers after a later repeat unit on the same molecule is undone", async () => {
  await render(aromaticSource);
  await selectAtom("a");
  await act(async () => {
    const runtime = register(context => context.documents.addConnectionPoints!({ objectId: source.id, anchors: ["a"] }));
    await runtime.invokeCommand(commandId);
  });
  const marked = present();
  const markerId = drawn().atoms.find(atom => atom.element === "X")!.id;
  expect(nativeSelection()).toEqual([markerId]);
  await selectAtom("d");
  await menu("bracket.repeatUnit.toggle");
  const repeated = present();
  expect(repeated.pages[0]!.objects.filter(object => object.type === "bracket")).toHaveLength(2);
  expect(nativeSelection()).toEqual([]);
  await menu("edit.undo");
  expect(present()).toEqual(marked);
  expect(nativeSelection()).toEqual(["d"]);
  await menu("edit.undo");
  expect(nativeSelection()).toEqual(["a"]);
  await menu("edit.redo");
  expect(present()).toEqual(marked);
  expect(nativeSelection()).toEqual([markerId]);
  await menu("edit.redo");
  expect(present()).toEqual(repeated);
  expect(nativeSelection()).toEqual([]);
});

it("leaves undo and redo of a later repeat-unit toggle across a selection-only Select All as origin/main does", async () => {
  await render(aromaticSource);
  await selectAtom("a");
  await act(async () => {
    const runtime = register(context => context.documents.addConnectionPoints!({ objectId: source.id, anchors: ["a"] }));
    await runtime.invokeCommand(commandId);
  });
  const marked = present();
  const markerId = drawn().atoms.find(atom => atom.element === "X")!.id;
  expect(nativeSelection()).toEqual([markerId]);
  await selectAtom("d");
  await menu("bracket.repeatUnit.toggle");
  const brackets = present().pages[0]!.objects.filter(object => object.type === "bracket").map(object => object.id);
  expect(brackets).toHaveLength(2);
  await menu("edit.selectAll");
  const selectedAll = present();
  expect(selectedAll.selection.objectIds.length).toBeGreaterThan(1);
  await menu("edit.undo");
  expect(present()).toEqual(marked);
  expect(nativeSelection()).toEqual(["d"]);
  await menu("edit.redo");
  expect(present()).toEqual(selectedAll);
  // Main restores the toggle's recorded selection only on the documents it recorded; redoing to the
  // Select All replacement keeps the live toggled atom. The mark plays no part in this step.
  expect(nativeSelection()).toEqual(["d"]);
  await menu("edit.undo");
  expect(present()).toEqual(marked);
  expect(nativeSelection()).toEqual(["d"]);
});

it("undoes and redoes a connection-point mark after a selection-only Select All", async () => {
  await render(aromaticSource);
  await selectAtom("a");
  const before = present();
  await act(async () => {
    const runtime = register(context => context.documents.addConnectionPoints!({ objectId: source.id, anchors: ["a"] }));
    await runtime.invokeCommand(commandId);
  });
  const marked = present();
  const markerId = drawn().atoms.find(atom => atom.element === "X")!.id;
  expect(nativeSelection()).toEqual([markerId]);
  await menu("edit.selectAll");
  expect(present().selection.objectIds).toEqual([source.id]);
  await menu("edit.undo");
  expect(present()).toEqual(before);
  expect(nativeSelection()).toEqual(["a"]);
  await menu("edit.redo");
  expect(present()).toEqual(marked);
  expect(nativeSelection()).toEqual([markerId]);
});

it("keeps the live atom selection when undoing and redoing a nudge after a mark on the same molecule", async () => {
  await render(aromaticSource);
  await selectAtom("a");
  await act(async () => {
    const runtime = register(context => context.documents.addConnectionPoints!({ objectId: source.id, anchors: ["a"] }));
    await runtime.invokeCommand(commandId);
  });
  const marked = present();
  const markerId = drawn().atoms.find(atom => atom.element === "X")!.id;
  expect(nativeSelection()).toEqual([markerId]);
  await selectAtom("d");
  const dX = () => drawn().atoms.find(atom => atom.id === "d")!.x;
  const originalX = dX();
  await menu("selection.nudge.right.large");
  expect(dX()).toBe(originalX + 10);
  expect(nativeSelection()).toEqual(["d"]);
  // The mark's recorded markers belong to redoing the mark, not to undoing a later edit.
  await menu("edit.undo");
  expect(dX()).toBe(originalX);
  expect(nativeSelection()).toEqual(["d"]);
  await menu("edit.redo");
  expect(dX()).toBe(originalX + 10);
  expect(nativeSelection()).toEqual(["d"]);
  await menu("edit.undo");
  expect(nativeSelection()).toEqual(["d"]);
  // Delete acts on the live selection, never on the marker.
  await menu("edit.forwardDeleteHoveredNativeTarget");
  expect(drawn().atoms.some(atom => atom.id === "d")).toBe(false);
  expect(drawn().atoms.some(atom => atom.id === markerId)).toBe(true);
  await menu("edit.undo");
  expect(present()).toEqual(marked);
  // Undoing the mark itself still restores the selection from before it, and redoing it the markers.
  await menu("edit.undo");
  expect(nativeSelection()).toEqual(["a"]);
  await menu("edit.redo");
  expect(present()).toEqual(marked);
  expect(nativeSelection()).toEqual([markerId]);
});

it("keeps a nudged marker selected through undo and redo, so Delete and a nudge act on the marker only", async () => {
  await render(aromaticSource);
  await selectAtom("a");
  const before = present();
  await act(async () => {
    const runtime = register(context => context.documents.addConnectionPoints!({ objectId: source.id, anchors: ["a"] }));
    await runtime.invokeCommand(commandId);
  });
  const marked = present();
  const markerId = drawn().atoms.find(atom => atom.element === "X")!.id;
  expect(nativeSelection()).toEqual([markerId]);
  const markerX = () => drawn().atoms.find(atom => atom.id === markerId)!.x;
  const ringX = () => drawn().atoms.filter(atom => atom.id !== markerId).map(atom => atom.x);
  const originalMarkerX = markerX();
  const originalRingX = ringX();
  await menu("selection.nudge.right.large");
  expect(markerX()).toBe(originalMarkerX + 10);
  expect(ringX()).toEqual(originalRingX);
  const nudged = present();
  await menu("edit.undo");
  expect(present()).toEqual(marked);
  expect(nativeSelection()).toEqual([markerId]);
  await menu("edit.redo");
  expect(present()).toEqual(nudged);
  expect(nativeSelection()).toEqual([markerId]);
  // Another nudge moves the marker only, never the whole molecule.
  await menu("selection.nudge.right.large");
  expect(markerX()).toBe(originalMarkerX + 20);
  expect(ringX()).toEqual(originalRingX);
  expect(nativeSelection()).toEqual([markerId]);
  // Delete with nothing hovered acts on the marker only (its label goes first), never the molecule.
  const ring = drawn().atoms.filter(atom => atom.id !== markerId);
  const marker = drawn().atoms.find(atom => atom.id === markerId);
  await menu("edit.forwardDeleteHoveredNativeTarget");
  expect(present().pages[0]!.objects.map(object => object.id)).toEqual([source.id]);
  expect(drawn().atoms.filter(atom => atom.id !== markerId)).toEqual(ring);
  expect(drawn().atoms.find(atom => atom.id === markerId)).not.toEqual(marker);
  await menu("edit.undo");
  await menu("edit.undo");
  await menu("edit.undo");
  expect(present()).toEqual(marked);
  expect(nativeSelection()).toEqual([markerId]);
  // Undoing and redoing the mark itself still restore its recorded selections.
  await menu("edit.undo");
  expect(present()).toEqual(before);
  expect(nativeSelection()).toEqual(["a"]);
  await menu("edit.redo");
  expect(present()).toEqual(marked);
  expect(nativeSelection()).toEqual([markerId]);
  await menu("edit.redo");
  expect(present()).toEqual(nudged);
  expect(nativeSelection()).toEqual([markerId]);
});

it("keeps a nudged atom selected through undo and redo after undoing a repeat-unit toggle", async () => {
  await render(aromaticSource);
  await selectAtom("d");
  const before = present();
  await menu("bracket.repeatUnit.toggle");
  const repeated = present();
  expect(repeated.pages[0]!.objects.filter(object => object.type === "bracket")).toHaveLength(2);
  expect(nativeSelection()).toEqual([]);
  await menu("edit.undo");
  expect(present()).toEqual(before);
  expect(nativeSelection()).toEqual(["d"]);
  const x = (id: string) => drawn().atoms.find(atom => atom.id === id)!.x;
  const others = () => drawn().atoms.filter(atom => atom.id !== "d").map(atom => atom.x);
  const originalX = x("d");
  const originalOthers = others();
  await menu("selection.nudge.right.large");
  expect(x("d")).toBe(originalX + 10);
  const nudged = present();
  await menu("edit.undo");
  expect(present()).toEqual(before);
  expect(nativeSelection()).toEqual(["d"]);
  await menu("edit.redo");
  expect(present()).toEqual(nudged);
  expect(nativeSelection()).toEqual(["d"]);
  await menu("selection.nudge.right.large");
  expect(x("d")).toBe(originalX + 20);
  expect(others()).toEqual(originalOthers);
  await menu("edit.forwardDeleteHoveredNativeTarget");
  expect(present().pages[0]!.objects.map(object => object.id)).toEqual([source.id]);
  expect(drawn().atoms.map(atom => atom.id)).toEqual([..."abcef"]);
});
