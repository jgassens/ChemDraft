// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginWorkerHandle } from "@chemdraft/plugin-api";
import type { EventCallback } from "@tauri-apps/api/event";
import { loadPackagedPlugin } from "./loadPackagedPlugin";
import { PluginPanelWindow } from "./PluginPanelWindow";
import { TauriExternalToolsEngine } from "../externalTools/externalToolsEngine";
import { TauriAssistantMcpEngine } from "../assistant/assistantMcpEngine";
import { MainWindow } from "../MainWindow";
import { createPhase4Document } from "../documentWorkflow";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { pluginPanelWindowId, PLUGIN_PANEL_REQUEST_EVENT, PLUGIN_PANEL_REPORT_EVENT } from "./panelBridge";
import * as pluginPanelActions from "./pluginPanelActions";

const native = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  invoke: vi.fn(),
  workerSettlements: [] as unknown[],
  runtime: undefined as import("./createPluginRuntime").DesktopPluginRuntime | undefined
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => false }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    const listeners = native.listeners.get(name) ?? new Set();
    listeners.add(handler); native.listeners.set(name, listeners);
    return () => listeners.delete(handler);
  },
  emit: async (name: string, payload: unknown) => {
    for (const handler of native.listeners.get(name) ?? []) handler({ payload });
  }
}));
// Linked dependencies resolve dynamic native imports outside Vitest's mock graph. Inject the
// native attachment port, preserving the production readiness/cleanup implementation.
vi.mock("../window-manager/tauriEvents", async importOriginal => {
  const actual = await importOriginal<typeof import("../window-manager/tauriEvents")>();
  const listen = (name: string, handler: EventCallback<unknown>) => actual.safeTauriListen(name, async wrapped => {
    const listeners = native.listeners.get(name) ?? new Set();
    const receive = ({ payload }: { payload: unknown }) => wrapped({ event: name, id: 1, payload });
    listeners.add(receive); native.listeners.set(name, listeners);
    return () => listeners.delete(receive);
  }, handler).attached;
  return { ...actual, listenTauriEvent: listen, listenCurrentWindowEvent: listen };
});
vi.mock("../window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("../window-manager")>(),
  isDesktopRuntime: () => true
}));
vi.mock("./pluginStagingFs", async importOriginal => ({
  ...await importOriginal<typeof import("./pluginStagingFs")>(),
  isTauriHost: () => false
}));
vi.mock("./createPluginRuntime", async importOriginal => {
  const actual = await importOriginal<typeof import("./createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: import("./createPluginRuntime").DesktopPluginRuntimeOptions) => {
    native.runtime = actual.createPluginRuntime({ ...options, defaultPanelSurface: "window", externalToolsEngine: new TauriExternalToolsEngine(native.invoke),
      assistantMcpEngine: new TauriAssistantMcpEngine(native.invoke, () => ({ onmessage: () => undefined }) as never) });
    return native.runtime;
  } };
});

