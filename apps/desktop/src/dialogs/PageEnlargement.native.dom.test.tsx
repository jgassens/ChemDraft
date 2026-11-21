// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@chemdraft/chem-core";
import type { PluginCommandContext } from "@chemdraft/plugin-api";
import type { ChemDraftAgentBridge } from "../agentBridge";
import { setDocumentCustomPageSize } from "../documentWorkflow";
import { closeDocumentTabCommandId } from "../commands";
import { MainWindow } from "../MainWindow";
import { DOM_COMMAND_EVENT } from "../window-manager";
import type { DesktopPluginRuntime } from "../plugins/createPluginRuntime";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { DialogWindow } from "./DialogWindow";
import type { DialogDelivery } from "./dialogTransport";
import { PAGE_ENLARGEMENT_TITLE, parseDialogMessage, type DialogMessage } from "./dialogProtocol";

const native = vi.hoisted(() => ({
  receiveOwner: undefined as ((delivery: DialogDelivery) => void) | undefined,
  receiveHost: undefined as ((message: DialogMessage) => void) | undefined,
  runtime: undefined as DesktopPluginRuntime | undefined,
  open: vi.fn(),
  send: vi.fn(),
  close: vi.fn()
}));
const label = "dialog-main-pageEnlargement-1";
vi.mock("./dialogTransport", () => ({
  nativeDialogTransport: {
    subscribe: async (receive: typeof native.receiveOwner) => { native.receiveOwner = receive; return () => {}; },
    open: native.open,
    publish: vi.fn(),
    close: native.close
  },
  subscribeDialogHost: async (_id: string, receive: typeof native.receiveHost) => { native.receiveHost = receive; return () => {}; },
  sendDialogMessage: native.send
}));
vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
vi.mock("../window-manager", async original => ({
  ...await original<typeof import("../window-manager")>(), isDesktopRuntime: () => true,
  loadDocumentSession: async () => undefined, saveDocumentSession: async () => {},
  loadToolsetLayoutState: async () => undefined, listToolsetWindowStates: async () => [],
  setToolbarsMenu: async () => {}, setQuitPromptEnabled: async () => {},
  listenForQuitFlushRequest: async () => () => {}, listenForQuitPromptRequest: async () => () => {},
  listenForQuitSettings: async () => () => {}
}));
vi.mock("../window-manager/tauriEvents", async original => ({
  ...await original<typeof import("../window-manager/tauriEvents")>(),
  listenTauriEvent: async () => () => {}, listenCurrentWindowEvent: async () => () => {}
}));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), isTauri: () => false, invoke: vi.fn(async () => null)
}));
vi.mock("../plugins/createPluginRuntime", async original => {
  const actual = await original<typeof import("../plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: Parameters<typeof actual.createPluginRuntime>[0]) =>
    native.runtime = actual.createPluginRuntime(options) };
});

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0).reverse()) root.unmount(); });
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["macos", "Escape"],
  ["windows", "Escape"],
  ["macos", "Cmd+."],
  ["windows", "Keep Page Size"],
  ["windows", "Enlarge"],
  ["macos", "end request"],
  ["windows", "timeout"]
] as const)("%s %s dismisses only the native question and returns focus to the drawing", async (platform, method) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform === "macos" ? "MacIntel" : "Win32");
  window.history.replaceState(null, "", "/?agentBridge=1");
  native.open.mockResolvedValue({ hostId: "host", windowLabel: label });
  native.send.mockImplementation(async (_id, message) => {
    expect(parseDialogMessage(message)).toEqual(message);
    native.receiveOwner!({ senderWindowId: label, windowLabel: label, message });
  });
  const main = document.body.appendChild(document.createElement("div"));
  const mainRoot = createRoot(main);
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const hostDocument = iframe.contentDocument!;
  const hostRoot = createRoot(hostDocument.body);
  roots.push(mainRoot, hostRoot);
  native.close.mockImplementation(async () => { hostRoot.unmount(); roots.pop(); });
  const drawing = setDocumentCustomPageSize(createEmptyDocument(), { width: 100, height: 100, unit: "css-px" });
  await act(async () => {
    mainRoot.render(<MainWindow initialDocument={drawing} shortcutPlatform={platform} nativePalette={false}
      initialActiveToolCommandId="tool.bond" initialPaletteMode="hidden" initialRulersVisible={false} />);
    hostRoot.render(<DialogWindow hostId="host" />);
  });
  const commandId = "plugin.pageQuestion.ask";
  let endRequest!: () => Promise<unknown>;
  const result = vi.fn();
  await act(async () => native.runtime!.registerPlugin({ id: "org.test.pageQuestion", name: "Page question", version: "1.0.0",
    apiVersion: "^0.1.26", entry: "test.js", permissions: ["document.read", "selection.read", "document.write", "chemistry.compute"],
    contributes: { commands: [{ id: commandId, title: "Ask for page space" }] }
  }, { commandHandlers: { [commandId]: async ({ requests }: PluginCommandContext) => {
    const begin = await requests!.begin({ label: "Ask for page space" });
    if (!begin.ok) throw new Error(begin.error.message);
    const { requestId } = begin.value;
    endRequest = () => requests!.end({ requestId });
    const context = await requests!.getContext({ requestId });
    if (!context.ok) throw new Error(context.error.message);
    const { pageId, revision } = context.value.pages[0]!;
    result(await requests!.requestPageSpace!({ requestId, pageId, revision,
      requiredBounds: { x: 20, y: 20, width: 200, height: 100 } }));
  } } }));
  let expire: (() => void) | undefined;
  if (method === "timeout") {
    const setTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (delay === 300_000 && typeof callback === "function") expire = () => callback(...args);
      return setTimer(callback, delay, ...args);
    });
  }
  let invoking!: Promise<unknown>;
  await act(async () => { invoking = native.runtime!.invokeCommand(commandId); });
  await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce());
  const snapshot = native.open.mock.calls[0]![0];
  expect(snapshot).toMatchObject({ dialogKind: "pageEnlargement", type: "snapshot", data: { title: PAGE_ENLARGEMENT_TITLE } });
  expect(main.querySelector(".plugin-prompt-backdrop")).toBeNull();
  await act(async () => { await import("./PageEnlargementForm"); native.receiveHost!(snapshot); });
  await vi.waitFor(() => expect(native.send).toHaveBeenCalledWith("host", expect.objectContaining({ type: "ready" })));

  const mainKey = vi.fn(), hostKey = vi.fn();
  const canvas = main.querySelector<HTMLElement>(".canvas-region")!;
  const keep = [...hostDocument.querySelectorAll("button")].find(button => button.textContent === "Keep Page Size")!;
  const active = hostDocument.activeElement!;
  expect(active.textContent).toBe("Enlarge");
  canvas.addEventListener("keydown", mainKey);
  active.addEventListener("keydown", hostKey);
  const otherControl = main.querySelector<HTMLButtonElement>(".document-tab-new")!;
  await act(async () => { otherControl.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
  expect(native.close).not.toHaveBeenCalled();
  const press = (key: string, init: KeyboardEventInit = {}, type = "keydown") => {
    const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init });
    active.dispatchEvent(event);
    return event.defaultPrevented;
  };
  await act(async () => {
    if (method === "end request") await endRequest();
    else if (method === "timeout") expire!();
    else if (method === "Enlarge") (active as HTMLButtonElement).click();
    else if (method === "Escape") {
      expect(press("Escape")).toBe(true);
      expect(press("Escape", { repeat: true })).toBe(true);
      expect(native.close).not.toHaveBeenCalled();
      expect(press("Escape", {}, "keyup")).toBe(true);
    } else if (method === "Cmd+.") {
      expect(press(".", { metaKey: true })).toBe(true);
    } else {
      expect(press(".", { metaKey: true })).toBe(false);
      expect(press(".", { ctrlKey: true })).toBe(false);
      expect(native.close).not.toHaveBeenCalled();
      keep.click();
    }
    await invoking;
  });
  expect(native.close).toHaveBeenCalledExactlyOnceWith("host", method === "Enlarge" ? "apply" : "cancel");
  expect(hostDocument.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(canvas);
  expect(mainKey).not.toHaveBeenCalled();
  expect(hostKey).toHaveBeenCalledTimes(method === "Keep Page Size" ? 2 : 0);
  const bridge = (window as Window & { __CHEMDRAFT_AGENT__?: ChemDraftAgentBridge }).__CHEMDRAFT_AGENT__!;
  expect(bridge.snapshot().activeToolCommandId).toBe("tool.bond");
  expect(result).toHaveBeenCalledExactlyOnceWith({ ok: true, value: method === "end request" || method === "timeout"
    ? { outcome: "unanswered" } : { outcome: method === "Enlarge" ? "enlarge" : "keep", decisionId: expect.any(String) } });
});

