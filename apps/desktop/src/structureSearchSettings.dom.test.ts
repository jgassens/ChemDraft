// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { useStructureSearchEnabled } from "./structureSearchSettings";
import { UNLISTEN_RETRY_MS } from "./window-manager/tauriEvents";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["MacIntel", "Win32"])("safely releases a pending search preference listener on %s", async platform => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { platform });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  native.invoke.mockReset().mockResolvedValue(undefined);
  let attach!: (stop: UnlistenFn) => void;
  let callback!: EventCallback<{ enabled: boolean }>;
  native.listen.mockImplementation((_name, handler) => {
    callback = handler;
    return new Promise<UnlistenFn>(resolve => { attach = resolve; });
  });
  function Surface() {
    return createElement("output", null, String(useStructureSearchEnabled()));
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  let mounted = true;
  try {
    await act(async () => root.render(createElement(Surface)));
    expect(native.listen).toHaveBeenCalledWith("chemdraft://structure-search-settings", expect.any(Function));
    await act(async () => callback({ event: "settings", id: 1, payload: { enabled: false } }));
    expect(container.textContent).toBe("false");
    expect(native.invoke).toHaveBeenLastCalledWith("set_structure_search_enabled", { enabled: false });
    await act(async () => root.unmount());
    mounted = false;
    native.invoke.mockClear();
    const stop = vi.fn().mockRejectedValueOnce(new Error("native listener entry is pending")).mockResolvedValue(undefined);
    await act(async () => { attach(stop); });
    expect(stop).toHaveBeenCalledTimes(1);
    callback({ event: "settings", id: 1, payload: { enabled: true } });
    expect(native.invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(UNLISTEN_RETRY_MS);
    expect(stop).toHaveBeenCalledTimes(2);
  } finally {
    if (mounted) await act(async () => root.unmount());
  }
});
