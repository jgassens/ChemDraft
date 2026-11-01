// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import type { DesktopPluginRuntime } from "./plugins/createPluginRuntime";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

const captured = vi.hoisted(() => ({
  runtime: undefined as DesktopPluginRuntime | undefined,
  unmounted: false,
  lateStateUpdate: vi.fn()
}));
// React can silently ignore unmounted updates; record setter calls so that regression still fails.
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: <T,>(initial: T | (() => T)) => {
    const [value, setValue] = actual.useState(initial);
    const trackedSetter = actual.useCallback((next: import("react").SetStateAction<T>) => {
      if (captured.unmounted) captured.lateStateUpdate(next);
      setValue(next);
    }, [setValue]);
    return [value, trackedSetter];
  } };
});
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
vi.mock("./plugins/createPluginRuntime", async original => {
  const actual = await original<typeof import("./plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: import("./plugins/createPluginRuntime").DesktopPluginRuntimeOptions) => {
    captured.runtime = actual.createPluginRuntime(options);
    return captured.runtime;
  } };
});

class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
const commandId = "plugin.unmountTest.run";
let container: HTMLDivElement;
let root: Root;
const unhandledRejection = vi.fn();
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  captured.unmounted = false;
  captured.lateStateUpdate.mockClear();
  unhandledRejection.mockClear();
  process.on("unhandledRejection", unhandledRejection);
  consoleError = vi.spyOn(console, "error");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<MainWindow initialPaletteMode="hidden"
    initialRulersVisible={false} nativePalette={false} />));
});

afterEach(async () => {
  try {
    if (!captured.unmounted) await unmount();
    expect(unhandledRejection).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.filter(args => /unmounted component|state update/i.test(args.join(" ")))).toEqual([]);
  } finally {
    process.off("unhandledRejection", unhandledRejection);
    container.remove();
    captured.runtime = undefined;
    captured.unmounted = false;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

async function unmount() {
  await act(async () => root.unmount());
  captured.unmounted = true;
}

async function startCommand(queued: boolean, warning?: string) {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  const runtime = captured.runtime!;
  if (queued) {
    await act(async () => {
      runtime.registerPlugin({ id: "org.chemdraft.unmountTest", name: "Unmount test", version: "0.1.0",
        apiVersion: "^0.1.15", entry: "test.js", permissions: [],
        contributes: { commands: [{ id: commandId, title: "Run" }] }
      }, { commandHandlers: { [commandId]: async () => undefined } });
    });
  }
  // An unregistered command reaches the immediate fallback; a registered one uses the queue.
  const invoke = vi.spyOn(runtime, "invokeCommand").mockImplementationOnce((_id, options) => {
    if (warning) options?.selectionWarnings?.push(warning);
    return pending;
  });
  await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0]![0]).toBe(commandId);
  return { resolve, reject };
}

async function settle(completion: () => void) {
  await act(async () => {
    completion();
    // Drain promise continuations and give Node a turn to emit any unhandled rejection.
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

describe("MainWindow plugin command completion", () => {
  it.each([false, true])("skips state updates when a command rejects after unmount (queued: %s)", async queued => {
    const pending = await startCommand(queued);
    await unmount();
    await expect(settle(() => pending.reject(new Error("late failure")))).resolves.toBeUndefined();
    expect(captured.lateStateUpdate).not.toHaveBeenCalled();
  });

  it.each([
    { result: undefined, warning: undefined },
    { result: { ok: false, error: { message: "refused" } }, warning: undefined },
    { result: undefined, warning: "Selection warning" }
  ])("skips queued completion state updates after unmount ($result, $warning)", async ({ result, warning }) => {
    const pending = await startCommand(true, warning);
    await unmount();
    await expect(settle(() => pending.resolve(result))).resolves.toBeUndefined();
    expect(captured.lateStateUpdate).not.toHaveBeenCalled();
  });

  it.each([false, true])("still shows command errors while mounted (queued: %s)", async queued => {
    const pending = await startCommand(queued);
    await settle(() => pending.reject(new Error("visible failure")));
    expect(container.querySelector(".status-row")?.textContent).toContain(
      `${queued ? "Plugin command" : "Command"} failed: visible failure`
    );
  });
});
