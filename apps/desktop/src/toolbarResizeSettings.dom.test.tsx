// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesWindow } from "./PreferencesWindow";
import { loadResizableFloatingToolbars, saveResizableFloatingToolbars, TOOLBAR_RESIZE_STORAGE_KEY } from "./toolbarResizeSettings";
import { useResizableToolbarsSetting } from "./useResizableToolbarsSetting";
import { broadcastResizableToolbars, listenForResizableToolbars, TOOLBAR_RESIZE_SETTINGS_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

const native = vi.hoisted(() => ({ invoke: vi.fn(), emit: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: native.emit, listen: native.listen }));
beforeEach(() => { vi.stubGlobal("localStorage", new MemoryStorage()); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("defaults to false, validates stored values, and tolerates blocked storage", () => {
  expect(loadResizableFloatingToolbars()).toBe(false);
  for (const raw of ["garbage", "null", '"true"', "1", "{}", "[]"]) {
    localStorage.setItem(TOOLBAR_RESIZE_STORAGE_KEY, raw);
    expect(loadResizableFloatingToolbars()).toBe(false);
  }
  saveResizableFloatingToolbars(true);
  expect(loadResizableFloatingToolbars()).toBe(true);
  saveResizableFloatingToolbars(false);
  expect(loadResizableFloatingToolbars()).toBe(false);
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(loadResizableFloatingToolbars()).toBe(false);
  expect(() => saveResizableFloatingToolbars(true)).not.toThrow();
});

it("saves and broadcasts the Preferences toggle to open palettes and loads it for later palettes", async () => {
  function PaletteState() { return createElement("output", null, String(useResizableToolbarsSetting())); }
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement("div", null, createElement(PreferencesWindow), createElement(PaletteState))));
    const label = Array.from(container.querySelectorAll("label")).find(item => item.textContent?.includes("Resizable floating toolbars"))!;
    const checkbox = label.querySelector("input")!;
    expect(checkbox.checked).toBe(false);
    expect(container.querySelector("output")?.textContent).toBe("false");
    await act(async () => checkbox.click());
    expect(localStorage.getItem(TOOLBAR_RESIZE_STORAGE_KEY)).toBe("true");
    expect(container.querySelector("output")?.textContent).toBe("true");
    await act(async () => root.render(createElement("div", null, createElement(PaletteState, { key: "late" }))));
    expect(container.querySelector("output")?.textContent).toBe("true");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

describe.each(["MacIntel", "Win32"])("native preference events on %s", platform => {
  it("broadcasts, validates received values, and unsubscribes", async () => {
    vi.stubGlobal("navigator", { platform }); vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.listen.mockResolvedValue(native.unlisten);
    const handler = vi.fn();
    const stop = await listenForResizableToolbars(handler);
    const callback = native.listen.mock.calls.at(-1)![1] as (event: { payload: unknown }) => void;
    callback({ payload: "true" });
    expect(handler).not.toHaveBeenCalled();
    callback({ payload: true });
    expect(handler).toHaveBeenCalledExactlyOnceWith(true);
    await broadcastResizableToolbars(false);
    expect(native.invoke).toHaveBeenCalledWith("set_resizable_toolbars", { enabled: false });
    expect(native.emit).toHaveBeenCalledWith(TOOLBAR_RESIZE_SETTINGS_EVENT, false);
    expect(native.invoke.mock.invocationCallOrder.at(-1)).toBeLessThan(native.emit.mock.invocationCallOrder.at(-1)!);
    stop(); expect(native.unlisten).toHaveBeenCalledOnce();
  });
});
