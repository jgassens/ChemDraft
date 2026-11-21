// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { createPhase4Document } from "../documentWorkflow";
import type { PerfProbe } from "./probe";
import { nativeMoleculeRings } from "@chemdraft/layout-engine";
import { insertNativeTemplateMolecule } from "../documentWorkflow";

const sourceStamp = readFileSync("apps/desktop/src/MainWindow.tsx", "utf8")
  .match(/^const CURRENT_BUILD_STAMP = "([^"]+)";$/m)![1];

const native = vi.hoisted(() => ({ desktop: true, runtime: undefined as import("../plugins/createPluginRuntime").DesktopPluginRuntime | undefined, panelOpen: vi.fn(), analysisPublish: vi.fn(), reportPublish: vi.fn(), invoke: vi.fn(), open: vi.fn(), close: vi.fn(), windows: new Set<string>(),
  content: undefined as ((payload: import("../window-manager").ToolsetPopoverContentPayload) => void) | undefined,
  dismiss: undefined as (() => void) | undefined, showPopover: vi.fn(), hidePopover: vi.fn(),
  snapshot: undefined as import("../dialogs/dialogProtocol").DialogMessage | undefined,
  receive: undefined as ((delivery: import("../dialogs/dialogTransport").DialogDelivery) => void) | undefined,
  publish: vi.fn(), writeText: vi.fn(), writeFile: vi.fn(), stat: vi.fn(), fileOpen: vi.fn(), fileRead: vi.fn(), fileClose: vi.fn(), pickOpen: vi.fn(), pickSave: vi.fn(),
  loadToolbarLayout: vi.fn(async (): Promise<unknown> => undefined),
  saveToolbarLayout: vi.fn(async () => {})
}));
vi.mock("../dialogs/dialogTransport", () => ({ nativeDialogTransport: {
  subscribe: async (receive: typeof native.receive) => { native.receive = receive; return () => {}; },
  open: async (snapshot: NonNullable<typeof native.snapshot>) => { native.snapshot = snapshot; return { hostId: "export-host", windowLabel: "dialog-main-export-1" }; },
  publish: native.publish, close: async () => {}
} }));
vi.mock("@tauri-apps/plugin-fs", async original => ({ ...await original<typeof import("@tauri-apps/plugin-fs")>(), stat: native.stat, open: native.fileOpen, writeTextFile: native.writeText, writeFile: native.writeFile }));
vi.mock("../nativeFileDialog", () => ({ prewarmNativeFileDialogs: async () => ({}), open: native.pickOpen, save: native.pickSave }));
vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: native.invoke, isTauri: () => false }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: native.hidePopover }) }));
vi.mock("../window-manager", async original => ({
  ...await original<typeof import("../window-manager")>(), isDesktopRuntime: () => native.desktop,
  openToolsetWindow: native.open, closeToolsetWindow: native.close,
  listenForToolsetPopoverContent: async (handler: typeof native.content) => { native.content = handler; return () => {}; },
  listenForToolsetPopoverDismiss: async (handler: typeof native.dismiss) => { native.dismiss = handler; return () => {}; },
  listenForToolsetTextStyle: async () => () => {}, requestToolsetPopoverContent: async () => {}, requestToolsetTextStyle: async () => {},
  setCurrentWindowLogicalPosition: async () => {}, setCurrentWindowLogicalSize: async () => {},
  isToolsetPopoverVisible: async () => true,
  showCurrentToolsetPopoverWindow: native.showPopover,
  sendPaletteCommand: async (commandId: string) => {
    window.dispatchEvent(new CustomEvent("chemdraft:native-command", { detail: { commandId } }));
  },
  loadDocumentSession: async () => undefined, saveDocumentSession: async () => {},
  loadToolsetLayoutState: native.loadToolbarLayout, saveToolsetLayoutState: native.saveToolbarLayout,
  listToolsetWindowStates: async () => [],
  setToolbarsMenu: async () => {}, setQuitPromptEnabled: async () => {},
  listenForQuitFlushRequest: async () => () => {}, listenForQuitPromptRequest: async () => () => {}, listenForQuitSettings: async () => () => {}
}));
vi.mock("../window-manager/tauriEvents", async original => ({
  ...await original<typeof import("../window-manager/tauriEvents")>(),
  listenTauriEvent: async () => () => {}, listenCurrentWindowEvent: async () => () => {}
}));
vi.mock("../plugins/panelBridge", async original => ({
  ...await original<typeof import("../plugins/panelBridge")>(),
  openPluginPanelWindow: native.panelOpen, broadcastAnalysisWindowSnapshot: native.analysisPublish,
  broadcastPluginPanelReport: native.reportPublish
}));
vi.mock("../plugins/createPluginRuntime", async original => {
  const actual = await original<typeof import("../plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: import("../plugins/createPluginRuntime").DesktopPluginRuntimeOptions) => {
    native.runtime = actual.createPluginRuntime({ ...options, defaultPanelSurface: "window" });
    return native.runtime;
  } };
});
let root: Root | undefined, container: HTMLDivElement, paletteRoot: Root | undefined, paletteContainer: HTMLDivElement;
let runtime: typeof import("./runtime");
// Keep the cold MainWindow transform out of the first test's timeout. A timed-out
// mount keeps running and can overlap the next test's act scope and shared root.
// mount still resets modules so every test gets its own runtime and probe state.
beforeAll(async () => { await import("../MainWindow"); });
afterEach(() => {
  act(() => root?.unmount()); root = undefined; container?.remove();
  act(() => paletteRoot?.unmount()); paletteRoot = undefined; paletteContainer?.remove();
  runtime?.perfProbe?.stop(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  native.loadToolbarLayout.mockReset();
});
type Case = { action: string; method: keyof PerfProbe; hide?: boolean; forwarded?: boolean; second?: boolean; web?: boolean; inline?: boolean; failed?: boolean };
const cases: Case[] = [
  ...(["expectSignal", "nativeWindowStarted", "timestamp", "nativeWindowShown", "complete"] as const)
    .map(method => ({ action: "analyze.molecularProperties", method })),
  ...(["expectSignal", "nativeWindowStarted", "timestamp", "nativeWindowShown", "registryExpected"] as const)
    .map(method => ({ action: "plugin.perfTest.open", method })),
  ...(["expectSignal", "complete"] as const).map(method => ({ action: "view.togglePreferences", method, web: true })),
  { action: "view.toggleDrawnStructureSettings", method: "complete", inline: true },
  ...["view.togglePreferences", "view.toggle3dDebugger"].map(action => ({ action, method: "complete" as const, failed: true })),
  ...["view.togglePreferences", "view.toggle3dDebugger"].flatMap(action => [
    ...(["expectSignal", "nativeWindowStarted", "timestamp", "nativeWindowShown"] as const).map(method => ({ action, method })),
    ...(["expectSignal", "complete"] as const).map(method => ({ action, method, hide: true }))
  ]),
  ...(["expectSignal", "nativeWindowStarted", "timestamp", "nativeWindowShown", "complete"] as const).map(method => ({ action: "view.toggleDrawnStructureSettings", method })),
  ...(["expectSignal", "complete"] as const).map(method => ({ action: "view.toggleDrawnStructureSettings", method, hide: true })),
  { action: "plugins.manage", method: "surfaceStarted" }, { action: "plugins.manage", method: "surfaceShown" },
  { action: "plugins.manage", method: "signal", second: true },
  // Real native menu and palette-forwarded deliveries both enter MainWindow's dispatcher.
  ...[false, true].flatMap(forwarded => (["command", "dispatchReturned", "signal"] as const).map(method => ({
    action: "page.setOrientation.landscape", method, forwarded
  }))),
  { action: "page.setOrientation.landscape", method: "forwardedInput", forwarded: true }
];
async function command(action: string, forwarded = false) {
  await act(async () => {
    if (forwarded) runtime.perfHook(() => runtime.perfProbe?.forwardedInput({
      inputId: "toolbar-1", t0: runtime.perfProbe!.timestamp()!, commandId: action, window: "toolset-core-main"
    }));
    window.dispatchEvent(new CustomEvent("chemdraft:native-command", { detail: { commandId: action } }));
  });
}
async function mount(options: { web?: boolean; inline?: boolean; failNativeToolbars?: boolean; document?: ReturnType<typeof createPhase4Document>; toolbarLayout?: unknown } = {}) {
  vi.resetModules(); vi.clearAllMocks(); native.windows.clear(); native.desktop = !options.web;
  native.loadToolbarLayout.mockResolvedValue(options.toolbarLayout);
  vi.stubGlobal("localStorage", new MemoryStorage()); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(window, "focus").mockImplementation(() => {});
  vi.spyOn(window, "open").mockReturnValue({} as Window);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  native.invoke.mockImplementation(async (name: string, args?: { label: string }) => {
    if (name === "perf_log_window_state") return native.windows.has("toggle_" + args!.label.replaceAll("-", "_") + "_window") ? "visible" : "hidden";
    if (!name.startsWith("toggle_")) return undefined;
    if (native.windows.delete(name)) return false;
    native.windows.add(name); return true;
  });
  native.panelOpen.mockResolvedValue(undefined); native.analysisPublish.mockResolvedValue(undefined); native.reportPublish.mockResolvedValue(undefined);
  native.open.mockImplementation(async (toolsetId: string) => {
    if (options.failNativeToolbars) throw new Error("Unable to open native toolbars");
    native.windows.add(toolsetId === "core.drawnStructureSettings" ? "settings" : toolsetId); return { toolsetId, open: true, focused: true };
  });
  native.close.mockImplementation(async (toolsetId: string) => {
    native.windows.delete(toolsetId === "core.drawnStructureSettings" ? "settings" : toolsetId); return { toolsetId, open: false, focused: false };
  });
  native.showPopover.mockResolvedValue(true); native.hidePopover.mockResolvedValue(undefined);
  native.publish.mockResolvedValue(undefined); native.writeText.mockResolvedValue(undefined); native.writeFile.mockResolvedValue(undefined);
  window.history.replaceState(null, "", "/?agentBridge=1");
  runtime = await import("./runtime");
  const { MainWindow } = await import("../MainWindow");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(createElement(MainWindow, {
    initialDocument: options.document ?? createPhase4Document("Probe failure"), initialPaletteMode: "hidden", nativePalette: !options.inline,
    initialRulersVisible: false, initialCrosshairsVisible: false
  })));
  await runtime.startPerfProbe("fault-test");
}

