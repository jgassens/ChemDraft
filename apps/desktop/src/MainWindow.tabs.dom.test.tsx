// @vitest-environment jsdom
import * as smilesListPaste from "./smilesListPaste";
import * as smilesPasteIdentity from "./smilesPasteIdentity";
import { IdentityVerificationTimeoutError } from "./depiction2d/identityWorkerClient";
import { inspectStructureOffThread } from "./depiction2d/identityClient";
import { act, createElement, StrictMode } from "react";
import { setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow, documentTabPathKey } from "./MainWindow";
import { exportPhase4Svg, applyNativeChainTool, createNativeSingleBondMolecule, arrangeSelectedDocumentObjects, createNativeSavePayload, createPhase4Document, openNativeDocument, selectDocumentObjects } from "./documentWorkflow";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { saveCompoundLayoutSettings } from "./compoundLayoutSettings";
import { saveKeybindingSettings } from "./keybindingSettings";
import { saveAskToSaveBeforeQuit, loadAskToSaveBeforeQuit } from "./quitSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { createViewportState } from "@chemdraft/viewport-engine";
import { DOM_COMMAND_EVENT, setToolbarsMenu, type ToolsetWindowState } from "./window-manager";
import { buildDocumentSessionEnvelope, buildDocumentTabsSession, parseDocumentSessionEnvelope } from "./documentSession";
import { createPluginRuntime, type DesktopPluginRuntime } from "./plugins/createPluginRuntime";
import { applyPatches, type DocumentPatch, type MoleculeObject } from "@chemdraft/chem-core";
import {
  ANALYSIS_WINDOW_ACTION_EVENT, ANALYSIS_WINDOW_OWNER_ID, PATCH_REVIEW_WINDOW_ID,
  type AnalysisWindowSnapshotPayload, broadcastAnalysisWindowSnapshot,
  pluginPanelWindowLabel, respondToProposalDecision
} from "./plugins/panelBridge";
import { createDesktopShortcutRegistry } from "./keyboardShortcuts";
import { createDocumentTabActions } from "./commands";
import type { ChemDraftAgentBridge } from "./agentBridge";
import * as atomLabelDraft from "./atomLabelDraft";
import * as nativePaletteReconciliation from "./toolbars/reconcileNativePalettes";
import type { DialogMessage } from "./dialogs/dialogProtocol";
import { nativeDialogTransport, type DialogDelivery } from "./dialogs/dialogTransport";
import { createPerfProbe, PerfProbe, type PerfRecord } from "./perf/probe";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";

const perfState = vi.hoisted(() => ({ current: undefined as import("./perf/probe").PerfProbe | undefined }));
vi.mock("./perf/runtime", async original => ({
  ...await original<typeof import("./perf/runtime")>(),
  get perfProbe() { return perfState.current; }
}));

