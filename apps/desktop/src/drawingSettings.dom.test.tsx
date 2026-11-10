// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesWindow } from "./PreferencesWindow";
import { DRAWING_SETTINGS_STORAGE_KEY, loadDrawingSettings, saveDrawingSettings } from "./drawingSettings";
import { broadcastDrawingSettings, DRAWING_SETTINGS_EVENT, listenForDrawingSettings } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

const native = vi.hoisted(() => ({ emit: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: native.emit, listen: native.listen }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => vi.stubGlobal("localStorage", new MemoryStorage()));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("persists and broadcasts one choice in StrictMode and reflects it after reopening", async () => {
  const handler = vi.fn(), stop = await listenForDrawingSettings(handler);
  const container = document.createElement("div"); document.body.append(container);
  let root = createRoot(container);
  const radio = (value: string) => container.querySelector<HTMLInputElement>(`input[name="default-double-bond"][value="${value}"]`)!;
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(PreferencesWindow))));
    expect(container.textContent).toContain("Default double bond");
    expect(radio("offset").checked).toBe(true);
    expect(radio("centred").closest("label")?.textContent).toContain("Centered");
    await act(async () => radio("centred").click());
    expect(loadDrawingSettings()).toEqual({ defaultDoubleBond: "centred" });
    expect(handler).toHaveBeenCalledExactlyOnceWith({ defaultDoubleBond: "centred" });
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(createElement(PreferencesWindow)));
    expect(radio("centred").checked).toBe(true);
    await act(async () => radio("offset").click());
    expect(loadDrawingSettings()).toEqual({ defaultDoubleBond: "offset" });
  } finally { stop(); await act(async () => root.unmount()); container.remove(); }
});

it("syncs browser storage changes and removes the listener on teardown", async () => {
  const handler = vi.fn(), stop = await listenForDrawingSettings(handler);
  saveDrawingSettings({ defaultDoubleBond: "centred" });
  window.dispatchEvent(new StorageEvent("storage", { key: DRAWING_SETTINGS_STORAGE_KEY }));
  expect(handler).toHaveBeenCalledExactlyOnceWith({ defaultDoubleBond: "centred" });
  stop();
  window.dispatchEvent(new StorageEvent("storage", { key: DRAWING_SETTINGS_STORAGE_KEY }));
  expect(handler).toHaveBeenCalledTimes(1);
});

describe.each(["MacIntel", "Win32"])("native drawing preference sync on %s", platform => {
  it("validates incoming events, broadcasts and tears down", async () => {
    vi.stubGlobal("navigator", { platform }); vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.listen.mockResolvedValue(native.unlisten);
    const handler = vi.fn(), stop = await listenForDrawingSettings(handler);
    expect(native.listen).toHaveBeenCalledWith(DRAWING_SETTINGS_EVENT, expect.any(Function));
    const callback = native.listen.mock.calls.at(-1)![1];
    callback({ payload: { defaultDoubleBond: "invalid" } });
    expect(handler).not.toHaveBeenCalled();
    callback({ payload: { defaultDoubleBond: "centred" } });
    expect(handler).toHaveBeenCalledExactlyOnceWith({ defaultDoubleBond: "centred" });
    await broadcastDrawingSettings({ defaultDoubleBond: "offset" });
    expect(native.emit).toHaveBeenCalledWith(DRAWING_SETTINGS_EVENT, { defaultDoubleBond: "offset" });
    stop(); expect(native.unlisten).toHaveBeenCalledTimes(1);
  });
});