async function clickToolbarButton(selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  await act(async () => button!.click());
}

async function openToolbarCommandPicker(toolsetId: string, query: string) {
  await clickToolbarButton(`[data-toolset-id="${toolsetId}"] .customize-toolset-title`);
  const button = [...container.querySelectorAll("button")].find(button => button.textContent === "Add command…");
  expect(button).toBeDefined();
  await act(async () => button!.click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search commands to add"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("re-adds a hidden plugin command from Main's gallery and another toolbar's picker", async () => {
  await mount({ web: true, inline: true });
  const pluginId = "plugin.customizeTest.run";
  await act(async () => {
    native.runtime!.registerPlugin({
      id: "org.chemdraft.customize-test", name: "Customize Test", version: "1.0.0",
      apiVersion: "^0.1.25", entry: "test.js", permissions: ["ui.toolbar"],
      contributes: {
        commands: [{ id: pluginId, title: "Run Customize Test" }],
        toolsets: [{ id: "plugin.customizeTest", title: "Customize Test Toolbar", defaultVisible: true,
          groups: [{ id: "plugin.customizeTest.items", items: [{ commandId: pluginId, title: "Run Customize Test" }] }] }]
      }
    }, { commandHandlers: { [pluginId]: vi.fn() } });
  });
  await command("view.customizeToolbars");
  await clickToolbarButton('[data-toolset-id="plugin.customizeTest"] .customize-toolset-title');
  await clickToolbarButton(`[data-item-id="${pluginId}"] .customize-item-visible`);
  await clickToolbarButton(".customize-toolbars-apply");
  expect(container.querySelector(`.tool-palette [data-command-id="${pluginId}"]`)).toBeNull();

  await command("view.customizeMainToolbar");
  expect(container.querySelector<HTMLButtonElement>('.gallery-tile[aria-label="Run Customize Test"]')?.disabled).toBe(false);
  const { TOOLSET_LAYOUT_EDIT_EVENT } = await import("../window-manager");
  await act(async () => {
    window.dispatchEvent(new CustomEvent(TOOLSET_LAYOUT_EDIT_EVENT, { detail: {
      toolsetId: "core.main", edit: { kind: "addCommand", groupId: "core.main.items", index: 0, commandId: pluginId }
    } }));
  });
  await command("view.customizeMainToolbar");
  expect(container.querySelector(`.tool-palette [data-command-id="${pluginId}"]`)).not.toBeNull();

  await act(async () => {
    window.dispatchEvent(new CustomEvent(TOOLSET_LAYOUT_EDIT_EVENT, { detail: {
      toolsetId: "core.main", edit: { kind: "removeItem", itemId: pluginId }
    } }));
  });
  expect(container.querySelector(`.tool-palette [data-command-id="${pluginId}"]`)).toBeNull();
  await command("view.customizeToolbars");
  await openToolbarCommandPicker("core.layout", pluginId);
  await clickToolbarButton(`.customize-toolbars-dialog [data-command-id="${pluginId}"]`);
  expect(container.querySelector(`[data-item-id="${pluginId}"]`)).not.toBeNull();
  await clickToolbarButton(".customize-toolbars-apply");
  await command("view.toolset.toggle.core.layout");
  expect(container.querySelectorAll(`.tool-palette [data-command-id="${pluginId}"]`)).toHaveLength(1);
});

