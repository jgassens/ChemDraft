import { afterEach, describe, expect, it, vi } from "vitest";
import { observeNativePaletteFrames, readNativePaletteFrames, type NativePaletteFrames } from "./useNativePaletteFrames";

const native = vi.hoisted(() => ({ windows: vi.fn(), current: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getAllWindows: native.windows, getCurrentWindow: native.current }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("native palette frame observation", () => {
  it.each([1, 1.25, 1.5, 2])("reads physical frames at document scale %s, excluding hidden, minimized and closed windows", async scale => {
    const utility = (label: string, visible = true, minimized = false) => ({ label,
      isVisible: async () => visible, isMinimized: async () => minimized,
      outerPosition: async () => ({ x: -1200, y: 100 }), outerSize: async () => ({ width: 300, height: 400 }) });
    native.current.mockReturnValue({ label: "main", innerPosition: async () => ({ x: -1400, y: 50 }), scaleFactor: async () => scale });
    native.windows.mockResolvedValue([
      utility("main"), utility("toolset-core-art"), utility("toolset-core-drawn-structure-settings"),
      utility("toolset-popover-core-art"), utility("plugin-panel-demo"),
      utility("toolset-hidden", false), utility("plugin-panel-minimized", true, true),
      utility("toolset-tooltip"), utility("preferences"),
      { ...utility("toolset-closed"), outerPosition: async () => { throw new Error("Closed"); } }
    ]);
    expect(await readNativePaletteFrames()).toEqual({ documentOrigin: { x: -1400, y: 50 }, scale,
      frames: Array.from({ length: 4 }, () => ({ x: -1200, y: 100, width: 300, height: 400 })) });
  });

  it("coalesces move/resize events to four samples per second and notices show, hide and close without events", async () => {
    vi.useFakeTimers();
    let snapshot: NativePaletteFrames = { frames: [], documentOrigin: { x: 0, y: 0 }, scale: 1 };
    const read = vi.fn(async () => snapshot);
    const publish = vi.fn();
    const observer = observeNativePaletteFrames(publish, read);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i++) observer.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    snapshot = { ...snapshot, frames: [{ x: 200, y: 100, width: 300, height: 400 }] };
    await vi.advanceTimersByTimeAsync(250);
    expect(publish).toHaveBeenLastCalledWith(snapshot);
    snapshot = { ...snapshot, frames: [{ ...snapshot.frames[0]!, x: 250, width: 350 }] };
    await vi.advanceTimersByTimeAsync(250);
    expect(publish).toHaveBeenLastCalledWith(snapshot);
    snapshot = { ...snapshot, frames: [] };
    await vi.advanceTimersByTimeAsync(250);
    expect(publish).toHaveBeenLastCalledWith(snapshot);
    await vi.advanceTimersByTimeAsync(249);
    expect(read).toHaveBeenCalledTimes(4);
    expect(publish).toHaveBeenCalledTimes(4);
    observer.stop();
    await vi.advanceTimersByTimeAsync(1000);
    observer.refresh();
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("does not overlap slow reads or publish a pending read after teardown", async () => {
    vi.useFakeTimers();
    let finish!: (snapshot: NativePaletteFrames) => void;
    const read = vi.fn(() => new Promise<NativePaletteFrames>(resolve => { finish = resolve; }));
    const publish = vi.fn();
    const observer = observeNativePaletteFrames(publish, read);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    observer.stop();
    finish({ frames: [], documentOrigin: { x: 0, y: 0 }, scale: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).not.toHaveBeenCalled();
  });
});
