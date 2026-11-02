// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginWorkerHandle, WorkerToHostMessage } from "@chemdraft/plugin-api";
import type { EventCallback } from "@tauri-apps/api/event";
import { loadPackagedPlugin } from "./loadPackagedPlugin";
import { TauriExternalToolsEngine } from "../externalTools/externalToolsEngine";
import { TauriAssistantMcpEngine } from "../assistant/assistantMcpEngine";
import { MainWindow } from "../MainWindow";
import { createPhase4Document } from "../documentWorkflow";
import { MemoryStorage } from "../testSupport/memoryStorage";

const native = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  invoke: vi.fn(),
  openPanelWindow: vi.fn(async () => undefined),
  workerSettlements: [] as Extract<WorkerToHostMessage, { kind: "commandSettled" }>[],
  runtime: undefined as import("./createPluginRuntime").DesktopPluginRuntime | undefined
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => false }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    const listeners = native.listeners.get(name) ?? new Set();
    listeners.add(handler);
    native.listeners.set(name, listeners);
    return () => listeners.delete(handler);
  },
  emit: async (name: string, payload: unknown) => {
    for (const handler of native.listeners.get(name) ?? []) handler({ payload });
  }
}));
// Keep the real readiness/cleanup implementation when linked dependencies put dynamic
// native imports outside Vitest's mock graph. Only the native event attachment is replaced.
vi.mock("../window-manager/tauriEvents", async importOriginal => {
  const actual = await importOriginal<typeof import("../window-manager/tauriEvents")>();
  const listen = (name: string, handler: EventCallback<unknown>) => actual.safeTauriListen(name, async wrapped => {
    const listeners = native.listeners.get(name) ?? new Set();
    const receive = ({ payload }: { payload: unknown }) => wrapped({ event: name, id: 1, payload });
    listeners.add(receive);
    native.listeners.set(name, listeners);
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
vi.mock("./panelBridge", async importOriginal => ({
  ...await importOriginal<typeof import("./panelBridge")>(),
  openPluginPanelWindow: native.openPanelWindow
}));
vi.mock("./createPluginRuntime", async importOriginal => {
  const actual = await importOriginal<typeof import("./createPluginRuntime")>();
  return {
    ...actual,
    createPluginRuntime: (options: import("./createPluginRuntime").DesktopPluginRuntimeOptions) => {
      native.runtime = actual.createPluginRuntime({
        ...options,
        defaultPanelSurface: "window",
        externalToolsEngine: new TauriExternalToolsEngine(native.invoke),
        assistantMcpEngine: new TauriAssistantMcpEngine(native.invoke, () => ({ onmessage: () => undefined }) as never)
      });
      return native.runtime;
    }
  };
});

// Original minimal plugin exercises the real loader, worker bridge and host.
const fixture = resolve("apps/desktop/src/plugins/__fixtures__/overlay-chat");
const manifest: unknown = JSON.parse(readFileSync(resolve(fixture, "manifest.json"), "utf8"));
const entry = readFileSync(resolve(fixture, "entry.js"), "utf8");
const lines = readFileSync(resolve(fixture, "tool-reply.stdout.jsonl"), "utf8").trim().split("\n");
const reply = "Test lookup `lookup_item` returned `sample_item`; replay value `C`.";
const prompt = "Draw benzene";

function createWorker(): PluginWorkerHandle {
  const hostListeners = new Set<(event: { data: unknown }) => void>();
  const workerListeners = new Set<(event: { data: unknown }) => void>();
  let terminated = false;
  const deliver = (listeners: typeof hostListeners, data: unknown) => {
    queueMicrotask(() => { if (!terminated) listeners.forEach(listener => listener({ data })); });
  };
  const workerContext = createContext({
    TextEncoder, TextDecoder, URL, crypto, setTimeout, clearTimeout, console,
    postMessage: (message: WorkerToHostMessage) => {
      if (message.kind === "commandSettled") native.workerSettlements.push(message);
      deliver(hostListeners, structuredClone(message));
    },
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      if (type === "message") workerListeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      if (type === "message") workerListeners.delete(listener);
    }
  });
  // A real Worker clones into the receiving realm. Passing Node's structuredClone
  // directly to the VM leaves host prototypes on button payloads; the test worker
  // correctly rejects those as non-plain records. Recreate these JSON-shaped protocol
  // values in the worker realm, preserving undefined (unlike a JSON round trip).
  const cloneForWorker = runInContext(`(function clone(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return Array.from(value, clone);
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  })`, workerContext) as (message: unknown) => unknown;
  runInContext(entry, workerContext);
  return {
    postMessage: message => deliver(workerListeners, cloneForWorker(structuredClone(message))),
    addEventListener: (type, listener) => { if (type === "message") hostListeners.add(listener as (event: { data: unknown }) => void); },
    removeEventListener: (type, listener) => { if (type === "message") hostListeners.delete(listener as (event: { data: unknown }) => void); },
    terminate: () => { terminated = true; }
  };
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let descriptor: ReturnType<typeof loadPackagedPlugin> | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  native.runtime = undefined;
  native.workerSettlements.length = 0;
  native.openPanelWindow.mockClear();
  vi.stubGlobal("localStorage", new MemoryStorage());
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "external_tool_status") return {
      tool: args!.tool,
      publisher: args!.tool === "codex" ? "OpenAI" : "Anthropic",
      state: args!.tool === "codex" ? "installed" : "missing",
      signedIn: args!.tool === "codex", consented: args!.tool === "codex",
      version: args!.tool === "codex" ? "0.163.0" : undefined,
      authMethod: args!.tool === "codex" ? "chatgpt" : "none",
      pinnedVersion: "test", pinnedDownloadBytes: 0, freeDiskBytes: null,
      canInstall: args!.tool !== "codex", probedAt: "2026-10-24"
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
    return undefined;
  });
});