it.each([["mol.1", "mol%2E1"], ["mol1", "mol1"]])("keeps atom problem actions for %s out of persistent toolbar customization", async (id, encoded) => {
  const { problemDocument, problemMolecule } = await import("../testSupport/atomProblemFixtures");
  await mount({ web: true, document: problemDocument({ ...problemMolecule("Qq"), id }) });
  await command("view.customizeToolbars");
  const commandId = `atom.problem.open.${encoded}.a0`;
  await openToolbarCommandPicker("core.main", commandId);
  expect(container.querySelector(`.customize-command-add[data-command-id="${commandId}"]`)).toBeNull();
  expect(container.querySelector(`.native-atom-invalid-marker[data-command-id="${commandId}"]`)).not.toBeNull();
  await clickToolbarButton(".customize-toolbars-apply");
  await command("view.customizeMainToolbar");
  expect(container.querySelector('.gallery-tile[aria-label="Atom problem…"]')).toBeNull();
});

it("restores a shipped Eraser hidden by dragging it away using Main's command picker", async () => {
  await mount({ web: true, inline: true });
  await command("view.customizeMainToolbar");
  const { TOOLSET_LAYOUT_EDIT_EVENT } = await import("../window-manager");
  await act(async () => {
    window.dispatchEvent(new CustomEvent(TOOLSET_LAYOUT_EDIT_EVENT, { detail: {
      toolsetId: "core.main", edit: { kind: "removeItem", itemId: "tool.eraser" }
    } }));
  });
  await command("view.customizeToolbars");
  expect(container.querySelector<HTMLInputElement>('[data-item-id="tool.eraser"] .customize-item-visible')?.checked).toBe(false);
  await openToolbarCommandPicker("core.main", "Eraser");
  await clickToolbarButton('.customize-toolbars-dialog [data-command-id="tool.eraser"]');
  expect(container.querySelectorAll('[data-item-id="tool.eraser"]')).toHaveLength(1);
  expect(container.querySelector<HTMLInputElement>('[data-item-id="tool.eraser"] .customize-item-visible')?.checked).toBe(true);
  await clickToolbarButton(".customize-toolbars-apply");
  expect(container.querySelectorAll('.web-floating-palette[data-toolset-id="core.main"] [data-command-id="tool.eraser"]')).toHaveLength(1);
});

it("offers the plugin starter in Customize and renders it on the built-in toolbar", async () => {
  await mount({ web: true, inline: true });
  await command("view.toolset.toggle.core.main");
  await command("view.customizeToolbars");
  await openToolbarCommandPicker("core.main", "Vibe Code");
  await clickToolbarButton('.customize-toolbars-dialog [data-command-id="plugins.vibeCodeStarter"]');
  await clickToolbarButton(".customize-toolbars-apply");
  expect(container.querySelector('.tool-palette [data-command-id="plugins.vibeCodeStarter"]')).not.toBeNull();
  await import("../dialogs/VibeCodeGuideForm");
  await clickToolbarButton('.tool-palette [data-command-id="plugins.vibeCodeStarter"]');
  await vi.waitFor(() => expect(container.querySelector("form.cd-vibe-guide")).not.toBeNull());
});

it("opens Layout with the two-column width despite a legacy preferred window size", async () => {
  await mount({ toolbarLayout: {
    version: 1, userToolsets: [],
    toolsetOverrides: [{ toolsetId: "core.layout", preferredWindowSize: { width: 900, height: 317 } }]
  } });
  await command("view.toolset.toggle.core.layout");
  expect(native.open).toHaveBeenCalledWith("core.layout", expect.objectContaining({ width: 60 }));
});