async function mountOwnedByOriginatingTab(platform: "macos" | "windows") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform === "macos" ? "MacIntel" : "Win32");
  native.open.mockResolvedValue({ hostId: "host", windowLabel: label });
  native.send.mockImplementation(async (_id, message) => {
    native.receiveOwner!({ senderWindowId: label, windowLabel: label, message });
  });
  const main = document.body.appendChild(document.createElement("div"));
  const mainRoot = createRoot(main);
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const hostDocument = iframe.contentDocument!;
  const hostRoot = createRoot(hostDocument.body);
  roots.push(mainRoot, hostRoot);
  native.close.mockImplementation(async () => { hostRoot.unmount(); roots.pop(); });
  const drawing = setDocumentCustomPageSize(createEmptyDocument(), { width: 100, height: 100, unit: "css-px" });
  await act(async () => {
    mainRoot.render(<MainWindow initialDocument={drawing} shortcutPlatform={platform} nativePalette={false}
      initialActiveToolCommandId="tool.bond" initialPaletteMode="hidden" initialRulersVisible={false} />);
    hostRoot.render(<DialogWindow hostId="host" />);
  });
  const commandId = "plugin.pageQuestion.ask";
  const result = vi.fn();
  let proceed!: () => void;
  const gate = new Promise<void>(resolve => { proceed = resolve; });
  await act(async () => native.runtime!.registerPlugin({ id: "org.test.pageQuestion", name: "Page question", version: "1.0.0",
    apiVersion: "^0.1.26", entry: "test.js", permissions: ["document.read", "selection.read", "document.write", "chemistry.compute"],
    contributes: { commands: [{ id: commandId, title: "Ask for page space" }] }
  }, { commandHandlers: { [commandId]: async ({ requests }: PluginCommandContext) => {
    const begin = await requests!.begin({ label: "Ask for page space" });
    if (!begin.ok) throw new Error(begin.error.message);
    const { requestId } = begin.value;
    const context = await requests!.getContext({ requestId });
    if (!context.ok) throw new Error(context.error.message);
    const { pageId, revision } = context.value.pages[0]!;
    await gate; // The user switches tabs after the request started and before it asks for space.
    result(await requests!.requestPageSpace!({ requestId, pageId, revision,
      requiredBounds: { x: 20, y: 20, width: 200, height: 100 } }));
  } } }));
  const command = (commandId: string) => act(async () => {
    window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }));
  });
  let invoking!: Promise<unknown>;
  await act(async () => { invoking = native.runtime!.invokeCommand(commandId); });
  await command("document.new");
  await act(async () => { proceed(); });
  await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce());
  const snapshot = native.open.mock.calls[0]![0];
  await act(async () => { await import("./PageEnlargementForm"); native.receiveHost!(snapshot); });
  await vi.waitFor(() => expect(native.send).toHaveBeenCalledWith("host", expect.objectContaining({ type: "ready" })));
  return { main, hostDocument, snapshot, result, command, invoking: () => invoking };
}

