import { afterEach, describe, expect, it, vi } from "vitest";
import { observeNativePaletteFrames, readNativePaletteFrames, type NativePaletteFrames } from "./useNativePaletteFrames";

const native = vi.hoisted(() => ({ windows: vi.fn(), current: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getAllWindows: native.windows, getCurrentWindow: native.current }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("native palette frame observation", () => {
  it("samples only while expanded and still permits event refreshes when collapsed", async () => {
    vi.useFakeTimers();
    const snapshot: NativePaletteFrames = { frames: [], documentOrigin: { x: 0, y: 0 }, scale: 1 };
    const read = vi.fn(async () => snapshot);
    const publish = vi.fn();
    let observer = observeNativePaletteFrames(publish, read);
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(1);
    observer.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    observer.stop();
    observer = observeNativePaletteFrames(publish, read, true);
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledTimes(5);
    observer.stop();
    observer = observeNativePaletteFrames(publish, read);
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(6);
    observer.stop();
  });
  it.each([1, 1.25, 1.5, 2])("reads physical frames at document scale %s, excluding hidden, minimized and closed windows", async scale => {
    const utility = (label: string, visible = true, minimized = false) => ({ label,
      isVisible: async () => visible, isMinimized: async () => minimized,
      outerPosition: async () => ({ x: -1200, y: 100 }), outerSize: async () => ({ width: 300, height: 400 }) });
    native.current.mockReturnValue({ label: "main", innerPosition: async () => ({ x: -1400, y: 50 }), scaleFactor: async () => scale });
    native.windows.mockResolvedValue([
      utility("main"), utility("toolset-core-art"), utility("toolset-core-drawn-structure-settings"),
      utility("toolset-popover-core-art"), utility("plugin-panel-demo"),
      utility("toolset-hidden", false), utility("plugin-panel-minimized", true, true),
      utility("toolset-tooltip"), utility("preferences"), utility("spin3d-debugger"), utility("dialog-main-export-1"),
      utility("dialog-main-hidden-1", false), utility("preferences", true, true),
      utility("spin3d-debugger", false), utility("dialog-other-export-1"), utility("unrelated"),
      { ...utility("toolset-closed"), outerPosition: async () => { throw new Error("Closed"); } }
    ]);
    expect(await readNativePaletteFrames()).toEqual({ documentOrigin: { x: -1400, y: 50 }, scale,
      frames: Array.from({ length: 7 }, () => ({ x: -1200, y: 100, width: 300, height: 400 })) });
  });

  it("refreshes a collapsed overlay once after a throttled burst, without further events", async () => {
    vi.useFakeTimers();
    let snapshot: NativePaletteFrames = { frames: [], documentOrigin: { x: 0, y: 0 }, scale: 1 };
    const read = vi.fn(async () => snapshot);
    const publish = vi.fn();
    const observer = observeNativePaletteFrames(publish, read);
    await vi.advanceTimersByTimeAsync(100);
    snapshot = { ...snapshot, frames: [{ x: 10, y: 20, width: 300, height: 400 }] };
    for (let i = 0; i < 20; i++) observer.refresh();
    await vi.advanceTimersByTimeAsync(149);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(snapshot);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    observer.stop();
  });

  it.each([100, 600])("queues one nonoverlapping trailing read after an in-flight read taking %s ms", async duration => {
    vi.useFakeTimers();
    const snapshot: NativePaletteFrames = { frames: [], documentOrigin: { x: 0, y: 0 }, scale: 1 };
    let finish!: (snapshot: NativePaletteFrames) => void;
    const read = vi.fn(() => new Promise<NativePaletteFrames>(resolve => { finish = resolve; }));
    const observer = observeNativePaletteFrames(vi.fn(), read);
    for (let i = 0; i < 20; i++) observer.refresh();
    await vi.advanceTimersByTimeAsync(duration);
    expect(read).toHaveBeenCalledTimes(1);
    finish(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    if (duration < 250) {
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(249 - duration);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(read).toHaveBeenCalledTimes(2);
    finish(snapshot);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    observer.stop();
  });

  it("cancels a scheduled trailing refresh on teardown", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async (): Promise<NativePaletteFrames> => ({ frames: [], documentOrigin: { x: 0, y: 0 }, scale: 1 }));
    const observer = observeNativePaletteFrames(vi.fn(), read);
    await vi.advanceTimersByTimeAsync(100);
    observer.refresh();
    observer.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("coalesces move/resize events to four samples per second and notices show, hide and close without events", async () => {
    vi.useFakeTimers();
    let snapshot: NativePaletteFrames = { frames: [], documentOrigin: { x: 0, y: 0 }, scale: 1 };
    const read = vi.fn(async () => snapshot);
    const publish = vi.fn();
    const observer = observeNativePaletteFrames(publish, read, true);
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
    const observer = observeNativePaletteFrames(publish, read, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    observer.stop();
    finish({ frames: [], documentOrigin: { x: 0, y: 0 }, scale: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).not.toHaveBeenCalled();
  });
});