afterEach(async () => {
  try {
    expect(native.runtime?.panels.getDetachedPanels() ?? []).toEqual([]);
    expect(native.runtime?.panels.getOpenPanel()).toBeUndefined();
    await act(async () => {
      if (descriptor) native.runtime?.unregisterPlugin(descriptor.manifest.id);
      root?.unmount();
    });
    // Entire-lifetime assertions, including teardown and any failed test. Do not clear
    // these spies between setup, send, Mode choice and the refused submission.
    expect(native.openPanelWindow).not.toHaveBeenCalled();
    // Publication mode delivers a private snapshot without opening or revealing a window.
    expect(native.invoke.mock.calls.filter(([command, args]) => command === "open_plugin_panel_window" && args?.request)).toEqual([]);
  } finally {
    descriptor?.deactivate?.();
    descriptor = undefined;
    root = undefined;
    document.body.innerHTML = "";
    native.listeners.clear();
    native.invoke.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

function overlay(): HTMLDivElement {
  const widget = container.querySelector<HTMLDivElement>(".plugin-canvas-overlay");
  expect(widget).not.toBeNull();
  return widget!;
}

function button(label: string, parent: ParentNode = overlay()): HTMLButtonElement {
  const matches = [...parent.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent === label);
  expect(matches, `Expected one ${label} button`).toHaveLength(1);
  expect(matches[0]!.disabled).toBe(false);
  return matches[0]!;
}

async function command(action: () => void): Promise<void> {
  const count = native.workerSettlements.length;
  await act(async () => {
    action();
    await vi.waitFor(() => expect(native.workerSettlements).toHaveLength(count + 1), { timeout: 2000 });
  });
  expect(native.workerSettlements.at(-1)).toMatchObject({ ok: true });
}

async function loadTestPlugin(origin: string): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MainWindow initialDocument={createPhase4Document("Overlay chat")}
    initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
  descriptor = loadPackagedPlugin({ baseUrl: `${origin}/installed-plugins/overlay-chat/`, manifest }, {
    createWorker: entryUrl => {
      expect(entryUrl.href).toBe(`${origin}/installed-plugins/overlay-chat/entry.js`);
      return createWorker();
    }
  });
  expect(descriptor.manifest.version).toBe("0.0.1");
  expect(descriptor.manifest.contributes.panels).toEqual([]);
  expect(descriptor.manifest.contributes.canvasOverlays).toHaveLength(1);
  expect(descriptor.manifest.contributes.canvasOverlays![0]!.prompt.select).toBeUndefined();
  await act(async () => { native.runtime!.registerPlugin(descriptor!.manifest, descriptor!.options); });
}

async function openFromPluginsMenu(origin: string): Promise<void> {
  await loadTestPlugin(origin);
  const menus = native.runtime!.host.listMenuContributions("plugins")
    .filter(item => item.pluginId === descriptor!.manifest.id);
  expect(menus).toHaveLength(1);
  expect(menus[0]!.contribution.commandId).toBe("plugin.chat.open");
  // This is the native Plugins menu's real command event, not direct host invocation.
  await command(() => window.dispatchEvent(new CustomEvent("chemdraft:native-command", {
    detail: { commandId: menus[0]!.contribution.commandId }
  })));
  expect(overlay().dataset.expanded).toBe("true");
  expect(document.activeElement).toBe(overlay().querySelector("textarea"));
  expect(overlay().querySelector(".plugin-canvas-overlay-panel")).toBeNull();
  expect(overlay().querySelector("select")).toBeNull();
  expect(overlay().querySelectorAll("textarea")).toHaveLength(1);
  expect(overlay().querySelector(".plugin-canvas-overlay-content")!.textContent).toContain("Setup — choose a mode");
  expect(native.invoke).toHaveBeenCalledWith("external_tool_status", expect.objectContaining({ tool: "codex" }));
}

async function chooseLocalInSetup(): Promise<void> {
  const heading = [...overlay().querySelectorAll("h4")].find(element => element.textContent === "Local mode");
  expect(heading).toBeDefined();
  expect(heading!.parentElement!.textContent).toContain("Installed 0.163.0. Signed in");
  const actions = heading!.parentElement!.nextElementSibling!;
  await command(() => button("Use this mode", actions).click());
}

async function finishLocalSetup(): Promise<void> {
  await chooseLocalInSetup();
  await command(() => button("Finish setup").click());
  expect(overlay().textContent).not.toContain("Setup — choose a mode");
  expectLocalChoice();
  expectNothingRan();
}

function expectLocalChoice(): void {
  // Mode choice is live overlay content, not a second state in the static prompt.
  const content = overlay().querySelector(".plugin-canvas-overlay-content")!;
  expect([...content.querySelectorAll("h4")].map(heading => heading.textContent)).toEqual(["Mode: Local"]);
  expect(overlay().querySelector("select")).toBeNull();
  const pinned = overlay().querySelector(".plugin-canvas-overlay-primary-actions")!;
  expect([...pinned.querySelectorAll("button"), ...content.querySelectorAll("button")].map(button => button.textContent)).toEqual([
    "✓ Local", "Setup…", "New conversation"
  ]);
  button("✓ Local", pinned);
  button("Setup…", pinned);
  button("New conversation", content);
}

function status(): HTMLElement {
  const statuses = overlay().querySelectorAll<HTMLElement>('[role="status"]');
  expect(statuses).toHaveLength(1);
  return statuses[0]!;
}

function expectNothingRan(): void {
  expect(native.invoke.mock.calls.filter(([command]) =>
    command === "external_tool_run_start" || command === "external_tool_run_poll" || command === "assistant_mcp_session_open"
  )).toEqual([]);
}

function expectSetupRefusal(): void {
  const message = "Finish Setup above before sending a request.";
  expect(status().textContent).toContain(message);
  // Refusal belongs in the one status line, without a duplicate transcript notice.
  expect(overlay().querySelector('[role="log"]')!.textContent).not.toContain(message);
  expect(overlay().querySelector('[data-role="assistant"]')).toBeNull();
  expectNothingRan();
}

async function submit(text: string): Promise<void> {
  const textarea = overlay().querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    textarea.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await command(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
}

function expectToolReply(): void {
  const runs = native.invoke.mock.calls.filter(([command]) => command === "external_tool_run_start");
  expect(runs, overlay().textContent ?? "").toHaveLength(1);
  expect(runs[0]![1]).toMatchObject({ request: { tool: "codex", prompt, pluginId: "org.chemdraft.test.overlay-chat" } });
  expect(native.invoke).toHaveBeenCalledWith("external_tool_run_poll", expect.objectContaining({ cursor: 0 }));
  expect(native.invoke).toHaveBeenCalledWith("external_tool_run_poll", expect.objectContaining({ cursor: lines.length }));
  const transcript = overlay().querySelector('[role="log"]')!;
  expect(transcript.querySelector('[data-role="user"] span')!.textContent).toBe(prompt);
  expect(transcript.querySelector('[data-role="assistant"] span')!.textContent).toBe(reply.replaceAll("`", ""));
  expect([...transcript.querySelectorAll("code")].map(node => node.textContent)).toEqual(["lookup_item", "sample_item", "C"]);
  expect(transcript.compareDocumentPosition(overlay().querySelector("textarea")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(status().textContent).toBe("Local replied — no changes to the page");
  expect(transcript.textContent).not.toMatch(/Done\.|Done —|replied — no changes to the page/i);
  expectLocalChoice();
}

describe.each(["tauri://localhost", "http://tauri.localhost"])("Overlay chat (%s)", origin => {
  it("honours live prompt state through the host and resumes the loaded plugin after content clears it", async () => {
    await openFromPluginsMenu(origin);
    await finishLocalSetup();
    // Exercise prompt overrides against the registered overlay and MainWindow dispatcher.
    const api = native.runtime!.host.createCommandContext(descriptor!.manifest.id).overlays!;
    const overlayId = descriptor!.manifest.contributes.canvasOverlays![0]!.id;
    await act(async () => api.setContent({ overlayId, sections: [{ kind: "text", body: "Working" }], prompt: { disabled: true } }));
    expect(overlay().querySelector(".plugin-canvas-overlay-content")!.textContent).toContain("Working");
    const textarea = overlay().querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, prompt);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const settlements = native.workerSettlements.length;
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => button("Send").click());
    expect(native.workerSettlements).toHaveLength(settlements);
    expectNothingRan();
    expect(overlay().textContent).toContain("Wait for the current request to finish, or press Stop.");
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe(prompt);
    await act(async () => api.setContent({ overlayId, sections: [] }));
    await command(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expectToolReply();
  });

  it("loads the saved mode heading on the first expansion after relaunch", async () => {
    await loadTestPlugin(origin);
    const storage = native.runtime!.host.createCommandContext(descriptor!.manifest.id).storage!;
    await storage.set("provider", "codex");
    await storage.set("chosenProviders", ["codex"]);
    await command(() => overlay().querySelector<HTMLButtonElement>(".plugin-canvas-overlay-icon")!.click());
    expectLocalChoice();
    expectNothingRan();
  });

  it("initializes a cold icon expansion once through the declared menu opener, and retries only when empty", async () => {
    await loadTestPlugin(origin);
    expect(overlay().querySelector(".plugin-canvas-overlay-content")).toBeNull();
    await command(() => overlay().querySelector<HTMLButtonElement>(".plugin-canvas-overlay-icon")!.click());
    expect(overlay().textContent).toContain("Setup — choose a mode");
    expectNothingRan();
    await finishLocalSetup();
    const count = native.workerSettlements.length;
    await act(async () => overlay().querySelector<HTMLButtonElement>('[aria-label="Collapse Overlay Test Plugin"]')!.click());
    await act(async () => overlay().querySelector<HTMLButtonElement>(".plugin-canvas-overlay-icon")!.click());
    expect(native.workerSettlements).toHaveLength(count);
    expectLocalChoice();
    await act(async () => { await native.runtime!.host.createCommandContext(descriptor!.manifest.id).overlays!.setContent({
      overlayId: descriptor!.manifest.contributes.canvasOverlays![0]!.id, sections: []
    }); });
    await act(async () => overlay().querySelector<HTMLButtonElement>('[aria-label="Collapse Overlay Test Plugin"]')!.click());
    await command(() => overlay().querySelector<HTMLButtonElement>(".plugin-canvas-overlay-icon")!.click());
    expectLocalChoice();
    expectNothingRan();
  });

  it("refuses a second request while the plugin command is pending and keeps the next draft", async () => {
    await openFromPluginsMenu(origin); await finishLocalSetup();
    const original = native.invoke.getMockImplementation()!;
    let finish!: () => void;
    const running = new Promise<void>(resolve => { finish = resolve; });
    native.invoke.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === "external_tool_run_poll") await running;
      return original(name, args);
    });
    const textarea = overlay().querySelector("textarea")!;
    const type = async (text: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const enter = () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await type(prompt);
    await act(async () => {
      enter();
      await vi.waitFor(() => expect(native.invoke.mock.calls.filter(([name]) => name === "external_tool_run_poll")).toHaveLength(1));
    });
    await type("Draw ethanol");
    await act(async () => enter());
    expect(overlay().textContent).toContain("Wait for the current request to finish, or press Stop.");
    await act(async () => button("Send").click());
    expect(textarea.value).toBe("Draw ethanol");
    await act(async () => {
      finish();
      await vi.waitFor(() => expect(overlay().querySelector('[data-role="assistant"]')).not.toBeNull());
    });
    expect(native.invoke.mock.calls.filter(([name]) => name === "external_tool_run_start")).toHaveLength(1);
    expect(textarea.value).toBe("Draw ethanol");
  });

  it("uses the mode chosen in Setup when the owner's next action is typing and pressing Enter", async () => {
    await openFromPluginsMenu(origin);
    await finishLocalSetup();
    // No storage seeding or extra mode-choice click: finishing Setup must be enough.
    expect(status().textContent).toBe("Local ready");
    await submit(prompt);
    expectToolReply();
  });

  it("offers only configured modes through overlay buttons and starts a new conversation in the same box", async () => {
    await openFromPluginsMenu(origin);
    await finishLocalSetup();
    // Independent mode-button path, not a fallback in the owner's regression above.
    // The alternate mode is not configured, so it must not be offered as a submission choice.
    await command(() => button("✓ Local").click());
    expectLocalChoice();
    expectNothingRan();
    await submit(prompt);
    expectToolReply();
    await command(() => button("New conversation").click());
    expect(overlay().querySelector('[role="log"]')!.textContent).toBe("");
    expect(status().textContent).toBe("Local ready");
    expectLocalChoice();
    expect(native.invoke.mock.calls.filter(([command]) => command === "external_tool_run_start")).toHaveLength(1);
    await command(() => button("Setup…").click());
    expect(overlay().textContent).toContain("Setup — choose a mode");
  });

  it("refuses Enter before Setup is finished even when the tool is already installed and signed in", async () => {
    await openFromPluginsMenu(origin);
    await submit(prompt);
    expectSetupRefusal();
    // Choosing an installed, signed-in tool still cannot bypass Finish setup.
    await chooseLocalInSetup();
    await submit(prompt);
    expectSetupRefusal();
    await command(() => button("Finish setup").click());
    expectLocalChoice();
    expectNothingRan();
    expect(status().textContent).toBe("Local ready");
    await submit(prompt);
    expectToolReply();
  });
});
