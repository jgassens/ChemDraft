// @vitest-environment jsdom
import { act, createElement } from "react";
import { setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow, documentTabPathKey } from "./MainWindow";
import { createNativeSavePayload, createPhase4Document, openNativeDocument } from "./documentWorkflow";
import { createViewportState } from "@chemdraft/viewport-engine";
import { DOM_COMMAND_EVENT, setToolbarsMenu } from "./window-manager";
import { buildDocumentSessionEnvelope, buildDocumentTabsSession, parseDocumentSessionEnvelope } from "./documentSession";
import { createPluginRuntime, type DesktopPluginRuntime } from "./plugins/createPluginRuntime";
import type { DocumentPatch } from "@chemdraft/chem-core";
import {
  ANALYSIS_WINDOW_ACTION_EVENT, type AnalysisWindowSnapshotPayload,
  broadcastAnalysisWindowSnapshot, respondToProposalDecision
} from "./plugins/panelBridge";
import { createDesktopShortcutRegistry } from "./keyboardShortcuts";
import { createDocumentTabActions } from "./commands";
import type { ChemDraftAgentBridge } from "./agentBridge";

const native = vi.hoisted(() => ({
  desktop: true,
  session: undefined as unknown,
  load: vi.fn<() => Promise<unknown>>(),
  saveSession: vi.fn<(value: unknown) => Promise<void>>(),
  quitFlush: undefined as undefined | (() => Promise<void>),
  quit: vi.fn(),
  events: new Map<string, (payload: unknown) => void>(),
  picker: vi.fn<() => Promise<string | null>>(),
  savePicker: vi.fn<() => Promise<string | null>>(),
  readFile: vi.fn<(path: string) => Promise<Uint8Array>>(),
  writeFile: vi.fn<(path: string, contents: string) => Promise<void>>()
}));
vi.mock("./documentWorkflow", async (original) => {
  const actual = await original<typeof import("./documentWorkflow")>();
  return { ...actual, createNativeSavePayload: vi.fn(actual.createNativeSavePayload) };
});
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./window-manager", async (original) => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => native.desktop,
  loadDocumentSession: native.load,
  saveDocumentSession: native.saveSession,
  setToolbarsMenu: vi.fn().mockResolvedValue(undefined),
  listenForQuitFlushRequest: async (handler: () => Promise<void>) => {
    native.quitFlush = handler;
    return () => { native.quitFlush = undefined; };
  },
  confirmQuitAfterFlush: native.quit
}));
vi.mock("./window-manager/tauriEvents", async (original) => {
  const listen = async (name: string, handler: (event: { payload: unknown }) => void) => {
    const callback = (payload: unknown) => handler({ payload });
    native.events.set(name, callback);
    return () => { if (native.events.get(name) === callback) native.events.delete(name); };
  };
  return { ...await original<typeof import("./window-manager/tauriEvents")>(),
    listenTauriEvent: listen, listenCurrentWindowEvent: listen };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn().mockResolvedValue(null)
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: native.picker, save: native.savePicker }));
vi.mock("@tauri-apps/plugin-fs", async (original) => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(), readFile: native.readFile, writeTextFile: native.writeFile
}));
vi.mock("./plugins/createPluginRuntime", async (original) => {
  const actual = await original<typeof import("./plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: vi.fn(actual.createPluginRuntime) };
});
vi.mock("./plugins/panelBridge", async (original) => {
  const actual = await original<typeof import("./plugins/panelBridge")>();
  return { ...actual, broadcastAnalysisWindowSnapshot: vi.fn().mockResolvedValue(undefined),
    respondToProposalDecision: vi.fn().mockResolvedValue(undefined) };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("documents in one window", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  let pendingPrompt: { prompt: NativePromptOptions; resolve: (id: string) => void } | undefined;
  let restorePromptProvider: () => void;

  beforeEach(async () => {
    pendingPrompt = undefined;
    restorePromptProvider = setNativePromptProvider((prompt) => new Promise((resolve) => {
      pendingPrompt = { prompt, resolve };
    }));
    vi.clearAllMocks();
    vi.mocked(setToolbarsMenu).mockResolvedValue(undefined);
    vi.mocked(broadcastAnalysisWindowSnapshot).mockResolvedValue(undefined);
    vi.mocked(respondToProposalDecision).mockResolvedValue(undefined);
    native.desktop = true;
    native.session = undefined;
    native.events.clear();
    native.load.mockImplementation(async () => native.session);
    native.saveSession.mockImplementation(async (value) => { native.session = JSON.parse(JSON.stringify(value)); });
    native.savePicker.mockResolvedValue(null);
    native.writeFile.mockResolvedValue();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(window, "focus").mockImplementation(() => {});
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    await mount();
  });

  afterEach(() => {
    restorePromptProvider();
    act(() => root?.unmount());
    root = undefined;
    container?.remove();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount(initialDocument = createPhase4Document("Untitled")) {
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(MainWindow, {
        initialDocument, initialActiveToolCommandId: "tool.select",
        initialPaletteMode: "hidden", initialCrosshairsVisible: false, initialRulersVisible: false, nativePalette: true
      }));
    });
  }
  async function remount() {
    act(() => root!.unmount());
    container.innerHTML = "";
    await mount();
  }
  function bridge(): ChemDraftAgentBridge {
    return (window as Window & { __CHEMDRAFT_AGENT__: ChemDraftAgentBridge }).__CHEMDRAFT_AGENT__;
  }
  const drawnText = () => bridge().snapshot().document.pages.flatMap((page) => page.objects)
    .filter((object) => object.type === "text").map((object) => object.text).join("\n");
  const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const active = () => tabs().findIndex((tab) => tab.getAttribute("aria-selected") === "true");
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function activate(index: number) {
    await act(async () => tabs()[index]!.click());
  }
  async function closeTab(index = active()) {
    await act(async () => container.querySelectorAll<HTMLButtonElement>(".document-tab-close")[index]!.click());
  }
  async function expectPristineUntitled(title = createPhase4Document().title) {
    expect(tabs()).toHaveLength(1);
    expect(active()).toBe(0);
    expect(tabs()[0]!.textContent).toBe("Untitled");
    expect(bridge().snapshot().file).toEqual({ dirty: false });
    expect(bridge().snapshot().document.title).toBe(title);
    expect(bridge().snapshot().page.objectCount).toBe(0);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(pendingPrompt).toBeUndefined();
    const saved = await flush();
    expect(saved.tabs).toHaveLength(1);
    expect(saved.tabs![0]).toMatchObject({ pristine: true, blank: true, dirty: false });
    await command("edit.undo");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Nothing to undo");
  }
  async function paste(text: string) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"], getData: () => text } });
    await act(async () => { window.dispatchEvent(event); });
  }
  function fileContents(name: string) { return createNativeSavePayload(createPhase4Document(name)).contents; }
  async function open(name: string, path = `/tmp/${name}.chemdraft`) {
    native.picker.mockResolvedValueOnce(path);
    native.readFile.mockResolvedValueOnce(new TextEncoder().encode(fileContents(name)));
    await command("document.open");
  }
  async function flush() {
    await act(async () => { await native.quitFlush!(); });
    return parseDocumentSessionEnvelope(native.session)!;
  }
  async function modalButton(label: string) {
    expect(pendingPrompt).toBeDefined();
    const { prompt, resolve } = pendingPrompt!;
    const choice = prompt.choices.find((candidate) => candidate.label === label);
    expect(choice).toBeDefined();
    pendingPrompt = undefined;
    await act(async () => resolve(choice!.id));
  }
  async function key(shiftKey = false) {
    const event = new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, shiftKey, bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(event); });
    return event;
  }
  const runtime = () => vi.mocked(createPluginRuntime).mock.results[0]!.value as DesktopPluginRuntime;
  function registerProposal(patch: DocumentPatch, wait?: Promise<void>) {
    const commandId = "plugin.tabProposal.review";
    runtime().registerPlugin({
      id: "org.test.tab-proposal", name: "Tab Proposal", version: "0.0.1", apiVersion: "^0.1.6",
      entry: "dist/plugin.js", permissions: ["document.proposePatch"],
      contributes: { commands: [{ id: commandId, title: "Review Result", requiredPermissions: ["document.proposePatch"] }] }
    }, { commandHandlers: { [commandId]: async (context) => {
      if (wait) await wait;
      return context.documents.proposePatch({ reason: "Review this result", patch });
    } } });
    return commandId;
  }
  async function propose(patch: DocumentPatch) {
    const commandId = registerProposal(patch);
    await act(async () => { await runtime().invokeCommand(commandId); });
    return runtime().host.listProposedPatches("pending")[0]!;
  }
  async function decide(kind: "acceptPluginProposal" | "rejectPluginProposal", proposalId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(ANALYSIS_WINDOW_ACTION_EVENT, {
      detail: { kind, proposalId, requestId: "review-result" }
    })));
  }
  const reviewItems = () => {
    const snapshots = vi.mocked(broadcastAnalysisWindowSnapshot).mock.calls
      .map(([payload]) => payload as AnalysisWindowSnapshotPayload);
    const content = snapshots.filter((payload) => payload.content.kind === "patchReview").at(-1)!.content;
    if (content.kind !== "patchReview") throw new Error("No proposal review snapshot");
    return content.proposals;
  };

  it("keeps proposals across switches and activates their source tab for one selected, undoable insertion", async () => {
    await open("Source");
    await paste("Source history");
    const sourceBefore = bridge().snapshot().document;
    const proposal = await propose({ op: "addObject", pageId: sourceBefore.pages[0]!.id, object: {
      id: "proposal-rect", type: "graphic", graphicKind: "rect", x: 100, y: 100, width: 80, height: 50,
      rotation: 0, style: {}, data: {}
    } });
    expect(reviewItems()[0]!.documentName).toBeUndefined();
    await open("Other");
    await paste("Other first edit");
    const otherFirstEdit = bridge().snapshot().document;
    await paste("Other second edit");
    await activate(0);
    await activate(1);
    await command("edit.undo");
    const otherBefore = bridge().snapshot().document;
    expect(runtime().host.listProposedPatches("pending")).toEqual([proposal]);
    expect(reviewItems()[0]!.documentName).toBe("Source.chemdraft");
    // Even disabling the plugin must retain the document binding and pending review.
    await act(async () => runtime().unregisterPlugin(proposal.pluginId));
    await decide("acceptPluginProposal", proposal.id);
    expect(active()).toBe(0);
    expect(bridge().snapshot().document.pages[0]!.objects.some((object) => object.id === "proposal-rect")).toBe(true);
    expect(bridge().snapshot().document.selection.objectIds).toEqual(["proposal-rect"]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("applied proposal");
    expect(runtime().host.listProposedPatches("pending")).toEqual([]);
    await command("edit.undo");
    expect(bridge().snapshot().document).toEqual(sourceBefore);
    await activate(1);
    expect(bridge().snapshot().document).toEqual(otherBefore);
    await command("edit.redo");
    expect(drawnText()).toContain("Other second edit");
    await command("edit.undo");
    expect(bridge().snapshot().document).toEqual(otherBefore);
    await command("edit.undo");
    expect(bridge().snapshot().document.pages[0]!.objects).toHaveLength(0);
    expect(otherFirstEdit.pages[0]!.objects).toHaveLength(1);
  });

  it.each(["updateObject", "removeObject"] as const)("applies %s only in the source tab when object ids repeat", async (op) => {
    await paste("Source object");
    const source = bridge().snapshot().document;
    const objectId = source.pages[0]!.objects[0]!.id;
    const proposal = await propose(op === "updateObject"
      ? { op, objectId, changes: { text: "Reviewed source" } }
      : { op, objectId });
    await command("document.new");
    await paste("Other object");
    const other = bridge().snapshot().document;
    expect(other.pages[0]!.objects[0]!.id).toBe(objectId);
    await decide("acceptPluginProposal", proposal.id);
    expect(active()).toBe(0);
    expect(drawnText()).toBe(op === "updateObject" ? "Reviewed source" : "");
    await command("edit.undo");
    expect(bridge().snapshot().document).toEqual(source);
    await activate(1);
    expect(bridge().snapshot().document).toEqual(other);
    await command("edit.undo");
    expect(bridge().snapshot().document.pages[0]!.objects).toHaveLength(0);
  });

  it.each([false, true])("tab x leaves a closed document's proposal pending and refuses Accept (multiple: %s)", async (multiple) => {
    await open("Closed source");
    const proposal = await propose({ op: "updatePageLayout", pageId: bridge().snapshot().document.pages[0]!.id,
      layout: bridge().snapshot().document.pages[0]!.layout });
    if (multiple) {
      await command("document.new");
      await activate(0);
    }
    await closeTab();
    const other = bridge().snapshot().document;
    expect(runtime().host.listProposedPatches("pending")).toEqual([proposal]);
    await decide("acceptPluginProposal", proposal.id);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("its document was closed (Closed source.chemdraft)");
    expect(respondToProposalDecision).toHaveBeenLastCalledWith("review-result", {
      ok: false, message: expect.stringContaining("its document was closed")
    });
    expect(runtime().host.listProposedPatches("pending")).toEqual([proposal]);
    expect(bridge().snapshot().document).toEqual(other);
    await command("edit.undo");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Nothing to undo");
    await decide("rejectPluginProposal", proposal.id);
    expect(runtime().host.listProposedPatches("pending")).toEqual([]);
    expect(bridge().snapshot().document).toEqual(other);
  });

  it("rejects a pending proposal from another open tab without switching or editing either document", async () => {
    await paste("Source drawing for rejection");
    const source = bridge().snapshot().document;
    const proposal = await propose({ op: "removeObject", objectId: source.pages[0]!.objects[0]!.id });
    await command("document.new");
    const other = bridge().snapshot().document;
    await decide("rejectPluginProposal", proposal.id);
    expect(active()).toBe(1);
    expect(runtime().host.listProposedPatches("pending")).toEqual([]);
    expect(bridge().snapshot().document).toEqual(other);
    await activate(0);
    expect(bridge().snapshot().document).toEqual(source);
  });

  it("queues a delayed proposal for the command's tab while a different tab is active", async () => {
    await open("Delayed source");
    await paste("Source drawing for delayed review");
    const source = bridge().snapshot().document;
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const commandId = registerProposal({ op: "removeObject", objectId: source.pages[0]!.objects[0]!.id }, wait);
    let invocation!: Promise<unknown>;
    await act(async () => { invocation = runtime().invokeCommand(commandId); });
    await command("document.new");
    await paste("Other drawing");
    const other = bridge().snapshot().document;
    await act(async () => { finish(); await invocation; });
    const proposal = runtime().host.listProposedPatches("pending")[0]!;
    expect(active()).toBe(1);
    expect(reviewItems()[0]!.documentName).toBe("Delayed source.chemdraft");
    await decide("acceptPluginProposal", proposal.id);
    expect(active()).toBe(0);
    expect(drawnText()).toBe("");
    await activate(1);
    expect(bridge().snapshot().document).toEqual(other);
  });

  it("always shows the strip; File New adds and activates an Untitled tab", async () => {
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs()).toHaveLength(1);
    await command("document.new");
    expect(tabs()).toHaveLength(2);
    expect(active()).toBe(1);
    expect(tabs()[1]!.textContent).toBe("Untitled");
    expect(bridge().snapshot().page.objectCount).toBe(0);
  });

  it("keeps native Close Window / Close Tab menu routing tied to the document count", async () => {
    expect(setToolbarsMenu).toHaveBeenLastCalledWith(expect.any(Array), false, false, false);
    await command("document.new");
    expect(setToolbarsMenu).toHaveBeenLastCalledWith(expect.any(Array), false, false, true);
    await closeTab();
    expect(tabs()).toHaveLength(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(pendingPrompt).toBeUndefined();
    expect(setToolbarsMenu).toHaveBeenLastCalledWith(expect.any(Array), false, false, false);
    await closeTab();
    expect(tabs()).toHaveLength(1);
    expect(setToolbarsMenu).toHaveBeenLastCalledWith(expect.any(Array), false, false, false);
  });

  it("New tab is keyboard-focusable and invokes the registered File New command exactly once", async () => {
    const invoke = vi.spyOn(runtime().host, "invokeCommand");
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="New tab"]')!;
    expect(button.title).toBe("New tab");
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(container.querySelector(".document-tab-strip")!.lastElementChild).toBe(button);
    await act(async () => button.click());
    expect(invoke).toHaveBeenCalledExactlyOnceWith("document.new");
    expect(tabs()).toHaveLength(2);
    expect(active()).toBe(1);
    expect(tabs()[1]!.textContent).toBe("Untitled");
    expect(bridge().snapshot().file).toEqual({ dirty: false });
    expect(bridge().snapshot().page.objectCount).toBe(0);
  });

  it("Open reuses a pristine Untitled, adds after a file is open, and activates an already open file", async () => {
    await open("First");
    expect(tabs()).toHaveLength(1);
    expect(bridge().snapshot().file.path).toBe("/tmp/First.chemdraft");
    await paste("Retain this note");
    await open("Second");
    expect(tabs()).toHaveLength(2);
    expect(active()).toBe(1);
    await open("First");
    expect(tabs()).toHaveLength(2);
    expect(active()).toBe(0);
    expect(drawnText()).toContain("Retain this note");
    expect(bridge().snapshot().file.dirty).toBe(true);
  });

  it("Open adds a tab for an edited Untitled, including after undo and after Save", async () => {
    await paste("Never replace this drawing");
    await command("edit.undo");
    await open("After undo");
    expect(tabs()).toHaveLength(2);
    await command("document.new");
    native.savePicker.mockResolvedValueOnce("/tmp/empty.chemdraft");
    await command("document.save");
    await open("After save");
    expect(tabs()).toHaveLength(4);
  });

  it("OS open-with and native file drop use the same reuse and duplicate rules", async () => {
    const contents = fileContents("OS opened");
    await act(async () => native.events.get("chemdraft://open-document")!({ path: "C:\\Drawings\\open.chemdraft", displayName: "open.chemdraft", contents }));
    expect(tabs()).toHaveLength(1);
    await paste("Keep OS edits");
    native.readFile.mockResolvedValueOnce(new TextEncoder().encode(fileContents("Dropped")));
    await act(async () => native.events.get("tauri://drag-drop")!({ paths: ["C:\\Drawings\\drop.chemdraft"] }));
    expect(tabs()).toHaveLength(2);
    await act(async () => native.events.get("chemdraft://open-document")!({ path: "C:\\Drawings\\open.chemdraft", displayName: "open.chemdraft", contents: `${contents}\n` }));
    expect(tabs()).toHaveLength(2);
    expect(active()).toBe(0);
    expect(drawnText()).toContain("Keep OS edits");
  });

  it("browser file drop reuses a pristine tab and preserves an edited one", async () => {
    native.desktop = false;
    async function drop(name: string) {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { files: [{ name, text: async () => fileContents(name) }] } });
      await act(async () => container.querySelector('[aria-label="Document workspace"]')!.dispatchEvent(event));
    }
    await drop("First.chemdraft");
    expect(tabs()).toHaveLength(1);
    await drop("Second.chemdraft");
    expect(tabs()).toHaveLength(2);
    await drop("First.chemdraft");
    expect(tabs()).toHaveLength(2);
    expect(active()).toBe(0);
  });

  it("recognizes Windows file identity across separator and case differences", () => {
    expect(documentTabPathKey("C:\\Drawings\\A.chemdraft", "windows"))
      .toBe(documentTabPathKey("c:/drawings/a.chemdraft", "windows"));
    expect(documentTabPathKey("/Drawings/A.chemdraft", "macos"))
      .not.toBe(documentTabPathKey("/Drawings/a.chemdraft", "macos"));
  });

  it("warnings follow the active tab and survive session restore", async () => {
    native.picker.mockResolvedValueOnce("/tmp/metals.cdxml");
    native.readFile.mockResolvedValueOnce(new TextEncoder().encode(
      readFileSync("packages/fixtures/cdxml/ten-metals.cdxml", "utf8")));
    await command("document.open");
    const warningButton = () => container.querySelector('[data-open-warnings-button]');
    expect(warningButton()?.textContent).toContain("11 warnings");
    await open("Clean");
    expect(warningButton()).toBeNull();
    await activate(0);
    expect(warningButton()?.textContent).toContain("11 warnings");
    const saved = await flush();
    expect(saved.tabs![0]!.openWarnings?.warnings).toHaveLength(11);
    await remount();
    expect(warningButton()?.textContent).toContain("11 warnings");
    await activate(1);
    expect(warningButton()).toBeNull();
  });

  it("preserves each tab's selection, undo/redo, dirty state, viewport and scroll", async () => {
    await paste("First note for history");
    const firstSelection = bridge().snapshot().selection;
    await command("view.zoomIn");
    const firstViewport = bridge().snapshot().viewport;
    const canvas = container.querySelector<HTMLElement>('[aria-label="Document workspace"]')!;
    canvas.scrollLeft = 123;
    canvas.scrollTop = 234;
    await command("document.new");
    expect(bridge().snapshot().file.dirty).toBe(false);
    await paste("Second note for history");
    await activate(0);
    expect(active()).toBe(0);
    expect(bridge().snapshot().selection).toEqual(firstSelection);
    expect(bridge().snapshot().viewport).toEqual(firstViewport);
    expect(canvas.scrollLeft).toBe(123);
    expect(canvas.scrollTop).toBe(234);
    expect(tabs()[0]!.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();
    await command("edit.undo");
    expect(container.querySelectorAll(".text-object")).toHaveLength(0);
    await activate(1);
    expect(drawnText()).toContain("Second note for history");
    await activate(0);
    await command("edit.redo");
    expect(drawnText()).toContain("First note for history");
  });

  it("dirty tab x uses the registered close command; Cancel retains it and Discard selects its neighbour", async () => {
    await paste("Keep the first drawing");
    await command("document.new");
    await paste("Second dirty drawing");
    const invoke = vi.spyOn(runtime().host, "invokeCommand");
    await closeTab();
    expect(invoke).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^document\.closeTab\./));
    expect(pendingPrompt?.prompt).toMatchObject({
      title: "Save changes before closing?", kind: "warning",
      choices: [{ id: "save", label: "Save" }, { id: "discard", label: "Don't Save", destructive: true },
        { id: "cancel", label: "Cancel", cancel: true }]
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(pendingPrompt).toBeDefined();
    await modalButton("Cancel");
    expect(tabs()).toHaveLength(2);
    expect(active()).toBe(1);
    expect(drawnText()).toContain("Second dirty drawing");
    await closeTab();
    await modalButton("Don't Save");
    expect(tabs()).toHaveLength(1);
    expect(drawnText()).toContain("Keep the first drawing");
  });

  it.each(["Import Visible CDXML", "Restore Embedded"])("CDXML conflict %s opens only the chosen document", async (choice) => {
    await paste("Original embedded note");
    const original = bridge().snapshot().document;
    const payload = createNativeSavePayload(original).contents;
    expect(payload).toContain("Original embedded note");
    const edited = payload.replace("Original embedded note", "Externally edited note");
    expect(openNativeDocument(edited).conflict?.visibleDocument).toBeDefined();
    native.picker.mockResolvedValueOnce("/tmp/conflicted.chemdraft");
    native.readFile.mockResolvedValueOnce(new TextEncoder().encode(edited));
    await command("document.open");
    expect(pendingPrompt?.prompt.title).toBe("Modified visible CDXML");
    expect(bridge().snapshot().document).toEqual(original);
    expect(tabs()).toHaveLength(1);
    await modalButton(choice);
    expect(tabs()).toHaveLength(2);
    expect(drawnText()).toContain(choice === "Import Visible CDXML" ? "Externally edited note" : "Original embedded note");
    expect(bridge().snapshot().file.path).toBe("/tmp/conflicted.chemdraft");
    await activate(0);
    expect(bridge().snapshot().document).toEqual(original);
  });

  it("the web build keeps the original close dialog and Escape retains the drawing", async () => {
    restorePromptProvider();
    native.desktop = false;
    await remount();
    await paste("Web drawing stays editable");
    const before = bridge().snapshot().document;
    await closeTab();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Save changes before closing?"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("Save the changes to Untitled?");
    expect(Array.from(dialog.querySelectorAll("button")).map((button) => button.textContent))
      .toEqual(["Cancel", "Don't Save", "Save"]);
    await act(async () => dialog.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true
    })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(bridge().snapshot().document).toEqual(before);
    expect(bridge().snapshot().file.dirty).toBe(true);
    await closeTab();
    const discard = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((button) => button.textContent === "Don't Save")!;
    await act(async () => discard.click());
    expect(bridge().snapshot().page.objectCount).toBe(0);
    expect(bridge().snapshot().file.dirty).toBe(false);
    expect(tabs()).toHaveLength(1);
  });

  it("closing an inactive clean tab keeps the current drawing active", async () => {
    await command("document.new");
    await command("document.new");
    await paste("Current drawing stays active");
    const currentDocument = bridge().snapshot().document;
    await closeTab(0);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(pendingPrompt).toBeUndefined();
    expect(tabs()).toHaveLength(2);
    expect(active()).toBe(1);
    expect(bridge().snapshot().document).toEqual(currentDocument);
    expect(drawnText()).toContain("Current drawing stays active");
  });

  it.each([false, true])("tab x Save closes only after success; cancellation and failure retain it (multiple: %s)", async (multiple) => {
    if (multiple) await command("document.new");
    await paste("Save before closing");
    await closeTab();
    await modalButton("Save");
    expect(tabs()).toHaveLength(multiple ? 2 : 1);
    expect(pendingPrompt).toBeDefined();
    native.savePicker.mockResolvedValueOnce("/tmp/saved.chemdraft");
    native.writeFile.mockRejectedValueOnce(new Error("disk full"));
    await modalButton("Save");
    expect(tabs()).toHaveLength(multiple ? 2 : 1);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("disk full");
    expect(pendingPrompt?.prompt.message).toContain("disk full");
    native.savePicker.mockResolvedValueOnce("/tmp/saved.chemdraft");
    await modalButton("Save");
    expect(native.writeFile).toHaveBeenLastCalledWith("/tmp/saved.chemdraft", expect.any(String));
    await expectPristineUntitled(multiple ? "Untitled" : createPhase4Document().title);
  });

  it.each([false, true])("the only clean tab x leaves a pristine Untitled without prompting (saved: %s)", async (saved) => {
    if (saved) await open("Clean saved drawing");
    const closedTab = tabs()[0];
    await closeTab();
    expect(tabs()[0]).not.toBe(closedTab);
    await expectPristineUntitled();
  });

  it("the only dirty tab x prompts; Cancel keeps it and Discard leaves a pristine Untitled", async () => {
    await paste("Only unsaved drawing");
    const before = bridge().snapshot().document;
    const closedTab = tabs()[0];
    await closeTab();
    expect(pendingPrompt?.prompt.message).toContain("Save the changes to Untitled?");
    await modalButton("Cancel");
    expect(tabs()).toHaveLength(1);
    expect(bridge().snapshot().document).toEqual(before);
    expect(bridge().snapshot().file.dirty).toBe(true);
    await closeTab();
    await modalButton("Don't Save");
    expect(tabs()[0]).not.toBe(closedTab);
    await expectPristineUntitled();
  });

  it("one dirty tab leaves CmdOrCtrl+W to window close and flushes the work without prompting", async () => {
    await paste("Retained by window close");
    const before = bridge().snapshot().document;
    const invoke = vi.spyOn(runtime().host, "invokeCommand");
    for (const modifiers of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new KeyboardEvent("keydown", { key: "w", ...modifiers, bubbles: true, cancelable: true });
      await act(async () => window.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(pendingPrompt).toBeUndefined();
    expect(bridge().snapshot().document).toEqual(before);
    const saved = await flush();
    expect(native.quit).toHaveBeenCalledOnce();
    expect(saved.tabs![0]).toMatchObject({ dirty: true });
    expect(saved.tabs![0]!.contents).toContain("Retained by window close");
  });

  it("a Save that completes after switching updates its original tab", async () => {
    await paste("Save this original drawing");
    await command("document.new");
    await activate(0);
    let finishWrite!: () => void;
    native.savePicker.mockResolvedValueOnce("/tmp/original.chemdraft");
    native.writeFile.mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    await command("document.save");
    expect(native.writeFile).toHaveBeenCalled();
    await activate(1);
    await paste("Other tab stays dirty");
    await act(async () => finishWrite());
    expect(bridge().snapshot().file).toMatchObject({ dirty: true });
    expect(bridge().snapshot().file.path).toBeUndefined();
    await activate(0);
    expect(bridge().snapshot().file).toMatchObject({ path: "/tmp/original.chemdraft", dirty: false });
    expect(drawnText()).toContain("Save this original drawing");
  });

  it("Ctrl+Tab and Ctrl+Shift+Tab cycle and wrap on both platforms; one tab leaves CmdOrCtrl+W unclaimed", async () => {
    for (const platform of ["macos", "windows"] as const) {
      const registry = createDesktopShortcutRegistry(createDocumentTabActions(true), platform);
      expect(registry.resolve({ key: "Tab", ctrlKey: true })).toBe("document.nextTab");
      expect(registry.resolve({ key: "Tab", ctrlKey: true, shiftKey: true })).toBe("document.previousTab");
      const closeKey = { key: "w", metaKey: platform === "macos", ctrlKey: platform === "windows" };
      expect(registry.resolve(closeKey)).toBe("document.closeTab");
      expect(createDesktopShortcutRegistry(createDocumentTabActions(false), platform).resolve(closeKey)).toBeUndefined();
    }
    await command("document.new");
    await command("document.new");
    expect((await key()).defaultPrevented).toBe(true);
    expect(active()).toBe(0);
    await key(true);
    expect(active()).toBe(2);
    await key(true);
    expect(active()).toBe(1);
  });

  it("tab navigation also works while a text field has focus, and stays blocked by the close modal", async () => {
    await command("document.new");
    const input = document.createElement("input");
    container.append(input);
    input.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(active()).toBe(0);
    input.remove();
    await paste("Dirty drawing for modal");
    await command("document.closeTab");
    await key();
    expect(active()).toBe(0);
    await modalButton("Cancel");
  });

  it("quit flush and restore round-trip three tabs, an untitled dirty drawing, and the active index", async () => {
    await open("Saved first");
    await command("document.new");
    await paste("Untitled unsaved drawing");
    await command("view.zoomIn");
    const restoredViewport = bridge().snapshot().viewport;
    const canvas = container.querySelector<HTMLElement>('[aria-label="Document workspace"]')!;
    canvas.scrollTop = 90;
    await command("document.new");
    await activate(1);
    const saved = await flush();
    expect(saved.tabs).toHaveLength(3);
    expect(saved.activeTabIndex).toBe(1);
    expect(saved.tabs![1]!.path).toBeUndefined();
    expect(saved.tabs![1]!.dirty).toBe(true);
    expect(saved.tabs![2]!.pristine).toBe(true);
    expect(native.quit).toHaveBeenCalledTimes(1);
    await remount();
    expect(tabs()).toHaveLength(3);
    expect(active()).toBe(1);
    expect(bridge().snapshot().file.dirty).toBe(true);
    expect(bridge().snapshot().viewport).toEqual(restoredViewport);
    expect(container.querySelector<HTMLElement>('[aria-label="Document workspace"]')!.scrollTop).toBe(90);
    expect(drawnText()).toContain("Untitled unsaved drawing");
    await activate(0);
    expect(bridge().snapshot().file.path).toBe("/tmp/Saved first.chemdraft");
    await activate(2);
    expect(bridge().snapshot().page.objectCount).toBe(0);
    await open("Reused restored pristine");
    expect(tabs()).toHaveLength(3);
  });

  it("cancels page-size editing but retains pending plugin proposals when activating another tab", async () => {
    await command("document.new");
    const runtime = vi.mocked(createPluginRuntime).mock.results[0]!.value;
    const proposal = {
      id: "tab-bound-review", pluginId: "test.plugin", status: "pending" as const,
      proposal: { title: "Tab A proposal", patch: { operations: [] } }
    };
    const list = vi.spyOn(runtime.host, "listProposedPatches").mockReturnValue([proposal] as never);
    const reject = vi.spyOn(runtime.host, "rejectProposedPatch").mockImplementation(() => {
      list.mockReturnValue([]);
      return { ...proposal, status: "rejected" } as never;
    });
    await command("page.setSizeCustom");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await activate(0);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(pendingPrompt).toBeUndefined();
    expect(reject).not.toHaveBeenCalled();
    expect(runtime.host.listProposedPatches("pending")).toEqual([proposal]);
  });

  function threeTabSession() {
    return buildDocumentTabsSession(["First", "Second", "Third"].map((name) => ({
      ...buildDocumentSessionEnvelope(createNativeSavePayload(createPhase4Document(name)),
        { path: `/tmp/${name}.chemdraft`, dirty: true }, name, true),
      view: { viewport: createViewportState(), scrollLeft: 0, scrollTop: 0 }
    })), 1);
  }

  it("restores all three tabs despite negative scroll or malformed cosmetic data", async () => {
    const session = threeTabSession();
    session.tabs![1]!.view!.scrollTop = -3;
    session.tabs![2]!.openWarnings = { warnings: "bad" } as never;
    native.session = session;
    await remount();
    expect(tabs()).toHaveLength(3);
    expect(active()).toBe(1);
    expect(container.querySelector<HTMLElement>('[aria-label="Document workspace"]')!.scrollTop).toBe(0);
    await activate(2);
    expect(bridge().snapshot().document.title).toBe("Third");
  });

  it("skips a corrupt active tab, reports it, and preserves its raw envelope on every autosave", async () => {
    const session = threeTabSession();
    const corrupt = { ...session.tabs![1]!, contents: "unreadable document", extraRecoveryData: { original: [1, 2, 3] } };
    session.tabs![1] = corrupt;
    let finishRead!: (value: unknown) => void;
    native.load.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    await remount();
    await act(async () => finishRead(session));
    expect(tabs()).toHaveLength(2);
    expect(bridge().snapshot().document.title).toBe("First");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("1 tab could not be restored");
    const saved = await flush();
    expect(saved.unrestoredTabs).toEqual([corrupt]);
    expect(saved.tabs!.map((tab) => tab.displayName)).toEqual(["First.chemdraft", "Third.chemdraft"]);
    await remount();
    expect(tabs()).toHaveLength(2);
    await command("view.zoomIn");
    expect((await flush()).unrestoredTabs).toEqual([corrupt]);
  });

  it.each(["envelope", "contents"])("never overwrites a wholly unreadable session (%s)", async (failure) => {
    const raw = failure === "envelope" ? { version: 99, recoverMe: true } :
      { ...threeTabSession(), tabs: threeTabSession().tabs!.map((tab) => ({ ...tab, contents: "corrupt" })) };
    native.session = raw;
    await remount();
    native.saveSession.mockClear();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("will not be autosaved");
    await paste("Drawing after failed restore");
    await flush();
    expect(native.saveSession).not.toHaveBeenCalled();
    expect(native.session).toEqual(raw);
  });

  it("neither restores nor announces a sole pristine blank Untitled tab", async () => {
    const saved = await flush();
    expect(saved.tabs).toHaveLength(1);
    expect(saved.tabs![0]!.pristine).toBe(true);
    await remount();
    expect(tabs()).toHaveLength(1);
    expect(bridge().snapshot().document.title).toBe("Untitled");
    expect(container.querySelector('[role="status"]')?.textContent).not.toContain("Restored last session");
    // A clean no-restore read still permits later autosaves.
    native.saveSession.mockClear();
    await paste("Fresh drawing");
    await flush();
    expect(native.saveSession).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("tab x queues OS open-with so Save writes the prompted drawing (multiple: %s)", async (multiple) => {
    if (multiple) {
      await paste("Original prompted drawing");
      await command("document.new");
    }
    await paste("Drawing being closed");
    await closeTab();
    await act(async () => native.events.get("chemdraft://open-document")!({
      path: "/tmp/incoming.chemdraft", displayName: "incoming.chemdraft", contents: fileContents("Incoming drawing")
    }));
    expect(active()).toBe(multiple ? 1 : 0);
    expect(drawnText()).toContain("Drawing being closed");
    native.savePicker.mockResolvedValueOnce("/tmp/closed.chemdraft");
    await modalButton("Save");
    expect(native.writeFile.mock.calls.at(-1)![0]).toBe("/tmp/closed.chemdraft");
    expect(native.writeFile.mock.calls.at(-1)![1]).toContain("Drawing being closed");
    expect(bridge().snapshot().document.title).toBe("Incoming drawing");
    expect(tabs()).toHaveLength(multiple ? 2 : 1);
    if (multiple) {
      await activate(0);
      expect(drawnText()).toContain("Original prompted drawing");
    }
  });

  it("zoom autosave keeps views current without serializing unchanged foreground or background tabs", async () => {
    await open("Background");
    await open("Foreground");
    await flush();
    vi.mocked(createNativeSavePayload).mockClear();
    await command("view.zoomIn");
    const view = bridge().snapshot().viewport;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
    expect(createNativeSavePayload).not.toHaveBeenCalled();
    expect(parseDocumentSessionEnvelope(native.session)!.tabs![1]!.view!.viewport).toEqual(view);
    await paste("Changed foreground");
    await flush();
    expect(createNativeSavePayload).toHaveBeenCalledTimes(1);
  });

  it.each(["switch", "close"])("cancels a live art drag before tab %s, and ignores its late pointer release", async (action) => {
    const drawing = createPhase4Document("Drag source");
    drawing.pages[0]!.objects = [{
      id: "drag-rect", type: "graphic", graphicKind: "rect", x: 100, y: 100, width: 80, height: 50,
      rotation: 0, style: {}, data: {}
    }];
    drawing.selection.objectIds = ["drag-rect"];
    act(() => root!.unmount());
    container.innerHTML = "";
    await mount(drawing);
    await command("document.new");
    const other = bridge().snapshot().document;
    await activate(0);
    const start = bridge().snapshot().document;
    const page = container.querySelector<HTMLElement>(".page")!;
    page.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 816, bottom: 1056,
      width: 816, height: 1056, toJSON: () => ({}) });
    page.hasPointerCapture = () => false;
    page.setPointerCapture = () => undefined;
    page.releasePointerCapture = () => undefined;
    const handle = container.querySelector('[data-object-resize-corner="bottom-right"]')!;
    expect(handle).not.toBeNull();
    async function pointer(target: Element, type: string, x: number, y: number) {
      const event = new MouseEvent(type, { button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true });
      Object.defineProperty(event, "pointerId", { value: 7 });
      await act(async () => target.dispatchEvent(event));
    }
    await pointer(handle, "pointerdown", 180, 150);
    await pointer(page, "pointermove", 230, 180);
    if (action === "switch") await key();
    else await closeTab();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(pendingPrompt).toBeUndefined();
    expect(active()).toBe(action === "switch" ? 1 : 0);
    await pointer(page, "pointerup", 230, 180);
    expect(bridge().snapshot().document).toEqual(other);
    await command("edit.undo");
    expect(bridge().snapshot().document).toEqual(other);
    if (action === "switch") {
      await activate(0);
      expect(bridge().snapshot().document).toEqual(start);
    }
  });

  it.each(["rotation", "resize"])("cancels a typed %s on Ctrl+Tab before Escape or Enter can affect the next document", async (kind) => {
    const drawing = createPhase4Document("Tab A");
    drawing.pages[0]!.objects = [{
      id: "rect-a", type: "graphic", graphicKind: "rect", x: 100, y: 100, width: 80, height: 50,
      rotation: 0, style: {}, data: {}
    }];
    drawing.selection.objectIds = ["rect-a"];
    act(() => root!.unmount());
    container.innerHTML = "";
    await mount(drawing);
    await command("document.new");
    const before = bridge().snapshot();
    await activate(0);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true })));
    const handle = container.querySelector(kind === "rotation"
      ? '[data-selection-rotate-handle="true"]' : '[data-object-resize-corner]');
    expect(handle).not.toBeNull();
    await act(async () => handle!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const input = container.querySelector<HTMLInputElement>(kind === "rotation"
      ? '[aria-label="Z rotation degrees"]' : '[aria-label="X stretch percent"]');
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, kind === "rotation" ? "25" : "125");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(active()).toBe(1);
    expect(container.querySelector('[data-rotation-input-popover]')).toBeNull();
    expect(container.querySelector('[data-scale-input-popover]')).toBeNull();
    for (const key of ["Escape", "Enter"]) {
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    }
    expect(bridge().snapshot().document).toEqual(before.document);
    await command("edit.undo");
    expect(bridge().snapshot().document).toEqual(before.document);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Nothing to undo");
    await activate(0);
    expect(bridge().snapshot().document.pages[0]!.objects[0]!.rotation).toBe(0);
  });

  it("an old single-document session restores as one tab with its dirty state", async () => {
    native.session = buildDocumentSessionEnvelope(createNativeSavePayload(createPhase4Document("Legacy session")),
      { path: "/tmp/legacy.chemdraft", dirty: true }, "legacy.chemdraft", true);
    await remount();
    expect(tabs()).toHaveLength(1);
    expect(bridge().snapshot().document.title).toBe("Legacy session");
    expect(bridge().snapshot().file).toMatchObject({ path: "/tmp/legacy.chemdraft", dirty: true });
  });

  it("a cold-start OS open waits for every session tab, then activates the already-open file", async () => {
    const oldTab = buildDocumentSessionEnvelope(createNativeSavePayload(createPhase4Document("Session drawing")),
      { path: "/tmp/existing.chemdraft", dirty: true }, "existing.chemdraft", true);
    const untitled = buildDocumentSessionEnvelope(createNativeSavePayload(createPhase4Document("Untitled")),
      { dirty: false }, "Untitled", true);
    let resolveRead!: (value: unknown) => void;
    native.load.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    await remount();
    await act(async () => native.events.get("chemdraft://open-document")!({
      path: "/tmp/existing.chemdraft", displayName: "existing.chemdraft", contents: fileContents("Disk drawing")
    }));
    expect(bridge().snapshot().document.title).toBe("Untitled");
    await act(async () => resolveRead(buildDocumentTabsSession([oldTab, untitled], 1)));
    expect(tabs()).toHaveLength(2);
    expect(active()).toBe(0);
    expect(bridge().snapshot().document.title).toBe("Session drawing");
    expect(bridge().snapshot().file.dirty).toBe(true);
    expect((await flush()).tabs).toHaveLength(2);
  });

  it("edits made during a slow session read remain active while the old tabs are restored", async () => {
    const previous = buildDocumentSessionEnvelope(createNativeSavePayload(createPhase4Document("Previous drawing")),
      { path: "/tmp/previous.chemdraft", dirty: true }, "previous.chemdraft", true);
    let resolveRead!: (value: unknown) => void;
    native.load.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    await remount();
    await paste("Early drawing must survive");
    await act(async () => resolveRead(previous));
    expect(tabs()).toHaveLength(2);
    expect(active()).toBe(0);
    expect(drawnText()).toContain("Early drawing must survive");
    await activate(1);
    expect(bridge().snapshot().document.title).toBe("Previous drawing");
    expect(bridge().snapshot().file.dirty).toBe(true);
  });

  it("does not autosave over a session whose read failed", async () => {
    native.load.mockRejectedValueOnce(new Error("unreadable session"));
    await remount();
    native.saveSession.mockClear();
    await paste("Work after failed read");
    await command("document.new");
    await flush();
    expect(native.saveSession).not.toHaveBeenCalled();
  });

  it("creates one plugin runtime across switches, with callbacks and agent snapshot following the active document", async () => {
    const options = vi.mocked(createPluginRuntime).mock.calls[0]![0]!;
    await paste("Plugin first drawing");
    const firstDocument = options.getActiveDocument!();
    await command("document.new");
    expect(options.getActiveDocument!()).not.toBe(firstDocument);
    await paste("Plugin second drawing");
    await activate(0);
    expect(options.getActiveDocument!()).toBe(firstDocument);
    expect(bridge().snapshot().document).toEqual(firstDocument);
    expect(createPluginRuntime).toHaveBeenCalledTimes(1);
  });

  it("keeps the worktree label in the active document's web title", async () => {
    await open("Title first");
    await open("Title second");
    expect(document.title).toContain("Title second.chemdraft");
    expect(document.title).toContain("test");
    await activate(0);
    expect(document.title).toContain("Title first.chemdraft");
  });
});
