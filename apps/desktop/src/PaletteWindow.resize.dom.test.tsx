// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaletteWindow } from "./PaletteWindow";
import { resetToolbarSizesAction } from "./commands";
import { saveResizableFloatingToolbars } from "./toolbarResizeSettings";
import { broadcastResizableToolbars, resetToolbarSizes } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  emit: vi.fn(),
  setSize: vi.fn(),
  position: { x: 100, y: 100 },
  callbacks: new Map<string, (event: { payload: unknown }) => void>(),
  size: null as { width: number; height: number } | null
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen, emit: native.emit }));
vi.mock("./window-manager/tauriEvents", async original => ({
  ...await original<typeof import("./window-manager/tauriEvents")>(),
  listenTauriEvent: (name: string, callback: (event: { payload: unknown }) => void) => native.listen(name, callback),
  listenCurrentWindowEvent: async () => () => {}
}));
vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor: vi.fn().mockResolvedValue(null),
  getCurrentWindow: () => ({ onMoved: async () => () => {}, onResized: async () => () => {}, setSize: native.setSize }),
  LogicalSize: class {
    constructor(public width: number, public height: number) {}
  }
}));

describe("resizable palette", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.callbacks.clear();
    native.size = null;
    native.position = { x: 100, y: 100 };
    native.setSize.mockImplementation(async () => { native.position = { x: 200, y: 200 }; });
    native.listen.mockImplementation(async (name: string, callback: (event: { payload: unknown }) => void) => {
      native.callbacks.set(name, callback);
      return () => native.callbacks.delete(name);
    });
    native.emit.mockResolvedValue(undefined);
    native.invoke.mockImplementation(async (name: string) => {
      if (name === "configure_toolset_resize") return native.size;
      if (name === "window_logical_position") return { ...native.position };
      if (name === "reset_toolbar_sizes") {
        native.size = null;
        native.callbacks.get("chemdraft://toolbar-user-size")?.({ payload: { toolsetId: "core.text", size: null } });
      }
      return undefined;
    });
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks();
  });
  async function render() {
    await act(async () => { root.render(createElement(PaletteWindow, { toolsetId: "core.text" })); });
    await act(async () => { await Promise.resolve(); });
  }

  it("uses the responsive scrolling layout for a saved size and reports a minimum", async () => {
    saveResizableFloatingToolbars(true);
    native.size = { width: 150, height: 100 };
    await render();
    expect(container.querySelector(".palette-window-shell.user-sized .tool-group-grid")).not.toBeNull();
    const css = readFileSync("apps/desktop/src/App.css", "utf8");
    expect(css).toMatch(/\.palette-window-shell\.user-sized \.palette-window-content\s*\{[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/\.palette-window-shell\.user-sized:not\([^}]*grid-template-columns:\s*repeat\(auto-fit/s);
    expect(native.invoke).toHaveBeenCalledWith("configure_toolset_resize", { minWidth: 96, minHeight: 56 });
    expect(native.invoke).not.toHaveBeenCalledWith("fit_toolset_window", expect.anything());
  });

  it("fits unsized palettes, and disabling resizing fits without clearing the saved size", async () => {
    saveResizableFloatingToolbars(true);
    await render();
    expect(native.invoke).toHaveBeenCalledWith("fit_toolset_window", expect.anything());
    native.size = { width: 150, height: 100 };
    await act(async () => native.callbacks.get("chemdraft://toolbar-user-size")?.({ payload: { toolsetId: "core.text", size: native.size } }));
    native.invoke.mockClear();
    native.setSize.mockClear();
    await act(async () => { await broadcastResizableToolbars(false); });
    expect(container.querySelector(".user-sized")).toBeNull();
    expect(native.setSize).toHaveBeenCalled();
    expect(native.invoke).toHaveBeenCalledWith("set_current_window_global_position", expect.anything());
    expect(native.invoke).not.toHaveBeenCalledWith("fit_toolset_window", expect.anything());
    expect(native.size).toEqual({ width: 150, height: 100 });
    expect(native.invoke).not.toHaveBeenCalledWith("reset_toolbar_sizes");
  });

  it("exposes the disabled reason and resets sizes so open palettes fit again", async () => {
    expect(resetToolbarSizesAction(false)).toMatchObject({ enabled: false, disabledReason: "Turn on Resizable floating toolbars in Preferences" });
    expect(resetToolbarSizesAction(true)).toMatchObject({ enabled: true, disabledReason: undefined });
    saveResizableFloatingToolbars(true);
    native.size = { width: 150, height: 100 };
    await render();
    native.invoke.mockClear();
    await act(async () => { await resetToolbarSizes(); });
    expect(native.invoke).toHaveBeenCalledWith("reset_toolbar_sizes");
    expect(container.querySelector(".user-sized")).toBeNull();
    expect(native.invoke).toHaveBeenCalledWith("fit_toolset_window", expect.anything());
  });
});
