// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginCommandContext, PluginPromptTextResult } from "@chemdraft/plugin-api";
import { createEmptyDocument, DocumentObjectSchema } from "@chemdraft/chem-core";
import { getAssistantHistoryPort } from "../assistant/historyPort";
import { DOM_COMMAND_EVENT } from "../window-manager";
import { MainWindow } from "../MainWindow";
import type { DesktopPluginRuntime } from "../plugins/createPluginRuntime";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { DialogWindow } from "./DialogWindow";
import type { DialogDelivery } from "./dialogTransport";
import { parseDialogMessage, type DialogMessage } from "./dialogProtocol";

const native = vi.hoisted(() => ({
  receiveOwner: undefined as ((delivery: DialogDelivery) => void) | undefined,
  receiveHost: undefined as ((message: DialogMessage) => void) | undefined,
  runtime: undefined as DesktopPluginRuntime | undefined,
  activeTabId: undefined as (() => string | undefined) | undefined,
  open: vi.fn(),
  publish: vi.fn(),
  send: vi.fn(),
  close: vi.fn()
}));
const label = "dialog-main-pluginTextPrompt-1";
vi.mock("./dialogTransport", () => ({
  nativeDialogTransport: {
    subscribe: async (receive: typeof native.receiveOwner) => { native.receiveOwner = receive; return () => {}; },
    open: native.open,
    publish: native.publish,
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
  return { ...actual, createPluginRuntime: (options: Parameters<typeof actual.createPluginRuntime>[0]) => {
    native.activeTabId = () => options.getActiveDocumentTab?.()?.id;
    return native.runtime = actual.createPluginRuntime(options);
  } };
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

type Method = "Submit" | "Enter" | "Cancel" | "Escape" | "Cmd+." | "title-bar close" | "command ends";

it.each([
  ["macos", "Submit"],
  ["windows", "Enter"],
  ["windows", "Cancel"],
  ["macos", "Escape"],
  ["windows", "Escape"],
  ["macos", "Cmd+."],
  ["windows", "title-bar close"],
  ["macos", "command ends"]
] as const)("%s %s: the plugin text prompt is its own native window, not part of the document", async (platform, method: Method) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform === "macos" ? "MacIntel" : "Win32");
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
  await act(async () => {
    mainRoot.render(<MainWindow shortcutPlatform={platform} nativePalette={false}
      initialActiveToolCommandId="tool.bond" initialPaletteMode="hidden" initialRulersVisible={false} />);
    hostRoot.render(<DialogWindow hostId="host" />);
  });

  const commandId = "plugin.nameToStructure.ask";
  const result = vi.fn();
  let finishCommand!: () => void;
  const commandDone = new Promise<void>(resolve => { finishCommand = resolve; });
  await act(async () => native.runtime!.registerPlugin({ id: "org.test.opsin", name: "Name to Structure (OPSIN)", version: "1.0.0",
    apiVersion: "^0.1.3", entry: "test.js", permissions: ["ui.panel"],
    contributes: { commands: [{ id: commandId, title: "Structure from Name" }] }
  }, { commandHandlers: { [commandId]: async ({ dialogs }: PluginCommandContext) => {
    if (method === "command ends") {
      // Fire and forget: the prompt must close when the command returns.
      void dialogs!.promptText({ title: "Structure from Name", label: "Chemical name", submitLabel: "Insert" })
        .then((answer: PluginPromptTextResult) => result(answer));
      await commandDone;
      return;
    }
    result(await dialogs!.promptText({ title: "Structure from Name", label: "Chemical name", placeholder: "e.g. aspirin", submitLabel: "Insert" }));
  } } }));

  let invoking!: Promise<unknown>;
  await act(async () => { invoking = native.runtime!.invokeCommand(commandId); });
  await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce());
  const snapshot = native.open.mock.calls[0]![0];
  expect(snapshot).toMatchObject({ dialogKind: "pluginTextPrompt", type: "snapshot", documentTabId: "initial",
    data: { title: "Structure from Name", label: "Chemical name", submitLabel: "Insert", maxLength: 500,
      pluginName: "Name to Structure (OPSIN)", pluginId: "org.test.opsin" } });
  // Nothing is drawn or dimmed inside the document viewport.
  expect(main.querySelector(".plugin-prompt-backdrop")).toBeNull();
  expect(main.querySelector(".plugin-prompt-dialog")).toBeNull();
  expect(document.body.querySelector(":scope > .plugin-prompt-backdrop")).toBeNull();
  expect(main.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();

  await act(async () => { await import("./PluginTextPromptForm"); native.receiveHost!(snapshot); });
  await vi.waitFor(() => expect(native.send).toHaveBeenCalledWith("host", expect.objectContaining({ type: "ready" })));
  const input = hostDocument.querySelector<HTMLInputElement>(".plugin-prompt-body input")!;
  expect(hostDocument.activeElement).toBe(input);
  expect(hostDocument.body.textContent).toContain("Requested by Name to Structure (OPSIN) (org.test.opsin)");
  const setValue = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  await act(async () => setValue("  benzene  "));

  const canvas = main.querySelector<HTMLElement>(".canvas-region")!;
  const mainKey = vi.fn();
  canvas.addEventListener("keydown", mainKey);
  const press = (key: string, init: KeyboardEventInit = {}, type = "keydown") => {
    const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const button = (text: string) => [...hostDocument.querySelectorAll("button")].find(b => b.textContent === text)!;
  await act(async () => {
    if (method === "Submit") button("Insert").click();
    else if (method === "Enter") expect(press("Enter")).toBe(true);
    else if (method === "Cancel") button("Cancel").click();
    else if (method === "Escape") {
      expect(press("Escape")).toBe(true);
      expect(press("Escape", { repeat: true })).toBe(true);
      expect(native.close).not.toHaveBeenCalled();
      expect(press("Escape", {}, "keyup")).toBe(true);
    } else if (method === "Cmd+.") expect(press(".", { metaKey: true })).toBe(true);
    else if (method === "title-bar close") {
      // Rust reports the native close; the owner settles without closing again.
      native.receiveOwner!({ senderWindowId: "main", windowLabel: label,
        message: { ...snapshot, requestId: "closed-1", type: "closed", data: { reason: "close" } } });
    } else finishCommand();
    await invoking;
  });
  await vi.waitFor(() => expect(result).toHaveBeenCalledOnce());
  const submitted = method === "Submit" || method === "Enter";
  expect(result).toHaveBeenCalledExactlyOnceWith(submitted ? { status: "submitted", value: "  benzene  " } : { status: "cancelled" });
  if (method === "title-bar close") expect(native.close).not.toHaveBeenCalled();
  else expect(native.close).toHaveBeenCalledExactlyOnceWith("host", submitted ? "apply" : "cancel");
  expect(mainKey).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(canvas);
  expect(native.runtime!.prompts.getOpenPrompt()).toBeUndefined();
});

it("keeps the prompt open with Submit off while another tab is active, and inserts only into its own tab", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  native.open.mockResolvedValue({ hostId: "host", windowLabel: label });
  native.publish.mockImplementation(async (_id, message) => { native.receiveHost!(message); });
  native.send.mockImplementation(async (_id, message) => native.receiveOwner!({ senderWindowId: label, windowLabel: label, message }));
  const main = document.body.appendChild(document.createElement("div"));
  const mainRoot = createRoot(main);
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const hostDocument = iframe.contentDocument!;
  const hostRoot = createRoot(hostDocument.body);
  roots.push(mainRoot, hostRoot);
  native.close.mockImplementation(async () => { hostRoot.unmount(); roots.pop(); });
  await act(async () => {
    mainRoot.render(<MainWindow shortcutPlatform="macos" nativePalette={false} initialDocument={createEmptyDocument({ title: "Aspirin notes" })}
      initialPaletteMode="hidden" initialRulersVisible={false} />);
    hostRoot.render(<DialogWindow hostId="host" />);
  });
  const commandId = "plugin.nameToStructure.insert";
  const inserted = DocumentObjectSchema.parse({ id: "named-structure", type: "plus", x: 40, y: 40, width: 20, height: 20 });
  const objectIds = (tabId: string) => getAssistantHistoryPort().read(tabId)!.pages.flatMap(page => page.objects.map(object => object.id));
  await act(async () => native.runtime!.registerPlugin({ id: "org.test.opsin", name: "Name to Structure (OPSIN)", version: "1.0.0",
    apiVersion: "^0.1.22", entry: "test.js", permissions: ["ui.panel", "document.write"],
    contributes: { commands: [{ id: commandId, title: "Structure from Name" }] }
  }, { commandHandlers: { [commandId]: async context => {
    const answer = await context.dialogs!.promptText({ title: "Structure from Name", label: "Chemical name", submitLabel: "Insert" });
    if (answer.status !== "submitted") return { status: "cancelled" };
    const pageId = getAssistantHistoryPort().read("initial")!.pages[0]!.id;
    await context.documents.applyPatch!({ reason: "Insert", patch: { op: "addObject", pageId, object: inserted } });
    return { status: "inserted" };
  } } }));
  let invoking!: Promise<unknown>;
  await act(async () => { invoking = native.runtime!.invokeCommand(commandId); });
  await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce());
  const snapshot = native.open.mock.calls[0]![0];
  await act(async () => { await import("./PluginTextPromptForm"); native.receiveHost!(snapshot); });
  const input = hostDocument.querySelector<HTMLInputElement>(".plugin-prompt-body input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "aspirin");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const insert = () => [...hostDocument.querySelectorAll("button")].find(b => b.textContent === "Insert")!;
  const command = (id: string) => act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: id } })); });

  await command("document.new");
  const otherTab = native.activeTabId!()!;
  expect(otherTab).not.toBe("initial");
  expect(native.close).not.toHaveBeenCalled();
  expect(native.runtime!.prompts.getOpenPrompt()).toBeDefined();
  expect(insert().disabled).toBe(true);
  expect(hostDocument.body.textContent).toContain("Switch back to Aspirin notes to insert.");
  expect(input.value).toBe("aspirin");
  // Enter does nothing, and an answer that reaches the owner anyway is refused: nothing is written anywhere.
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(native.send).not.toHaveBeenCalledWith("host", expect.objectContaining({ type: "action" }));
  await act(async () => native.receiveOwner!({ senderWindowId: label, windowLabel: label,
    message: { ...snapshot, requestId: "forged-submit", type: "action", data: { action: "submit", value: "aspirin" } } }));
  expect(native.close).not.toHaveBeenCalled();
  expect(native.runtime!.prompts.getOpenPrompt()).toBeDefined();
  expect(objectIds("initial")).not.toContain(inserted.id);

  await command("document.previousTab");
  expect(insert().disabled).toBe(false);
  expect(hostDocument.body.textContent).not.toContain("Switch back");
  await act(async () => { insert().click(); await invoking; });
  expect(await invoking).toEqual({ status: "inserted" });
  expect(native.close).toHaveBeenCalledExactlyOnceWith("host", "apply");
  expect(objectIds("initial")).toContain(inserted.id);
  expect(objectIds(otherTab)).not.toContain(inserted.id);
});

it("does not handle Cmd+. on Windows", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  const { PluginTextPromptForm } = await import("./PluginTextPromptForm");
  const onCancel = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<PluginTextPromptForm platform="windows" onSubmit={vi.fn()} onCancel={onCancel}
    data={{ title: "T", label: "L", placeholder: "", initialValue: "", submitLabel: "OK", maxLength: 10, pluginName: "P", pluginId: "p" }} />));
  const input = container.querySelector("input")!;
  const event = new KeyboardEvent("keydown", { key: ".", metaKey: true, bubbles: true, cancelable: true });
  await act(async () => { input.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(false);
  expect(onCancel).not.toHaveBeenCalled();
});
