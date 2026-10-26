// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { MemoryStorage } from "../testSupport/memoryStorage";
const render = vi.hoisted(() => vi.fn());
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }) }));
vi.mock("../App", () => ({ App: () => null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["throw", "reject"])("mounts and disables diagnostics when the startup gate hook fails (%s)", async failure => {
  vi.resetModules(); render.mockClear();
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  document.body.innerHTML = '<div id="root"></div>';
  const runtime = await import("./runtime");
  const gate = await import("./gate");
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, fail) => { reject = fail; });
  const fault = vi.spyOn(gate, "perfProbeRequestedFromWindow").mockImplementation(() => {
    if (failure === "throw") throw new Error("gate failed");
    return pending as never;
  });
  vi.useFakeTimers(); const before = Date.now();
  await import("../main");
  expect(render).toHaveBeenCalledTimes(1); expect(Date.now()).toBe(before);
  expect(fault).toHaveBeenCalledTimes(1);
  if (failure === "reject") reject(new Error("gate rejected"));
  await Promise.resolve(); await Promise.resolve();
  const later = vi.fn(); runtime.perfHook(later); expect(later).not.toHaveBeenCalled();
  const rows = localStorage.getItem("chemdraft.perfLog");
  await vi.advanceTimersByTimeAsync(120_001);
  expect(localStorage.getItem("chemdraft.perfLog")).toBe(rows);
});

it.each([false, true].flatMap(secondary => ["throw", "reject", "pending"].map(failure => ({ secondary, failure }))))
  ("mounts without awaiting a $failure startup probe (secondary=$secondary)", async ({ secondary, failure }) => {
    vi.resetModules(); render.mockClear();
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    window.history.replaceState(null, "", secondary ? "/?window=toolset&agentBridge=1" : "/?agentBridge=1");
    document.body.innerHTML = '<div id="root"></div>';
    const runtime = await import("./runtime");
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, fail) => { reject = fail; });
    const broken = vi.fn(() => {
      if (failure === "throw") throw new Error("probe startup failed");
      return pending;
    });
    vi.doMock("../MainWindow", () => ({ startMainWindowPerfProbe: broken }));
    vi.spyOn(runtime, "startPerfProbe").mockImplementation(broken);
    await import("../MainWindow");
    vi.useFakeTimers();
    const start = Date.now();
    await import("../main");
    expect(render).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(broken).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(start);
    expect(render).toHaveBeenCalledTimes(1); // Still mounted while the probe promise is unresolved.
    if (failure === "reject") reject(new Error("async startup failure"));
    if (failure !== "pending") {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const later = vi.fn(); runtime.perfHook(later); expect(later).not.toHaveBeenCalled();
      const rows = localStorage.getItem("chemdraft.perfLog");
      await vi.advanceTimersByTimeAsync(120_001);
      expect(localStorage.getItem("chemdraft.perfLog")).toBe(rows);
    }
  });
