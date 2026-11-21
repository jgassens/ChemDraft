// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, DocumentObjectSchema, type ChemDraftDocument } from "@chemdraft/chem-core";
import type { PluginPromptTextResult } from "@chemdraft/plugin-api";
import { MainWindow } from "./MainWindow";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import type { DesktopPluginRuntime, DesktopPluginRuntimeOptions } from "./plugins/createPluginRuntime";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { closeDocumentTabCommandId } from "./commands";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
const captured = vi.hoisted(() => ({
  runtime: undefined as DesktopPluginRuntime | undefined,
  options: undefined as DesktopPluginRuntimeOptions | undefined
}));
vi.mock("./plugins/createPluginRuntime", async original => {
  const actual = await original<typeof import("./plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: DesktopPluginRuntimeOptions) => {
    captured.options = options;
    captured.runtime = actual.createPluginRuntime(options);
    return captured.runtime;
  } };
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pluginId = "org.chemdraft.test.promptTabs";
const commandId = "plugin.promptTabs.insert";
const inserted = DocumentObjectSchema.parse({ id: "named-structure", type: "plus", x: 40, y: 40, width: 20, height: 20 });

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  captured.runtime = undefined; captured.options = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function command(id: string) {
  await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: id } })); });
}
const activeTabId = () => captured.options!.getActiveDocumentTab!()!.id;
const tabDocument = (tabId: string) => getAssistantHistoryPort().read(tabId)!;
const objectIds = (drawing: ChemDraftDocument) => drawing.pages.flatMap(page => page.objects.map(object => object.id));

/** Mounts the window with a Name-to-Structure-shaped plugin: ask for text, then insert into the drawing. */
async function mount() {
  await act(async () => root.render(<MainWindow initialDocument={createEmptyDocument()} initialPaletteMode="hidden"
    initialRulersVisible={false} nativePalette={false} />));
  const runtime = captured.runtime!;
  const prompts: PluginPromptTextResult[] = [];
  await act(async () => {
    runtime.registerPlugin({ id: pluginId, name: "Prompt tabs", version: "0.1.0", apiVersion: "^0.1.22", entry: "test.js",
      permissions: ["ui.panel", "document.write"], contributes: { commands: [{ id: commandId, title: "Insert Named Structure" }] }
    }, { commandHandlers: { [commandId]: async context => {
      const result = await context.dialogs!.promptText({ title: "Insert Structure from Name", label: "Chemical name" });
      prompts.push(result);
      if (result.status !== "submitted") return { status: "cancelled" };
      const pageId = tabDocument(activeTabId()).pages[0]!.id;
      await context.documents.applyPatch!({ reason: "Insert Named Structure", patch: { op: "addObject", pageId, object: inserted } });
      return { status: "inserted" };
    } } });
  });
  return { runtime, prompts };
}
async function start(runtime: DesktopPluginRuntime) {
  let invocation!: Promise<unknown>;
  await act(async () => { invocation = runtime.invokeCommand(commandId).then(value => value, error => error); });
  const open = runtime.prompts.getOpenPrompt();
  expect(open?.pluginId).toBe(pluginId);
  // The in-page prompt is on screen for the browser build.
  expect(container.ownerDocument.body.textContent).toContain("Insert Structure from Name");
  return { invocation, promptId: open!.id };
}

describe("plugin text prompt and document tabs", () => {
  it("inserts into the tab the command started on when answered there", async () => {
    const { runtime, prompts } = await mount();
    const tabA = activeTabId();
    const { invocation, promptId } = await start(runtime);
    await act(async () => { runtime.prompts.submit(promptId, "benzene"); await invocation; });
    expect(await invocation).toEqual({ status: "inserted" });
    expect(prompts).toEqual([{ status: "submitted", value: "benzene" }]);
    expect(objectIds(tabDocument(tabA))).toContain(inserted.id);
  });

  it("keeps the prompt open with Submit off on another tab, and inserts only into its own tab once back", async () => {
    const { runtime, prompts } = await mount();
    const tabA = activeTabId();
    const { invocation, promptId } = await start(runtime);
    const input = () => document.body.querySelector<HTMLInputElement>(".plugin-prompt-dialog input")!;
    const submitButton = () => document.body.querySelector<HTMLButtonElement>('.plugin-prompt-dialog button[type="submit"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), "benzene");
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });

    await command("document.new");
    const tabB = activeTabId();
    expect(tabB).not.toBe(tabA);
    const beforeB = tabDocument(tabB);
    // Still open with the typed text; Submit is off and one line says where to go.
    expect(runtime.prompts.getOpenPrompt()?.id).toBe(promptId);
    expect(input().value).toBe("benzene");
    expect(submitButton().disabled).toBe(true);
    expect(document.body.textContent).toContain("Switch back to Untitled to insert.");
    // An answer arriving while tab B is active is refused: the prompt stays open and nothing is written.
    await act(async () => { runtime.prompts.submit(promptId, "benzene"); });
    expect(runtime.prompts.getOpenPrompt()?.id).toBe(promptId);
    expect(prompts).toEqual([]);
    expect(tabDocument(tabB)).toBe(beforeB);

    await command("document.previousTab");
    expect(activeTabId()).toBe(tabA);
    expect(submitButton().disabled).toBe(false);
    expect(document.body.textContent).not.toContain("Switch back");
    await act(async () => { submitButton().click(); await invocation; });
    expect(await invocation).toEqual({ status: "inserted" });
    expect(prompts).toEqual([{ status: "submitted", value: "benzene" }]);
    expect(objectIds(tabDocument(tabA))).toContain(inserted.id);
    expect(objectIds(tabDocument(tabB))).not.toContain(inserted.id);
  });

  it("cancels the prompt when its tab is closed, also while another tab is active, inserting nothing", async () => {
    const { runtime, prompts } = await mount();
    await command("document.new");
    const tabB = activeTabId();
    await command("document.previousTab");
    const tabA = activeTabId();
    expect(tabA).not.toBe(tabB);
    const beforeB = tabDocument(tabB);
    const { invocation } = await start(runtime);
    await command("document.nextTab");
    expect(activeTabId()).toBe(tabB);
    expect(runtime.prompts.getOpenPrompt()).toBeDefined();

    await command(closeDocumentTabCommandId(tabA));
    expect(activeTabId()).toBe(tabB);
    expect(getAssistantHistoryPort().read(tabA)).toBeUndefined();
    expect(runtime.prompts.getOpenPrompt()).toBeUndefined();
    expect(await invocation).toEqual({ status: "cancelled" });
    expect(prompts).toEqual([{ status: "cancelled" }]);
    expect(tabDocument(tabB)).toBe(beforeB);
  });

  it("keeps the prompt open when the shell re-announces the same active document", async () => {
    const { runtime, prompts } = await mount();
    const tabA = activeTabId();
    const { invocation, promptId } = await start(runtime);
    // StrictMode re-runs the announcing effect without changing the document; that is not a switch.
    await act(async () => { runtime.notifyActiveDocumentChanged("re-announced"); });
    expect(runtime.prompts.getOpenPrompt()?.id).toBe(promptId);
    await act(async () => { runtime.prompts.submit(promptId, "benzene"); await invocation; });
    expect(prompts).toEqual([{ status: "submitted", value: "benzene" }]);
    expect(objectIds(tabDocument(tabA))).toContain(inserted.id);
  });
});