it.each(["native", "inline"] as const)("sizes the Main toolbar from content in the %s path despite a legacy width", async surface => {
  await mount({ failNativeToolbars: surface === "inline", toolbarLayout: {
    version: 1, userToolsets: [],
    toolsetOverrides: [{ toolsetId: "core.main", preferredWindowSize: { width: 5000, height: 317 } }]
  } });
  const palette = '.web-floating-palette[data-toolset-id="core.main"]';
  if (surface === "inline") {
    await vi.waitFor(() => expect(container.querySelector(palette)).not.toBeNull(), { timeout: 1500 });
  }
  const width = surface === "native"
    ? native.open.mock.calls.find(([id]) => id === "core.main")?.[1].width
    : Number.parseInt(container.querySelector<HTMLElement>(palette)!.style.getPropertyValue("--palette-width"), 10);
  expect(width).toBeGreaterThan(0);
  expect(width).toBeLessThan(5000);
});

it("can toggle and cancel Customize Toolbars after loading a newer saved layout", async () => {
  await mount({ toolbarLayout: {
    version: 2,
    toolsetOverrides: [{ toolsetId: "core.layout", visible: true }],
    userToolsets: []
  } });
  expect(container.querySelector('.web-floating-palette[data-toolset-id="core.main"]')).not.toBeNull();
  expect(native.saveToolbarLayout).not.toHaveBeenCalled();
  await command("view.customizeToolbars");

  const dialog = ".customize-toolbars-dialog";
  const palette = '.web-floating-palette[data-toolset-id="core.layout"]';
  const visibility = container.querySelector<HTMLInputElement>(`${dialog} [data-toolset-id="core.layout"] .customize-toolset-visible`)!;
  expect(visibility.checked).toBe(false);
  await act(async () => visibility.click());
  expect(visibility.checked).toBe(true);
  expect(container.querySelector(palette)).not.toBeNull();

  await clickToolbarButton(".customize-toolbars-cancel");
  expect(container.querySelector(dialog)).toBeNull();
  expect(container.querySelector(palette)).toBeNull();
});

it.each([undefined, 3])("uses in-window fallback after a malformed saved addition (revision %s)", async revision => {
  const malformedId = "atom.problem.open.mol%2E1.a0";
  await mount({ toolbarLayout: {
    version: 1,
    mainToolbarDefaultsRevision: revision,
    toolsetOverrides: [{
      toolsetId: "core.layout", visible: true,
      itemAdditions: [
        { groupId: "core.layout.tools", item: { commandId: malformedId } },
        { groupId: "core.layout.tools", item: { commandId: "edit.undo" } }
      ]
    }],
    userToolsets: []
  } });
  expect(container.querySelector('.web-floating-palette[data-toolset-id="core.main"]')).not.toBeNull();
  expect(native.open).not.toHaveBeenCalled();
  expect(native.saveToolbarLayout).not.toHaveBeenCalled();
});

it.each([
  new Error("Could not restore document for Preferences: unminimize failed"),
  "Dialog owner is hidden",
  "Document monitor unavailable"
])("reports the native Preferences opening error in document status: %s", async error => {
  await mount(); vi.useFakeTimers();
  const invoke = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (name: string, args?: { label: string }) => {
    if (name === "toggle_preferences_window") throw error;
    return invoke(name, args);
  });
  try {
    // command's awaited act flushes the fire-and-forget IPC rejection and status
    // render, just as in the existing failed-IPC cases below; no polling escapes it.
    await command("view.togglePreferences");
    expect(container.querySelector("[data-status-message]")?.textContent)
      .toBe(`Preferences unavailable: ${error instanceof Error ? error.message : error}`);
    expect(native.invoke).toHaveBeenCalledWith("toggle_preferences_window");
    expect(native.windows.has("toggle_preferences_window")).toBe(false);
  } finally {
    native.invoke.mockImplementation(invoke);
  }
});

it("opens Preferences successfully without adding a failure status", async () => {
  await mount(); vi.useFakeTimers();
  const status = container.querySelector("[data-status-message]")!.textContent;
  await command("view.togglePreferences");
  expect(native.windows.has("toggle_preferences_window")).toBe(true);
  expect(native.invoke).toHaveBeenCalledWith("toggle_preferences_window");
  expect(container.querySelector("[data-status-message]")?.textContent).toBe(status);
  expect(container.querySelector("[data-status-message]")?.textContent).not.toContain("Preferences unavailable");
});

it.each([false, true].flatMap(inline => ["throw", "reject"].map(failure => ({ inline, failure }))))
  ("ring close finishes selection cleanup and status after a failed completion hook ($failure, inline=$inline)", async ({ inline, failure }) => {
    const initial = insertNativeTemplateMolecule(createPhase4Document("Ring cleanup"), { x: 300, y: 300 }, "benzene");
    const molecule = initial.pages[0].objects[0];
    if (molecule.type !== "molecule") throw new Error("Expected ring fixture");
    const ring = nativeMoleculeRings(molecule)[0]!;
    await mount({ inline, document: initial });
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) });
    await command("view.toggleRingInspector");
    const target = [...container.querySelectorAll<SVGPathElement>(".native-molecule-ring-hit-target")].find(node => node.dataset.ringHitKey === ring.ringKey)!;
    expect(target).toBeDefined();
    await act(async () => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, button: 0, buttons: type === "pointerup" ? 0 : 1, cancelable: true, clientX: ring.center.x, clientY: ring.center.y });
        Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 7 }, pointerType: { value: "mouse" } });
        target.dispatchEvent(event);
      }
    });
    expect(container.querySelector(`[data-selected-native-ring-key="${ring.ringKey}"]`)).not.toBeNull();
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, fail) => { reject = fail; });
    const fault = vi.spyOn(runtime.perfProbe!, "complete").mockImplementation(() => {
      if (failure === "throw") throw new Error("completion failed");
      return pending as never;
    });
    const before = Date.now();
    await command("view.toggleRingInspector");
    expect(fault).toHaveBeenCalled(); expect(Date.now()).toBe(before);
    expect(container.querySelector(`[data-selected-native-ring-key="${ring.ringKey}"]`)).toBeNull();
    expect(container.textContent).toContain(inline ? "Toggled Rings" : "Rings closed");
    if (!inline) expect(native.windows.has("core.ringInspector")).toBe(false);
    if (failure === "reject") reject(new Error("completion rejected"));
    await Promise.resolve(); await Promise.resolve();
    const calls = fault.mock.calls.length, rows = localStorage.getItem("chemdraft.perfLog");
    await command("page.setOrientation.landscape");
    await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
    expect(fault).toHaveBeenCalledTimes(calls); expect(localStorage.getItem("chemdraft.perfLog")).toBe(rows);
  });