it.each(["macos", "windows"] as const)("%s binds the question to the request's tab: closing another tab leaves it open", async platform => {
  const { hostDocument, snapshot, result, command, invoking } = await mountOwnedByOriginatingTab(platform);
  expect(snapshot).toMatchObject({ dialogKind: "pageEnlargement", documentTabId: "initial" });
  await command("document.closeTab"); // closes the active tab B, which is not the request's tab
  expect(native.close).not.toHaveBeenCalled();
  expect(hostDocument.querySelector('[role="dialog"]')).not.toBeNull();
  expect(result).not.toHaveBeenCalled();
  const enlarge = [...hostDocument.querySelectorAll("button")].find(button => button.textContent === "Enlarge")!;
  await act(async () => { enlarge.click(); await invoking(); });
  expect(native.close).toHaveBeenCalledExactlyOnceWith("host", "apply");
  expect(result).toHaveBeenCalledExactlyOnceWith({ ok: true, value: { outcome: "enlarge", decisionId: expect.any(String) } });
});

it.each(["macos", "windows"] as const)("%s dismisses the question as unanswered when the request's own tab closes", async platform => {
  const { snapshot, result, command, invoking } = await mountOwnedByOriginatingTab(platform);
  expect(snapshot).toMatchObject({ dialogKind: "pageEnlargement", documentTabId: "initial" });
  await command(closeDocumentTabCommandId("initial")); // the request's tab A while tab B is active
  await act(async () => { await invoking(); });
  expect(native.close).toHaveBeenCalledExactlyOnceWith("host", "cancel"); // the closed tab ends its request, which aborts the question
  expect(result).toHaveBeenCalledExactlyOnceWith({ ok: true, value: { outcome: "unanswered" } });
});

