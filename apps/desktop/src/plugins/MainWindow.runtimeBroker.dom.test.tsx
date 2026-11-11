// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPatch, type ChemDraftDocument, type TextObject } from "@chemdraft/chem-core";
import type { RegisterPluginOptions } from "@chemdraft/plugin-host";
import { MainWindow } from "../MainWindow";
import { createPhase4Document } from "../documentWorkflow";
import { activateDocumentTabCommandId } from "../commands";
import { getAssistantHistoryPort } from "../assistant/historyPort";
import { getAssistantTransactions } from "../assistant/assistantTransaction";
import { RuntimeTestChannels } from "../testSupport/runtimeBrokerChannels";
import { createPluginRuntime } from "./createPluginRuntime";
import { RuntimeBroker } from "./runtimeBroker";
import { RuntimeBrokerHost } from "./runtimeBrokerHost";
import { RuntimeBrokerDocument, type RuntimeDocumentPort } from "./runtimeBrokerDocument";
import { createRuntimeDocumentSession } from "./runtimeDocumentSession";

const captured = vi.hoisted(() => ({ port: undefined as RuntimeDocumentPort | undefined }));
vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./runtimeDocumentPort", async original => {
  const actual = await original<typeof import("./runtimeDocumentPort")>();
  return { ...actual, createRuntimeDocumentPort: (options: import("./runtimeDocumentPort").RuntimeDocumentPortOptions) => {
    const port = actual.createRuntimeDocumentPort(options);
    captured.port = port;
    return port;
  } };
});

const caption = (id: string): TextObject => ({ id, type: "text", text: id, spans: [],
  x: 30, y: 40, width: 100, height: 20, rotation: 0, style: {} });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
let root: Root | undefined;
let container: HTMLDivElement | undefined;
const cleanup: Array<() => void> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) stop();
  await act(async () => root?.unmount());
  root = undefined; container?.remove(); container = undefined; captured.port = undefined;
  window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function fixture(platform: "macos" | "windows", handler: RegisterPluginOptions) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLElement.prototype.hasPointerCapture = () => false;
  window.history.replaceState(null, "", "/?agentBridge=1");
  const initial = createPhase4Document("Broker document port");
  const inserted = applyPatch(initial, { op: "addObject", pageId: initial.pages[0]!.id, object: caption("selected") });
  const drawing = applyPatch(inserted, { op: "setSelection", pageId: initial.pages[0]!.id, objectIds: ["selected"] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(createElement(MainWindow, { initialDocument: drawing,
    shortcutPlatform: platform, initialPaletteMode: "hidden", initialRulersVisible: false,
    initialCrosshairsVisible: false, nativePalette: false })));
  const port = captured.port!;
  const source = port.activeTabId();
  const channels = new RuntimeTestChannels();
  const hostBroker = new RuntimeBroker("runtime", channels.transport("runtime"));
  const documentBroker = new RuntimeBroker(port.windowId, channels.transport(port.windowId));
  const client = new RuntimeBrokerDocument(documentBroker, port);
  const host = new RuntimeBrokerHost(hostBroker, () => createPluginRuntime({ getActiveDocument: () => undefined }), () => [port.windowId]);
  cleanup.push(() => { client.dispose(); host.dispose(); documentBroker.dispose(); hostBroker.dispose(); });
  host.runtime.registerPlugin({ id: "org.test.broker", name: "Broker", version: "1.0.0", apiVersion: "^0.1.25",
    entry: "test.js", permissions: ["document.read", "document.write"],
    contributes: { commands: [{ id: "plugin.broker.run", title: "Run" }] } }, handler);
  await act(async () => client.refreshContributions());
  const command = async (id: string) => { await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(id); }); };
  return { port, source, client, command,
    read: () => getAssistantHistoryPort().read(source)!,
    active: () => window.__CHEMDRAFT_AGENT__!.snapshot().document as ChemDraftDocument };
}