it.each(["throw", "reject"])("shortcut registry cleanup unmounts the document despite a %s probe hook", async failure => {
  await mount(); vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, fail) => { reject = fail; });
  const fault = vi.spyOn(runtime.perfProbe!, "setShortcutRegistry").mockImplementation(() => {
    if (failure === "throw") throw new Error("cleanup failed");
    return pending as never;
  });
  const before = Date.now();
  await act(async () => { root!.unmount(); root = undefined; });
  expect(fault).toHaveBeenCalledWith(undefined); expect(Date.now()).toBe(before);
  expect(container.childElementCount).toBe(0);
  if (failure === "reject") reject(new Error("cleanup rejected"));
  await Promise.resolve(); await Promise.resolve();
  const later = vi.fn(); runtime.perfHook(later); expect(later).not.toHaveBeenCalled();
  const calls = fault.mock.calls.length, rows = localStorage.getItem("chemdraft.perfLog");
  await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
  expect(fault).toHaveBeenCalledTimes(calls); expect(localStorage.getItem("chemdraft.perfLog")).toBe(rows);
});

it.each(["throw", "reject"])("toggle state query fails open (%s) after the actual window effect", async failure => {
  await mount(); vi.useFakeTimers();
  const original = native.invoke.getMockImplementation()!;
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, fail) => { reject = fail; });
  native.invoke.mockImplementation((name: string, ...args: unknown[]) => {
    if (name !== "perf_log_window_state") return original(name, ...args);
    if (failure === "throw") throw new Error("state query threw");
    return pending;
  });
  const before = Date.now();
  await command("view.togglePreferences");
  expect(native.windows.has("toggle_preferences_window")).toBe(true); expect(Date.now()).toBe(before);
  expect(native.invoke).toHaveBeenCalledWith("toggle_preferences_window");
  expect(native.invoke).toHaveBeenCalledWith("perf_log_window_state", { label: "preferences" });
  if (failure === "reject") reject(new Error("state query rejected"));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const later = vi.fn(); runtime.perfHook(later); expect(later).not.toHaveBeenCalled();
  const calls = native.invoke.mock.calls.length, rows = localStorage.getItem("chemdraft.perfLog");
  await command("view.togglePreferences");
  expect(native.windows.has("toggle_preferences_window")).toBe(false);
  expect(native.invoke).toHaveBeenCalledTimes(calls + 1);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
  expect(localStorage.getItem("chemdraft.perfLog")).toBe(rows);
});

it.each(cases.flatMap(test => ["throw", "reject"].map(failure => ({ ...test, failure }))))
  ("$action/$method hide=$hide forwarded=$forwarded fails open ($failure)", async test => {
    await mount(test);
    if (test.action === "plugin.perfTest.open") await act(async () => {
      native.runtime!.registerPlugin({ id: "org.chemdraft.perf-test", name: "Perf Test", version: "1.0.0",
        apiVersion: "^0.1.14", entry: "test.js", permissions: ["ui.panel"], contributes: {
          commands: [{ id: test.action, title: "Open report" }],
          panels: [{ id: "panel.perfTest.report", title: "Report", commandId: test.action }]
        } }, { commandHandlers: { [test.action]: context => context.panels!.showReport("panel.perfTest.report", { title: "Fault report", sections: [] }) } });
    });
    if (test.failed) native.invoke.mockImplementation(async (name: string) => {
      if (name.startsWith("toggle_")) throw new Error("app toggle failed");
    });
    if (test.hide || test.second) await command(test.action);
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, fail) => { reject = fail; });
    const fault = vi.spyOn(runtime.perfProbe!, test.method).mockImplementation(() => {
      if (test.failure === "throw") throw new Error("injected probe failure");
      return pending as never;
    });
    const before = Date.now();
    await command(test.action, test.forwarded);
    expect(fault).toHaveBeenCalled(); // This case must reach its particular real hook.
    expect(Date.now()).toBe(before); // No fake clock advancement or probe settlement needed.
    if (test.failed) expect(container.textContent).toContain(test.action === "view.togglePreferences" ? "Preferences unavailable" : "3D debugger unavailable");
    else if (test.web) {
      expect(window.open).toHaveBeenCalled(); expect(container.textContent).toContain("Preferences opened in browser");
    } else if (test.inline) expect(container.textContent).toContain("Toggled Drawn Structure Settings");
    else if (test.action === "analyze.molecularProperties") {
      expect(native.panelOpen).toHaveBeenCalledWith(expect.objectContaining({ title: "Molecular Inspector" }));
      expect(native.analysisPublish).toHaveBeenCalled(); // Broadcast follows the final perf hook.
      expect(container.textContent).toContain("select a structure");
    } else if (test.action === "plugin.perfTest.open") {
      expect(native.panelOpen).toHaveBeenCalledWith(expect.objectContaining({ title: "Fault report" }));
      expect(native.reportPublish).toHaveBeenCalled();
      expect(native.runtime!.panels.getDetachedPanels()).toHaveLength(1);
    } else if (test.action === "plugins.manage") expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    else if (test.action === "page.setOrientation.landscape") {
      expect(container.querySelector('svg')).not.toBeNull();
      const snapshot = (window as Window & { __CHEMDRAFT_AGENT__: import("../agentBridge").ChemDraftAgentBridge }).__CHEMDRAFT_AGENT__.snapshot();
      expect(snapshot.document.pages[0].width).toBeGreaterThan(snapshot.document.pages[0].height);
    } else {
      const key = test.action === "view.toggleDrawnStructureSettings" ? "settings"
        : test.action === "view.togglePreferences" ? "toggle_preferences_window" : "toggle_spin3d_debugger_window";
      expect(native.windows.has(key)).toBe(!test.hide);
      if (test.action === "view.toggleDrawnStructureSettings") expect(container.textContent)
        .toContain(test.hide ? "Drawn Structure Settings closed" : "Drawn Structure Settings open");
    }
    // Reject only AFTER the observable action. An accidental await would never reach here.
    if (test.failure === "reject") reject(new Error("injected rejected probe"));
    await Promise.resolve(); await Promise.resolve();
    const calls = fault.mock.calls.length;
    const rows = localStorage.getItem("chemdraft.perfLog");
    await command(test.action, test.forwarded); // Real action still works after probe shutdown.
    await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
    expect(fault).toHaveBeenCalledTimes(calls);
    expect(localStorage.getItem("chemdraft.perfLog")).toBe(rows);
  });

