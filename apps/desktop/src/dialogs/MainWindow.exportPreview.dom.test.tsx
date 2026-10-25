// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MainWindow } from "../MainWindow";
import { applyNativeChainTool, createPhase4Document, selectDocumentObjects } from "../documentWorkflow";
import { saveExportPreviewEnabled } from "../exportPreviewSettings";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { DOM_COMMAND_EVENT, broadcastExportPreviewSettings } from "../window-manager";
import type { ChemDraftAgentBridge } from "../agentBridge";
import type { MoleculeObject } from "@chemdraft/chem-core";
import type { DialogMessage } from "./dialogProtocol";
import type { DialogDelivery } from "./dialogTransport";
import * as atomLabelDraft from "../atomLabelDraft";
import * as workflow from "../documentWorkflow";
import { perfProbe, startPerfProbe } from "../perf/runtime";
import { Window as TauriWindow } from "@tauri-apps/api/window";

const native = vi.hoisted(() => ({
  snapshot: undefined as DialogMessage | undefined, receive: undefined as ((message: DialogDelivery) => void) | undefined,
  publish: vi.fn(), invoke: vi.fn(), preferences: vi.fn().mockResolvedValue(undefined), events: new Map<string, (event: { payload: unknown }) => void>()
}));
vi.mock("./dialogTransport", () => ({ nativeDialogTransport: {
  subscribe: async (receive: typeof native.receive) => { native.receive = receive; return () => {}; },
  open: async (snapshot: DialogMessage) => { native.snapshot = snapshot; return { hostId: "host", windowLabel: "dialog-main-export-1" }; },
  publish: native.publish, close: async () => {}
} }));
vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("../window-manager", async original => ({
  ...await original<typeof import("../window-manager")>(), isDesktopRuntime: () => true,
  togglePreferencesWindow: native.preferences,
  loadDocumentSession: async () => undefined, saveDocumentSession: async () => {},
  loadToolsetLayoutState: async () => undefined, listToolsetWindowStates: async () => [],
  setToolbarsMenu: async () => {}, setQuitPromptEnabled: async () => {},
  listenForQuitFlushRequest: async () => () => {}, listenForQuitPromptRequest: async () => () => {}, listenForQuitSettings: async () => () => {}
}));
vi.mock("../window-manager/tauriEvents", async original => {
  const listen = async (name: string, handler: (event: { payload: unknown }) => void) => {
    native.events.set(name, handler); return () => { native.events.delete(name); };
  };
  return { ...await original<typeof import("../window-manager/tauriEvents")>(), listenTauriEvent: listen, listenCurrentWindowEvent: listen };
});
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), isTauri: () => false, invoke: native.invoke }));
let root: Root, container: HTMLDivElement;
const bridge = () => (window as Window & { __CHEMDRAFT_AGENT__: ChemDraftAgentBridge }).__CHEMDRAFT_AGENT__;
async function command(commandId: string) {
  await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
}
async function send(type: "action" | "ready", data: unknown) {
  await act(async () => native.receive!({ senderWindowId: "dialog-main-export-1", windowLabel: "dialog-main-export-1", message: { ...native.snapshot!, requestId: crypto.randomUUID(), type, data } }));
}
beforeEach(async () => {
  vi.clearAllMocks(); native.publish.mockResolvedValue(undefined); native.invoke.mockResolvedValue(null); native.events.clear();
  vi.stubGlobal("localStorage", new MemoryStorage()); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(window, "focus").mockImplementation(() => {});
  window.history.replaceState(null, "", "/?agentBridge=1");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const chain = applyNativeChainTool(createPhase4Document("Preview draft"), { x: 80, y: 300 }, { x: 700, y: 300 });
  await act(async () => root.render(createElement(MainWindow, {
    initialDocument: selectDocumentObjects(chain, chain.pages[0].id, []), initialActiveToolCommandId: "tool.select",
    initialPaletteMode: "hidden", initialCrosshairsVisible: false, initialRulersVisible: false, nativePalette: true
  })));
});
afterEach(() => { perfProbe?.stop(); act(() => root.unmount()); container.remove(); window.history.replaceState(null, "", "/"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("records Preferences shown and hidden without leaving either command pending", async () => {
  const frames = new Map<number, FrameRequestCallback>(); let id = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++id, callback); return id; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(key => { frames.delete(key); });
  const visible = vi.fn().mockResolvedValue(true);
  vi.spyOn(TauriWindow, "getByLabel").mockResolvedValue({ isVisible: visible } as unknown as TauriWindow);
  await startPerfProbe("preferences-test");
  for (const open of [true, false]) {
    visible.mockResolvedValue(open);
    await command("view.togglePreferences");
    for (const frame of [...frames.values()]) frame(0);
    frames.clear();
    const rows = (localStorage.getItem("chemdraft.perfLog") ?? "").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(rows.at(-1)).toMatchObject({ commandId: "view.togglePreferences", doneSignal: open ? "window-shown" : "command-finished" });
    const surfaces = rows.filter(row => row.window === "preferences");
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({ kind: "window-shown", doneSignal: "window-shown" });
  }
  expect(native.preferences).toHaveBeenCalledTimes(2);
});

it("records Plugin Manager only on real opens through the command handler", async () => {
  const frames = new Map<number, FrameRequestCallback>(); let id = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++id, callback); return id; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(key => { frames.delete(key); });
  await startPerfProbe("plugin-manager-test");
  const paint = () => { for (const frame of [...frames.values()]) frame(0); frames.clear(); };
  const surfaces = () => (localStorage.getItem("chemdraft.perfLog") ?? "").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line)).filter(row => row.kind === "dialog-open");
  await command("plugins.manage"); paint();
  await command("plugins.manage"); paint();
  expect(surfaces()).toHaveLength(1);
  expect(surfaces()[0]).toMatchObject({ commandId: "plugins.manage", extra: { surface: "plugin-manager" } });
  const close = [...document.querySelectorAll<HTMLButtonElement>(".plugin-manager-button")].find(button => button.textContent?.trim() === "Close")!;
  await act(async () => close.click());
  await command("plugins.manage"); paint();
  expect(surfaces()).toHaveLength(2);
});