describe("MainWindow's real broker document/history port", () => {
  it.each(["macos", "windows"] as const)("dispatches real Undo/Redo through the production facade with a failed host on %s", async platform => {
    const f = await fixture(platform, { commandHandlers: { "plugin.broker.run": context => context.documents.applyPatch!({
      reason: "Insert caption", patch: { op: "addObject", pageId: "page_001", object: caption("inserted") }
    }) } });
    const before = f.read();
    await act(async () => { await f.client.invokeCommand("plugin.broker.run"); });
    const after = f.read();
    const session = createRuntimeDocumentSession({ documentPort: f.port, commandRegistry: f.port.commandRegistry },
      async () => { throw new Error("Runtime host unavailable"); });
    cleanup.push(session.dispose);
    await expect(session.client.ready).rejects.toThrow("Runtime host unavailable");
    await act(async () => { await session.client.runtime.invokeCommand("edit.undo"); });
    expect(f.read()).toEqual(before);
    await act(async () => { await session.client.runtime.invokeCommand("edit.redo"); });
    expect(f.read()).toEqual(after);
    expect(after.selection.objectIds).toEqual(["inserted"]);
  });

  it.each(["macos", "windows"] as const)("commits a late write to the inactive source tab's history on %s", async platform => {
    const started = deferred(), resume = deferred();
    const f = await fixture(platform, { commandHandlers: { "plugin.broker.run": async context => {
      started.resolve(); await resume.promise;
      return context.documents.applyPatch!({ reason: "Move source caption",
        patch: { op: "moveObject", objectId: "selected", x: 80, y: 90 } });
    } } });
    const before = f.read(), key = f.port.read(f.source)!.documentKey;
    let work!: Promise<unknown>;
    await act(async () => { work = f.client.invokeCommand("plugin.broker.run"); await started.promise; });
    await f.command("document.new");
    const other = f.active();
    await act(async () => { resume.resolve(); await work; });
    const after = f.read();
    expect(after.pages[0]!.objects[0]).toMatchObject({ x: 80, y: 90 });
    expect(after.selection.objectIds).toEqual(["selected"]);
    expect(f.active()).toBe(other);
    expect(f.port.read(f.source)!.documentKey).toBe(key);
    await f.command(activateDocumentTabCommandId(f.source));
    expect(f.port.read(f.source)!.documentKey).toBe(key);
    await f.command("edit.undo"); expect(f.read()).toEqual(before);
    await f.command("edit.redo"); expect(f.read()).toEqual(after);
  });

  it.each(["macos", "windows"] as const)("groups broker writes in the existing assistant request on %s, with exact undo/redo selection", async platform => {
    const f = await fixture(platform, { commandHandlers: { "plugin.broker.run": async context => {
      const pageId = (await context.documents.getActiveDocument())!.pages[0]!.id;
      for (const id of ["assistant-one", "assistant-two"]) {
        await context.documents.applyPatch!({ reason: "Caption", patch: { op: "addObject", pageId, object: caption(id) } });
      }
    } } });
    const before = f.read(), transactions = getAssistantTransactions();
    const tx = transactions.beginAssistantTransaction({ pluginId: "org.test.broker", runId: "broker-request",
      tabId: f.source, label: "Two captions", sendSelection: before.selection });
    await act(async () => {
      await f.client.invokeCommand("plugin.broker.run");
      expect(transactions.endAssistantTransaction(tx, { touchedIds: [] })).toEqual({ split: false, touchedIds: ["assistant-one", "assistant-two"] });
    });
    const after = f.read();
    await f.command("edit.undo"); expect(f.read()).toEqual(before);
    await f.command("edit.undo"); expect(f.read()).toEqual(before);
    await f.command("edit.redo"); expect(f.read()).toEqual(after);
    expect(after.selection.objectIds).toEqual(["assistant-one", "assistant-two"]);
    await act(async () => { expect(transactions.undoOwnTransaction(tx)).toBe(true); });
    expect(f.read()).toEqual(before);
  });
});
