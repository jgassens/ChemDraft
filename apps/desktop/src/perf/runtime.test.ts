// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { probeRequested } from "./gate";
import { alignEventTime, calibrateClock, perfProbe, probePlatform, startPerfProbe, windowRole } from "./runtime";
import { PerfRecordSchema } from "./probe";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => { vi.stubGlobal("localStorage", new MemoryStorage()); });

afterEach(() => {
  perfProbe?.stop(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  delete (window as Window & { __CHEMDRAFT_PERF_ALLOWED__?: boolean }).__CHEMDRAFT_PERF_ALLOWED__;
  history.replaceState({}, "", "/"); invoke.mockReset();
});

describe("probe gate and cross-webview clocks", () => {
  it("uses exclusively the authoritative native gate on desktop and existing browser gate on web", () => {
    expect(probeRequested(true, false, "?agentBridge=1", "1")).toBe(false);
    expect(probeRequested(true, true, "")).toBe(true);
    expect(probeRequested(false, false, "")).toBe(false);
    expect(probeRequested(false, false, "?perfProbe=1")).toBe(false);
    expect(probeRequested(false, false, "?agentBridge=1")).toBe(true);
    expect(probeRequested(false, false, "", "1")).toBe(true);
  });
  it.each(["web", "desktop"])("off registers no %s listeners, observers, timers, writes, or invokes", async runtime => {
    if (runtime === "desktop") vi.stubGlobal("__TAURI_INTERNALS__", {});
    const listen = vi.spyOn(window, "addEventListener");
    const timeout = vi.spyOn(window, "setTimeout");
    const write = vi.spyOn(localStorage, "setItem");
    const observer = vi.fn(); vi.stubGlobal("MutationObserver", observer);
    await startPerfProbe();
    expect(listen).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
  it("on writes valid JSON lines via the native append command", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    Object.defineProperty(window, "__CHEMDRAFT_PERF_ALLOWED__", { configurable: true, value: true });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    invoke.mockImplementation(async (command: string) => command === "perf_log_clock" ? { now: 1700000000000, processStart: 1699999999000 } : undefined);
    await startPerfProbe(); perfProbe!.readyCanvas(); frames.splice(0).forEach(callback => callback(0));
    await vi.waitFor(() => expect(invoke.mock.calls.some(call => call[0] === "perf_log_append")).toBe(true));
    const written = invoke.mock.calls.find(call => call[0] === "perf_log_append")![1] as { line: string };
    expect(PerfRecordSchema.parse(JSON.parse(written.line))).toMatchObject({ kind: "cold-launch", v: 1, window: "main" });
    expect(invoke.mock.calls.filter(call => call[0] === "perf_log_clock")).toHaveLength(3);
  });
  it("web uses the existing storage gate and writes JSONL without native invokes", async () => {
    localStorage.setItem("chemdraft.agentBridge", "1");
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    await startPerfProbe(); perfProbe!.readyCanvas(); frames.splice(0).forEach(callback => callback(0));
    const lines = localStorage.getItem("chemdraft.perfLog")!.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(PerfRecordSchema.parse(JSON.parse(lines[0])).kind).toBe("cold-launch");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("exercises Mac and Windows platform values from one host", () => {
    expect(probePlatform("macos")).toBe("macos"); expect(probePlatform("windows")).toBe("windows");
    expect(probePlatform("linux")).toBe("linux");
  });
  it("labels every recording window role", () => {
    for (const [query, role] of [["", "main"], ["?window=toolset", "palette"], ["?window=toolsetPopover", "palette-popover"], ["?window=toolsetTooltip", "palette-popover"], ["?window=dialog", "dialog"], ["?window=preferences", "dialog"], ["?window=pluginPanel", "plugin-panel"], ["?window=spin3d-debugger", "plugin-panel"]]) expect(windowRole(query)).toBe(role);
  });
  it("aligns relative and legacy epoch event timestamps without sampling wall time per event", () => {
    expect(alignEventTime(42, 1700000000000, 1700000000100)).toBe(1700000000142);
    expect(alignEventTime(1700000000042, 1700000000000, 1700000000100)).toBe(1700000000142);
  });
  it("uses the minimum RTT midpoint to align different webviews to one monotonic clock", async () => {
    const clock = vi.fn().mockResolvedValueOnce({ now: 1010, processStart: 500 }).mockResolvedValueOnce({ now: 1021, processStart: 500 }).mockResolvedValueOnce({ now: 1040, processStart: 500 });
    const samples = [0, 20, 20, 22, 22, 58];
    const aligned = await calibrateClock(() => samples.shift()!, clock);
    expect(aligned).toEqual({ offset: 1000, error: 1, processStart: 500 });
    const other = await calibrateClock(() => 100, async () => ({ now: 1100, processStart: 500 }));
    expect(42 + aligned.offset).toBe(42 + other.offset);
  });
});
