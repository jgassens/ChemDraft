import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), handler: undefined as (() => void) | undefined, stop: vi.fn()
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./tauriEvents", () => ({
  listenCurrentWindowEvent: vi.fn(async (_event: string, handler: () => void) => { mocks.handler = handler; return mocks.stop; })
}));
import { canPersistCurrentToolsetSize, togglePreferencesWindow, showAboutDialog } from "./index";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("native palette dialog lifecycle", () => {
  it("keeps Preferences pending until the native close notification", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    mocks.invoke.mockResolvedValue(true);
    let finished = false;
    const opened = togglePreferencesWindow().then(() => { finished = true; });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("toggle_preferences_window"));
    expect(finished).toBe(false);
    mocks.handler!(); await opened;
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });
  it("finishes when an already-visible Preferences window is toggled closed", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    mocks.invoke.mockResolvedValue(false);
    await togglePreferencesWindow();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });
  it("cleans up the Preferences listener when native opening fails", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    mocks.invoke.mockRejectedValue(new Error("native failed"));
    await expect(togglePreferencesWindow()).rejects.toThrow("native failed");
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });
  it("asks Rust for the palette, Windows owner and quit persistence decision", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    mocks.invoke.mockResolvedValue(false);
    expect(await canPersistCurrentToolsetSize()).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("can_persist_toolset_size");
  });
  it("awaits the native About close before resolving", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    let close!: () => void;
    mocks.invoke.mockImplementation(() => new Promise<void>((resolve) => { close = resolve; }));
    let finished = false;
    const opened = showAboutDialog().then(() => { finished = true; });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("show_about_dialog"));
    expect(finished).toBe(false); close(); await opened; expect(finished).toBe(true);
  });
});
