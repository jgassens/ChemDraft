// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "./testSupport/memoryStorage";
import {
  broadcastPluginUpdateSettings, listenForPluginUpdateSettings, loadAutomaticPluginUpdates,
  PLUGIN_UPDATE_SETTINGS_KEY, saveAutomaticPluginUpdates
} from "./pluginUpdateSettings";

const native = vi.hoisted(() => ({ desktop: false, emit: vi.fn(async () => {}), listen: vi.fn() }));
vi.mock("./window-manager", () => ({ isDesktopRuntime: () => native.desktop }));
vi.mock("@tauri-apps/api/event", () => ({ emit: native.emit }));
vi.mock("./window-manager/tauriEvents", () => ({ listenTauriEvent: native.listen }));

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  native.desktop = false;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe("automatic plugin update preference", () => {
  it("defaults on and persists opt-out and opt-in", () => {
    expect(loadAutomaticPluginUpdates()).toBe(true);
    saveAutomaticPluginUpdates(false);
    expect(loadAutomaticPluginUpdates()).toBe(false);
    expect(localStorage.getItem(PLUGIN_UPDATE_SETTINGS_KEY)).toBe("false");
    saveAutomaticPluginUpdates(true);
    expect(loadAutomaticPluginUpdates()).toBe(true);
    localStorage.setItem(PLUGIN_UPDATE_SETTINGS_KEY, "malformed");
    expect(loadAutomaticPluginUpdates()).toBe(true);
  });

  it("uses the default when storage throws and tolerates failed writes", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(loadAutomaticPluginUpdates()).toBe(true);
    expect(() => saveAutomaticPluginUpdates(false)).not.toThrow();
  });

  it("delivers same-window changes and removes the DOM listener", async () => {
    const handler = vi.fn();
    const stop = await listenForPluginUpdateSettings(handler);
    await broadcastPluginUpdateSettings(false);
    expect(handler).toHaveBeenCalledWith(false);
    expect(native.emit).not.toHaveBeenCalled();
    stop();
    await broadcastPluginUpdateSettings(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(["macos", "windows"])("broadcasts and receives live changes through Tauri on %s", async () => {
    native.desktop = true;
    const stopNative = vi.fn();
    native.listen.mockResolvedValue(stopNative);
    const handler = vi.fn();
    const stop = await listenForPluginUpdateSettings(handler);
    await broadcastPluginUpdateSettings(false);
    expect(native.emit).toHaveBeenCalledWith("chemdraft://plugin-update-settings", false);
    const listener = native.listen.mock.calls[0]![1];
    listener({ payload: true });
    listener({ payload: "invalid" });
    expect(handler.mock.calls).toEqual([[false], [true]]);
    stop();
    expect(stopNative).toHaveBeenCalledOnce();
  });
});
