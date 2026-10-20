// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { loadResizableToolbarSettings, saveResizableToolbarSettings, resetPaletteFrames, listenForPaletteFrameResets, broadcastResizableToolbarSettings, listenForResizableToolbarSettings } from "./resizableToolbarSettings";

vi.mock("./window-manager", () => ({ isDesktopRuntime: () => false }));
let storage: MemoryStorage;
beforeEach(() => { storage = new MemoryStorage(); vi.stubGlobal("localStorage", storage); });
afterEach(() => vi.unstubAllGlobals());

describe("resizable toolbar preferences and resets", () => {
  it("defaults off for missing, corrupt, or invalid settings", () => {
    expect(loadResizableToolbarSettings()).toEqual({ enabled: false });
    for (const value of ["{", "null", '{"enabled":"true"}']) {
      storage.setItem("chemdraft.resizable-toolbars.v1", value);
      expect(loadResizableToolbarSettings()).toEqual({ enabled: false });
    }
    saveResizableToolbarSettings({ enabled: true });
    expect(loadResizableToolbarSettings()).toEqual({ enabled: true });
  });

  it("delivers live preference changes and detaches listeners", async () => {
    const handler = vi.fn();
    const stop = await listenForResizableToolbarSettings(handler);
    await broadcastResizableToolbarSettings({ enabled: true });
    expect(handler).toHaveBeenCalledWith({ enabled: true });
    stop();
    await broadcastResizableToolbarSettings({ enabled: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("clears only committed selected frames, and Reset All includes closed palettes", async () => {
    storage.setItem("chemdraft.palette.frame.v1.core.main", "main");
    storage.setItem("chemdraft.palette.frame.v1.core.closed", "closed");
    storage.setItem("other", "keep");
    const handler = vi.fn();
    const stop = await listenForPaletteFrameResets(handler);
    await resetPaletteFrames(["core.main"]);
    expect(storage.getItem("chemdraft.palette.frame.v1.core.main")).toBeNull();
    expect(storage.getItem("chemdraft.palette.frame.v1.core.closed")).toBe("closed");
    expect(handler).toHaveBeenLastCalledWith(["core.main"]);
    await resetPaletteFrames("all");
    expect(storage.getItem("chemdraft.palette.frame.v1.core.closed")).toBeNull();
    expect(storage.getItem("other")).toBe("keep");
    expect(handler).toHaveBeenLastCalledWith("all");
    stop();
  });
});
