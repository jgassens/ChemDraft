// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, type ChemDraftDocument, type TextObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";
import {
  beginAssistantTransaction, writeAssistantTransaction, endAssistantTransaction, undoOwnTransaction
} from "./assistant/assistantTransaction";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { saveKeybindingSettings } from "./keybindingSettings";
import { DOM_COMMAND_EVENT } from "./window-manager";
import type { DesktopPluginRuntime } from "./plugins/createPluginRuntime";
import { AssistantCapabilityPermissions, PluginApiVersion, type PluginCommandContext } from "@chemdraft/plugin-api";
import { deferred } from "./testSupport/deferred";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
const captured = vi.hoisted(() => ({ runtime: undefined as DesktopPluginRuntime | undefined }));
vi.mock("./plugins/createPluginRuntime", async original => {
  const actual = await original<typeof import("./plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: import("./plugins/createPluginRuntime").DesktopPluginRuntimeOptions) => {
    captured.runtime = actual.createPluginRuntime(options);
    return captured.runtime;
  } };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe("MainWindow assistant history port", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.hasPointerCapture = () => false;
    saveKeybindingSettings({ scheme: "chemdraft" });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    const initial = createPhase4Document("Assistant transaction");
    const initialDocument = applyPatch(initial, { op: "addObject", pageId: initial.pages[0].id,
      object: { id: "existing_caption", type: "text", x: 50, y: 50, width: 100, height: 20,
        rotation: 0, style: {}, text: "User caption", spans: [] } });
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument, initialPaletteMode: "hidden",
      initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false
    })));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  const snapshotDocument = (): ChemDraftDocument => getAssistantHistoryPort().read("initial")!;
  const begin = () => beginAssistantTransaction({ pluginId: "org.chemdraft.assistant", runId: "run", tabId: "initial",
    label: "Draw three captions", sendSelection: snapshotDocument().selection });
  function write(tx: string, id: string) {
    const object: TextObject = { id, type: "text", x: 100, y: 100, width: 100, height: 20,
      rotation: 0, style: {}, text: id, spans: [] };
    writeAssistantTransaction(tx, applyPatch(snapshotDocument(), { op: "addObject", pageId: snapshotDocument().pages[0].id, object }));
  }
  async function menu(commandId: string) {
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }

  it("records one entry for three writes; Edit > Undo restores all and redo never calls the run/tools", async () => {
    const before = structuredClone(snapshotDocument());
    const tools = { write: vi.fn(async (context: PluginCommandContext, id: string) => {
      const object: TextObject = { id, type: "text", x: 100, y: 100, width: 100, height: 20,
        rotation: 0, style: {}, text: id, spans: [] };
      await context.documents!.applyPatch!({ reason: "Insert caption", warnings: [], requiresUserApproval: true,
        patch: { op: "addObject", pageId: snapshotDocument().pages[0].id, object } });
    }) };
    const provider = { run: vi.fn(async (context: PluginCommandContext) => {
      const tx = await context.assistant!.beginRequest({ prompt: "Draw three captions" });
      for (const id of ["assistant_one", "assistant_two", "assistant_three"]) await tools.write(context, id);
      return context.assistant!.endRequest(tx);
    }) };
    await act(async () => {
      captured.runtime!.registerPlugin({ id: "org.chemdraft.assistant", name: "Assistant", version: "0.1.0",
        apiVersion: "^0.1.21", entry: "test.js", permissions: [...AssistantCapabilityPermissions],
        contributes: { commands: [{ id: "plugin.assistant.submit", title: "Send" }] }
      }, { commandHandlers: { "plugin.assistant.submit": provider.run } });
      expect(await captured.runtime!.invokeCommand("plugin.assistant.submit")).toMatchObject({ split: false });
    });
    const after = structuredClone(snapshotDocument());
    expect(after.selection.objectIds).toEqual(["assistant_one", "assistant_two", "assistant_three"]);
    provider.run.mockClear(); tools.write.mockClear();
    await menu("edit.undo");
    expect(snapshotDocument()).toEqual(before);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Undid ChemDraft Assistant: Draw three captions");
    await menu("edit.undo");
    expect(snapshotDocument()).toEqual(before); // There was only one entry.
    await menu("edit.redo");
    expect(snapshotDocument()).toEqual(after);
    expect(provider.run).not.toHaveBeenCalled(); expect(tools.write).not.toHaveBeenCalled();
  });

  it("excludes legacy and public requests in both orders and keeps their undo entries independent", async () => {
    const runtime = captured.runtime!;
    const original = snapshotDocument(), pageId = original.pages[0]!.id;
    const patch = (id: string) => ({ op: "addObject" as const, pageId, object: {
      id, type: "text" as const, x: 50, y: 150, width: 50, height: 18, rotation: 0, style: {}, text: id, spans: []
    } });
    await act(async () => {
      runtime.registerPlugin({ id: "org.test.both", name: "History test", version: "1.0.0",
        apiVersion: `^${PluginApiVersion}`, entry: "test.js", permissions: [...AssistantCapabilityPermissions],
        contributes: { commands: [{ id: "plugin.both.legacy", title: "Legacy" }, { id: "plugin.both.tryPublic", title: "Concurrent write" },
          { id: "plugin.both.public", title: "Public" }] }
      }, { commandHandlers: {
        "plugin.both.legacy": async ctx => {
          const tx = await ctx.assistant!.beginRequest({ prompt: "Legacy" });
          try {
            expect(await ctx.requests!.begin({ label: "Same command" })).toMatchObject({ ok: false, error: { code: "busy" } });
            await ctx.documents.applyPatch!({ reason: "Legacy write", patch: patch("legacy-one") });
            await runtime.invokeCommand("plugin.both.tryPublic");
            await ctx.documents.applyPatch!({ reason: "Second legacy write", patch: patch("legacy-two") });
          } finally { await ctx.assistant!.endRequest(tx); }
        },
        "plugin.both.tryPublic": async ctx => {
          expect(await ctx.requests!.begin({ label: "Concurrent public request" }))
            .toMatchObject({ ok: false, error: { code: "busy" } });
        },
        "plugin.both.public": async ctx => {
          const result = await ctx.requests!.begin({ label: "Public" });
          if (!result.ok) throw new Error(result.error.message);
          const { requestId } = result.value;
          await expect(ctx.assistant!.beginRequest({ prompt: "Same command" })).rejects.toThrow(/public request invocation/);
          await ctx.documents.applyPatch!({ reason: "First public write", patch: patch("public-one") });
          await expect(runtime.invokeCommand("plugin.both.legacy")).rejects.toMatchObject({ code: "busy" });
          expect(await ctx.documents.applyRequestPatch!({ requestId, patch: patch("public-two") })).toMatchObject({ ok: true });
          expect(await ctx.requests!.end({ requestId })).toMatchObject({ ok: true });
        }
      } });
      await runtime.invokeCommand("plugin.both.legacy");
    });
    const legacyOnly = snapshotDocument();
    expect(legacyOnly.selection.objectIds).toEqual(["legacy-one", "legacy-two"]);
    await act(async () => { await runtime.invokeCommand("plugin.both.public"); });
    expect(snapshotDocument().selection.objectIds).toEqual(["public-one", "public-two"]);
    await menu("edit.undo");
    expect(snapshotDocument()).toEqual(legacyOnly);
    await menu("edit.undo");
    expect(snapshotDocument()).toEqual(original);
  });

  it.each(["return", "throw", "unregister"])("releases abandoned request history on %s", async exit => {
    const runtime = captured.runtime!;
    const manifest = { id: "org.test.cleanup", name: "History cleanup", version: "1.0.0",
      apiVersion: `^${PluginApiVersion}`, entry: "test.js", permissions: [...AssistantCapabilityPermissions],
      contributes: { commands: [{ id: "plugin.cleanup.run", title: "Run" }] } };
    await act(async () => {
      for (const kind of ["legacy", "public"] as const) {
        runtime.registerPlugin(manifest, { commandHandlers: { "plugin.cleanup.run": async ctx => {
          if (kind === "legacy") {
            await ctx.assistant!.beginRequest({ prompt: "Legacy" });
          } else {
            expect(await ctx.requests!.begin({ label: "Public" })).toMatchObject({ ok: true });
            await ctx.documents.insertTable!({ columns: [{ header: "A" }], rows: [["value"]] });
          }
          if (exit === "throw") throw new Error("Command failed");
          if (exit === "unregister") runtime.unregisterPlugin(manifest.id);
        } } });
        const work = runtime.invokeCommand("plugin.cleanup.run");
        if (exit === "throw") await expect(work).rejects.toThrow("Command failed");
        else await work;
        // Probe before unregistering a completed command, since unregister also cleans up.
        const probe = begin();
        endAssistantTransaction(probe, { touchedIds: [] });
        if (exit !== "unregister") runtime.unregisterPlugin(manifest.id);
      }
    });
  });

  it("splits after a real editor command, preserving the user's entry", async () => {
    const tx = begin();
    await act(async () => write(tx, "assistant_one"));
    await menu("layout.duplicate");
    const userState = structuredClone(snapshotDocument());
    await act(async () => {
      write(tx, "assistant_two");
      expect(endAssistantTransaction(tx, { touchedIds: [] }).split).toBe(true);
    });
    await menu("edit.undo"); expect(snapshotDocument()).toEqual(userState);
  });

  it("Undo this request restores the recorded snapshot through the host port", async () => {
    const before = structuredClone(snapshotDocument()); const tx = begin();
    await act(async () => { write(tx, "assistant_one"); endAssistantTransaction(tx, { touchedIds: [] }); });
    await act(async () => { expect(undoOwnTransaction(tx)).toBe(true); });
    expect(snapshotDocument()).toEqual(before);
  });

  it("selection changes during the request do not split; redo restores the recorded final selection", async () => {
    const tx = begin();
    await act(async () => write(tx, "assistant_one"));
    await menu("edit.selectAll");
    await act(async () => {
      write(tx, "assistant_two");
      expect(endAssistantTransaction(tx, { touchedIds: [] }).split).toBe(false);
    });
    const final = structuredClone(snapshotDocument());
    await menu("edit.selectAll");
    expect(snapshotDocument().selection).not.toEqual(final.selection);
    await menu("edit.undo"); await menu("edit.redo");
    expect(snapshotDocument()).toEqual(final);
  });

  it("keeps writing to the Send tab after a tab switch and refuses after that tab closes", async () => {
    const tx = begin();
    await act(async () => write(tx, "assistant_one"));
    await menu("document.new");
    const active = structuredClone(window.__CHEMDRAFT_AGENT__!.snapshot().document);
    await act(async () => write(tx, "assistant_two"));
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().document).toEqual(active);
    expect(snapshotDocument().selection.objectIds).toEqual(["assistant_one", "assistant_two"]);
    await menu("document.closeTab.initial");
    const discard = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(candidate => candidate.textContent === "Don't Save");
    expect(discard).toBeDefined();
    await act(async () => { discard!.click(); });
    expect(getAssistantHistoryPort().read("initial")).toBeUndefined();
    expect(() => writeAssistantTransaction(tx, active)).toThrow(/tab is closed/);
  });

  it.each([false, true])("keeps request writes pinned and independent of ordinary commands (interruption=%s)", async interrupt => {
    const runtime = captured.runtime!;
    const before = snapshotDocument();
    const events = vi.fn();
    const forbiddenEvents = vi.fn();
    const id = "org.test.pinned";
    const runId = "plugin.pinned.run", ordinaryId = "plugin.pinned.ordinary";
    const patch = (id: string, pageId: string) => ({ op: "addObject" as const, pageId, object: {
      id, type: "text" as const, x: 50, y: 150, width: 50, height: 18, rotation: 0, style: {}, text: id, spans: []
    } });
    const followUp = deferred<void>();
    const firstWrite = deferred<void>();
    const run = vi.fn(async (ctx: PluginCommandContext) => {
      const request = await ctx.requests!.begin({ label: "Two captions" });
      if (!request.ok) throw new Error(request.error.message);
      const { requestId } = request.value;
      const context = await ctx.requests!.getContext({ requestId });
      if (!context.ok) throw new Error(context.error.message);
      const { documentKey, pages } = context.value;
      expect(documentKey).toBe(events.mock.calls[0]![0].documentKey);
      await menu("document.new");
      const tabB = window.__CHEMDRAFT_AGENT__!.snapshot().document!;
      expect(events.mock.calls[1]![0].documentKey).not.toBe(documentKey);
      await runtime.invokeCommand(ordinaryId);
      const ordinary = window.__CHEMDRAFT_AGENT__!.snapshot().document;
      expect(ordinary?.pages[0]!.objects.map(object => object.id)).toEqual(["ordinary"]);
      const apply = ctx.documents.applyRequestPatch!;
      const pageId = pages[0]!.pageId;
      expect(await apply({ requestId, patch: patch("one", pageId) })).toMatchObject({ ok: true });
      expect(window.__CHEMDRAFT_AGENT__!.snapshot().document).toEqual(ordinary);
      expect(tabB.pages[0]!.objects).toHaveLength(0);
      firstWrite.resolve();
      await followUp.promise;
      const afterUser = snapshotDocument();
      const second = await apply({ requestId, patch: patch("two", pageId) });
      if (interrupt) {
        expect(second).toMatchObject({ ok: false, error: { code: "interrupted" } });
        expect(snapshotDocument()).toBe(afterUser);
      } else expect(second).toMatchObject({ ok: true });
      await ctx.requests!.end({ requestId });
    });
    runtime.registerPlugin({ id: "org.test.noRead", name: "No read", version: "1.0.0", apiVersion: "^0.1.26",
      entry: "worker.js", permissions: [] }, { onActiveDocumentChanged: forbiddenEvents });
    runtime.registerPlugin({ id, name: "Captions", version: "1.0.0", apiVersion: "^0.1.26", entry: "worker.js",
      permissions: ["document.read", "selection.read", "document.write", "chemistry.compute"],
      contributes: { commands: [{ id: runId, title: "Place" }, { id: ordinaryId, title: "Add" }] }
    }, { onActiveDocumentChanged: events, commandHandlers: {
      [runId]: run,
      [ordinaryId]: async ctx => {
        const current = await ctx.documents.getActiveDocument!();
        await ctx.documents.applyPatch!({ reason: "Ordinary caption", patch: patch("ordinary", current!.pages[0]!.id) });
      }
    } });
    let finished!: Promise<unknown>;
    await act(async () => {
      finished = runtime.invokeCommand(runId);
      await Promise.race([firstWrite.promise, finished]);
    });
    await menu("document.activateTab.initial");
    expect(events.mock.calls[2]![0].documentKey).toBe(events.mock.calls[0]![0].documentKey);
    const first = snapshotDocument();
    if (interrupt) {
      await menu("layout.duplicate");
      expect(snapshotDocument().pages[0]!.objects).toHaveLength(first.pages[0]!.objects.length + 1);
    }
    await act(async () => { followUp.resolve(); await finished; });
    if (!interrupt) expect(snapshotDocument().selection.objectIds).toEqual(["one", "two"]);
    expect(events.mock.calls.map(([event]) => event.sequence)).toEqual([1, 2, 3]);
    expect(forbiddenEvents).not.toHaveBeenCalled();
    runtime.unregisterPlugin(id);
    const after = snapshotDocument();
    await menu("edit.undo");
    expect(snapshotDocument()).toEqual(interrupt ? first : before);
    await menu("edit.redo");
    expect(snapshotDocument()).toEqual(after);
    expect(run).toHaveBeenCalledOnce();
    await menu("document.new");
    expect(events).toHaveBeenCalledTimes(3);
  });

  it("invalidates requests and publishes keys when a pristine tab is opened over and then closed", async () => {
    const runtime = captured.runtime!;
    const pluginId = "org.test.lifecycle";
    const commandId = "plugin.lifecycle.watch";
    const active = vi.fn();
    const started = deferred<void>();
    const finish = deferred<void>();
    await act(async () => runtime.registerPlugin({ id: pluginId, name: "Document lifecycle", version: "1.0.0",
      apiVersion: "^0.1.26", entry: "test.js", permissions: ["document.read", "selection.read"],
      contributes: { commands: [{ id: commandId, title: "Watch a document" }] }
    }, { onActiveDocumentChanged: active, commandHandlers: { [commandId]: async ctx => {
      const begin = await ctx.requests!.begin({ label: "Watch document" });
      if (!begin.ok) throw new Error(begin.error.message);
      const { requestId } = begin.value;
      started.resolve();
      await finish.promise;
      return ctx.requests!.getContext({ requestId });
    } } }));
    await menu("document.new");
    let read!: Promise<unknown>;
    await act(async () => {
      read = runtime.invokeCommand(commandId);
      await Promise.race([started.promise, read]);
    });
    const bytes = new TextEncoder().encode(JSON.stringify(createPhase4Document("Opened drawing")));
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept*="chemdraft"]')!;
    Object.defineProperty(input, "files", { value: [{ name: "opened.chemdraft", size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer }], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().document.title).toBe("Opened drawing");
    await act(async () => {
      finish.resolve();
      await expect(read).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
    });
    await menu("document.closeTab");
    const keys = active.mock.calls.map(([event]) => event.documentKey);
    expect(keys).toHaveLength(4);
    expect(new Set(keys.slice(0, 3)).size).toBe(3);
    expect(keys[3]).toBe(keys[0]);
    expect(active.mock.calls.map(([event]) => event.sequence)).toEqual([1, 2, 3, 4]);
  });
});
