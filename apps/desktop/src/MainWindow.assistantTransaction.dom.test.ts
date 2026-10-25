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
import type { PluginCommandContext } from "@chemdraft/plugin-api";

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
      const tx = begin();
      for (const id of ["assistant_one", "assistant_two", "assistant_three"]) await tools.write(context, id);
      return endAssistantTransaction(tx, { touchedIds: [] });
    }) };
    await act(async () => {
      captured.runtime!.registerPlugin({ id: "org.chemdraft.assistant", name: "Assistant", version: "0.1.0",
        apiVersion: "^0.1.8", entry: "test.js", permissions: ["document.write"],
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
});