const native = vi.hoisted(() => ({
  desktop: true,
  suspendUtilities: false,
  suspensionDepth: 0,
  visibilityChanges: [] as string[],
  toolsetWindows: new Map<string, boolean>(),
  suspendedToolsets: [] as string[],
  loadToolsetLayout: vi.fn<() => Promise<unknown>>(),
  listToolsets: vi.fn<() => Promise<ToolsetWindowState[]>>(),
  openToolset: vi.fn<(id: string) => Promise<ToolsetWindowState>>(),
  session: undefined as unknown,
  load: vi.fn<() => Promise<unknown>>(),
  saveSession: vi.fn<(value: unknown) => Promise<void>>(),
  quitFlush: undefined as undefined | (() => Promise<void>),
  quit: vi.fn(),
  promptQuit: undefined as undefined | ((id: number) => Promise<void>),
  quitId: 0,
  prepareQuit: vi.fn(),
  resumeQuit: vi.fn(),
  promptShowing: vi.fn(),
  cancelQuit: vi.fn(),
  requestAfterClose: vi.fn(),
  suspendFailure: false,
  suspendPending: undefined as Promise<void> | undefined,
  clipboardPending: undefined as Promise<{ types: string[]; textItems: { type: string; text: string }[] }> | undefined,
  events: new Map<string, (payload: unknown) => void>(),
  picker: vi.fn<() => Promise<string | null>>(),
  savePicker: vi.fn<() => Promise<string | null>>(),
  readFile: vi.fn<(path: string) => Promise<Uint8Array>>(),
  writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(),
  dialogSnapshot: undefined as DialogMessage | undefined,
  dialogListener: undefined as ((delivery: DialogDelivery) => void) | undefined,
  dialogClose: vi.fn(),
  dialogPublish: vi.fn()
}));
vi.mock("./dialogs/dialogTransport", () => ({ nativeDialogTransport: {
  subscribe: async (handler: (delivery: DialogDelivery) => void) => { native.dialogListener = handler; return () => { native.dialogListener = undefined; }; },
  open: async (snapshot: DialogMessage) => { native.dialogSnapshot = snapshot; return { hostId: "opaque", windowLabel: `dialog-main-${snapshot.dialogKind}-1` }; },
  publish: native.dialogPublish, close: native.dialogClose
} }));
vi.mock("./documentWorkflow", async (original) => {
  const actual = await original<typeof import("./documentWorkflow")>();
  return { ...actual, createNativeSavePayload: vi.fn(actual.createNativeSavePayload), openNativeDocument: vi.fn(actual.openNativeDocument) };
});
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./window-manager", async (original) => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => native.desktop,
  loadDocumentSession: native.load,
  saveDocumentSession: native.saveSession,
  loadToolsetLayoutState: native.loadToolsetLayout,
  openToolsetWindow: native.openToolset,
  listToolsetWindowStates: native.listToolsets,
  closeToolsetWindow: async (toolsetId: string) => {
    native.toolsetWindows.set(toolsetId, false);
    return { toolsetId, open: false, focused: false };
  },
  setToolbarsMenu: vi.fn().mockResolvedValue(undefined),
  listenForQuitFlushRequest: async (handler: () => Promise<void>) => {
    native.quitFlush = handler;
    return () => { if (native.quitFlush === handler) native.quitFlush = undefined; };
  },
  confirmQuitAfterFlush: native.quit,
  listenForQuitPromptRequest: async (handler: (id: number) => Promise<void>) => {
    native.promptQuit = handler;
    return () => { if (native.promptQuit === handler) native.promptQuit = undefined; };
  },
  listenForQuitSettings: async () => () => {},
  setQuitPromptEnabled: vi.fn().mockResolvedValue(undefined),
  prepareQuitPrompt: native.prepareQuit,
  resumeQuitAfterPrompt: native.resumeQuit,
  confirmPromptedQuit: native.quit,
  reportQuitPromptShowing: native.promptShowing,
  cancelQuit: native.cancelQuit,
  requestQuitAfterClose: native.requestAfterClose
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
  ...await original<typeof import("@tauri-apps/api/core")>(),
  isTauri: () => native.suspendUtilities,
  invoke: vi.fn(async (command: string, options?: { suspended?: boolean }) => {
    if (command === "read_clipboard_payload") return native.clipboardPending ?? { types: [], textItems: [] };
    if (command === "suspend_toolset_windows") {
      if (native.suspendFailure && options?.suspended) throw new Error("Native utility hide refused");
      if (native.suspendPending && options?.suspended) await native.suspendPending;
      if (options?.suspended) {
        if (native.suspensionDepth++ === 0) {
          native.visibilityChanges.push("hide");
          native.suspendedToolsets = [...native.toolsetWindows].filter(([, visible]) => visible).map(([id]) => id);
          for (const id of native.suspendedToolsets) native.toolsetWindows.set(id, false);
        }
      } else if (--native.suspensionDepth === 0) {
        native.visibilityChanges.push("restore");
        for (const id of native.suspendedToolsets) native.toolsetWindows.set(id, true);
      }
    }
    return null;
  })
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
  beforeAll(async () => {
    expect((await inspectStructureOffThread("smiles", "C")).valid).toBe(true);
  }, 20_000);
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
    vi.stubGlobal("localStorage", new MemoryStorage());
    saveAskToSaveBeforeQuit(false);
    native.promptShowing.mockImplementation(async () => {
      expect(pendingPrompt?.prompt.title === "Save changes before quitting?" ||
        document.querySelector('[role="dialog"][aria-modal="true"][aria-labelledby="quit-prompt-title"]') !== null).toBe(true);
      return true;
    });
    native.cancelQuit.mockResolvedValue(true);
    native.prepareQuit.mockResolvedValue(true);
    native.resumeQuit.mockResolvedValue(true);
    native.quitId = 0;
    native.suspendFailure = false;
    native.suspendPending = undefined;
    native.clipboardPending = undefined;
    native.requestAfterClose.mockImplementation(async () => { await native.promptQuit!(++native.quitId); });
    vi.mocked(setToolbarsMenu).mockResolvedValue(undefined);
    vi.mocked(broadcastAnalysisWindowSnapshot).mockResolvedValue(undefined);
    vi.mocked(respondToProposalDecision).mockResolvedValue(undefined);
    native.desktop = true;
    native.dialogSnapshot = undefined;
    native.dialogListener = undefined;
    native.dialogClose.mockReset().mockResolvedValue(undefined);
    native.dialogPublish.mockReset().mockResolvedValue(undefined);
    native.suspendUtilities = false;
    native.suspensionDepth = 0;
    native.visibilityChanges = [];
    native.toolsetWindows.clear();
    native.suspendedToolsets = [];
    native.loadToolsetLayout.mockResolvedValue(undefined);
    native.listToolsets.mockImplementation(async () => [...native.toolsetWindows]
      .map(([toolsetId, open]) => ({ toolsetId, open, focused: false })));
    native.openToolset.mockImplementation(async (toolsetId) => {
      // Match Rust: suspension refuses even creation of a window that does not yet exist.
      if (!native.suspensionDepth) native.toolsetWindows.set(toolsetId, true);
      return { toolsetId, open: native.toolsetWindows.get(toolsetId) ?? false, focused: false };
    });
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
    perfState.current?.stop(); perfState.current = undefined;
    root = undefined;
    container?.remove();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function mount(initialDocument = createPhase4Document("Untitled"), strict = false) {
    root = createRoot(container);
    await act(async () => {
      const main = createElement(MainWindow, {
        initialDocument, initialActiveToolCommandId: "tool.select",
        initialPaletteMode: "hidden", initialCrosshairsVisible: false, initialRulersVisible: false, nativePalette: true
      });
      root!.render(strict ? createElement(StrictMode, null, main) : main);
    });
  }
  async function remount() {
    act(() => root!.unmount());
    pendingPrompt = undefined;
    container.innerHTML = "";
    await mount();
  }

  function recordOpens() {
    const records: PerfRecord[] = [];
    const frames = new Map<number, () => void>(); let id = 0;
    perfState.current = createPerfProbe(true, () => ({
      target: window, now: () => performance.now(), eventTime: stamp => stamp,
      frame: callback => { frames.set(++id, callback); return id; }, afterPaint: callback => callback(), cancelFrame: key => { frames.delete(key); },
      defer: callback => window.queueMicrotask(callback), timeout: callback => window.setTimeout(callback, 120_000), clearTimeout: id => window.clearTimeout(id),
      write: record => records.push(record), window: "main", platform: "macos", buildStamp: "test", processStart: 0, clockErrorMs: 0
    }));
    return () => {
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback());
      return records.filter(record => record.kind === "document-open");
    };
  }

  it("with the probe off installs no perf listeners, registry wrapper or native calls through MainWindow", async () => {
    const instrument = vi.spyOn(PerfProbe.prototype, "instrumentRegistry");
    const measuredCommand = vi.spyOn(PerfProbe.prototype, "command");
    const listen = vi.spyOn(window, "addEventListener");
    await remount(); await open("Probe off"); await command("document.new");
    expect(instrument).not.toHaveBeenCalled(); expect(measuredCommand).not.toHaveBeenCalled();
    expect(listen.mock.calls.filter(([name]) => name.startsWith("chemdraft:perf"))).toEqual([]);
    expect(vi.mocked(nativeInvoke).mock.calls.filter(([name]) => name.startsWith("perf_log_"))).toEqual([]);
  });

  it("reports commits only for installed opens and labels an already open file", async () => {
    const rows = recordOpens();
    await open("Perf first");
    expect(rows()).toEqual([expect.objectContaining({ doneSignal: "document-commit" })]);
    await open("Perf first");
    expect(rows()).toEqual([
      expect.objectContaining({ doneSignal: "document-commit" }),
      expect.objectContaining({ doneSignal: "command-finished", extra: expect.objectContaining({ openOutcome: "already-open" }) })
    ]);
  });

  it("labels a startup open queued during hydration, then records its later history install", async () => {
    let hydrated!: (session: unknown) => void;
    native.load.mockImplementationOnce(() => new Promise(resolve => { hydrated = resolve; }));
    const rows = recordOpens(); await remount();
    await act(async () => native.events.get("chemdraft://open-document")!({
      path: "/tmp/perf-startup.chemdraft", displayName: "perf-startup.chemdraft", contents: fileContents("Startup")
    }));
    expect(rows()).toEqual([expect.objectContaining({ doneSignal: "command-finished", extra: expect.objectContaining({ openOutcome: "queued" }) })]);
    await act(async () => hydrated(undefined));
    expect(rows().map(row => row.doneSignal)).toEqual(["command-finished", "document-commit"]);
  });

  it("labels an open queued while the quit question is active", async () => {
    saveAskToSaveBeforeQuit(true); await paste("Unsaved drawing");
    await act(async () => native.promptQuit!(++native.quitId));
    const rows = recordOpens();
    await act(async () => native.events.get("chemdraft://open-document")!({
      path: "/tmp/perf-quit.chemdraft", displayName: "perf-quit.chemdraft", contents: fileContents("After quit")
    }));
    expect(rows()).toEqual([expect.objectContaining({ doneSignal: "command-finished", extra: expect.objectContaining({ openOutcome: "queued" }) })]);
    await modalButton("Cancel");
    expect(rows().map(row => row.doneSignal)).toEqual(["command-finished", "document-commit"]);
  });

  it.each(["/Users/chemist/drawing.chemdraft", "D:\\drawings\\drawing.chemdraft", "D:\\drawings\\drawing.cdxml"])(
    "saves a restored dirty named tab directly to %s without a picker", async (path) => {
      const payload = createNativeSavePayload(createPhase4Document("Restored drawing"));
      native.session = buildDocumentTabsSession([
        buildDocumentSessionEnvelope(payload, { path, dirty: true }, "drawing.chemdraft", false)
      ], 0);
      await remount();
      native.writeFile.mockClear(); native.savePicker.mockClear();
      await command("document.save");
      expect(native.savePicker).not.toHaveBeenCalled();
      expect(native.writeFile).toHaveBeenCalledExactlyOnceWith(path, expect.any(String));
      expect(bridge().snapshot().file).toMatchObject({ path, dirty: false });
    }
  );

  it.each(["the saved file is unavailable", "File access could not be restored"])(
    "uses Save As for a restored path when %s, preserving content on cancel", async (reason) => {
      const path = "D:\\drawings\\missing.chemdraft";
      const payload = createNativeSavePayload(createPhase4Document("Restored drawing"));
      native.session = { ...buildDocumentSessionEnvelope(payload, { path, dirty: true }, "missing.chemdraft", false),
        restoreSavePathError: reason };
      await remount();
      const document = bridge().snapshot().document;
      expect(container.querySelector('[role="status"]')?.textContent).toContain(reason);
      native.writeFile.mockClear(); native.savePicker.mockClear();
      native.savePicker.mockResolvedValueOnce(null);
      await command("document.save");
      expect(native.writeFile).not.toHaveBeenCalled();
      expect(native.savePicker).toHaveBeenCalledWith(expect.objectContaining({ title: "Save As — restored file unavailable" }));
      expect(bridge().snapshot().file).toMatchObject({ path, dirty: true });
      expect(bridge().snapshot().document).toEqual(document);
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Choose a location with Save As");
      const replacement = "D:\\drawings\\rescued.chemdraft";
      native.savePicker.mockResolvedValueOnce(replacement);
      await command("document.save");
      expect(native.writeFile).toHaveBeenCalledExactlyOnceWith(replacement, expect.any(String));
      expect(bridge().snapshot().file).toMatchObject({ path: replacement, dirty: false });
      native.savePicker.mockClear();
      await command("document.save");
      expect(native.savePicker).not.toHaveBeenCalled();
    }
  );

  it("uses the restored-path Save As fallback from the dirty-tab close prompt", async () => {
    native.session = { ...buildDocumentSessionEnvelope(createNativeSavePayload(createPhase4Document("Kept drawing")),
      { path: "D:\\missing.chemdraft", dirty: true }, "missing.chemdraft", false),
      restoreSavePathError: "the saved file is unavailable" };
    await remount();
    await closeTab();
    native.savePicker.mockResolvedValueOnce(null);
    await modalButton("Save");
    expect(tabs()).toHaveLength(1);
    expect(bridge().snapshot().file.dirty).toBe(true);
    expect(pendingPrompt?.prompt.message).toContain("Choose a location with Save As");
    native.savePicker.mockResolvedValueOnce("D:\\rescued.chemdraft");
    await modalButton("Save");
    expect(native.writeFile).toHaveBeenCalledWith("D:\\rescued.chemdraft", expect.any(String));
    expect(bridge().snapshot().file).toEqual({ dirty: false });
  });
  function bridge(): ChemDraftAgentBridge {
    return (window as Window & { __CHEMDRAFT_AGENT__: ChemDraftAgentBridge }).__CHEMDRAFT_AGENT__;
  }
  const drawnText = () => bridge().snapshot().document.pages.flatMap((page) => page.objects)
    .filter((object) => object.type === "text").map((object) => object.text).join("\n");
  const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const active = () => tabs().findIndex((tab) => tab.getAttribute("aria-selected") === "true");
  it("refuses a timed-out SMILES check without inserting a molecule or fallback text", async () => {
    const before = structuredClone(bridge().snapshot().document);
    vi.spyOn(smilesListPaste, "depictSmilesForPaste").mockResolvedValueOnce({
      depiction: { atoms: [{ element: "C", x: 0, y: 0, charge: 0 }], bonds: [] }, stereoCount: 0
    });
    vi.spyOn(smilesPasteIdentity, "verifySmilesPaste").mockRejectedValueOnce(
      new smilesPasteIdentity.SmilesPasteIdentityError("CC", new IdentityVerificationTimeoutError(4_000)));
    await paste("CC");
    expect(bridge().snapshot().document).toEqual(before);
    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain("within 4 s; nothing was inserted");
  });
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function pageSizeMessage(type: "ready" | "action", data: unknown) {
    await act(async () => { native.dialogListener!({ senderWindowId: `dialog-main-${native.dialogSnapshot!.dialogKind}-1`, windowLabel: `dialog-main-${native.dialogSnapshot!.dialogKind}-1`,
      message: { ...native.dialogSnapshot!, type, data, requestId: crypto.randomUUID() } }); });
  }
  async function spacingDrawing() {
    saveCompoundLayoutSettings({ enabled: true });
    let source = createPhase4Document("Spacing source");
    for (let i = 0; i < 3; i++) source = applyPatches(source, [{ op: "addObject", pageId: source.pages[0].id,
      object: createNativeSingleBondMolecule(source, { x: 200 + i * 100, y: 300 }) }]);
    source = selectDocumentObjects(source, source.pages[0].id, source.pages[0].objects.map(o => o.id));
    source = arrangeSelectedDocumentObjects(source, "circle", { gap: 100 }).document;
    act(() => root!.unmount()); container.innerHTML = ""; await mount(source);
    return bridge().snapshot().document;
  }
  async function spacingMessage(data: unknown, requestId = crypto.randomUUID()) {
    const label = "dialog-main-arrangementSpacing-1";
    await act(async () => native.dialogListener!({ senderWindowId: label, windowLabel: label,
      message: { ...native.dialogSnapshot!, type: "action", data, requestId } }));
  }
  async function readySpacing() {
    const label = "dialog-main-arrangementSpacing-1";
    await act(async () => native.dialogListener!({ senderWindowId: label, windowLabel: label,
      message: { ...native.dialogSnapshot!, type: "ready", data: {}, requestId: crypto.randomUUID() } }));
  }
  it("native spacing previews without an overlay and saves to the original inactive tab with one undo", async () => {
    const before = await spacingDrawing(); await command("layout.adjustArrangementSpacing");
    expect(native.dialogSnapshot).toMatchObject({ dialogKind: "arrangementSpacing", documentTabId: "initial" });
    expect(container.querySelector('.arrangement-spacing-dialog')).toBeNull(); await readySpacing();
    await spacingMessage({ action: "preview", percent: 80 });
    await vi.waitFor(() => expect(native.dialogPublish).toHaveBeenCalled());
    expect(native.dialogPublish.mock.calls.some(call => (call[1] as DialogMessage).type === "preview")).toBe(true);
    expect(bridge().snapshot().document).toEqual(before);
    await command("document.new"); const other = bridge().snapshot().document;
    await spacingMessage({ action: "apply", percent: 80 });
    expect(active()).toBe(1); expect(bridge().snapshot().document).toEqual(other);
    await activate(0); expect(bridge().snapshot().document).not.toEqual(before);
    expect(bridge().snapshot().document.selection).toEqual(before.selection);
    await command("edit.undo"); expect(bridge().snapshot().document).toEqual(before);
    await command("edit.undo"); expect(container.querySelector('[role="status"]')?.textContent).toContain("Nothing to undo");
    saveCompoundLayoutSettings({ enabled: false });
  });
  it("rejects stale native spacing Save and closes its window with the originating tab", async () => {
    await spacingDrawing(); await command("layout.adjustArrangementSpacing"); await readySpacing();
    await command("layout.arrange.row"); const changed = bridge().snapshot().document;
    await spacingMessage({ action: "apply", percent: 80 });
    expect(bridge().snapshot().document).toEqual(changed);
    expect(native.dialogPublish.mock.calls.some(call => (call[1] as DialogMessage).type === "result" && (call[1] as { data: { status: string } }).data.status === "error")).toBe(true);
    await command("document.new"); await closeTab(0); await modalButton("Don't Save");
    expect(native.dialogClose).toHaveBeenCalledWith("opaque", "ownerTabClose");
    saveCompoundLayoutSettings({ enabled: false });
  });
  it("reports native spacing creation failure without rendering an in-page desktop fallback", async () => {
    await spacingDrawing(); const source = bridge().snapshot().document;
    const open = nativeDialogTransport.open;
    const spy = vi.spyOn(nativeDialogTransport, "open").mockRejectedValueOnce(new Error("native unavailable"));
    await command("layout.adjustArrangementSpacing");
    expect(container.querySelector('.arrangement-spacing-dialog')).toBeNull();
    expect(container.textContent).toContain("native unavailable"); expect(bridge().snapshot().document).toEqual(source);
    spy.mockRestore(); expect(nativeDialogTransport.open).toBe(open); saveCompoundLayoutSettings({ enabled: false });
  });
  it("native Page Size stays modeless and applies to its originating inactive tab with one undo entry", async () => {
    const originalLayout = bridge().snapshot().document.pages[0]!.layout;
    await command("page.setSizeCustom");
    expect(native.dialogSnapshot).toMatchObject({ type: "snapshot", documentTabId: "initial", data: { title: "Untitled" } });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await command("document.new"); expect(active()).toBe(1);
    const otherLayout = bridge().snapshot().document.pages[0]!.layout;
    await pageSizeMessage("ready", {});
    await pageSizeMessage("action", { action: "apply", width: 200, height: 300, unit: "mm" });
    expect(active()).toBe(1); expect(bridge().snapshot().document.pages[0]!.layout).toEqual(otherLayout);
    expect(native.dialogClose).toHaveBeenCalledExactlyOnceWith("opaque", "apply");
    await activate(0);
    expect(bridge().snapshot().document.pages[0]!.layout).toMatchObject({ presetId: "custom", sourceWidth: 200, sourceHeight: 300, sourceUnit: "mm" });
    expect(bridge().snapshot().file.dirty).toBe(true);
    await command("edit.undo"); expect(bridge().snapshot().document.pages[0]!.layout).toEqual(originalLayout);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Set Custom Page Size");
    await command("edit.undo"); expect(container.querySelector('[role="status"]')?.textContent).toContain("Nothing to undo");
  });
  it("closing the originating tab closes Page Size while a different drawing is active", async () => {
    await command("page.setSizeCustom"); await command("document.new"); await closeTab(0);
    expect(native.dialogClose).toHaveBeenCalledExactlyOnceWith("opaque", "ownerTabClose");
  });
  it("replacing a pristine tab settles its Page Size draft before a late Apply can reach the new file", async () => {
    await command("page.setSizeCustom");
    await pageSizeMessage("ready", {});
    const oldSession = native.dialogSnapshot!;
    await open("Replacement drawing");
    expect(tabs()).toHaveLength(1);
    expect(native.dialogClose).toHaveBeenCalledExactlyOnceWith("opaque", "ownerTabClose");
    const opened = bridge().snapshot();
    await pageSizeMessage("action", { action: "apply", width: 200, height: 300, unit: "mm" });
    expect(bridge().snapshot().document).toEqual(opened.document);
    expect(bridge().snapshot().file.dirty).toBe(false);
    await command("page.setSizeCustom");
    expect(native.dialogSnapshot!.documentTabId).toBe(oldSession.documentTabId);
    expect(native.dialogSnapshot!.sessionId).not.toBe(oldSession.sessionId);
    await act(async () => native.dialogListener!({ senderWindowId: "dialog-main-pageSize-1", windowLabel: "dialog-main-pageSize-1",
      message: { ...oldSession, type: "closed", data: { reason: "destroy" } } }));
    await pageSizeMessage("ready", {});
    await pageSizeMessage("action", { action: "apply", width: 100, height: 150, unit: "mm" });
    expect(bridge().snapshot().document.pages[0]!.layout.sourceWidth).toBe(100);
  });
  it("the browser fallback renders the shared Page Size form and applies the existing page logic", async () => {
    native.desktop = false;
    await command("page.setSizeCustom");
    expect(native.dialogSnapshot).toBeUndefined();
    expect(container.querySelector(".cd-page-size-form")).not.toBeNull();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Drawing: Untitled");
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('.cd-page-size-form button')).find(b => b.textContent === "Apply")!.click());
    expect(bridge().snapshot().document.pages[0]!.layout.presetId).toBe("custom");
    expect(container.querySelector(".cd-page-size-form")).toBeNull();
  });
  it("the browser keeps the shared Export form and shows its download receipt", async () => {
    native.desktop = false;
    vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:export"); static revokeObjectURL = vi.fn(); });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await command("export.open");
    expect(native.dialogSnapshot).toBeUndefined();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Export"]')!;
    expect(dialog).not.toBeNull();
    const select = dialog.querySelector<HTMLSelectElement>("#chemdraft-export-format")!;
    await act(async () => { select.value = "svg"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === "Export")!.click());
    expect(click).toHaveBeenCalledTimes(1);
    expect(dialog.textContent).toContain("Exported SVG");
    expect(Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === "Exported")!.disabled).toBe(true);
    expect(native.savePicker).not.toHaveBeenCalled();
    await act(async () => Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === "Close")!.click());
    expect(container.querySelector('[role="dialog"][aria-label="Export"]')).toBeNull();
  });
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
    await act(async () => {
      if (loadAskToSaveBeforeQuit()) await native.promptQuit!(++native.quitId);
      else await native.quitFlush!();
    });
    return parseDocumentSessionEnvelope(native.session)!;
  }
  async function quitButton(label: string) {
    expect(pendingPrompt?.prompt.title).toBe("Save changes before quitting?");
    await modalButton(label === "Discard" ? "Don't Save" : label);
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
  const reviewSourceLabel = pluginPanelWindowLabel({ pluginId: ANALYSIS_WINDOW_OWNER_ID, panelId: PATCH_REVIEW_WINDOW_ID });
  async function decide(kind: "acceptPluginProposal" | "rejectPluginProposal", proposalId: string) {
    // Rust stamps the review window's label before forwarding the action to main.
    await act(async () => native.events.get(ANALYSIS_WINDOW_ACTION_EVENT)!({
      kind, proposalId, requestId: "review-result", sourceLabel: reviewSourceLabel
    }));
  }
  const reviewItems = () => {
    const snapshots = vi.mocked(broadcastAnalysisWindowSnapshot).mock.calls
      .map(([payload]) => payload as AnalysisWindowSnapshotPayload);
    const content = snapshots.filter((payload) => payload.content.kind === "patchReview").at(-1)!.content;
    if (content.kind !== "patchReview") throw new Error("No proposal review snapshot");
    return content.proposals;
  };

  it.each(["acceptPluginProposal", "rejectPluginProposal"] as const)("requires the native review window sender for %s", async kind => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await paste("Source object");
    const before = bridge().snapshot().document;
    const proposal = await propose({ op: "updateObject", objectId: before.pages[0]!.objects[0]!.id,
      changes: { text: "Reviewed source" } });
    const action = { kind, proposalId: proposal.id, requestId: "review-result" };
    const receive = native.events.get(ANALYSIS_WINDOW_ACTION_EVENT)!;
    const otherSourceLabel = pluginPanelWindowLabel({ pluginId: "org.test.tab-proposal", panelId: PATCH_REVIEW_WINDOW_ID });
    for (const payload of [action, { ...action, sourceLabel: otherSourceLabel }]) {
      await act(async () => receive(payload));
      expect(runtime().host.listProposedPatches("pending")).toEqual([proposal]);
      expect(bridge().snapshot().document).toEqual(before);
      expect(respondToProposalDecision).not.toHaveBeenCalled();
    }
    await act(async () => window.dispatchEvent(new CustomEvent(ANALYSIS_WINDOW_ACTION_EVENT, {
      detail: { ...action, sourceLabel: reviewSourceLabel }
    })));
    expect(runtime().host.listProposedPatches("pending")).toEqual([proposal]);
    expect(bridge().snapshot().document).toEqual(before);
    expect(respondToProposalDecision).not.toHaveBeenCalled();
    await decide(kind, proposal.id);
    expect(runtime().host.listProposedPatches("pending")).toEqual([]);
    expect(drawnText()).toBe(kind === "acceptPluginProposal" ? "Reviewed source" : "Source object");
    expect(respondToProposalDecision).toHaveBeenCalledExactlyOnceWith("review-result", {
      ok: true, message: expect.any(String)
    }, reviewSourceLabel);
  });

  async function mountHoverChain() {
    act(() => root!.unmount());
    container.innerHTML = "";
    vi.mocked(createPluginRuntime).mockClear();
    saveKeybindingSettings({ scheme: "chemdraft" });
    const chain = applyNativeChainTool(createPhase4Document("Hover cancellation"), { x: 80, y: 300 }, { x: 700, y: 300 });
    await mount(selectDocumentObjects(chain, chain.pages[0]!.id, []));
    await command("tool.bond");
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      element.getBoundingClientRect = () => rect;
    }
  }
  const hoverMolecule = () => bridge().snapshot().document.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
  const labelEditor = () => container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
  async function hoverChainAtom(index: number) {
    const atom = hoverMolecule().atoms[index]!;
    await act(async () => {
      const event = new MouseEvent("pointermove", { bubbles: true, clientX: atom.x, clientY: atom.y, buttons: 0 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector(".page")!.dispatchEvent(event);
    });
    expect(bridge().snapshot().hoveredNativeTarget).toMatchObject({ kind: "atom", atomId: atom.id });
  }
  async function labelKey(key: string) {
    const target = document.activeElement ?? document.body;
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(event); });
    if (!event.defaultPrevented && target instanceof HTMLInputElement && key.length === 1) {
      const value = target.value + key;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.setSelectionRange(value.length, value.length);
      });
    }
  }

  it("Escape preserves an accepted chemistry proposal between the first hover letter and the draft", async () => {
    await mountHoverChain();
    await hoverChainAtom(1);
    await labelKey("N");
    const beforeProposal = hoverMolecule();
    const proposal = await propose({ op: "updateObject", objectId: beforeProposal.id, changes: {
      atoms: beforeProposal.atoms.map((atom, index) => index === 3 ? { ...atom, element: "O" } : atom)
    } });
    await decide("acceptPluginProposal", proposal.id);
    const acceptedAtom = hoverMolecule().atoms[3]!;
    expect(acceptedAtom.element).toBe("O");
    await labelKey("M");
    await labelKey("e");
    expect(labelEditor()?.value).toBe("NMe");
    await labelKey("Escape");
    expect(labelEditor()).toBeNull();
    expect(hoverMolecule().atoms[3]).toEqual(acceptedAtom);
    expect(hoverMolecule().atoms[1]!.element).toBe("N");
    expect(bridge().snapshot().file.dirty).toBe(true);
    // The external proposal keeps its undo entry.
    await command("edit.undo");
    expect(hoverMolecule().atoms[3]!.element).toBe("C");
    expect(hoverMolecule().atoms[1]!.element).toBe("N");
  });

  it.each(["O", "N"])("Escape preserves a same-atom proposal that supersedes the open draft with %s", async element => {
    await mountHoverChain();
    await hoverChainAtom(1);
    for (const key of "NMe") await labelKey(key);
    expect(labelEditor()?.value).toBe("NMe");
    const beforeProposal = hoverMolecule();
    const proposal = await propose({ op: "updateObject", objectId: beforeProposal.id, changes: {
      atoms: beforeProposal.atoms.map((atom, index) => index === 1 ? { ...atom, element } : atom)
    } });
    await decide("acceptPluginProposal", proposal.id);
    const accepted = bridge().snapshot().document;
    expect(hoverMolecule().atoms[1]!.element).toBe(element);
    expect(labelEditor()?.value).toBe("NMe");
    await labelKey("Escape");
    expect(labelEditor()).toBeNull();
    expect(bridge().snapshot().document).toEqual(accepted);
    // Escape neither overwrites the accepted atom nor removes the proposal's history entry.
    await command("edit.undo");
    expect(hoverMolecule().atoms[1]!.element).toBe("N");
  });

  it("Escape discards the first letter even when rollback constructs document keys in a different order", async () => {
    await mountHoverChain();
    const before = bridge().snapshot().document;
    await hoverChainAtom(1);
    for (const key of "NMe") await labelKey(key);
    const restore = atomLabelDraft.restoreAtomLabelDraft;
    vi.spyOn(atomLabelDraft, "restoreAtomLabelDraft").mockImplementation((document, state) => {
      const restored = restore(document, state);
      return Object.fromEntries(Object.entries(restored).reverse()) as typeof restored;
    });
    await labelKey("Escape");
    expect(labelEditor()).toBeNull();
    expect(bridge().snapshot().document).toEqual(before);
    expect(container.querySelector('[data-can-undo]')?.getAttribute("data-can-undo")).toBe("false");
  });

  it.each(["document.save", "document.saveAs"])("Escape after %s during a hover draft keeps the saved path and marks the canvas dirty", async saveCommand => {
    await mountHoverChain();
    native.savePicker.mockResolvedValueOnce("/tmp/chain.chemdraft");
    await command("document.save");
    expect(bridge().snapshot().file).toEqual({ path: "/tmp/chain.chemdraft", dirty: false });
    const before = bridge().snapshot().document;
    await hoverChainAtom(1);
    for (const key of "NMe") await labelKey(key);
    expect(labelEditor()?.value).toBe("NMe");
    const savedPath = saveCommand === "document.saveAs" ? "/tmp/renamed-chain.chemdraft" : "/tmp/chain.chemdraft";
    if (saveCommand === "document.saveAs") native.savePicker.mockResolvedValueOnce(savedPath);
    await command(saveCommand);
    expect(labelEditor()?.value).toBe("NMe");
    const [path, contents] = native.writeFile.mock.calls.at(-1)!;
    expect(path).toBe(savedPath);
    const saved = openChemDraftPayload(contents).document!;
    const savedMolecule = saved.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    expect(savedMolecule.atoms[1]!.element).toBe("NMe");
    expect(bridge().snapshot().file).toEqual({ path: savedPath, dirty: false });
    await labelKey("Escape");
    expect(bridge().snapshot().document).toEqual(before);
    expect(bridge().snapshot().file).toEqual({ path: savedPath, dirty: true });
    expect(document.title).toContain(`${savedPath.split("/").at(-1)} •`);
    expect(container.querySelector('[data-can-undo]')?.getAttribute("data-can-undo")).toBe("false");
  });

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
    expect(tabs()).toHaveLength(1);
    expect(reviewItems()[0]!.documentName).toBe("Closed source.chemdraft (closed)");
    expect(runtime().host.listProposedPatches("pending")).toEqual([proposal]);
    await decide("acceptPluginProposal", proposal.id);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("its document was closed (Closed source.chemdraft)");
    expect(respondToProposalDecision).toHaveBeenLastCalledWith("review-result", {
      ok: false, message: expect.stringContaining("its document was closed")
    }, reviewSourceLabel);
    expect(runtime().host.listProposedPatches("pending")).toEqual([proposal]);
    expect(bridge().snapshot().document).toEqual(other);
    await command("edit.undo");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Nothing to undo");
    await decide("rejectPluginProposal", proposal.id);
    expect(runtime().host.listProposedPatches("pending")).toEqual([]);
    expect(bridge().snapshot().document).toEqual(other);
  });

  it.each([false, true])("uses the Save As title for proposal labels and the Accept refusal (multiple: %s)", async (multiple) => {
    await open("Original source");
    const proposal = await propose({ op: "updatePageLayout", pageId: bridge().snapshot().document.pages[0]!.id,
      layout: bridge().snapshot().document.pages[0]!.layout });
    expect(reviewItems()[0]!.documentName).toBeUndefined();
    if (multiple) {
      await command("document.new");
      expect(reviewItems()[0]!.documentName).toBe("Original source.chemdraft");
      await activate(0);
    }
    native.savePicker.mockResolvedValueOnce("/tmp/Renamed source.chemdraft");
    await command("document.saveAs");
    expect(tabs()[0]!.textContent).toBe("Renamed source.chemdraft");
    expect(reviewItems()[0]!.documentName).toBe(multiple ? "Renamed source.chemdraft" : undefined);
    await closeTab();
    expect(tabs()).toHaveLength(1);
    expect(reviewItems()[0]!.documentName).toBe("Renamed source.chemdraft (closed)");
    await decide("acceptPluginProposal", proposal.id);
    const message = "Could not accept the proposal: its document was closed (Renamed source.chemdraft). You can reject it.";
    expect(container.querySelector('[role="status"]')?.textContent).toContain(message);
    expect(respondToProposalDecision).toHaveBeenLastCalledWith("review-result", { ok: false, message }, reviewSourceLabel);
    expect(runtime().host.listProposedPatches("pending")).toEqual([proposal]);
  });

  it.each([false, true])("uses the Save As title when a running command proposes later (close before arrival: %s)", async (closeBeforeArrival) => {
    await open("Original delayed source");
    const source = bridge().snapshot().document;
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const commandId = registerProposal({ op: "updatePageLayout", pageId: source.pages[0]!.id,
      layout: source.pages[0]!.layout }, wait);
    let invocation!: Promise<unknown>;
    await act(async () => { invocation = runtime().invokeCommand(commandId); });
    native.savePicker.mockResolvedValueOnce("/tmp/Renamed delayed source.chemdraft");
    await command("document.saveAs");
    expect(runtime().host.listProposedPatches("pending")).toEqual([]);
    if (closeBeforeArrival) await closeTab();
    await act(async () => { finish(); await invocation; });
    const proposal = runtime().host.listProposedPatches("pending")[0]!;
    if (!closeBeforeArrival) {
      expect(reviewItems()[0]!.documentName).toBeUndefined();
      await command("document.new");
      expect(reviewItems()[0]!.documentName).toBe("Renamed delayed source.chemdraft");
      await activate(0);
      await closeTab();
    }
    expect(tabs()).toHaveLength(1);
    expect(reviewItems()[0]!.documentName).toBe("Renamed delayed source.chemdraft (closed)");
    const other = bridge().snapshot().document;
    await decide("acceptPluginProposal", proposal.id);
    const message = "Could not accept the proposal: its document was closed (Renamed delayed source.chemdraft). You can reject it.";
    expect(container.querySelector('[role="status"]')?.textContent).toContain(message);
    expect(respondToProposalDecision).toHaveBeenLastCalledWith("review-result", { ok: false, message }, reviewSourceLabel);
    expect(runtime().host.listProposedPatches("pending")).toEqual([proposal]);
    expect(bridge().snapshot().document).toEqual(other);
    await decide("rejectPluginProposal", proposal.id);
    expect(runtime().proposalDocumentTab(proposal.id)).toBeUndefined();
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

  it.each(["Import Visible CDXML", "Restore Embedded", "Cancel"])("CDXML conflict %s opens only the chosen document", async (choice) => {
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
    // Cancel keeps a dismissal's old outcome, the embedded document; Escape reaches it on macOS.
    expect(pendingPrompt?.prompt.choices.map((candidate) => candidate.label))
      .toEqual(["Import Visible CDXML", "Restore Embedded", "Cancel"]);
    expect(bridge().snapshot().document).toEqual(original);
    expect(tabs()).toHaveLength(1);
    await modalButton(choice);
    expect(tabs()).toHaveLength(2);
    expect(drawnText()).toContain(choice === "Import Visible CDXML" ? "Externally edited note" : "Original embedded note");
    expect(bridge().snapshot().file.path).toBe("/tmp/conflicted.chemdraft");
    await activate(0);
    expect(bridge().snapshot().document).toEqual(original);
  });

  it("reopening a file whose CDXML choice is still pending gives one tab for the path", async () => {
    await paste("Original embedded note");
    const edited = createNativeSavePayload(bridge().snapshot().document).contents
      .replace("Original embedded note", "Externally edited note");
    const prompts: { prompt: NativePromptOptions; resolve: (id: string) => void }[] = [];
    const restore = setNativePromptProvider((prompt) => new Promise((resolve) => { prompts.push({ prompt, resolve }); }));
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        native.picker.mockResolvedValueOnce("/tmp/conflicted.chemdraft");
        native.readFile.mockResolvedValueOnce(new TextEncoder().encode(edited));
        await command("document.open");
      }
      let shown = 0;
      while (prompts.length) {
        const { prompt, resolve } = prompts.shift()!;
        expect(prompt.title).toBe("Modified visible CDXML");
        shown += 1;
        await act(async () => resolve("visible"));
      }
      expect(shown).toBe(1);
    } finally { restore(); }
    expect(tabs()).toHaveLength(2);
    expect(active()).toBe(1);
    expect(bridge().snapshot().file.path).toBe("/tmp/conflicted.chemdraft");
    expect(drawnText()).toContain("Externally edited note");
    const saved = await flush();
    expect(saved.tabs!.filter((tab) => tab.path === "/tmp/conflicted.chemdraft")).toHaveLength(1);
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

  it.each(["MacIntel", "Win32"])("modeless Export's own picker restores its live window on %s", async (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    native.suspendUtilities = true;
    await remount();
    native.toolsetWindows.set("visible-toolbar", true);
    native.toolsetWindows.set("hidden-toolbar", false);
    await command("export.open");
    expect(container.querySelector('[role="dialog"][aria-label="Export"]')).toBeNull();
    expect(native.dialogSnapshot).toMatchObject({ dialogKind: "export" });
    expect(native.suspensionDepth).toBe(0);
    native.toolsetWindows.set("dialog-main-export-1", true);
    await pageSizeMessage("ready", {});
    const snapshot = native.dialogSnapshot!;
    if (snapshot.type !== "snapshot" || snapshot.dialogKind !== "export") throw new Error("Missing Export snapshot");
    let finishPanel!: (path: string | null) => void;
    native.savePicker.mockImplementationOnce(() => new Promise(resolve => { finishPanel = resolve; }));
    await pageSizeMessage("action", { action: "chooseDestination", options: snapshot.data.options });
    await vi.waitFor(() => expect(finishPanel).toBeDefined());
    expect(native.suspensionDepth).toBe(1);
    expect([...native.toolsetWindows.values()]).toEqual([false, false, false]);
    await act(async () => finishPanel("/tmp/granted.pdf"));
    await vi.waitFor(() => expect(native.dialogPublish).toHaveBeenCalledWith("opaque", expect.objectContaining({ data: { status: "picked", destinationPath: "/tmp/granted.pdf", filename: "granted.pdf" } })));
    expect(native.suspensionDepth).toBe(0);
    expect(native.visibilityChanges).toEqual(["hide", "restore"]);
    expect([...native.toolsetWindows.values()]).toEqual([true, false, true]);
    await pageSizeMessage("action", { action: "cancel" });
    expect(native.dialogClose).toHaveBeenCalledWith("opaque", "cancel");
  });

  it.each(["x".repeat(255), "x".repeat(251) + "😀yz"])("opens Export with a bounded default filename for a long title (%s)", async title => {
    act(() => root!.unmount()); container.innerHTML = "";
    await mount(createPhase4Document(title));
    await command("export.open");
    expect(native.dialogSnapshot).toMatchObject({ type: "snapshot", dialogKind: "export" });
    const snapshot = native.dialogSnapshot!;
    if (snapshot.type !== "snapshot" || snapshot.dialogKind !== "export") throw new Error("Missing Export snapshot");
    expect(snapshot.data.options.filename).toBe(title.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 252) + ".pdf");
    expect(snapshot.data.options.filename.length).toBeLessThanOrEqual(256);
    expect(snapshot.data.options.filename).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("Export commits the still-focused atom-label draft before rendering", async () => {
    await mountHoverChain();
    await command("export.open"); await pageSizeMessage("ready", {});
    const snapshot = native.dialogSnapshot!;
    if (snapshot.type !== "snapshot" || snapshot.dialogKind !== "export") throw new Error("Missing Export snapshot");
    await hoverChainAtom(1);
    for (const key of "NMe") await labelKey(key);
    expect(labelEditor()?.value).toBe("NMe");
    expect(document.activeElement).toBe(labelEditor());
    // Preview already changes the working chemistry. Also require the flush's close
    // decision so this test catches exporting that preview without committing the draft.
    const finishDraft = vi.spyOn(atomLabelDraft, "restoreAtomLabelDraft");
    const options = { ...snapshot.data.options, format: "cdxml", filename: "label.cdxml" };
    native.savePicker.mockResolvedValueOnce("/tmp/label.cdxml");
    await pageSizeMessage("action", { action: "export", options });
    expect(finishDraft).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ draft: "NMe" }));
    await vi.waitFor(() => expect(native.writeFile).toHaveBeenCalledWith("/tmp/label.cdxml", expect.any(String)));
    const contents = native.writeFile.mock.calls.find(([path]) => path === "/tmp/label.cdxml")![1];
    await labelKey("Enter");
    expect(labelEditor()).toBeNull();
    const exported = openNativeDocument(contents).document;
    if (!exported) throw new Error("Exported atom-label document could not be reopened");
    const committed = bridge().snapshot().document;
    const molecule = (doc: typeof committed) => doc.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    expect(molecule(exported)).toEqual(molecule(committed));
    expect(contents).toContain("NMe");
  });

  it("Export reads its originating tab's current contents and writes unchanged SVG bytes once", async () => {
    await command("export.open"); await pageSizeMessage("ready", {});
    const snapshot = native.dialogSnapshot!;
    if (snapshot.type !== "snapshot" || snapshot.dialogKind !== "export") throw new Error("Missing Export snapshot");
    await paste("Edited while Export was open");
    const origin = bridge().snapshot().document;
    await command("document.new"); await paste("Other drawing");
    const options = { ...snapshot.data.options, format: "svg", filename: "drawing.svg", destinationPath: undefined };
    native.savePicker.mockResolvedValueOnce("/tmp/granted-without-extension");
    const action = { ...snapshot, type: "action", data: { action: "export", options }, requestId: "export-press" };
    await act(async () => {
      const delivery = { senderWindowId: "dialog-main-export-1", windowLabel: "dialog-main-export-1", message: action };
      native.dialogListener!(delivery); native.dialogListener!(delivery);
    });
    await vi.waitFor(() => expect(native.writeFile.mock.calls.filter(([path]) => path.startsWith("/tmp/"))).toHaveLength(1));
    expect(native.writeFile).toHaveBeenCalledWith("/tmp/granted-without-extension", exportPhase4Svg(origin, options.svg).contents);
    expect(active()).toBe(1);
    expect(native.dialogPublish).toHaveBeenCalledWith("opaque", expect.objectContaining({ data: expect.objectContaining({ status: "exported" }) }));
  });

  it("asks again after a chosen name or format changes, and sends write failures to Export", async () => {
    await command("export.open"); await pageSizeMessage("ready", {});
    const snapshot = native.dialogSnapshot!;
    if (snapshot.type !== "snapshot" || snapshot.dialogKind !== "export") throw new Error("Missing Export snapshot");
    const options = { ...snapshot.data.options, format: "svg", filename: "drawing.svg" };
    native.savePicker.mockResolvedValueOnce("/tmp/granted.svg");
    await pageSizeMessage("action", { action: "chooseDestination", options });
    native.savePicker.mockResolvedValueOnce("/tmp/new-grant.svg");
    native.writeFile.mockRejectedValueOnce(new Error("Disk full"));
    await pageSizeMessage("action", { action: "export", options: { ...options, filename: "renamed.svg", destinationPath: "/tmp/granted.svg" } });
    await vi.waitFor(() => expect(native.dialogPublish).toHaveBeenCalledWith("opaque", expect.objectContaining({ data: { status: "error", error: "Error: Disk full" } })));
    expect(native.savePicker).toHaveBeenCalledTimes(2);
    expect(native.writeFile).toHaveBeenCalledWith("/tmp/new-grant.svg", expect.any(String));
  });
  it("uses an unchanged destination grant directly, without another picker", async () => {
    await command("export.open"); await pageSizeMessage("ready", {});
    const snapshot = native.dialogSnapshot!;
    if (snapshot.type !== "snapshot" || snapshot.dialogKind !== "export") throw new Error("Missing Export snapshot");
    const options = { ...snapshot.data.options, format: "svg", filename: "drawing.svg" };
    native.savePicker.mockResolvedValueOnce("/tmp/exact-grant.svg");
    await pageSizeMessage("action", { action: "chooseDestination", options });
    await pageSizeMessage("action", { action: "export", options: { ...options, destinationPath: "/tmp/exact-grant.svg", filename: "exact-grant.svg" } });
    await vi.waitFor(() => expect(native.writeFile).toHaveBeenCalledWith("/tmp/exact-grant.svg", expect.any(String)));
    expect(native.savePicker).toHaveBeenCalledTimes(1);
  });

  it.each(["close", "replace"])("dismisses Export on originating document %s and rejects late submit", async kind => {
    await command("export.open"); await pageSizeMessage("ready", {});
    const snapshot = native.dialogSnapshot!;
    if (snapshot.type !== "snapshot" || snapshot.dialogKind !== "export") throw new Error("Missing Export snapshot");
    if (kind === "close") { await command("document.new"); await closeTab(0); }
    else await open("Replacement drawing");
    expect(native.dialogClose).toHaveBeenCalledWith("opaque", "ownerTabClose");
    await pageSizeMessage("action", { action: "export", options: { ...snapshot.data.options, format: "svg" } });
    expect(native.writeFile.mock.calls.filter(([path]) => path.startsWith("/tmp/"))).toHaveLength(0); expect(native.savePicker).not.toHaveBeenCalled();
  });

  it.each(["document.open", "document.save", "document.saveAs"])(
    "%s suspends the standalone document file panel until cancellation", async (commandId) => {
      native.suspendUtilities = true;
      await paste("Standalone panel suspension");
      const picker = commandId === "document.open" ? native.picker : native.savePicker;
      let finishPanel!: (path: string | null) => void;
      picker.mockImplementationOnce(() => new Promise((resolve) => { finishPanel = resolve; }));
      await command(commandId);
      await vi.waitFor(() => expect(finishPanel).toBeDefined());
      expect(native.suspensionDepth).toBe(1);
      expect(native.visibilityChanges).toEqual(["hide"]);
      await act(async () => finishPanel(null));
      await vi.waitFor(() => expect(native.suspensionDepth).toBe(0));
      expect(native.visibilityChanges).toEqual(["hide", "restore"]);
    }
  );

  it.each(["saved", "Don't Save", "Cancel", "panel cancelled then Cancel", "panel throws then Cancel"])(
    "balances suspension through the real tab-close flow: %s", async (ending) => {
      native.suspendUtilities = true;
      await paste("Close-chain suspension");
      await closeTab();
      expect(native.suspensionDepth).toBe(1);
      expect(native.visibilityChanges).toEqual(["hide"]);
      if (ending === "Cancel" || ending === "Don't Save") {
        await modalButton(ending);
      } else {
        let finishPanel!: (path: string | null) => void;
        let failPanel!: (error: Error) => void;
        native.savePicker.mockImplementationOnce(() => new Promise((resolve, reject) => {
          finishPanel = resolve; failPanel = reject;
        }));
        const saving = modalButton("Save");
        await vi.waitFor(() => expect(native.savePicker).toHaveBeenCalled());
        expect(native.suspensionDepth).toBe(2);
        expect(native.visibilityChanges).toEqual(["hide"]);
        await act(async () => {
          if (ending === "panel throws then Cancel") failPanel(new Error("panel unavailable"));
          else finishPanel(ending === "saved" ? "/tmp/suspended-save.chemdraft" : null);
        });
        await saving;
        if (ending !== "saved") {
          expect(pendingPrompt?.prompt.message).toContain(ending.startsWith("panel throws") ? "panel unavailable" : "Save canceled");
          expect(native.suspensionDepth).toBe(1);
          expect(native.visibilityChanges).toEqual(["hide"]);
          await modalButton("Cancel");
        }
      }
      await vi.waitFor(() => expect(native.suspensionDepth).toBe(0));
      expect(native.visibilityChanges).toEqual(["hide", "restore"]);
    }
  );

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

  async function mountForShortcutPlatform(platform: "macos" | "windows") {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform === "macos" ? "MacIntel" : "Win32");
    await remount();
  }
  async function closeWithShortcut(platform: "macos" | "windows") {
    await mountForShortcutPlatform(platform);
    const event = new KeyboardEvent("keydown", {
      key: "w", [platform === "macos" ? "metaKey" : "ctrlKey"]: true,
      bubbles: true, cancelable: true
    });
    await act(async () => window.dispatchEvent(event));
    return event;
  }

  it("Ctrl+W closes the only clean Windows drawing through the tab-close path", async () => {
    await mountForShortcutPlatform("windows");
    const closedTab = tabs()[0];
    const event = new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(tabs()[0]).not.toBe(closedTab);
    await expectPristineUntitled();
  });

  it("Ctrl+W prompts for the only dirty Windows drawing; Cancel retains it and Don't Save replaces it", async () => {
    await closeWithShortcut("windows");
    await paste("Windows drawing to close");
    const before = bridge().snapshot().document;
    const closedTab = tabs()[0];

    const cancelEvent = new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(cancelEvent));
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(pendingPrompt?.prompt.message).toContain("Save the changes to Untitled?");
    await modalButton("Cancel");
    expect(tabs()[0]).toBe(closedTab);
    expect(bridge().snapshot().document).toEqual(before);
    expect(bridge().snapshot().file.dirty).toBe(true);

    const discardEvent = new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(discardEvent));
    expect(discardEvent.defaultPrevented).toBe(true);
    await modalButton("Don't Save");
    expect(tabs()[0]).not.toBe(closedTab);
    await expectPristineUntitled();
  });

  it("Ctrl+W keeps the existing multi-tab close behavior on Windows", async () => {
    await closeWithShortcut("windows");
    await paste("First Windows drawing");
    const first = bridge().snapshot().document;
    await command("document.new");
    const secondTab = tabs()[1];

    const event = new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0]).not.toBe(secondTab);
    expect(bridge().snapshot().document).toEqual(first);
  });

  it("Cmd+W leaves the last macOS drawing to Close Window", async () => {
    await closeWithShortcut("macos");
    await paste("Retained by Close Window");
    const before = bridge().snapshot().document;
    const event = new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(pendingPrompt).toBeUndefined();
    expect(bridge().snapshot().document).toEqual(before);
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

  it("Ctrl+Tab and Ctrl+Shift+Tab cycle and wrap on both platforms", async () => {
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

  it("quit Save resolves a pending close prompt and saves dirty A and B by id", async () => {
    await paste("Dirty A");
    await command("document.new");
    await paste("Dirty B");
    await closeTab();
    saveAskToSaveBeforeQuit(true);
    native.savePicker.mockResolvedValueOnce("/tmp/quit-a.chemdraft").mockResolvedValueOnce("/tmp/quit-b.chemdraft");
    await flush();
    // The existing OS alert must actually resolve before the replacement quit modal appears.
    expect(native.promptShowing).not.toHaveBeenCalled();
    await modalButton("Cancel");
    expect(native.requestAfterClose).toHaveBeenCalledTimes(1);
    await quitButton("Save");
    const writes = native.writeFile.mock.calls.filter(([path]) => path.endsWith(".chemdraft"));
    expect(writes.map(([path]) => path)).toEqual(["/tmp/quit-a.chemdraft", "/tmp/quit-b.chemdraft"]);
    expect(writes[0]![1]).toContain("Dirty A");
    expect(writes[1]![1]).toContain("Dirty B");
    expect(native.quit).toHaveBeenCalledTimes(1);
  });

  it("late Cancel completion cannot close a newer quit prompt", async () => {
    await paste("Dirty drawing");
    saveAskToSaveBeforeQuit(true);
    await flush();
    let reply: (value: boolean) => void = () => {};
    native.cancelQuit.mockImplementationOnce(() => new Promise<boolean>((resolve) => { reply = resolve; }));
    await quitButton("Cancel");
    await flush();
    await act(async () => { reply(true); });
    expect(pendingPrompt?.prompt.title).toBe("Save changes before quitting?");
    expect(native.promptShowing).toHaveBeenLastCalledWith(2);
    expect(native.quit).not.toHaveBeenCalled();
  });

  it.each(["Save", "Discard"])("re-arms native grace before a stalled %s session write", async (choice) => {
    await paste("Dirty drawing");
    saveAskToSaveBeforeQuit(true);
    native.savePicker.mockResolvedValueOnce("/tmp/stall-save.chemdraft");
    await flush();
    let finish: () => void = () => {};
    native.saveSession.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await quitButton(choice);
    expect(native.resumeQuit).toHaveBeenCalledWith(1);
    expect(native.resumeQuit.mock.invocationCallOrder[0]).toBeLessThan(native.saveSession.mock.invocationCallOrder.at(-1)!);
    expect(native.quit).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(native.quit).toHaveBeenCalledTimes(1);
  });

  it("native quit modal suspension hides palettes and releases on Cancel", async () => {
    native.suspendUtilities = true;
    native.toolsetWindows.set("bonds", true);
    await paste("Dirty drawing");
    saveAskToSaveBeforeQuit(true);
    await flush();
    expect(native.visibilityChanges).toContain("hide");
    expect(native.toolsetWindows.get("bonds")).toBe(false);
    await quitButton("Cancel");
    expect(native.suspensionDepth).toBe(0);
    expect(native.toolsetWindows.get("bonds")).toBe(true);
  });

  it.each(["resume", "flush"])("blocks native edits after saving while %s IPC is pending", async (phase) => {
    await paste("Saved quit drawing");
    saveAskToSaveBeforeQuit(true);
    native.savePicker.mockResolvedValueOnce("/tmp/frozen-quit.chemdraft");
    await flush();
    let finish: () => void = () => {};
    if (phase === "resume") native.resumeQuit.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = () => resolve(true); }));
    else native.saveSession.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await quitButton("Save");
    const saved = bridge().snapshot().document;
    await command("edit.undo");
    expect(bridge().snapshot().document).toEqual(saved);
    expect(bridge().snapshot().file.dirty).toBe(false);
    expect(native.quit).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(native.quit).toHaveBeenCalledTimes(1);
  });

  it("Cancel consumes the native question while its reply is pending", async () => {
    await paste("Dirty drawing");
    saveAskToSaveBeforeQuit(true);
    await flush();
    let reply: (value: boolean) => void = () => {};
    native.cancelQuit.mockImplementationOnce(() => new Promise<boolean>((resolve) => { reply = resolve; }));
    await quitButton("Cancel");
    expect(pendingPrompt).toBeUndefined();
    expect(container.querySelector('[aria-labelledby="quit-prompt-title"]')).toBeNull();
    expect(native.writeFile.mock.calls.filter(([path]) => path.endsWith(".chemdraft"))).toHaveLength(0);
    await act(async () => { reply(true); });
  });

  it("failed native suspension never acknowledges the prompt and cancels its request", async () => {
    native.suspendUtilities = true;
    native.suspendFailure = true;
    await paste("Dirty drawing");
    saveAskToSaveBeforeQuit(true);
    await flush();
    expect(native.promptShowing).not.toHaveBeenCalled();
    expect(native.cancelQuit).toHaveBeenCalledWith(1);
    expect(native.suspensionDepth).toBe(0);
    expect(native.quit).not.toHaveBeenCalled();
  });

  it("opens only after utility suspension and releases it exactly once on Cancel", async () => {
    native.suspendUtilities = true;
    let finish: () => void = () => {};
    native.suspendPending = new Promise<void>((resolve) => { finish = resolve; });
    await paste("Dirty drawing");
    saveAskToSaveBeforeQuit(true);
    await flush();
    expect(pendingPrompt).toBeUndefined();
    expect(native.promptShowing).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(native.promptShowing).toHaveBeenCalledWith(1);
    await quitButton("Cancel");
    expect(native.visibilityChanges).toEqual(["hide", "restore"]);
    expect(native.suspensionDepth).toBe(0);
  });

  it("balances quit suspension and listeners under StrictMode", async () => {
    act(() => root!.unmount());
    root = undefined;
    native.suspendUtilities = true;
    await mount(createPhase4Document("Strict quit"), true);
    await paste("Dirty drawing");
    saveAskToSaveBeforeQuit(true);
    await flush();
    expect(native.suspensionDepth).toBeGreaterThan(0);
    await quitButton("Cancel");
    expect(native.suspensionDepth).toBe(0);
    expect(native.promptShowing).toHaveBeenCalledTimes(1);
  });

  it.each(["clipboard", "depiction", "identity", "list identity"])(
    "prevents an already-running %s paste from changing the saved quit snapshot", async (kind) => {
      await paste("Existing drawing");
      let finishPaste: () => void = () => {};
      if (kind === "clipboard") {
        native.clipboardPending = new Promise((resolve) => {
          finishPaste = () => resolve({ types: ["text/plain"],
            textItems: [{ type: "text/plain", text: "Late clipboard text" }] });
        });
        await command("clipboard.paste");
      } else {
        const parsed = await smilesListPaste.depictSmilesForPaste("CC");
        expect(parsed).toBeDefined();
        if (kind.includes("identity")) {
          const inspect = smilesPasteIdentity.createPasteIdentityInspector();
          const wait = new Promise<void>(resolve => { finishPaste = resolve; });
          if (kind === "list identity") {
            const original = smilesPasteIdentity.verifySmilesGridEntries;
            const entries = ["CC", "CC"].map(smiles => ({ smiles, depiction: parsed!.depiction }));
            vi.spyOn(smilesListPaste, "depictSmilesListForPaste")
              .mockReturnValueOnce(Promise.resolve({ entries, skipped: 0, skippedItems: [], failures: [] }));
            vi.spyOn(smilesPasteIdentity, "verifySmilesGridEntries").mockImplementationOnce(async entries => {
              await wait;
              return original(entries, inspect);
            });
          } else {
            const original = smilesPasteIdentity.verifySmilesPaste;
            vi.spyOn(smilesListPaste, "depictSmilesForPaste").mockResolvedValueOnce(parsed);
            vi.spyOn(smilesPasteIdentity, "verifySmilesPaste")
              .mockImplementationOnce(async (depiction, smiles) => {
                await wait;
                await original(depiction, smiles, inspect);
              });
          }
        } else {
          vi.spyOn(smilesListPaste, "depictSmilesForPaste")
            .mockImplementationOnce(() => new Promise((resolve) => {
              finishPaste = () => resolve(parsed);
            }));
        }
        await paste(kind === "list identity" ? "CC\nCC" : "CC");
      }
      saveAskToSaveBeforeQuit(true);
      native.savePicker.mockResolvedValueOnce("/tmp/async-quit.chemdraft");
      await flush();
      let finishFlush: () => void = () => {};
      native.saveSession.mockImplementationOnce(() =>
        new Promise<void>(resolve => { finishFlush = resolve; }));
      await quitButton("Save");
      const saved = bridge().snapshot().document;
      await act(async () => { finishPaste(); });
      if (kind.includes("identity")) {
        await vi.waitFor(() => {
          expect(container.querySelector('[role="status"]')?.textContent)
            .toBe("Paste cancelled while quitting");
        }, { timeout: 15_000 });
      }
      expect(bridge().snapshot().document).toEqual(saved);
      expect(bridge().snapshot().file.dirty).toBe(false);
      expect(native.quit).not.toHaveBeenCalled();
      await act(async () => { finishFlush(); });
      expect(native.quit).toHaveBeenCalledTimes(1);
  }, 20_000);

  it.each(["picker cancelled", "write failed"])("remains editable after quit Save is %s", async (failure) => {
    await paste("Existing drawing");
    saveAskToSaveBeforeQuit(true);
    if (failure === "write failed") {
      native.savePicker.mockResolvedValueOnce("/tmp/failing-quit.chemdraft");
      native.writeFile.mockRejectedValueOnce(new Error("Disk write refused"));
    }
    await flush();
    await quitButton("Save");
    expect(native.cancelQuit).toHaveBeenCalledWith(1);
    expect(container.querySelector('[aria-labelledby="quit-prompt-title"]')).toBeNull();
    await paste("Editable after cancelled quit");
    expect(drawnText()).toContain("Editable after cancelled quit");
    expect(bridge().snapshot().file.dirty).toBe(true);
    expect(native.quit).not.toHaveBeenCalled();
  });

  it("keeps the modal available if acknowledgement and cancel IPC both fail", async () => {
    await paste("Existing drawing");
    saveAskToSaveBeforeQuit(true);
    native.promptShowing.mockRejectedValueOnce(new Error("Acknowledgement reply lost"));
    native.cancelQuit.mockRejectedValueOnce(new Error("Cancel IPC unavailable"));
    await flush();
    expect(pendingPrompt?.prompt.title).toBe("Save changes before quitting?");
    await quitButton("Cancel");
    expect(container.querySelector('[aria-labelledby="quit-prompt-title"]')).toBeNull();
    expect(native.quit).not.toHaveBeenCalled();
  });

  it("opt-in quit with no changes flushes without a prompt", async () => {
    saveAskToSaveBeforeQuit(true);
    await flush();
    expect(native.quit).toHaveBeenCalledTimes(1);
    expect(native.promptShowing).not.toHaveBeenCalled();
  });

  it("uses the native quit question without rendering an in-window dialog", async () => {
    await paste("Dirty native prompt drawing");
    saveAskToSaveBeforeQuit(true);
    await flush();
    expect(pendingPrompt?.prompt).toMatchObject({
      title: "Save changes before quitting?", kind: "warning",
      choices: [
        { id: "save", label: "Save" },
        { id: "discard", label: "Don't Save", destructive: true },
        { id: "cancel", label: "Cancel", cancel: true }
      ]
    });
    expect(container.querySelector('[aria-labelledby="quit-prompt-title"]')).toBeNull();
    await quitButton("Cancel");
  });

  it("retains the accessible quit fallback when the native question cannot open", async () => {
    const restore = setNativePromptProvider((prompt, fallback) => fallback(prompt));
    try {
      await paste("Dirty fallback drawing");
      saveAskToSaveBeforeQuit(true);
      await flush();
      const dialog = container.querySelector('[role="dialog"][aria-modal="true"][aria-labelledby="quit-prompt-title"]')!;
      expect(dialog).not.toBeNull();
      expect(native.promptShowing).toHaveBeenCalledWith(1);
      const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!;
      await act(async () => cancel.click());
      expect(container.querySelector('[aria-labelledby="quit-prompt-title"]')).toBeNull();
      expect(native.quit).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it("opt-in quit prompts for a dirty background tab and Cancel keeps it open", async () => {
    await paste("Unsaved drawing");
    await command("document.new");
    saveAskToSaveBeforeQuit(true);
    await flush();
    expect(native.promptShowing).toHaveBeenCalledTimes(1);
    expect(native.quit).not.toHaveBeenCalled();
    await quitButton("Cancel");
    expect(native.cancelQuit).toHaveBeenCalledTimes(1);
    expect(native.quit).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-labelledby="quit-prompt-title"]')).toBeNull();
  });

  it("opt-in Discard flushes then quits", async () => {
    await paste("Unsaved drawing");
    saveAskToSaveBeforeQuit(true);
    await flush();
    await quitButton("Discard");
    expect(native.saveSession).toHaveBeenCalled();
    expect(native.quit).toHaveBeenCalledTimes(1);
  });

  it("opt-in Save writes every dirty tab before quitting", async () => {
    await paste("First unsaved drawing");
    await command("document.new");
    await paste("Second unsaved drawing");
    saveAskToSaveBeforeQuit(true);
    native.savePicker.mockResolvedValueOnce("/tmp/first-quit.chemdraft")
      .mockResolvedValueOnce("/tmp/second-quit.chemdraft");
    await flush();
    await quitButton("Save");
    expect(native.writeFile.mock.calls.map(([path]) => path).filter((path) => path.endsWith(".chemdraft"))).toEqual([
      "/tmp/first-quit.chemdraft", "/tmp/second-quit.chemdraft"
    ]);
    expect(native.quit).toHaveBeenCalledTimes(1);
    expect(native.cancelQuit).not.toHaveBeenCalled();
  });

  it("opt-in Save saves dirty tabs before quitting and picker cancellation stays open", async () => {
    await paste("Unsaved drawing");
    saveAskToSaveBeforeQuit(true);
    await flush();
    await quitButton("Save");
    expect(native.cancelQuit).toHaveBeenCalledTimes(1);
    expect(native.quit).not.toHaveBeenCalled();
    native.savePicker.mockResolvedValueOnce("/tmp/quit-drawing.chemdraft");
    await flush();
    await quitButton("Save");
    expect(native.writeFile).toHaveBeenCalled();
    expect(native.quit).toHaveBeenCalledTimes(1);
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

  it("retains modeless page-size editing and pending plugin proposals when activating another tab", async () => {
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
    expect(native.dialogSnapshot).toMatchObject({ dialogKind: "pageSize" });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await activate(0);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(native.dialogClose).not.toHaveBeenCalled();
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

  function sessionWithUnrestoredTabs(names = ["First.chemdraft", "Second.cdxml", "Third.chemdraft"]) {
    const session = threeTabSession();
    session.unrestoredTabs = names.map((displayName, index) => ({
      ...session.tabs![index % 3]!, displayName, contents: `unreadable raw document ${index}`,
      extraRecoveryData: { original: index }
    }));
    return session;
  }

  describe.each(["MacIntel", "Win32"])("kept drawings on %s", (platform) => {
    beforeEach(() => {
      vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
      native.suspendUtilities = true;
    });

    const expectSuspended = () => {
      expect(native.suspensionDepth).toBeGreaterThan(0);
      expect(native.visibilityChanges).toEqual(["hide"]);
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    };
    const expectReleased = () => {
      expect(native.suspensionDepth).toBe(0);
      expect(native.visibilityChanges).toEqual(["hide", "restore"]);
      expect(pendingPrompt).toBeUndefined();
    };

    const startupLayout = {
      version: 1, toolsetOrder: [], userToolsets: [],
      toolsetOverrides: ["core.main", "core.art", "core.structure"].map(toolsetId => ({ toolsetId, visible: true }))
    };

    it("waits for saved toolbar layout and native window creation before suspending for the launch box", async () => {
      vi.useFakeTimers();
      native.session = sessionWithUnrestoredTabs(["Kept.chemdraft"]);
      let finishLayout!: (value: unknown) => void;
      native.loadToolsetLayout.mockImplementationOnce(() => new Promise(resolve => { finishLayout = resolve; }));
      let finishArt!: () => void;
      const openNormally = native.openToolset.getMockImplementation()!;
      native.openToolset.mockImplementation(async (id) => {
        if (id === "core.art") await new Promise<void>(resolve => { finishArt = resolve; });
        return openNormally(id);
      });
      native.openToolset.mockClear();
      await remount();
      expect(tabs()).toHaveLength(3);
      expect(native.openToolset).not.toHaveBeenCalled();
      expect(pendingPrompt).toBeUndefined();
      expect(native.visibilityChanges).toEqual([]);
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });

      await act(async () => finishLayout(startupLayout));
      expect(native.openToolset).toHaveBeenCalledWith("core.main", expect.anything());
      expect(native.openToolset).toHaveBeenCalledWith("core.art", expect.anything());
      expect(pendingPrompt).toBeUndefined();
      expect(native.suspensionDepth).toBe(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });

      await act(async () => finishArt());
      expect(native.openToolset).toHaveBeenCalledWith("core.structure", expect.anything());
      expect(pendingPrompt?.prompt.title).toBe("1 drawing didn't open");
      expect(pendingPrompt?.prompt.message).toMatch(/^Its drawing is kept,/);
      expect(pendingPrompt?.prompt.message).not.toContain("1 drawing didn't open");
      expectSuspended();
      for (const { toolsetId } of startupLayout.toolsetOverrides) {
        expect(native.toolsetWindows.has(toolsetId)).toBe(true);
        expect(native.toolsetWindows.get(toolsetId)).toBe(false);
      }
      // Installed plugins can finish loading after the launch box has appeared. The catalog
      // refresh must not mistake the deliberately hidden windows for creation failures.
      const currentRuntime = vi.mocked(createPluginRuntime).mock.results.at(-1)!.value as DesktopPluginRuntime;
      native.openToolset.mockClear();
      await act(async () => currentRuntime.registerPlugin({
        id: "org.test.late-startup", name: "Late startup plugin", version: "0.0.1", apiVersion: "^0.1.6",
        entry: "dist/plugin.js", permissions: [], contributes: { commands: [] }
      }));
      // Keeping the box open beyond the old retry window must never activate the web fallback.
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(native.openToolset).not.toHaveBeenCalled();
      expect(container.querySelector(".native-shell")).not.toBeNull();
      expect(container.querySelector('[role="status"]')?.textContent).not.toContain("unavailable");
      await modalButton("Cancel");
      expectReleased();
      for (const { toolsetId } of startupLayout.toolsetOverrides) {
        expect(native.toolsetWindows.get(toolsetId)).toBe(true);
      }
      expect(container.querySelector(".native-shell")).not.toBeNull();
    });

    it("still falls back on genuine creation failure before showing the launch box", async () => {
      vi.useFakeTimers();
      native.session = sessionWithUnrestoredTabs(["Kept.chemdraft"]);
      native.loadToolsetLayout.mockResolvedValue(startupLayout);
      native.openToolset.mockRejectedValue(new Error("native window creation failed"));
      native.openToolset.mockClear();
      await remount();
      expect(pendingPrompt).toBeUndefined();
      expect(native.suspensionDepth).toBe(0);
      // Each retry uses the real reconciler, including its delay and failure verdict.
      for (let attempt = 0; attempt < 3; attempt++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(220); });
      }
      expect(native.openToolset.mock.calls.filter(([id]) => id === "core.main")).toHaveLength(3);
      expect(container.querySelector(".web-shell")).not.toBeNull();
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Native toolset windows unavailable; using in-window toolbars");
      expect(pendingPrompt?.prompt.title).toBe("1 drawing didn't open");
      expectSuspended();
      await modalButton("Cancel");
      expectReleased();
    });

    it.each(["layout", "list", "open"])("bounds a never-resolving %s load/IPC without blocking commands or queued opens", async (stalled) => {
      vi.useFakeTimers();
      native.session = sessionWithUnrestoredTabs(["Kept.chemdraft"]);
      native.loadToolsetLayout.mockResolvedValue(startupLayout);
      if (stalled === "layout") native.loadToolsetLayout.mockImplementationOnce(() => new Promise(() => {}));
      if (stalled === "list") native.listToolsets.mockImplementation(() => new Promise(() => {}));
      if (stalled === "open") native.openToolset.mockImplementation(() => new Promise(() => {}));
      await remount();
      await act(async () => native.events.get("chemdraft://open-document")!({
        path: "/tmp/incoming.chemdraft", displayName: "incoming.chemdraft", contents: fileContents("Incoming drawing")
      }));
      await command("document.new");
      expect(tabs()).toHaveLength(3);
      await act(async () => { await vi.advanceTimersByTimeAsync(999); });
      expect(pendingPrompt).toBeUndefined();
      expect(native.suspensionDepth).toBe(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(pendingPrompt?.prompt.title).toBe("1 drawing didn't open");
      expectSuspended();
      // Timeout alone cannot establish that native windows are genuinely unavailable.
      expect(container.querySelector(".native-shell")).not.toBeNull();
      await modalButton("Cancel");
      expectReleased();
      expect(tabs()).toHaveLength(4);
      expect(bridge().snapshot().document.title).toBe("Incoming drawing");
      await command("document.new");
      expect(tabs()).toHaveLength(5);
    });

    it.each(["layout", "list", "reconciliation"])("opens the box and applies fallback when %s rejects", async (rejected) => {
      vi.useFakeTimers();
      native.session = sessionWithUnrestoredTabs(["Kept.chemdraft"]);
      native.loadToolsetLayout.mockResolvedValue(startupLayout);
      if (rejected === "layout") native.loadToolsetLayout.mockRejectedValueOnce(new Error("layout read failed"));
      else if (rejected === "list") native.listToolsets.mockRejectedValue(new Error("list IPC failed"));
      else vi.spyOn(nativePaletteReconciliation, "reconcileNativePaletteWindows")
        .mockRejectedValueOnce(new Error("reconciliation failed"));
      await remount();
      // IPC rejections take the existing three-attempt path; a layout rejection settles directly.
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(container.querySelector(".web-shell")).not.toBeNull();
      expect(pendingPrompt?.prompt.title).toBe("1 drawing didn't open");
      expectSuspended();
      await modalButton("Cancel");
      expectReleased();
      await command("document.new");
      expect(tabs()).toHaveLength(4);
    });

    it.each([
      ["layout", false], ["open", false], ["layout", true], ["open", true]
    ] as const)("handles late %s completion without a second box or false fallback (dismissed: %s)", async (late, dismissed) => {
      vi.useFakeTimers();
      native.session = sessionWithUnrestoredTabs(["Kept.chemdraft"]);
      native.loadToolsetLayout.mockResolvedValue(startupLayout);
      let finish!: () => void;
      if (late === "layout") {
        native.loadToolsetLayout.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(startupLayout); }));
      } else {
        const openNormally = native.openToolset.getMockImplementation()!;
        native.openToolset.mockImplementationOnce(async (id) => {
          await new Promise<void>(resolve => { finish = resolve; });
          return openNormally(id);
        });
      }
      await remount();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      const firstPrompt = pendingPrompt;
      expect(firstPrompt).toBeDefined();
      expectSuspended();
      if (dismissed) await modalButton("Cancel");
      native.openToolset.mockClear();
      await act(async () => finish());
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      if (!dismissed) {
        // Finishing under suspension must defer the rest of creation until the box is dismissed.
        expect(pendingPrompt).toBe(firstPrompt);
        expect(native.openToolset).not.toHaveBeenCalled();
        await modalButton("Cancel");
      }
      expect(container.querySelector(".native-shell")).not.toBeNull();
      expectReleased();
      for (const { toolsetId } of startupLayout.toolsetOverrides) {
        expect(native.toolsetWindows.get(toolsetId)).toBe(true);
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(pendingPrompt).toBeUndefined();
      expect(container.querySelector(".native-shell")).not.toBeNull();
    });

    function unsupportedChildrenSession() {
      const session = threeTabSession();
      return { ...session, tabs: session.tabs!.map((tab, index) => ({
        ...tab, version: 99, contents: `${tab.contents}\r\n\t `,
        extraRecoveryData: { original: index, label: "α 🧪" }
      })) };
    }

    it("offers every version-99 child, keeps them after Cancel and relaunch, and autosaves new work", async () => {
      const raw = unsupportedChildrenSession();
      native.session = raw;
      await remount();
      expect(tabs()).toHaveLength(1);
      expect(bridge().snapshot().page.objectCount).toBe(0);
      expect(bridge().snapshot().file).toEqual({ dirty: false });
      expect(pendingPrompt?.prompt.title).toBe("3 drawings didn't open");
      for (const tab of raw.tabs) expect(pendingPrompt?.prompt.message).toContain(tab.displayName);
      expectSuspended();
      expect((await flush()).unrestoredTabs).toEqual(raw.tabs);
      await modalButton("Cancel");
      expectReleased();
      native.saveSession.mockClear();
      await paste("Fresh work after unreadable children");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
      expect(native.saveSession).toHaveBeenCalled();
      const autosaved = parseDocumentSessionEnvelope(native.session)!;
      expect(autosaved.unrestoredTabs).toEqual(raw.tabs);
      expect(autosaved.tabs![0]!.contents).toContain("Fresh work after unreadable children");
      native.visibilityChanges = [];
      await remount();
      expect(pendingPrompt?.prompt.title).toBe("3 drawings didn't open");
      expect(drawnText()).toContain("Fresh work after unreadable children");
      expect((await flush()).unrestoredTabs).toEqual(raw.tabs);
      await modalButton("Cancel");
      expectReleased();
    });

    it("saves the original contents of every version-99 child without reserializing them", async () => {
      const raw = unsupportedChildrenSession();
      native.session = raw;
      await remount();
      expect(pendingPrompt?.prompt.title).toBe("3 drawings didn't open");
      const paths = raw.tabs.map((_, index) => platform === "Win32"
        ? `C:\\rescued\\drawing-${index}.chemdraft` : `/tmp/drawing-${index}.chemdraft`);
      for (const path of paths) native.savePicker.mockResolvedValueOnce(path);
      native.writeFile.mockClear();
      await modalButton("Save Drawing…");
      expect(native.writeFile).toHaveBeenCalledTimes(3);
      raw.tabs.forEach((tab, index) => {
        expect(native.writeFile).toHaveBeenNthCalledWith(index + 1, paths[index], tab.contents);
      });
      expectReleased();
      expect((await flush()).unrestoredTabs).toBeUndefined();
      expect(tabs()).toHaveLength(1);
      await remount();
      expect(pendingPrompt).toBeUndefined();
    });

    it("restores readable siblings while offering unsupported and malformed child envelopes", async () => {
      const session = threeTabSession();
      const unreadable = [
        { ...session.tabs![0]!, version: 99, extraRecoveryData: { original: true } },
        { ...session.tabs![2]!, dirty: "unknown", extraRecoveryData: { original: false } }
      ];
      native.session = { ...session, tabs: [unreadable[0], session.tabs![1], unreadable[1]] };
      await remount();
      expect(tabs()).toHaveLength(1);
      expect(bridge().snapshot().document.title).toBe("Second");
      expect(pendingPrompt?.prompt.title).toBe("2 drawings didn't open");
      expect((await flush()).unrestoredTabs).toEqual(unreadable);
      await modalButton("Cancel");
      expectReleased();
    });

    it.each([false, true])("includes existing kept tabs with new unreadable children (readable sibling: %s)", async (readableSibling) => {
      const raw = unsupportedChildrenSession();
      const readable = threeTabSession().tabs![1]!;
      const children = readableSibling ? [raw.tabs[0], readable, raw.tabs[2]] : raw.tabs;
      const alreadyKept = { version: 99, displayName: "Previously kept", contents: "original\r\nα 🧪" };
      const recoverable = { ...readable, contents: fileContents("Previously kept, now readable") };
      native.session = { ...raw, tabs: children, unrestoredTabs: [alreadyKept, recoverable] };
      await remount();
      expect(tabs()).toHaveLength(readableSibling ? 2 : 1);
      expect(pendingPrompt?.prompt.title).toBe(`${readableSibling ? 3 : 4} drawings didn't open`);
      expect(pendingPrompt?.prompt.message).toContain("Previously kept");
      const expectedKept = [alreadyKept, ...children.filter(tab => tab.version === 99)];
      expect((await flush()).unrestoredTabs).toEqual(expectedKept);
      await modalButton("Cancel");
      expectReleased();
      await activate(readableSibling ? 1 : 0);
      expect(bridge().snapshot().document.title).toBe("Previously kept, now readable");
    });

    it("offers malformed children even when no child envelope is readable", async () => {
      const session = threeTabSession();
      const children = session.tabs!.map(tab => ({ ...tab, dirty: "unknown" }));
      native.session = { ...session, tabs: children };
      await remount();
      expect(tabs()).toHaveLength(1);
      expect(pendingPrompt?.prompt.title).toBe("3 drawings didn't open");
      expect((await flush()).unrestoredTabs).toEqual(children);
      await modalButton("Cancel");
      expectReleased();
    });

    it.each(["unknown outer version", "bad JSON"])("leaves the raw file and autosave gate unchanged for %s", async (failure) => {
      const raw = failure === "bad JSON" ? "{bad JSON" : { ...unsupportedChildrenSession(), version: 99,
        unrestoredTabs: [{ version: 99, contents: "previously kept" }] };
      native.session = raw;
      if (failure === "bad JSON") {
        // The native load rejects invalid JSON before any envelope reaches MainWindow.
        native.load.mockImplementationOnce(async () => JSON.parse(raw as string));
      }
      await remount();
      expect(pendingPrompt).toBeUndefined();
      expect(native.visibilityChanges).toEqual([]);
      expect(container.querySelector('[role="status"]')?.textContent).toContain("will not be autosaved");
      native.saveSession.mockClear();
      await paste("Drawing after unreadable outer session");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
      await flush();
      expect(native.saveSession).not.toHaveBeenCalled();
      expect(native.session).toEqual(raw);
    });

    it.each(["Cancel", "Escape"])("keeps raw drawings and retries next launch after %s", async (ending) => {
      const session = sessionWithUnrestoredTabs(["Still unreadable.chemdraft"]);
      native.session = session;
      for (let launch = 0; launch < 2; launch += 1) {
        native.visibilityChanges = [];
        vi.mocked(openNativeDocument).mockClear();
        await remount();
        expect(openNativeDocument).toHaveBeenCalledWith("unreadable raw document 0");
        expect(tabs()).toHaveLength(3);
        expect(pendingPrompt?.prompt).toMatchObject({
          title: "1 drawing didn't open", kind: "warning",
          choices: [{ id: "save", label: "Save Drawing…" }, { id: "delete", label: "Delete", destructive: true },
            { id: "cancel", label: "Cancel", cancel: true }]
        });
        expect(pendingPrompt?.prompt.message).toContain("Still unreadable.chemdraft");
        expect(pendingPrompt?.prompt.message).toMatch(/^Its drawing is kept,/);
        expect(pendingPrompt?.prompt.message).not.toContain("1 drawing didn't open");
        expect(pendingPrompt?.prompt.message).toContain("Cancel keeps the drawings for the next launch.");
        expectSuspended();
        // The native layer returns the Cancel choice for Escape; its literal-label mapping is
        // also tested at the plugin message boundary in nativePrompt.test.ts.
        if (ending === "Escape") {
          const resolve = pendingPrompt!.resolve;
          const cancel = pendingPrompt!.prompt.choices.find(choice => choice.cancel)!;
          pendingPrompt = undefined;
          await act(async () => resolve(cancel.id));
        } else await modalButton("Cancel");
        expectReleased();
        await command("view.zoomIn");
        expect((await flush()).unrestoredTabs).toEqual(session.unrestoredTabs);
      }
    });

    it("retries carried tabs and restores drawings that are now readable", async () => {
      const session = threeTabSession();
      const recovered = { ...session.tabs![0]!, displayName: "Recovered.chemdraft", contents: fileContents("Recovered") };
      session.unrestoredTabs = [recovered];
      native.session = session;
      await remount();
      expect(openNativeDocument).toHaveBeenCalledWith(recovered.contents);
      expect(tabs()).toHaveLength(4);
      expect(active()).toBe(1);
      expect(pendingPrompt).toBeUndefined();
      await activate(3);
      expect(bridge().snapshot().document.title).toBe("Recovered");
      expect((await flush()).unrestoredTabs).toBeUndefined();
      await remount();
      expect(tabs()).toHaveLength(4);
    });

    it("keeps a future schema unchanged and opens it after its schema becomes readable", async () => {
      const drawing = createPhase4Document("Future drawing");
      const session = threeTabSession();
      session.tabs![1] = { ...session.tabs![1]!, displayName: "Future.chemdraft",
        contents: JSON.stringify({ ...drawing, schema: "chemdraft.document.v999" }) };
      native.session = session;
      await remount();
      expect(tabs()).toHaveLength(2);
      expect(pendingPrompt?.prompt.message).toContain("Future.chemdraft");
      expect(pendingPrompt?.prompt.message).toContain("saved by a newer ChemDraft");
      await modalButton("Cancel");
      const saved = await flush();
      expect(saved.unrestoredTabs).toEqual([session.tabs![1]]);
      saved.unrestoredTabs = [{ ...session.tabs![1]!, contents: JSON.stringify(drawing) }];
      native.session = saved;
      await remount();
      expect(tabs()).toHaveLength(3);
      expect(pendingPrompt).toBeUndefined();
      await activate(2);
      expect(bridge().snapshot().document.title).toBe("Future drawing");
      expect((await flush()).unrestoredTabs).toBeUndefined();
    });

    it("saves an unsupported envelope's exact text to the chosen path unchanged", async () => {
      const session = sessionWithUnrestoredTabs(["Recovered.chemdraft"]);
      session.unrestoredTabs = [{ version: 99, displayName: "Recovered.chemdraft", contents: "future saved format" }];
      native.session = session;
      await remount();
      native.writeFile.mockClear();
      native.savePicker.mockResolvedValueOnce(platform === "Win32" ? "C:\\rescued\\chosen-name" : "/tmp/chosen-name");
      native.writeFile.mockImplementationOnce(async () => { expectSuspended(); });
      await modalButton("Save Drawing…");
      expect(native.writeFile).toHaveBeenCalledExactlyOnceWith(
        platform === "Win32" ? "C:\\rescued\\chosen-name" : "/tmp/chosen-name", "future saved format");
      expectReleased();
      expect((await flush()).unrestoredTabs).toBeUndefined();
      await activate(2);
      expect(container.querySelector('[role="status"]')?.textContent).not.toContain("kept for later");
      await remount();
      expect(pendingPrompt).toBeUndefined();
    });

    it("saves several raw drawings individually and removes only successful writes", async () => {
      const session = sessionWithUnrestoredTabs();
      native.session = session;
      await remount();
      expect(pendingPrompt?.prompt.title).toBe("3 drawings didn't open");
      native.writeFile.mockClear();
      native.savePicker.mockResolvedValueOnce("C:\\rescued\\First.chemdraft")
        .mockResolvedValueOnce("C:\\rescued\\Second.cdxml").mockResolvedValueOnce("C:\\rescued\\Third.chemdraft");
      native.writeFile.mockResolvedValueOnce().mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce();
      await modalButton("Save Drawing…");
      expect(native.savePicker).toHaveBeenNthCalledWith(1, {
        title: "Save Drawing — First.chemdraft", defaultPath: "First.chemdraft",
        filters: [{ name: "Saved document", extensions: ["chemdraft"] }]
      });
      expect(native.savePicker).toHaveBeenNthCalledWith(2, expect.objectContaining({
        defaultPath: "Second.cdxml", filters: [{ name: "Saved document", extensions: ["cdxml"] }]
      }));
      expect(native.writeFile).toHaveBeenNthCalledWith(1, "C:\\rescued\\First.chemdraft", "unreadable raw document 0");
      expect(native.writeFile).toHaveBeenNthCalledWith(2, "C:\\rescued\\Second.cdxml", "unreadable raw document 1");
      expect((await flush()).unrestoredTabs).toEqual([session.unrestoredTabs![1]]);
      expect(pendingPrompt?.prompt.message).toContain("Second.cdxml: disk full");
      expect(pendingPrompt?.prompt.title).toBe("1 drawing didn't open");
      expectSuspended();
      await modalButton("Cancel");
      expectReleased();
      await remount();
      expect((await flush()).unrestoredTabs).toEqual([session.unrestoredTabs![1]]);
      expect(pendingPrompt).toBeDefined();
    });

    it.each([0, 1])("keeps pending, canceled and unattempted drawings (saved before cancellation: %s)", async (saved) => {
      const session = sessionWithUnrestoredTabs();
      native.session = session;
      await remount();
      let finishWrite!: () => void;
      native.writeFile.mockClear();
      if (saved) {
        native.savePicker.mockResolvedValueOnce("/tmp/rescued.chemdraft").mockResolvedValueOnce(null);
        native.writeFile.mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve; }));
      }
      await modalButton("Save Drawing…");
      if (saved) {
        expect((await flush()).unrestoredTabs).toEqual(session.unrestoredTabs);
        expectSuspended();
        await command("document.new");
        expect(tabs()).toHaveLength(3);
        await act(async () => finishWrite());
      }
      expect(native.writeFile).toHaveBeenCalledTimes(saved);
      expect((await flush()).unrestoredTabs).toEqual(session.unrestoredTabs!.slice(saved));
      expect(pendingPrompt?.prompt.message).toContain(`Saved ${saved} ${saved === 1 ? "drawing" : "drawings"}; ${3 - saved} kept for later (save canceled)`);
      expectSuspended();
      await modalButton("Cancel");
      expectReleased();
    });

    it.each(["Delete", "Cancel", "Escape"])("requires a second native confirmation before deleting (%s)", async (ending) => {
      const session = sessionWithUnrestoredTabs(["Alpha.chemdraft", "Beta.chemdraft"]);
      native.session = session;
      await remount();
      await modalButton("Delete");
      expect(pendingPrompt?.prompt).toMatchObject({
        title: "Delete the kept drawing?", kind: "warning",
        choices: [{ id: "delete", label: "Delete", destructive: true }, { id: "cancel", label: "Cancel", cancel: true }]
      });
      expect(pendingPrompt?.prompt.message).toContain("This cannot be undone.");
      expect(pendingPrompt?.prompt.message).toContain("Alpha.chemdraft");
      expect(pendingPrompt?.prompt.message).toContain("Beta.chemdraft");
      expect((await flush()).unrestoredTabs).toEqual(session.unrestoredTabs);
      expectSuspended();
      await modalButton(ending === "Escape" ? "Cancel" : ending);
      const confirmed = ending === "Delete";
      expect((await flush()).unrestoredTabs).toEqual(confirmed ? undefined : session.unrestoredTabs);
      if (!confirmed) {
        expect(pendingPrompt?.prompt.title).toBe("2 drawings didn't open");
        expectSuspended();
        await modalButton("Cancel");
      }
      expectReleased();
      await activate(2);
      expect(container.querySelector('[role="status"]')?.textContent.includes("kept for later")).toBe(!confirmed);
      await remount();
      expect((await flush()).unrestoredTabs).toEqual(confirmed ? undefined : session.unrestoredTabs);
      expect(pendingPrompt === undefined).toBe(confirmed);
    });

    it("returns to the native prompt after a save panel fails", async () => {
      const session = sessionWithUnrestoredTabs(["Kept.chemdraft"]);
      native.session = session;
      await remount();
      native.savePicker.mockRejectedValueOnce(new Error("panel failed"));
      await modalButton("Save Drawing…");
      expect(pendingPrompt?.prompt.message).toContain("Kept.chemdraft: panel failed");
      expect((await flush()).unrestoredTabs).toEqual(session.unrestoredTabs);
      expectSuspended();
      await modalButton("Cancel");
      expectReleased();
    });

    it("keeps drawings without an in-app fallback when native prompting fails", async () => {
      const session = sessionWithUnrestoredTabs();
      native.session = session;
      const restoreFailureProvider = setNativePromptProvider(async (prompt, fallback) => fallback(prompt));
      try {
        await remount();
        expectReleased();
        expect(container.querySelector('[role="dialog"]')).toBeNull();
        expect((await flush()).unrestoredTabs).toEqual(session.unrestoredTabs);
      } finally { restoreFailureProvider(); }
    });

    it("retains kept drawings when persisting confirmed deletion fails", async () => {
      const session = sessionWithUnrestoredTabs();
      native.session = session;
      await remount();
      await modalButton("Delete");
      native.saveSession.mockRejectedValueOnce(new Error("session write refused"));
      await modalButton("Delete");
      expect(pendingPrompt?.prompt.message).toContain("Delete failed; the drawings are kept for later: session write refused");
      expect((await flush()).unrestoredTabs).toEqual(session.unrestoredTabs);
      expectSuspended();
      await modalButton("Cancel");
      expectReleased();
    });

    it("carries every raw tab when all document payloads fail", async () => {
      const raw = { ...threeTabSession(), tabs: threeTabSession().tabs!.map(tab => ({ ...tab, contents: "corrupt" })) };
      native.session = raw;
      await remount();
      expect(tabs()).toHaveLength(1);
      expect(pendingPrompt?.prompt.title).toBe("3 drawings didn't open");
      expect((await flush()).unrestoredTabs).toEqual(raw.tabs);
      await modalButton("Delete");
      await modalButton("Delete");
      expect((await flush()).unrestoredTabs).toBeUndefined();
      expectReleased();
    });

    it("queues OS open-with until the launch prompt ends", async () => {
      native.session = sessionWithUnrestoredTabs();
      await remount();
      await act(async () => native.events.get("chemdraft://open-document")!({
        path: "/tmp/incoming.chemdraft", displayName: "incoming.chemdraft", contents: fileContents("Incoming drawing")
      }));
      expect(tabs()).toHaveLength(3);
      await modalButton("Cancel");
      expect(tabs()).toHaveLength(4);
      expect(bridge().snapshot().document.title).toBe("Incoming drawing");
    });

    it("does not register retired menu commands or prompt on a clean launch", async () => {
      await remount();
      expect(pendingPrompt).toBeUndefined();
      for (const id of ["document.saveUnrestoredTabs", "document.discardUnrestoredTabs"]) {
        expect(runtime().host.commands.has(id)).toBe(false);
      }
      expect(native.savePicker).not.toHaveBeenCalled();
    });
  });

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
    expect(container.querySelector('[role="status"]')?.textContent).toContain("1 drawing is kept for later");
    const saved = await flush();
    expect(saved.unrestoredTabs).toEqual([corrupt]);
    expect(saved.tabs!.map((tab) => tab.displayName)).toEqual(["First.chemdraft", "Third.chemdraft"]);
    await remount();
    expect(tabs()).toHaveLength(2);
    await command("view.zoomIn");
    expect((await flush()).unrestoredTabs).toEqual([corrupt]);
  });

  it("never overwrites a wholly unreadable session envelope", async () => {
    const raw = { version: 99, recoverMe: true };
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