it("gives two concurrent requests in two tabs each a question owned by its own tab", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  let opened = 0;
  native.open.mockImplementation(async () => ({ hostId: `host-${++opened}`, windowLabel: `${label}-${opened}` }));
  native.send.mockResolvedValue(undefined);
  const main = document.body.appendChild(document.createElement("div"));
  const mainRoot = createRoot(main);
  roots.push(mainRoot);
  const drawing = setDocumentCustomPageSize(createEmptyDocument(), { width: 100, height: 100, unit: "css-px" });
  await act(async () => {
    mainRoot.render(<MainWindow initialDocument={drawing} shortcutPlatform="macos" nativePalette={false}
      initialActiveToolCommandId="tool.bond" initialPaletteMode="hidden" initialRulersVisible={false} />);
  });
  const commandId = "plugin.pageQuestion.ask";
  const result = vi.fn();
  const gates: Array<() => void> = [];
  const ends: Array<() => Promise<unknown>> = [];
  await act(async () => native.runtime!.registerPlugin({ id: "org.test.pageQuestion", name: "Page question", version: "1.0.0",
    apiVersion: "^0.1.26", entry: "test.js", permissions: ["document.read", "selection.read", "document.write", "chemistry.compute"],
    contributes: { commands: [{ id: commandId, title: "Ask for page space" }] }
  }, { commandHandlers: { [commandId]: async ({ requests }: PluginCommandContext) => {
    const begin = await requests!.begin({ label: "Ask for page space" });
    if (!begin.ok) throw new Error(begin.error.message);
    const { requestId } = begin.value;
    ends.push(() => requests!.end({ requestId }));
    const context = await requests!.getContext({ requestId });
    if (!context.ok) throw new Error(context.error.message);
    const { pageId, revision } = context.value.pages[0]!;
    await new Promise<void>(resolve => gates.push(resolve)); // Both requests exist before either asks.
    result(await requests!.requestPageSpace!({ requestId, pageId, revision,
      requiredBounds: { x: 20, y: 20, width: 5000, height: 5000 } }));
  } } }));
  const command = (id: string) => act(async () => {
    window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: id } }));
  });
  const invoking: Promise<unknown>[] = [];
  await act(async () => { invoking.push(native.runtime!.invokeCommand(commandId)); });
  await vi.waitFor(() => expect(gates).toHaveLength(1)); // Request 1 is bound to the first tab.
  await command("document.new");
  await act(async () => { invoking.push(native.runtime!.invokeCommand(commandId)); });
  await vi.waitFor(() => expect(gates).toHaveLength(2)); // Request 2 is bound to the new, active tab.
  await act(async () => { gates[1]!(); gates[0]!(); }); // Ask in the reverse of the order they began.
  await vi.waitFor(() => expect(native.open).toHaveBeenCalledTimes(2));
  const owners = native.open.mock.calls.map(call => call[0].documentTabId);
  expect(new Set(owners).size).toBe(2);
  expect(owners).toContain("initial");
  expect(owners.find(owner => owner !== "initial")).toBeTruthy();
  for (const call of native.open.mock.calls) {
    expect(call[0]).toMatchObject({ dialogKind: "pageEnlargement" });
  }
  // Closing request 1's own tab dismisses only its question; request 2's tab and question stay.
  await command(closeDocumentTabCommandId("initial"));
  await vi.waitFor(() => expect(result).toHaveBeenCalledTimes(1));
  expect(result).toHaveBeenLastCalledWith({ ok: true, value: { outcome: "unanswered" } });
  expect(native.close).toHaveBeenCalledOnce();
  await act(async () => { await ends[1]!(); await Promise.all(invoking); });
  expect(result).toHaveBeenCalledTimes(2);
  expect(native.close).toHaveBeenCalledTimes(2);
});
