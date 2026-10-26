// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { probeRequested } from "./gate";
import { afterPaint, alignEventTime, calibrateClock, perfProbe, probePlatform, startPerfProbe, windowRole } from "./runtime";
import { PerfRecordSchema } from "./probe";
import { readFileSync } from "node:fs";
import toolsets from "../toolsets/desktop-toolsets.json";

const source = readFileSync("apps/desktop/src/MainWindow.tsx", "utf8");
const sourceStamp = source.match(/^const CURRENT_BUILD_STAMP = "([^"]+)";$/m)![1];

const { invoke, subscribePopover } = vi.hoisted(() => ({ invoke: vi.fn(), subscribePopover: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../window-manager", () => ({ listenForToolsetPopoverContent: subscribePopover }));
beforeEach(() => {
  subscribePopover.mockResolvedValue(() => {});
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("MessageChannel", class {
    port1 = { onmessage: undefined as (() => void) | undefined, close() {} };
    port2 = { postMessage: () => { void Promise.resolve().then(() => this.port1.onmessage?.()); }, close() {} };
  });
});

afterEach(() => {
  perfProbe?.stop(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  delete (window as Window & { __CHEMDRAFT_PERF_ALLOWED__?: boolean }).__CHEMDRAFT_PERF_ALLOWED__;
  history.replaceState({}, "", "/"); invoke.mockReset();
});

describe("probe gate and cross-webview clocks", () => {
  it("posts a MessageChannel task after rAF, including a 40 ms rendering turn", () => {
    const tasks: (() => void)[] = [];
    vi.stubGlobal("MessageChannel", class {
      port1 = { onmessage: () => {}, close() {} };
      port2 = { postMessage: () => { tasks.push(() => this.port1.onmessage()); }, close() {} };
    });
    let now = 16; let stamp: number | undefined;
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frame = callback; return 1; });
    window.requestAnimationFrame(() => afterPaint(() => { stamp = now; }));
    frame!(16); now += 40;
    expect(stamp).toBeUndefined();
    tasks.splice(0).forEach(callback => callback());
    expect(stamp).toBe(56);
  });
  it("uses a bound zero-delay timeout when MessageChannel is unavailable", () => {
    vi.stubGlobal("MessageChannel", undefined);
    const callback = vi.fn();
    vi.stubGlobal("setTimeout", function (this: unknown, handler: () => void, delay: number) {
      expect(this).toBe(window); expect(delay).toBe(0);
      handler(); return 1;
    });
    afterPaint(callback); expect(callback).toHaveBeenCalledOnce();
  });
  it.each([["core.drawnStructureSettings", "settings"], ["core.main", "toolset"]])(
    "records a cold %s open in its real role, once, with the originating ID and actual FCP", async (toolsetId, role) => {
      history.replaceState({}, "", `/?window=toolset&toolsetId=${toolsetId}`);
      vi.stubGlobal("__TAURI_INTERNALS__", {});
      Object.defineProperty(window, "__CHEMDRAFT_PERF_ALLOWED__", { configurable: true, value: true });
      let now = 0;
      vi.spyOn(window.performance, "now").mockImplementation(() => now);
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      let paint!: (entries: { getEntries(): { name: string; startTime: number }[] }) => void;
      vi.stubGlobal("PerformanceObserver", class {
        static supportedEntryTypes = ["paint"];
        constructor(callback: typeof paint) { paint = callback; }
        observe() {}
      });
      const nativeOpen = { target: `toolset:${toolsetId}`, inputId: "origin-input-1", t0: 1000, shownAt: 1228, commandId: "tool.settings", cold: true };
      invoke.mockImplementation(async (command: string) => command === "perf_log_clock"
        ? { now: 1000, processStart: 500, buildStamp: "one label", nativeOpen } : undefined);
      const root = document.createElement("div"); root.id = "root"; document.body.append(root);
      await startPerfProbe();
      root.innerHTML = "<section>Window content</section>";
      await Promise.resolve();
      expect(frames).toHaveLength(0); // A content commit is insufficient before the cold FCP.
      paint({ getEntries: () => [{ name: "first-contentful-paint", startTime: 766 }] });
      now = 770; frames.splice(0).forEach(callback => callback(770));
      now = 810;
      await vi.waitFor(() => expect(invoke.mock.calls.filter(call => call[0] === "perf_log_append")).toHaveLength(1));
      const row = JSON.parse(invoke.mock.calls.find(call => call[0] === "perf_log_append")![1].line);
      expect(row).toMatchObject({ window: role, doneSignal: "window-painted", doneMs: 766,
        windowShownMs: 228, rafStartMs: 770, firstFrameMs: 810, extra: { inputId: "origin-input-1", paintMethod: "first-contentful-paint" } });
      window.dispatchEvent(new CustomEvent("chemdraft:perf-open", { detail: nativeOpen }));
      root.append(document.createElement("p")); await Promise.resolve();
      expect(frames).toHaveLength(0);
      root.remove();
    }
  );
  it.each(["preferences", "spin3d-debugger"])("a fast-calibrating cold %s waits for its registered intent's show receipt", async role => {
    history.replaceState({}, "", `/?window=${role}`);
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    Object.defineProperty(window, "__CHEMDRAFT_PERF_ALLOWED__", { configurable: true, value: true });
    vi.stubGlobal("PerformanceObserver", undefined);
    const request = { target: role, inputId: "cold-toggle", t0: 1000, cold: true };
    invoke.mockImplementation(async (command: string) => command === "perf_log_clock"
      ? { now: 1100, processStart: 500, buildStamp: "test", nativeOpen: request } : undefined);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const root = document.createElement("div"); root.id = "root";
    root.innerHTML = "<section>Cold content</section>"; document.body.append(root);
    try {
      await startPerfProbe(); // Calibration completes before the toggle/state query.
      expect(frames).toHaveLength(0);
      expect(invoke.mock.calls.filter(call => call[0] === "perf_log_append")).toHaveLength(0);
      window.dispatchEvent(new CustomEvent("chemdraft:perf-open", { detail: { ...request, shownAt: 1100 } }));
      expect(frames).toHaveLength(1);
      frames.splice(0).forEach(callback => callback(0));
      await vi.waitFor(() => expect(invoke.mock.calls.filter(call => call[0] === "perf_log_append")).toHaveLength(1));
      const row = JSON.parse(invoke.mock.calls.find(call => call[0] === "perf_log_append")![1].line);
      expect(row).toMatchObject({ kind: "window-shown", window: role, doneSignal: "window-painted", extra: { inputId: "cold-toggle" } });
    } finally { root.remove(); }
  });
  it("receives a native show receipt while the toolbar transport is still loading", async () => {
    history.replaceState({}, "", "/?window=toolset&toolsetId=core.main");
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    Object.defineProperty(window, "__CHEMDRAFT_PERF_ALLOWED__", { configurable: true, value: true });
    const request = { target: "toolset:core.main", inputId: "loading-transport", t0: 1000, cold: false };
    invoke.mockImplementation(async (command: string) => command === "perf_log_clock"
      ? { now: 2000, processStart: 500, buildStamp: "test", nativeOpen: request } : undefined);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let subscribed!: (stop: () => void) => void;
    subscribePopover.mockImplementationOnce(() => new Promise(resolve => { subscribed = resolve; }));
    const root = document.createElement("div"); root.id = "root"; document.body.append(root);
    const starting = startPerfProbe();
    await vi.waitFor(() => expect(subscribed).toBeDefined());
    window.dispatchEvent(new CustomEvent("chemdraft:perf-open", { detail: { ...request, shownAt: 1500 } }));
    subscribed(() => {}); await starting;
    root.innerHTML = "<section>Loaded toolbar</section>"; await Promise.resolve();
    frames.splice(0).forEach(callback => callback(0));
    await vi.waitFor(() => expect(invoke.mock.calls.some(call => call[0] === "perf_log_append")).toBe(true));
    const row = JSON.parse(invoke.mock.calls.find(call => call[0] === "perf_log_append")![1].line);
    expect(row).toMatchObject({ window: "toolset", windowShownMs: 500, extra: { inputId: "loading-transport" } });
    root.remove();
  });
  it("writes cold launch before input with WebKit-style receiver checks on browser globals", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    Object.defineProperty(window, "__CHEMDRAFT_PERF_ALLOWED__", { configurable: true, value: true });
    const frames = new Map<number, FrameRequestCallback>();
    const timers = new Set<number>();
    let id = 0;
    const check = (receiver: unknown) => {
      if (receiver !== window) throw new TypeError("Can only call Window method on instances of Window");
    };
    vi.stubGlobal("setTimeout", function (this: unknown) { check(this); timers.add(++id); return id; });
    vi.stubGlobal("clearTimeout", function (this: unknown, key: number) { check(this); timers.delete(key); });
    vi.stubGlobal("requestAnimationFrame", function (this: unknown, callback: FrameRequestCallback) {
      check(this); frames.set(++id, callback); return id;
    });
    vi.stubGlobal("cancelAnimationFrame", function (this: unknown, key: number) { check(this); frames.delete(key); });
    vi.stubGlobal("queueMicrotask", function (this: unknown, callback: () => void) { check(this); callback(); });
    for (const method of ["addEventListener", "removeEventListener"] as const) {
      const original = window[method].bind(window);
      vi.spyOn(window, method).mockImplementation(function (this: unknown, ...args: Parameters<typeof original>) {
        check(this); original(args[0], args[1], args[2]);
      });
    }
    const originalNow = window.performance.now.bind(window.performance);
    vi.spyOn(window.performance, "now").mockImplementation(function (this: unknown) {
      if (this !== window.performance) throw new TypeError("Illegal invocation of performance.now");
      return originalNow();
    });
    invoke.mockImplementation(async (command: string) => command === "perf_log_clock"
      ? { now: 1700000000000, processStart: 1699999999000 } : undefined);
    await startPerfProbe(sourceStamp);
    // This is the startup hydration hook; no pointer or command event has occurred.
    perfProbe!.readyCanvas();
    const launchFrames = [...frames.values()]; frames.clear();
    for (const callback of launchFrames) callback(0);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const rows = invoke.mock.calls.filter(call => call[0] === "perf_log_append");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0][1].line)).toMatchObject({ kind: "cold-launch", doneSignal: "canvas-ready" });
    expect(timers.size).toBe(0);
    // Exercise deferred input frames, cancellation and event listener teardown as well.
    window.dispatchEvent(new CustomEvent("chemdraft:native-command", { detail: { commandId: "test.input" } }));
    perfProbe!.rendered(); perfProbe!.rendered(); perfProbe!.stop();
    expect(timers.size).toBe(0);
    expect(frames.size).toBe(0);
  });
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
    await startPerfProbe(sourceStamp);
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
    await startPerfProbe(sourceStamp); perfProbe!.readyCanvas(); frames.splice(0).forEach(callback => callback(0));
    await vi.waitFor(() => expect(invoke.mock.calls.some(call => call[0] === "perf_log_append")).toBe(true));
    const written = invoke.mock.calls.find(call => call[0] === "perf_log_append")![1] as { line: string };
    expect(PerfRecordSchema.parse(JSON.parse(written.line))).toMatchObject({ kind: "cold-launch", v: 3, window: "main", buildStamp: `${sourceStamp} · test` });
    // The test build stamp contains the worktree label "test" already.
    expect(JSON.parse(written.line).buildStamp.match(/test/g)).toHaveLength(1);
    expect(invoke.mock.calls.filter(call => call[0] === "perf_log_clock").map(call => call[1])).toEqual([
      { buildStamp: `${sourceStamp} · test` }, { buildStamp: undefined }, { buildStamp: undefined }
    ]);
  });
  it("web uses the existing storage gate and writes JSONL without native invokes", async () => {
    localStorage.setItem("chemdraft.agentBridge", "1");
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    await startPerfProbe(sourceStamp); perfProbe!.readyCanvas(); frames.splice(0).forEach(callback => callback(0));
    await Promise.resolve();
    const lines = localStorage.getItem("chemdraft.perfLog")!.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(PerfRecordSchema.parse(JSON.parse(lines[0])).kind).toBe("cold-launch");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("dialog rows use the main stamp returned by Rust without registering their own", async () => {
    history.replaceState({}, "", "/?window=dialog");
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    Object.defineProperty(window, "__CHEMDRAFT_PERF_ALLOWED__", { configurable: true, value: true });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const buildStamp = `${sourceStamp} · test`;
    invoke.mockImplementation(async (command: string) => command === "perf_log_clock"
      ? { now: 1700000000000, processStart: 1699999999000, buildStamp } : undefined);
    await startPerfProbe();
    window.dispatchEvent(new CustomEvent("chemdraft:native-command", { detail: { commandId: "test.dialog" } }));
    perfProbe!.dispatchReturned(perfProbe!.command("test.dialog"));
    await Promise.resolve();
    frames.splice(0).forEach(callback => callback(0));
    await vi.waitFor(() => expect(invoke.mock.calls.some(call => call[0] === "perf_log_append")).toBe(true));
    const written = invoke.mock.calls.find(call => call[0] === "perf_log_append")![1] as { line: string };
    expect(PerfRecordSchema.parse(JSON.parse(written.line))).toMatchObject({ window: "dialog", buildStamp });
    expect(invoke.mock.calls.filter(call => call[0] === "perf_log_clock").every(call => call[1].buildStamp === undefined)).toBe(true);
  });
  it("exercises Mac and Windows platform values from one host", () => {
    expect(probePlatform("macos")).toBe("macos"); expect(probePlatform("windows")).toBe("windows");
    expect(probePlatform("linux")).toBe("linux");
  });
  it("labels every recording window role", () => {
    for (const [query, role] of [["", "main"], ["?window=toolset", "toolset"], ["?window=toolset&toolsetId=core.drawnStructureSettings", "settings"], ["?window=toolsetPopover", "palette-popover"], ["?window=toolsetTooltip", "palette-popover"], ["?window=dialog", "dialog"], ["?window=preferences", "preferences"], ["?window=pluginPanel", "plugin-panel"], ["?window=spin3d-debugger", "spin3d-debugger"]]) expect(windowRole(query)).toBe(role);
  });
  it("uses Rust's creation stamp for startup, and takes a fresh paint after a warm reveal without a DOM change", async () => {
    history.replaceState({}, "", "/?window=preferences");
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    Object.defineProperty(window, "__CHEMDRAFT_PERF_ALLOWED__", { configurable: true, value: true });
    vi.stubGlobal("PerformanceObserver", undefined);
    const root = document.createElement("div"); root.id = "root"; root.innerHTML = "<p>Preferences</p>"; document.body.append(root);
    let now = 100;
    vi.spyOn(window.performance, "now").mockImplementation(() => now);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.push(callback); return frames.length; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    invoke.mockImplementation(async (command: string) => command === "perf_log_clock"
      ? { now: 1000, processStart: 100, createdAt: 500, buildStamp: "creation-test" } : undefined);
    try {
      await startPerfProbe();
      now = 400; frames.splice(0).forEach(callback => callback(0));
      await vi.waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "perf_log_append")).toHaveLength(1));
      const startup = JSON.parse(invoke.mock.calls.find(([name]) => name === "perf_log_append")![1].line);
      expect(startup).toMatchObject({ kind: "startup", doneSignal: "startup-painted", t0: 500, firstFrameMs: 800 });
      window.dispatchEvent(new CustomEvent("chemdraft:perf-open", { detail: { target: "preferences", inputId: "warm-1", t0: 1200, shownAt: 1300, cold: false } }));
      expect(invoke.mock.calls.filter(([name]) => name === "perf_log_append")).toHaveLength(1);
      now = 450; frames.splice(0).forEach(callback => callback(0));
      await vi.waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "perf_log_append")).toHaveLength(2));
      const warm = JSON.parse(invoke.mock.calls.filter(([name]) => name === "perf_log_append")[1][1].line);
      expect(warm).toMatchObject({ kind: "window-shown", doneSignal: "window-painted", t0: 1200, firstFrameMs: 150, doneMs: 150, extra: { inputId: "warm-1", paintMethod: "post-paint-content" } });
    } finally { perfProbe?.stop(); root.remove(); }
  });
  it.each(toolsets.toolsets.flatMap(toolset => ["toolset", "tool-palette"].map(window => ({ id: toolset.id, window }))))
    ("labels $window/$id by its actual toolbar, settings or inspector role", ({ id, window }) => {
      const expected = id === "core.drawnStructureSettings" ? "settings"
        : ["core.art", "core.text", "core.ringInspector", "core.molecularInspector"].includes(id) ? "inspector" : "toolset";
      expect(windowRole(`?window=${window}&toolsetId=${encodeURIComponent(id)}`)).toBe(expected);
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

it("retains the hydration timestamp when native calibration finishes later", async () => {
  vi.resetModules();
  const runtime = await import("./runtime");
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  Object.defineProperty(window, "__CHEMDRAFT_PERF_ALLOWED__", { configurable: true, value: true });
  let now = 0;
  vi.spyOn(window.performance, "now").mockImplementation(() => now);
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.push(callback); return frames.length; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  let release!: (sample: { now: number; processStart: number }) => void;
  invoke.mockImplementation(async (command: string) => command === "perf_log_clock" ? { now: now + 1000, processStart: 500 } : undefined);
  invoke.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const starting = runtime.startPerfProbe("late-calibration");
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(release).toBeDefined();
  now = 20; runtime.perfCanvasReady();
  now = 100; release({ now: 1000, processStart: 500 });
  await starting;
  now = 120; frames.splice(0).forEach(callback => callback(0));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const row = JSON.parse(invoke.mock.calls.find(([name]) => name === "perf_log_append")![1].line);
  expect(row).toMatchObject({ kind: "cold-launch", doneMs: 520, firstFrameMs: 620 });
  runtime.perfProbe?.stop();
});
