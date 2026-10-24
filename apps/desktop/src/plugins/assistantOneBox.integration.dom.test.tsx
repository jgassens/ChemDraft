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

// Unmodified release bundle, including its SDK, parsers and command handlers. The real
// loader, worker bridge, host, MainWindow dispatch and PluginCanvasOverlay all participate.
const fixture = resolve("apps/desktop/src/plugins/__fixtures__/assistant-0.1.3");
const manifest: unknown = JSON.parse(readFileSync(resolve(fixture, "manifest.json"), "utf8"));
const entry = readFileSync(resolve(fixture, "entry.js"), "utf8");
const lines = readFileSync(resolve(fixture, "real-tool-reply.stdout.jsonl"), "utf8").trim().split("\n");
const reply = "I looked up benzene with `name_to_structure`, then inserted it using `insert_structures` with SMILES `c1ccccc1`.";
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
  // directly to the VM leaves host prototypes on button payloads; the bundled SDK
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
    // these spies between setup, send, AI choice and the refused submission.
    expect(native.openPanelWindow).not.toHaveBeenCalled();
    expect(native.invoke.mock.calls.filter(([command]) => command === "open_plugin_panel_window")).toEqual([]);
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

async function openFromPluginsMenu(origin: string): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MainWindow initialDocument={createPhase4Document("Assistant one box")}
    initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
  descriptor = loadPackagedPlugin({ baseUrl: `${origin}/installed-plugins/assistant/`, manifest }, {
    createWorker: entryUrl => {
      expect(entryUrl.href).toBe(`${origin}/installed-plugins/assistant/entry.js`);
      return createWorker();
    }
  });
  expect(descriptor.manifest.version).toBe("0.1.3");
  expect(descriptor.manifest.contributes.panels).toEqual([]);
  expect(descriptor.manifest.contributes.canvasOverlays).toHaveLength(1);
  expect(descriptor.manifest.contributes.canvasOverlays![0]!.prompt.select).toBeUndefined();
  await act(async () => { native.runtime!.registerPlugin(descriptor!.manifest, descriptor!.options); });
  const menus = native.runtime!.host.listMenuContributions("plugins")
    .filter(item => item.pluginId === descriptor!.manifest.id);
  expect(menus).toHaveLength(1);
  expect(menus[0]!.contribution.commandId).toBe("plugin.assistant.open");
  // This is the native Plugins menu's real command event, not direct host invocation.
  await command(() => window.dispatchEvent(new CustomEvent("chemdraft:native-command", {
    detail: { commandId: menus[0]!.contribution.commandId }
  })));
  expect(overlay().dataset.expanded).toBe("true");
  expect(document.activeElement).toBe(overlay().querySelector("textarea"));
  expect(overlay().querySelector(".plugin-canvas-overlay-panel")).toBeNull();
  expect(overlay().querySelector("select")).toBeNull();
  expect(overlay().querySelectorAll("textarea")).toHaveLength(1);
  expect(overlay().querySelector(".plugin-canvas-overlay-content")!.textContent).toContain("Setup — choose your AI");
  expect(native.invoke).toHaveBeenCalledWith("external_tool_status", expect.objectContaining({ tool: "codex" }));
}

async function chooseCodexInSetup(): Promise<void> {
  const heading = [...overlay().querySelectorAll("h4")].find(element => element.textContent === "Codex — OpenAI");
  expect(heading).toBeDefined();
  expect(heading!.parentElement!.textContent).toContain("Installed 0.163.0. Signed in");
  const actions = heading!.parentElement!.nextElementSibling!;
  await command(() => button("Use this AI", actions).click());
}

async function finishCodexSetup(): Promise<void> {
  await chooseCodexInSetup();
  await command(() => button("Finish setup").click());
  expect(overlay().textContent).not.toContain("Setup — choose your AI");
  expectCodexChoice();
  expectNothingRan();
}

function expectCodexChoice(): void {
  // AI choice is live overlay content, not a second state in the static prompt.
  const content = overlay().querySelector(".plugin-canvas-overlay-content")!;
  expect([...content.querySelectorAll("h4")].map(heading => heading.textContent)).toEqual(["AI: Codex (OpenAI)"]);
  expect(overlay().querySelector("select")).toBeNull();
  expect([...content.querySelectorAll("button")].map(button => button.textContent)).toEqual([
    "✓ Codex (OpenAI)", "Setup…", "New conversation"
  ]);
  button("✓ Codex (OpenAI)", content);
  button("Setup…", content);
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

function expectCodexReply(): void {
  const runs = native.invoke.mock.calls.filter(([command]) => command === "external_tool_run_start");
  expect(runs, overlay().textContent ?? "").toHaveLength(1);
  expect(runs[0]![1]).toMatchObject({ request: { tool: "codex", prompt, pluginId: "org.chemdraft.assistant" } });
  expect(native.invoke).toHaveBeenCalledWith("external_tool_run_poll", expect.objectContaining({ cursor: 0 }));
  expect(native.invoke).toHaveBeenCalledWith("external_tool_run_poll", expect.objectContaining({ cursor: lines.length }));
  const transcript = overlay().querySelector('[role="log"]')!;
  expect(transcript.querySelector('[data-role="user"] span')!.textContent).toBe(prompt);
  expect(transcript.querySelector('[data-role="assistant"] span')!.textContent).toBe(reply);
  expect(overlay().querySelector("textarea")!.compareDocumentPosition(transcript) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(status().textContent).toBe("Codex (OpenAI) replied — no changes to the page");
  expect(transcript.textContent).not.toMatch(/Done\.|Done —|replied — no changes to the page/i);
  expectCodexChoice();
}

describe.each(["tauri://localhost", "http://tauri.localhost"])("Assistant 0.1.3 one box (%s)", origin => {
  it("uses the AI chosen in Setup when the owner's next action is typing and pressing Enter", async () => {
    await openFromPluginsMenu(origin);
    await finishCodexSetup();
    // No storage seeding or extra AI-choice click: finishing Setup must be enough.
    expect(status().textContent).toBe("Codex (OpenAI) ready");
    await submit(prompt);
    expectCodexReply();
  });

  it("offers only set-up AIs through overlay buttons and starts a new conversation in the same box", async () => {
    await openFromPluginsMenu(origin);
    await finishCodexSetup();
    // Independent AI-button path, not a fallback in the owner's regression above.
    // Claude Code is not set up, so it must not be offered as a submission choice.
    await command(() => button("✓ Codex (OpenAI)").click());
    expectCodexChoice();
    expectNothingRan();
    await submit(prompt);
    expectCodexReply();
    await command(() => button("New conversation").click());
    expect(overlay().querySelector('[role="log"]')!.textContent).toBe("");
    expect(status().textContent).toBe("Codex (OpenAI) ready");
    expectCodexChoice();
    expect(native.invoke.mock.calls.filter(([command]) => command === "external_tool_run_start")).toHaveLength(1);
    await command(() => button("Setup…").click());
    expect(overlay().textContent).toContain("Setup — choose your AI");
  });

  it("refuses Enter before Setup is finished even when Codex is already installed and signed in", async () => {
    await openFromPluginsMenu(origin);
    await submit(prompt);
    expectSetupRefusal();
    // Choosing an installed, signed-in AI still cannot bypass Finish setup.
    await chooseCodexInSetup();
    await submit(prompt);
    expectSetupRefusal();
    await command(() => button("Finish setup").click());
    expectCodexChoice();
    expectNothingRan();
    expect(status().textContent).toBe("Codex (OpenAI) ready");
    await submit(prompt);
    expectCodexReply();
  });
});
