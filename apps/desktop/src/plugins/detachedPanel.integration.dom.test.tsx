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
import { MainWindow } from "../MainWindow";
import { createPhase4Document } from "../documentWorkflow";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { pluginPanelWindowId, parsePluginPanelWindowLabel, PLUGIN_PANEL_REQUEST_EVENT, PLUGIN_PANEL_REPORT_EVENT } from "./panelBridge";

const native = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  invoke: vi.fn(),
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
    native.runtime = actual.createPluginRuntime({ ...options, defaultPanelSurface: "window" });
    return native.runtime;
  } };
});

// Original minimal plugin exercises the real loader, worker bridge and host.
const fixture = resolve("apps/desktop/src/plugins/__fixtures__/detached-panel");
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
    postMessage: (message: unknown) => deliver(hostListeners, message),
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

it.each([
  ["macos", "menu", "tauri://localhost"], ["macos", "overlay", "tauri://localhost"],
  ["windows", "menu", "http://tauri.localhost"], ["windows", "overlay", "http://tauri.localhost"]
])("loads the test plugin on %s through the %s path and replays its detached report", async (_platform, source, origin) => {
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MainWindow initialDocument={createPhase4Document("Test document")}
    initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
  const runtime = native.runtime!;
  const descriptor = loadPackagedPlugin({ baseUrl: `${origin}/installed-plugins/detached-panel/`, manifest }, {
    createWorker: entryUrl => {
      expect(entryUrl.href).toBe(`${origin}/installed-plugins/detached-panel/entry.js`);
      return createWorker();
    }
  });
  await act(async () => { runtime.registerPlugin(descriptor.manifest, descriptor.options); });
  try {
    if (source === "menu") {
      // The native Plugins menu relays this contributed command to the shared command registry.
      await act(async () => {
        window.dispatchEvent(new CustomEvent("chemdraft:native-command", {
          detail: { commandId: descriptor.manifest.contributes.menus[0]!.commandId }
        }));
      });
    } else {
      await act(async () => container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-icon")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-panel")!.click());
    }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    const panel = runtime.panels.getDetachedPanels()[0];
    expect(runtime.panels.getDiagnostics()).toEqual([]);
    expect(panel?.report.title).toBe("Panel Test Plugin");
    expect(panel?.report.sections.length).toBeGreaterThan(0);
    expect(panel?.report.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "prompt", id: "paneltest.message", commandId: "plugin.paneltest.submit" }),
      expect.objectContaining({ kind: "actions", id: "paneltest.readiness" })
    ]));
    const windowId = pluginPanelWindowId(descriptor.manifest.id, panel!.panelId);
    expect(native.invoke).toHaveBeenCalledWith("open_plugin_panel_window", { request: {
      panelId: windowId, title: "Panel Test Plugin", width: 440, height: 640
    } });
    // Mount AFTER the first report broadcast, exactly like a newly created native webview.
    // Suppress DOM events: main and the detached webview do not share a DOM in production.
    const dispatch = window.dispatchEvent.bind(window);
    vi.spyOn(window, "dispatchEvent").mockImplementation(event =>
      [PLUGIN_PANEL_REQUEST_EVENT, PLUGIN_PANEL_REPORT_EVENT].includes(event.type) ? true : dispatch(event));
    window.history.replaceState(null, "", `/?window=pluginPanel&panelId=${windowId}`);
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.invoke.mockImplementation(async (command: string, args?: { event?: string; payload?: unknown }) => {
      if (command === "plugin_panel_event_forward") {
        expect(args?.event).toBe(PLUGIN_PANEL_REQUEST_EVENT);
        // Rust derives this label from the IPC caller and refuses mismatched identities.
        expect(args?.payload).toEqual(parsePluginPanelWindowLabel(`plugin-panel-${windowId}`));
        for (const handler of native.listeners.get(args!.event!) ?? []) handler({ payload: args!.payload });
      }
      return undefined;
    });
    const detached = document.createElement("div"); document.body.append(detached);
    panelRoot = createRoot(detached);
    await act(async () => panelRoot!.render(<PluginPanelWindow panelId={windowId} />));
    expect(native.invoke).toHaveBeenCalledWith("plugin_panel_event_forward", expect.anything());
    expect(detached.querySelector(".palette-title-label")?.textContent).toBe("Panel Test Plugin");
    expect(detached.querySelector("textarea")).not.toBeNull();
    expect(detached.querySelector("select")?.value).toBe("local");
    expect(detached.textContent).toContain("Using local test mode");
    expect(detached.textContent).not.toContain("Waiting for plugin content");
  } finally { descriptor.deactivate?.(); }
});
