// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryStorage } from "../testSupport/memoryStorage";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
let root: Root | undefined, runtime: typeof import("./runtime"), container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount()); root = undefined; container?.remove(); runtime?.perfProbe?.stop();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it.each(["preferences", "spin3d-debugger"].flatMap(role =>
  (["rendered", "timestamp", "destinationPaint"] as const).flatMap(method =>
    ["throw", "reject"].map(failure => ({ role, method, failure })))))
  ("$role first paint/$method fails open ($failure) with its real React surface", async ({ role, method, failure }) => {
    vi.resetModules(); vi.useFakeTimers();
    vi.stubGlobal("localStorage", new MemoryStorage()); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("PerformanceObserver", undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.push(callback); return frames.length; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.stubGlobal("MessageChannel", class {
      port1 = { onmessage: () => {}, close() {} };
      port2 = { postMessage: () => { void Promise.resolve().then(() => this.port1.onmessage()); }, close() {} };
    });
    window.history.replaceState(null, "", `/?window=${role}&agentBridge=1`);
    container = document.createElement("div"); container.id = "root"; document.body.append(container); root = createRoot(container);
    runtime = await import("./runtime"); await runtime.startPerfProbe();
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, fail) => { reject = fail; });
    const fault = vi.spyOn(runtime.perfProbe!, method).mockImplementation(() => {
      if (failure === "throw") throw new Error("first paint probe failure");
      return pending as never;
    });
    const Component = role === "preferences" ? (await import("../PreferencesWindow")).PreferencesWindow
      : (await import("../Spin3dDebuggerWindow")).Spin3dDebuggerWindow;
    const start = Date.now();
    await act(async () => root!.render(createElement(Component)));
    expect(container.querySelector("h1")?.textContent).toBe(role === "preferences" ? "Preferences" : "3D Debugger");
    // Browser paint boundary, no fake clock advancement and no diagnostic promise settlement.
    await act(async () => frames.splice(0).forEach(callback => callback(0)));
    expect(fault).toHaveBeenCalled(); expect(Date.now()).toBe(start);
    if (failure === "reject") reject(new Error("first paint rejection"));
    await Promise.resolve(); await Promise.resolve();
    const calls = fault.mock.calls.length, rows = localStorage.getItem("chemdraft.perfLog");
    if (role === "preferences") {
      const control = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      await act(async () => control.click());
      expect(control.checked).toBe(true);
      expect(JSON.parse(localStorage.getItem("chemdraft.compound-layout-tools.v1")!).enabled).toBe(true);
    } else {
      container.append(document.createElement("p")); // Another real DOM commit after shutdown.
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
    expect(fault).toHaveBeenCalledTimes(calls);
    expect(localStorage.getItem("chemdraft.perfLog")).toBe(rows);
  });
