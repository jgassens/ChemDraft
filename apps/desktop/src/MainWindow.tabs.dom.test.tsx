// @vitest-environment jsdom
import { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow, documentTabPathKey } from "./MainWindow";
import { createNativeSavePayload, createPhase4Document } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { buildDocumentSessionEnvelope, buildDocumentTabsSession, parseDocumentSessionEnvelope } from "./documentSession";
import { createPluginRuntime } from "./plugins/createPluginRuntime";
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
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./window-manager", async (original) => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => native.desktop,
  loadDocumentSession: native.load,
  saveDocumentSession: native.saveSession,
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

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("documents in one window", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
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
    act(() => root?.unmount());
    root = undefined;
    container?.remove();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount() {
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(MainWindow, {
        initialDocument: createPhase4Document("Untitled"), initialActiveToolCommandId: "tool.select",
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
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((candidate) => candidate.textContent === label)!;
    await act(async () => button.click());
  }
  async function key(shiftKey = false) {
    const event = new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, shiftKey, bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(event); });
    return event;
  }

  it("hides the strip for one document; File New adds and activates an Untitled tab", async () => {
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    await command("document.new");
    expect(tabs()).toHaveLength(2);
    expect(active()).toBe(1);
    expect(tabs()[1]!.textContent).toBe("Untitled");
    expect(bridge().snapshot().page.objectCount).toBe(0);
  });

  it("Open reuses a pristine Untitled, adds after a file is open, and activates an already open file", async () => {
    await open("First");
    expect(tabs()).toHaveLength(0);
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
    expect(tabs()).toHaveLength(0);
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
    expect(tabs()).toHaveLength(0);
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

  it("dirty close is aria-modal; Cancel retains the tab and Discard selects its neighbour", async () => {
    await paste("Keep the first drawing");
    await command("document.new");
    await paste("Second dirty drawing");
    await command("document.closeTab");
    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
    await modalButton("Cancel");
    expect(tabs()).toHaveLength(2);
    expect(active()).toBe(1);
    await command("document.closeTab");
    await modalButton("Discard");
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(drawnText()).toContain("Keep the first drawing");
  });

  it("closing an inactive clean tab keeps the current drawing active", async () => {
    await command("document.new");
    await command("document.new");
    await paste("Current drawing stays active");
    const currentDocument = bridge().snapshot().document;
    await act(async () => container.querySelector<HTMLButtonElement>(".document-tab-close")!.click());
    expect(tabs()).toHaveLength(2);
    expect(active()).toBe(1);
    expect(bridge().snapshot().document).toEqual(currentDocument);
    expect(drawnText()).toContain("Current drawing stays active");
  });

  it("Save closes only after success; picker cancellation and write failure retain the tab", async () => {
    await command("document.new");
    await paste("Save before closing");
    await command("document.closeTab");
    await modalButton("Save");
    expect(tabs()).toHaveLength(2);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    native.savePicker.mockResolvedValueOnce("/tmp/saved.chemdraft");
    native.writeFile.mockRejectedValueOnce(new Error("disk full"));
    await modalButton("Save");
    expect(tabs()).toHaveLength(2);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("disk full");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("disk full");
    native.savePicker.mockResolvedValueOnce("/tmp/saved.chemdraft");
    await modalButton("Save");
    expect(native.writeFile).toHaveBeenLastCalledWith("/tmp/saved.chemdraft", expect.any(String));
    expect(container.querySelector('[role="tablist"]')).toBeNull();
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

  it("an old single-document session restores as one tab with its dirty state", async () => {
    native.session = buildDocumentSessionEnvelope(createNativeSavePayload(createPhase4Document("Legacy session")),
      { path: "/tmp/legacy.chemdraft", dirty: true }, "legacy.chemdraft", true);
    await remount();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
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