it.each((["setShortcutRegistry", "instrumentRegistry", "readyCanvas", "rendered"] as const)
  .flatMap(method => [false, true].flatMap(web => ["throw", "reject"].map(failure => ({ method, failure, web })))))
  ("startup/$method fails open ($failure) while the real document mounts", async ({ method, failure, web }) => {
    native.desktop = !web;
    // Start with the actual document root present, as in index.html, so its commit observer runs.
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
    native.panelOpen.mockResolvedValue(undefined); native.analysisPublish.mockResolvedValue(undefined); native.reportPublish.mockResolvedValue(undefined);
    vi.stubGlobal("localStorage", new MemoryStorage()); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(window, "focus").mockImplementation(() => {});
    window.history.replaceState(null, "", "/?agentBridge=1");
    runtime = await import("./runtime");
    container = document.createElement("div"); container.id = "root"; document.body.append(container); root = createRoot(container);
    await runtime.startPerfProbe("startup-fault");
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, fail) => { reject = fail; });
    const fault = vi.spyOn(runtime.perfProbe!, method).mockImplementation(() => {
      if (failure === "throw") throw new Error("startup hook failed");
      return pending as never;
    });
    const { MainWindow } = await import("../MainWindow");
    const start = Date.now();
    await act(async () => root!.render(createElement(MainWindow, {
      initialDocument: createPhase4Document("Startup fault"), initialPaletteMode: "hidden", nativePalette: true,
      initialRulersVisible: false, initialCrosshairsVisible: false
    })));
    expect(container.querySelector(".page")).not.toBeNull();
    expect(container.textContent).toContain(sourceStamp);
    expect(fault).toHaveBeenCalled(); expect(Date.now()).toBe(start);
    if (failure === "reject") reject(new Error("rejected startup hook"));
    await Promise.resolve(); await Promise.resolve();
    const calls = fault.mock.calls.length, rows = localStorage.getItem("chemdraft.perfLog");
    await command("page.setOrientation.landscape");
    await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
    expect(fault).toHaveBeenCalledTimes(calls);
    expect(localStorage.getItem("chemdraft.perfLog")).toBe(rows);
  });

const popoverContent = { toolsetId: "core.main", kind: "flyout" as const,
  flyout: { flyoutId: "arrows", title: "Arrows", commands: [{ id: "page.setOrientation.landscape", title: "Landscape", enabled: true, active: false }] } };
