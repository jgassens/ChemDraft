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
const touchCommandId = "plugin.promptTabs.touch";
const touched = DocumentObjectSchema.parse({ id: "unsaved-edit", type: "plus", x: 80, y: 80, width: 20, height: 20 });
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
async function mount(initialDocument: ChemDraftDocument = createEmptyDocument()) {
  await act(async () => root.render(<MainWindow initialDocument={initialDocument} initialPaletteMode="hidden"
    initialRulersVisible={false} nativePalette={false} />));
  const runtime = captured.runtime!;
  const prompts: PluginPromptTextResult[] = [];
  await act(async () => {
    runtime.registerPlugin({ id: pluginId, name: "Prompt tabs", version: "0.1.0", apiVersion: "^0.1.22", entry: "test.js",
      permissions: ["ui.panel", "document.write"], contributes: { commands: [{ id: commandId, title: "Insert Named Structure" }, { id: touchCommandId, title: "Edit Without Asking" }] }
    }, { commandHandlers: { [touchCommandId]: async context => {
      const pageId = tabDocument(activeTabId()).pages[0]!.id;
      await context.documents.applyPatch!({ reason: "Edit Without Asking", patch: { op: "addObject", pageId, object: touched } });
      return { status: "edited" };
    }, [commandId]: async context => {
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
    expect(document.body.textContent).toContain("Switch back to Untitled (tab 1) to insert.");
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

  const statusText = () => document.body.querySelector(".plugin-prompt-dialog")?.textContent ?? "";

  it("names the prompt's tab by position when another open tab has the same name", async () => {
    const { runtime } = await mount();
    const tabA = activeTabId();
    await command("document.new");
    const tabB = activeTabId();
    expect(tabB).not.toBe(tabA);
    const { invocation } = await start(runtime);
    await command("document.previousTab");
    expect(activeTabId()).toBe(tabA);
    expect(statusText()).toContain("Switch back to Untitled (tab 2) to insert.");
    // A tab opened while the prompt is open does not move the origin tab; the position is recomputed on each push.
    await command("document.new");
    await command("document.nextTab");
    expect(activeTabId()).toBe(tabA);
    expect(statusText()).toContain("Switch back to Untitled (tab 2) to insert.");
    await act(async () => { runtime.prompts.cancel(runtime.prompts.getOpenPrompt()!.id); await invocation; });
  });

  it("recomputes the prompt tab's position when an earlier tab closes and the active tab does not change", async () => {
    const { runtime } = await mount();
    const tab1 = activeTabId();
    await command("document.new");
    const tab2 = activeTabId();
    await command("document.new");
    const tab3 = activeTabId();
    expect(new Set([tab1, tab2, tab3]).size).toBe(3);
    const { invocation } = await start(runtime);
    await command("document.previousTab");
    expect(activeTabId()).toBe(tab2);
    expect(statusText()).toContain("Switch back to Untitled (tab 3) to insert.");
    // Closing an earlier, non-active tab moves the prompt's tab up one place; the active tab stays tab 2,
    // so only the documentTabs effect can refresh the line.
    await command(closeDocumentTabCommandId(tab1));
    expect(getAssistantHistoryPort().read(tab1)).toBeUndefined();
    expect(activeTabId()).toBe(tab2);
    expect(statusText()).toContain("Switch back to Untitled (tab 2) to insert.");
    expect(statusText()).not.toContain("(tab 3)");
    await act(async () => { runtime.prompts.cancel(runtime.prompts.getOpenPrompt()!.id); await invocation; });
  });

  it("keeps the plain tab name in the status line when it is unique", async () => {
    const { runtime } = await mount({ ...createEmptyDocument(), title: "Benzene" });
    const { invocation } = await start(runtime);
    await command("document.new");
    expect(statusText()).toContain("Switch back to Benzene to insert.");
    expect(statusText()).not.toContain("(tab");
    await act(async () => { runtime.prompts.cancel(runtime.prompts.getOpenPrompt()!.id); await invocation; });
  });

  describe("closing the prompt's tab", () => {
    const closeQuestion = () => document.body.querySelector('[role="dialog"][aria-label="Save changes before closing?"]');
    const answer = async (label: string) => {
      const button = Array.from(closeQuestion()!.querySelectorAll("button")).find(candidate => candidate.textContent === label)!;
      await act(async () => { button.click(); });
    };
    const input = () => document.body.querySelector<HTMLInputElement>(".plugin-prompt-dialog input")!;
    const submitButton = () => document.body.querySelector<HTMLButtonElement>('.plugin-prompt-dialog button[type="submit"]')!;
    /** Tab A holds an unsaved edit and the prompt (with typed text); tab B exists and A is active. */
    async function dirtyOriginWithPrompt() {
      const mounted = await mount();
      const tabA = activeTabId();
      await command("document.new");
      const tabB = activeTabId();
      await command("document.previousTab");
      expect(activeTabId()).toBe(tabA);
      await act(async () => { await mounted.runtime.invokeCommand(touchCommandId); });
      const started = await start(mounted.runtime);
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), "benzene");
        input().dispatchEvent(new Event("input", { bubbles: true }));
      });
      await command("document.nextTab");
      expect(activeTabId()).toBe(tabB);
      return { ...mounted, ...started, tabA, tabB };
    }

    it("keeps the prompt, its text and its tab binding when the close is cancelled", async () => {
      const { runtime, prompts, promptId, tabA, tabB } = await dirtyOriginWithPrompt();
      await command(closeDocumentTabCommandId(tabA));
      expect(closeQuestion()).not.toBeNull();
      await answer("Cancel");
      expect(closeQuestion()).toBeNull();
      expect(getAssistantHistoryPort().read(tabA)).toBeDefined();
      expect(runtime.prompts.getOpenPrompt()?.id).toBe(promptId);
      expect(prompts).toEqual([]);
      expect(input().value).toBe("benzene");
      // Still bound to tab A: disabled while another tab is active, enabled once back.
      await command("document.nextTab");
      expect(activeTabId()).toBe(tabB);
      expect(submitButton().disabled).toBe(true);
      expect(statusText()).toContain("Switch back to Untitled (tab 1) to insert.");
      await command("document.previousTab");
      expect(activeTabId()).toBe(tabA);
      expect(submitButton().disabled).toBe(false);
      await act(async () => { runtime.prompts.cancel(promptId); });
    });

    it("cancels the prompt only once Don't Save removes the tab, inserting nothing", async () => {
      const { runtime, prompts, invocation, promptId, tabA, tabB } = await dirtyOriginWithPrompt();
      const beforeB = tabDocument(tabB);
      await command(closeDocumentTabCommandId(tabA));
      expect(closeQuestion()).not.toBeNull();
      expect(runtime.prompts.getOpenPrompt()?.id).toBe(promptId);
      expect(prompts).toEqual([]);
      await answer("Don't Save");
      expect(getAssistantHistoryPort().read(tabA)).toBeUndefined();
      expect(runtime.prompts.getOpenPrompt()).toBeUndefined();
      expect(await invocation).toEqual({ status: "cancelled" });
      expect(prompts).toEqual([{ status: "cancelled" }]);
      expect(objectIds(tabDocument(tabB))).not.toContain(inserted.id);
      expect(tabDocument(tabB)).toBe(beforeB);
    });

    it("cancels the prompt right away when a clean origin tab closes", async () => {
      const { runtime, prompts } = await mount();
      const tabA = activeTabId();
      await command("document.new");
      await command("document.previousTab");
      const { invocation } = await start(runtime);
      await command(closeDocumentTabCommandId(tabA));
      expect(closeQuestion()).toBeNull();
      expect(getAssistantHistoryPort().read(tabA)).toBeUndefined();
      expect(runtime.prompts.getOpenPrompt()).toBeUndefined();
      expect(await invocation).toEqual({ status: "cancelled" });
      expect(prompts).toEqual([{ status: "cancelled" }]);
    });
  });
});