it("does not compute content frames or publish preview traffic with the preference off, including drawing edits", async () => {
  const crop = vi.spyOn(workflow, "copyAsScopedDocument");
  await command("export.open"); await send("ready", {});
  expect(native.snapshot).toMatchObject({ dialogKind: "export" });
  expect(native.snapshot!.type === "snapshot" && native.snapshot!.dialogKind === "export" && native.snapshot!.data.frame).toBeUndefined();
  await command("page.orientation.landscape");
  expect(crop).not.toHaveBeenCalled();
  expect(native.publish).not.toHaveBeenCalled();
  await act(async () => { saveExportPreviewEnabled(true); await broadcastExportPreviewSettings(true); });
  expect(crop).toHaveBeenCalled();
  expect(native.publish).toHaveBeenCalledWith("host", expect.objectContaining({ data: expect.objectContaining({ status: "frame" }) }));
});

it.each([false, true])("uses the owner's preference (%s) for stale dialog presentation options", async enabled => {
  await act(async () => { saveExportPreviewEnabled(true); await broadcastExportPreviewSettings(true); });
  await command("export.open"); await send("ready", {});
  if (!enabled) await act(async () => { saveExportPreviewEnabled(false); await broadcastExportPreviewSettings(false); });
  const snapshot = native.snapshot!;
  if (snapshot.type !== "snapshot" || snapshot.dialogKind !== "export") throw new Error("Missing Export snapshot");
  const svg = vi.spyOn(workflow, "exportPhase4Svg");
  await send("action", { action: "export", options: { ...snapshot.data.options, format: "svg", filename: "drawing.svg",
    presentation: { width: 1200, dpi: 300, crop: "content", background: "transparent" } } });
  await vi.waitFor(() => expect(svg).toHaveBeenCalled());
  const exportedOptions = svg.mock.calls.at(-1)![1];
  if (enabled) expect(exportedOptions).toMatchObject({ outputWidth: 101.6, outputUnit: "mm", background: "transparent" });
  else {
    expect(exportedOptions).not.toHaveProperty("outputWidth");
    expect(exportedOptions).not.toHaveProperty("background");
  }
});

it("renders preview from the same pending atom-label flush as export without closing the edit", async () => {
  await act(async () => { saveExportPreviewEnabled(true); await broadcastExportPreviewSettings(true); });
  await command("export.open"); await send("ready", {}); await command("tool.bond");
  const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
  for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
  const molecule = bridge().snapshot().document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
  const atom = molecule.atoms[1];
  await act(async () => {
    const event = new MouseEvent("pointermove", { bubbles: true, clientX: atom.x, clientY: atom.y, buttons: 0 });
    Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    container.querySelector(".page")!.dispatchEvent(event);
  });
  for (const key of "NMe") {
    const target = document.activeElement ?? document.body;
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(event); });
    if (!event.defaultPrevented && target instanceof HTMLInputElement) {
      const value = target.value + key;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
        target.dispatchEvent(new Event("input", { bubbles: true })); target.setSelectionRange(value.length, value.length);
      });
    }
  }
  expect(container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]')?.value).toBe("NMe");
  const finish = vi.spyOn(atomLabelDraft, "restoreAtomLabelDraft");
  const svg = vi.spyOn(workflow, "exportPhase4Svg");
  const snapshot = native.snapshot!;
  if (snapshot.type !== "snapshot" || snapshot.dialogKind !== "export") throw new Error("Missing Export snapshot");
  await send("action", { action: "preview", options: { ...snapshot.data.options, format: "svg", filename: "drawing.svg" } });
  await vi.waitFor(() => expect(native.publish).toHaveBeenCalledWith("host", expect.objectContaining({ data: expect.objectContaining({ status: "preview" }) })));
  expect(finish).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ draft: "NMe" }));
  const source = svg.mock.calls.at(-1)![0];
  expect(source.pages[0].objects.find(object => object.type === "molecule")).toEqual(bridge().snapshot().document.pages[0].objects.find(object => object.type === "molecule"));
  expect(container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]')?.value).toBe("NMe");
});