// Original minimal plugin exercises the real loader, worker bridge and host.
const fixture = resolve("apps/desktop/src/plugins/__fixtures__/overlay-transcript");
const manifest = JSON.parse(readFileSync(resolve(fixture, "manifest.json"), "utf8"));
const entry = readFileSync(resolve(fixture, "entry.js"), "utf8");
function createWorker(): PluginWorkerHandle {
  const hostListeners = new Set<(event: { data: unknown }) => void>();
  const workerListeners = new Set<(event: { data: unknown }) => void>();
  let terminated = false;
  const deliver = (listeners: typeof hostListeners, message: unknown) => {
    const data = structuredClone(message);
    queueMicrotask(() => { if (!terminated) listeners.forEach(listener => listener({ data })); });
  };
  runInNewContext(entry, {
    TextEncoder, TextDecoder, URL, crypto, setTimeout, clearTimeout, console,
    postMessage: (message: unknown) => {
      if ((message as { kind?: string }).kind === "commandSettled") native.workerSettlements.push(message);
      deliver(hostListeners, message);
    },
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      if (type === "message") workerListeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      if (type === "message") workerListeners.delete(listener);
    }
  });
  return {
    postMessage: message => deliver(workerListeners, message),
    addEventListener: (type, listener) => { if (type === "message") hostListeners.add(listener as (event: { data: unknown }) => void); },
    removeEventListener: (type, listener) => { if (type === "message") hostListeners.delete(listener as (event: { data: unknown }) => void); },
    terminate: () => { terminated = true; }
  };
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let panelRoot: Root | undefined;
beforeEach(() => {
  native.workerSettlements.length = 0;
  vi.stubGlobal("localStorage", new MemoryStorage());
  native.invoke.mockImplementation(async () => undefined);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(async () => {
  await act(async () => { panelRoot?.unmount(); root?.unmount(); });
  panelRoot = undefined; root = undefined;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  native.listeners.clear(); native.invoke.mockReset();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it.each(["tauri://localhost", "http://tauri.localhost"])("replays synthetic tool output into the overlay and panel (%s)", async origin => {
  const lines = readFileSync(resolve(fixture, "tool-reply.stdout.jsonl"), "utf8").trim().split("\n");
  const reply = JSON.parse(lines.find(line => line.includes('"reply"'))!).text as string;
  const dispatch = window.dispatchEvent.bind(window);
  native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "external_tool_status") return {
      tool: args!.tool, publisher: "OpenAI", state: "installed", signedIn: true, consented: true,
      pinnedVersion: "test", pinnedDownloadBytes: 0, freeDiskBytes: null, canInstall: false, probedAt: "2026-10-24"
    };
    if (command === "assistant_mcp_session_open") return { sessionId: "session-test", serverName: "chemdraft" };
    if (command === "external_tool_run_start") return { runId: "run-test", pid: 1, cwd: "fixture", startedAt: "2026-10-24" };
    if (command === "external_tool_run_poll") return {
      lines: args!.cursor === 0 ? lines.map((text, seq) => ({ stream: "stdout", text, seq })) : [],
      nextCursor: lines.length, droppedLines: 0, status: { state: "exited", code: 0, durationMs: 1 }
    };
    if (command === "plugin_panel_event_forward") {
      for (const handler of native.listeners.get(args!.event as string) ?? []) handler({ payload: args!.payload });
    }
    if (command === "open_plugin_panel_window" && args?.publication) {
      const publication = args.publication as { targetLabel: string; event: string; payload: unknown };
      const windowId = new URLSearchParams(window.location.search).get("panelId");
      if (windowId) {
        expect(args).not.toHaveProperty("request");
        expect(publication.targetLabel).toBe(`plugin-panel-${windowId}`);
        dispatch(new CustomEvent(publication.event, { detail: publication.payload }));
      }
    }
    return undefined;
  });
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MainWindow initialDocument={createPhase4Document("Test document")}
    initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
  const runtime = native.runtime!;
  // Linked native imports may bypass Vitest's module mock; provide the real IPC entry point too.
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: (command: string, args: unknown) => native.invoke(command, args) });
  const descriptor = loadPackagedPlugin({ baseUrl: `${origin}/installed-plugins/overlay-transcript/`, manifest }, { createWorker });
  await act(async () => { runtime.registerPlugin(descriptor.manifest, descriptor.options); });
  try {
    const storage = runtime.host.createCommandContext(manifest.id).storage!;
    await storage.set("provider", "codex");
    await storage.set("chosenProviders", ["codex"]);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-icon")!.click();
      await vi.waitFor(() => expect(native.workerSettlements).toHaveLength(1), { timeout: 5000 });
    });
    const textarea = container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Draw benzene");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(native.workerSettlements).toHaveLength(2), { timeout: 5000 });
    });
    expect(native.invoke).toHaveBeenCalledWith("external_tool_run_start", expect.anything());
    const transcript = container.querySelector('[role="log"]')!;
    expect(transcript.textContent).toContain("Draw benzene");
    expect(transcript.textContent).toContain(reply.replaceAll("`", ""));
    expect([...transcript.querySelectorAll("code")].map(node => node.textContent)).toEqual(["lookup_item", "sample_item", "C"]);
    const panel = runtime.panels.getDetachedPanels()[0]!;
    const windowId = pluginPanelWindowId(manifest.id, panel.panelId);
    // Separate webviews share neither DOM events nor private native publications.
    vi.spyOn(window, "dispatchEvent").mockImplementation(event =>
      [PLUGIN_PANEL_REQUEST_EVENT, PLUGIN_PANEL_REPORT_EVENT].includes(event.type) ? true : dispatch(event));
    window.history.replaceState(null, "", `/?window=pluginPanel&panelId=${windowId}`);
    const detached = document.createElement("div"); document.body.append(detached);
    panelRoot = createRoot(detached);
    await act(async () => panelRoot!.render(<PluginPanelWindow panelId={windowId} />));
    expect(detached.textContent).toContain("Draw benzene");
    expect(detached.textContent).toContain(reply.replaceAll("`", ""));
    expect([...detached.querySelectorAll("code")].map(node => node.textContent)).toEqual(["lookup_item", "sample_item", "C"]);
  } finally { descriptor.deactivate?.(); }
});