it.each([
  { surface: "popover", method: "surfaceStarted" as const },
  { surface: "popover", method: "surfaceShown" as const },
  { surface: "popover-replace", method: "surfaceShown" as const },
  { surface: "popover-dismiss", method: "surfaceShown" as const },
  { surface: "popover-empty", method: "surfaceShown" as const },
  { surface: "popover-failed", method: "surfaceShown" as const },
  ...["popover-click", "toolbar-click"].flatMap(surface => (["command", "dispatchReturned"] as const).map(method => ({ surface, method })))
].flatMap(test => ["throw", "reject"].map(failure => ({ ...test, failure }))))
  ("$surface/$method fails open ($failure) with a real reveal, dismissal or button click", async ({ surface, method, failure }) => {
    await mount(); vi.useFakeTimers();
    paletteContainer = document.createElement("div"); document.body.append(paletteContainer); paletteRoot = createRoot(paletteContainer);
    if (surface === "toolbar-click") {
      const { PaletteWindow } = await import("../PaletteWindow");
      await act(async () => paletteRoot!.render(createElement(PaletteWindow, { toolsetId: "core.main" })));
    } else {
      const { PalettePopoverWindow } = await import("../PalettePopoverWindow");
      await act(async () => paletteRoot!.render(createElement(PalettePopoverWindow, { toolsetId: "core.main", kind: "flyout", prewarm: true })));
    }
    if (surface === "popover-click" || surface === "popover-replace" || surface === "popover-dismiss") {
      // Keep the first reveal outstanding for the replacement/dismissal paths.
      if (surface !== "popover-click") native.showPopover.mockImplementationOnce(() => new Promise<boolean>(() => {}));
      await act(async () => native.content!(popoverContent));
    }
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, fail) => { reject = fail; });
    const fault = vi.spyOn(runtime.perfProbe!, method).mockImplementation(() => {
      if (failure === "throw") throw new Error("palette probe failure");
      return pending as never;
    });
    const start = Date.now();
    if (surface.endsWith("click")) {
      const id = surface === "toolbar-click" ? "tool.bond" : "page.setOrientation.landscape";
      const button = paletteContainer.querySelector<HTMLButtonElement>(`[data-command-id="${id}"]`)!;
      expect(button).not.toBeNull();
      await act(async () => button.click());
      const snapshot = (window as Window & { __CHEMDRAFT_AGENT__: import("../agentBridge").ChemDraftAgentBridge }).__CHEMDRAFT_AGENT__.snapshot();
      if (surface === "toolbar-click") expect(snapshot.activeToolCommandId).toBe("tool.bond");
      else expect(snapshot.document.pages[0].width).toBeGreaterThan(snapshot.document.pages[0].height);
    } else if (surface === "popover-dismiss") {
      await act(async () => paletteRoot!.render(null)); // Real window/root teardown cancels a pending reveal.
      expect(paletteContainer.childElementCount).toBe(0);
    } else {
      if (surface === "popover-failed") native.showPopover.mockRejectedValueOnce(new Error("native reveal failed"));
      await act(async () => native.content!(surface === "popover-empty"
        ? { ...popoverContent, flyout: { ...popoverContent.flyout, commands: [] } } : popoverContent));
      if (surface === "popover-empty") {
        expect(paletteContainer.querySelector('[data-command-id="page.setOrientation.landscape"]')).toBeNull();
        expect(native.showPopover).not.toHaveBeenCalled();
      } else {
      expect(paletteContainer.querySelector('[role="menu"]')).not.toBeNull();
      expect(native.showPopover).toHaveBeenCalled();
      }
    }
    expect(fault).toHaveBeenCalled(); expect(Date.now()).toBe(start);
    if (failure === "reject") reject(new Error("palette probe rejection"));
    await Promise.resolve(); await Promise.resolve();
    const calls = fault.mock.calls.length, rows = localStorage.getItem("chemdraft.perfLog");
    await command("page.setOrientation.portrait");
    await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
    expect(fault).toHaveBeenCalledTimes(calls);
    expect(localStorage.getItem("chemdraft.perfLog")).toBe(rows);
  });

it.each([
  { action: "view.togglePreferences", target: "preferences", toggle: "toggle_preferences_window" },
  { action: "view.openKeyboardPreferences", target: "preferences", toggle: "toggle_preferences_window", args: { keyboard: true } },
  { action: "view.toggle3dDebugger", target: "spin3d-debugger", toggle: "toggle_spin3d_debugger_window" }
])("$action registers cold-open intent before the toggle without awaiting diagnostics", async ({ action, target, toggle, args }) => {
  await mount(); vi.useFakeTimers(); native.invoke.mockClear();
  let registered: import("./runtime").NativeOpen | undefined;
  native.invoke.mockImplementation((name: string, args?: { nativeOpen?: import("./runtime").NativeOpen }) => {
    if (name === "perf_log_clock" && args?.nativeOpen) {
      registered = { ...args.nativeOpen };
      // A held registration reply must never hold the app toggle. Native IPC consumes the
      // intent first; a new webview can now calibrate while the toggle is still in flight.
      return new Promise(() => {});
    }
    if (name === toggle) {
      expect(registered).toMatchObject({ target, commandId: action });
      expect(registered!.shownAt).toBeUndefined();
      native.windows.add(toggle);
      return Promise.resolve();
    }
    if (name === "perf_log_window_state") return Promise.resolve("visible");
    return Promise.resolve();
  });
  await command(action);
  expect(native.windows.has(toggle)).toBe(true);
  expect(native.invoke.mock.calls.slice(0, 2)).toEqual([
    ["perf_log_clock", { nativeOpen: expect.objectContaining({ target, commandId: action }) }],
    args ? [toggle, args] : [toggle]
  ]);
  expect(registered?.shownAt).toEqual(expect.any(Number));
  const at = registered!.shownAt! + 1;
  runtime.perfHook(() => runtime.perfProbe?.remoteNativePaint(target, at, at + 1, target, at));
  await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
  const rows = (localStorage.getItem("chemdraft.perfLog") ?? "").split("\n").filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.commandId === action);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ doneSignal: "window-painted" });
  expect(rows[0].extra.missingDestinationPaint).toBeUndefined();
});

it.each(["view.togglePreferences", "view.toggle3dDebugger"])("%s records failed IPC promptly, without a missing-paint timeout", async action => {
  await mount(); vi.useFakeTimers();
  native.invoke.mockImplementation(async (name: string) => {
    if (name.startsWith("toggle_")) throw new Error("toggle IPC failed");
  });
  await command(action);
  await act(async () => { await vi.advanceTimersByTimeAsync(32); });
  const rows = () => (localStorage.getItem("chemdraft.perfLog") ?? "").split("\n").filter(Boolean)
    .map(line => JSON.parse(line)).filter(row => row.commandId === action);
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toMatchObject({ doneSignal: "failed" });
  expect(rows()[0].extra.missingDestinationPaint).toBeUndefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
  expect(rows()).toHaveLength(1);
});

