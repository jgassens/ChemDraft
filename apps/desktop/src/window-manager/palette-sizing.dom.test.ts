// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentWindowLogicalWorkArea, fitCurrentPaletteWindow } from "./index";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  currentMonitor: vi.fn(),
  setSize: vi.fn(),
  position: { x: 100, y: 100 }
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor: native.currentMonitor,
  getCurrentWindow: () => ({ setSize: native.setSize }),
  LogicalSize: class {
    constructor(public width: number, public height: number) {}
  }
}));

describe("palette work-area sizing", () => {
  beforeEach(() => {
    vi.stubGlobal("__TAURI__", {});
    native.position = { x: 100, y: 100 };
    native.setSize.mockReset().mockResolvedValue(undefined);
    native.currentMonitor.mockReset();
    native.invoke.mockReset().mockImplementation(async (command, payload) => {
      if (command === "window_logical_position") return { ...native.position };
      if (command === "set_current_window_global_position") native.position = { ...payload };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([1, 1.5, 2])("uses the monitor's own scale (%s) and excludes OS chrome", async (scaleFactor) => {
    native.currentMonitor.mockResolvedValue({
      scaleFactor,
      position: { x: -1920 * scaleFactor, y: 0 },
      size: { width: 1920 * scaleFactor, height: 1080 * scaleFactor },
      workArea: {
        position: { x: -1920 * scaleFactor, y: 24 * scaleFactor },
        size: { width: 1920 * scaleFactor, height: 1016 * scaleFactor }
      }
    });
    expect(await currentWindowLogicalWorkArea()).toEqual({ left: -1920, top: 24, right: 0, bottom: 1040 });
  });

  it("uses available screen dimensions when the monitor query fails", async () => {
    native.currentMonitor.mockRejectedValue(new Error("No monitor"));
    vi.spyOn(window.screen, "availHeight", "get").mockReturnValue(720);
    vi.spyOn(window.screen, "availWidth", "get").mockReturnValue(1280);
    expect(await currentWindowLogicalWorkArea()).toEqual({ left: 0, top: 0, right: 1280, bottom: 720 });
  });

  it("caps an oversized inspector and moves its entire frame into the work area", async () => {
    native.position = { x: 1500, y: 700 };
    await fitCurrentPaletteWindow({ width: 553, height: 1214 }, { left: 0, top: 24, right: 1920, bottom: 1040 });
    expect(native.setSize).toHaveBeenCalledWith({ width: 553, height: 1016 });
    expect(native.invoke).toHaveBeenCalledWith("set_current_window_global_position", { x: 1367, y: 24 });
  });

  it("restores the top-left when a native resize shifts the window's top edge", async () => {
    native.setSize.mockImplementation(async () => { native.position.y = -200; });
    await fitCurrentPaletteWindow({ width: 520, height: 600 }, { left: 0, top: 24, right: 1920, bottom: 1040 });
    expect(native.invoke).toHaveBeenCalledWith("set_current_window_global_position", { x: 100, y: 100 });
  });

  it("does not move a window whose resized frame already fits", async () => {
    await fitCurrentPaletteWindow({ width: 520, height: 600 }, { left: 0, top: 24, right: 1920, bottom: 1040 });
    expect(native.setSize).toHaveBeenCalledWith({ width: 520, height: 600 });
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual([
      "window_logical_position", "window_logical_position"
    ]);
  });
});