it("dispatches live overlay content with no panel contribution and never opens a panel", async () => {
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MainWindow initialDocument={createPhase4Document("One box")}
    initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
  const runtime = native.runtime!;
  const commandId = "plugin.single.submit";
  const replacementCommandId = "plugin.single.replace";
  const openId = "plugin.single.open";
  const overlayId = "overlay.single.chat";
  const handler = vi.fn();
  const replacementHandler = vi.fn();
  await act(async () => { runtime.registerPlugin({
    id: "single", name: "Single box", version: "0", apiVersion: "^0.1.12", entry: "test.js", permissions: ["ui.canvas", "ui.menu"],
    contributes: {
      commands: [{ id: commandId, title: "Send" }, { id: replacementCommandId, title: "Replace" }, { id: openId, title: "Open" }],
      menus: [{ id: "menu.single.open", title: "Single box", commandId: openId, location: "plugins" }],
      canvasOverlays: [{ id: overlayId, title: "Single box", icon: "data:image/png;base64,YQ==", commandId,
        prompt: { kind: "prompt", id: "prompt", commandId } }]
    }
  }, { commandHandlers: {
    [commandId]: ctx => handler(ctx.input),
    [replacementCommandId]: ctx => { replacementHandler(ctx.input); },
    [openId]: ctx => ctx.overlays!.open({ overlayId, focus: true })
  } }); });
  const api = runtime.host.createCommandContext("single").overlays!;
  const sections = [{ kind: "actions" as const, id: "setup", buttons: [{ id: "run", label: "Run", commandId, payload: { choice: "live" } }] }];
  await act(async () => { await api.setContent({ overlayId, sections }); });
  await act(async () => {
    window.dispatchEvent(new CustomEvent("chemdraft:native-command", { detail: { commandId: openId } }));
  });
  expect(container.querySelector<HTMLElement>(".plugin-canvas-overlay")!.dataset.expanded).toBe("true");
  expect(container.querySelector(".plugin-canvas-overlay-panel")).toBeNull();
  expect(document.activeElement).toBe(container.querySelector(".plugin-canvas-overlay textarea"));
  const button = () => container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-primary-actions button")!;
  const resolver = vi.spyOn(pluginPanelActions, "resolvePluginPanelAction");
  await act(async () => button().click());
  expect(handler).toHaveBeenLastCalledWith({ source: "overlay", overlayId, sectionId: "setup", control: "button", controlId: "run", payload: { choice: "live" } });
  expect(handler).toHaveBeenCalledTimes(1);
  // Invoke the still-rendered widget before React paints replacement content. Dispatch must use
  // the runtime's current definition, so an old enabled button cannot bypass a live disable/removal.
  resolver.mockClear();
  await act(async () => {
    const stale = button();
    const update = api.setContent({ overlayId, sections: [{ ...sections[0]!, buttons: [{ ...sections[0]!.buttons[0]!, disabled: true }] }] });
    expect(stale.isConnected).toBe(true);
    expect(stale.disabled).toBe(false);
    stale.click();
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveLastReturnedWith({ ok: false, reason: "This action button is disabled." });
    await update;
  });
  expect(handler).toHaveBeenCalledTimes(1);
  await act(async () => { await api.setContent({ overlayId, sections }); });
  resolver.mockClear();
  await act(async () => {
    const stale = button();
    const update = api.setContent({ overlayId, sections: [] });
    expect(stale.isConnected).toBe(true);
    expect(stale.disabled).toBe(false);
    stale.click();
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveLastReturnedWith({ ok: false, reason: 'Unknown panel section "setup".' });
    await update;
  });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(replacementHandler).not.toHaveBeenCalled();
  await act(async () => { await api.setContent({ overlayId, sections: [{ ...sections[0]!, buttons: [{
    ...sections[0]!.buttons[0]!, commandId: replacementCommandId, payload: { choice: "replacement" }
  }] }] }); });
  await act(async () => button().click());
  expect(replacementHandler).toHaveBeenCalledExactlyOnceWith({ source: "overlay", overlayId,
    sectionId: "setup", control: "button", controlId: "run", payload: { choice: "replacement" } });
  expect(handler).toHaveBeenCalledTimes(1);
  const textarea = container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Hello");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // A command started elsewhere must also block Send, independently of the composer's own lock.
  let finish!: () => void;
  handler.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await act(async () => window.dispatchEvent(new CustomEvent("chemdraft:native-command", { detail: { commandId } })));
  const calls = handler.mock.calls.length;
  await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(handler).toHaveBeenCalledTimes(calls);
  expect(container.querySelector(".plugin-canvas-overlay")!.textContent).toContain("Wait for the current request to finish, or press Stop.");
  expect(textarea.value).toBe("Hello");
  await act(async () => finish());
  await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(handler).toHaveBeenLastCalledWith({ source: "overlay", overlayId, sectionId: "prompt", control: "prompt", text: "Hello" });
  await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-icon")!.click());
  expect(container.querySelector(".plugin-canvas-overlay-panel")).toBeNull();
  expect(runtime.panels.getDetachedPanels()).toEqual([]);
  // Publication mode delivers a private snapshot without opening or revealing a window.
  expect(native.invoke.mock.calls.some(([command, args]) => command === "open_plugin_panel_window" && args?.request)).toBe(false);
  await act(async () => runtime.unregisterPlugin("single"));
});