it.each(["svg", "pdf"].flatMap(format => ["throw", "reject"].map(failure => ({ format, failure }))))
  ("native $format export writes its bytes and reports success when the write hook $failure fails", async ({ format, failure }) => {
    await mount(); vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {}); // jsPDF's optional outline plugin in jsdom.
    native.pickSave.mockResolvedValue(`/exports/drawing.${format}`);
    await command("export.open");
    const send = async (type: "ready" | "action", data: unknown) => act(async () => {
      native.receive!({ senderWindowId: "dialog-main-export-1", windowLabel: "dialog-main-export-1",
        message: { ...native.snapshot!, type, requestId: crypto.randomUUID(), data } });
    });
    await send("ready", {});
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, fail) => { reject = fail; });
    const fault = vi.spyOn(runtime.perfProbe!, "signal").mockImplementation(() => {
      if (failure === "throw") throw new Error("write probe failure");
      return pending as never;
    });
    const start = Date.now();
    const { exportFixture } = await import("../dialogs/exportTestFixtures");
    // Preload optional exporters just as the normal user path may; no probe promise is awaited.
    if (format === "pdf") await import("@chemdraft/export-engine/pdf");
    // The host emits a terminal receipt after the write and its perf hook. Wait for that
    // event, with the diagnostic promise still pending and the fake clock untouched.
    const receipt = new Promise<void>(resolve => {
      native.publish.mockImplementation(async (_host: string, message: import("../dialogs/dialogProtocol").DialogMessage) => {
        if (message.type === "result" && (message.data.status === "exported" || message.data.status === "error")) resolve();
      });
    });
    await act(async () => {
      await send("action", { action: "export", options: { ...exportFixture(), format, filename: `drawing.${format}` } });
      await receipt;
    });
    expect(fault).toHaveBeenCalledWith("export-written");
    if (format === "svg") expect(native.writeText).toHaveBeenCalledWith("/exports/drawing.svg", expect.stringContaining("<svg"));
    else {
      expect(native.writeFile).toHaveBeenCalledWith("/exports/drawing.pdf", expect.any(Uint8Array));
      expect(new TextDecoder().decode(native.writeFile.mock.calls[0][1]).startsWith("%PDF")).toBe(true);
    }
    expect(native.publish).toHaveBeenCalledWith("export-host", expect.objectContaining({ data: expect.objectContaining({ status: "exported" }) }));
    expect(Date.now()).toBe(start);
    if (failure === "reject") reject(new Error("write probe rejection"));
    await Promise.resolve(); await Promise.resolve();
    const calls = fault.mock.calls.length, rows = localStorage.getItem("chemdraft.perfLog");
    await command("page.setOrientation.landscape");
    await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
    expect(fault).toHaveBeenCalledTimes(calls);
    expect(localStorage.getItem("chemdraft.perfLog")).toBe(rows);
  }, 30_000);

it.each((["documentOpenStarted", "documentOpenCommitted", "documentOpenSkipped", "documentOpenFailed"] as const)
  .flatMap(method => ["throw", "reject"].map(failure => ({ method, failure }))))
  ("File Open/$method fails open ($failure) through the native picker and document install", async ({ method, failure }) => {
    await mount(); vi.useFakeTimers();
    const { createNativeSavePayload } = await import("../documentWorkflow");
    native.pickOpen.mockResolvedValue("/drawings/opened.chemdraft");
    let bytes = new TextEncoder().encode(createNativeSavePayload(createPhase4Document("Opened drawing")).contents);
    native.stat.mockImplementation(async () => ({ size: bytes.length }));
    native.fileClose.mockResolvedValue(undefined);
    native.fileOpen.mockImplementation(async () => {
      let offset = 0;
      return {
        read: native.fileRead.mockImplementation(async (buffer: Uint8Array) => {
          if (offset === bytes.length) return null;
          const count = Math.min(buffer.length, bytes.length - offset);
          buffer.set(bytes.subarray(offset, offset + count));
          offset += count;
          return count;
        }),
        close: native.fileClose
      };
    });
    if (method === "documentOpenSkipped") await command("document.open");
    if (method === "documentOpenFailed") bytes = new TextEncoder().encode("{ invalid document");
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, fail) => { reject = fail; });
    const fault = vi.spyOn(runtime.perfProbe!, method).mockImplementation(() => {
      if (failure === "throw") throw new Error("open probe failure");
      return pending as never;
    });
    const start = Date.now();
    await command("document.open");
    // Native command delivery is fire-and-forget. Observe the completed app action,
    // allowing imports/IO to finish without advancing diagnostics' fake clock.
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(fault).toHaveBeenCalled();
      if (method === "documentOpenFailed") expect(container.textContent).toMatch(/failed|invalid|Unexpected/i);
      else expect(container.textContent).toContain("Opened opened.chemdraft");
    }, { interval: 0, timeout: 15_000 });
    expect(fault).toHaveBeenCalled(); expect(Date.now()).toBe(start);
    if (method === "documentOpenFailed") expect(container.textContent).toMatch(/failed|invalid|Unexpected/i);
    else {
      expect(container.textContent).toContain("Opened opened.chemdraft");
      expect((window as Window & { __CHEMDRAFT_AGENT__: import("../agentBridge").ChemDraftAgentBridge }).__CHEMDRAFT_AGENT__.snapshot().file.path).toBe("/drawings/opened.chemdraft");
    }
    expect(native.stat).toHaveBeenCalledWith("/drawings/opened.chemdraft");
    expect(native.fileOpen).toHaveBeenCalledWith("/drawings/opened.chemdraft", { read: true });
    expect(native.fileRead).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(native.fileClose).toHaveBeenCalledTimes(method === "documentOpenSkipped" ? 2 : 1);
    if (failure === "reject") reject(new Error("open probe rejection"));
    await Promise.resolve(); await Promise.resolve();
    const calls = fault.mock.calls.length, rows = localStorage.getItem("chemdraft.perfLog");
    await command("page.setOrientation.landscape");
    await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
    expect(fault).toHaveBeenCalledTimes(calls);
    expect(localStorage.getItem("chemdraft.perfLog")).toBe(rows);
  }, 30_000);
