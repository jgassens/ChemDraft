// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeToolsetPopoverWindow, notifyToolsetPopoverClosed, setToolsetPopoverContent, toolsetPopoverTimestamp } from "./index";
import { installPopoverEscapeRouting } from "./popoverEscape";

const native = vi.hoisted(() => ({
  visible: true,
  exists: true,
  queryVisibility: vi.fn(async (): Promise<boolean> => native.visible),
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  windowListeners: new Map<string, Set<() => void>>(),
  invoke: vi.fn(async (_command: string, _args?: unknown) => {}),
  emit: vi.fn(async (name: string, payload?: unknown) => {
    native.listeners.get(name)?.forEach(receive => receive({ payload }));
  })
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: native.emit }));
vi.mock("./tauriEvents", async original => ({
  ...await original<typeof import("./tauriEvents")>(),
  listenTauriEvent: async (name: string, receive: (event: { payload: unknown }) => void) => {
    const listeners = native.listeners.get(name) ?? new Set();
    native.listeners.set(name, listeners);
    listeners.add(receive);
    return () => { listeners.delete(receive); };
  }
}));
vi.mock("@tauri-apps/api/window", () => ({
  Window: { getByLabel: async (label: string) => {
    expect(label).toBe("toolset-popover-core-art");
    return native.exists ? { isVisible: native.queryVisibility,
      listen: async (name: string, receive: () => void) => {
        const key = `${label}:${name}`;
        const listeners = native.windowListeners.get(key) ?? new Set();
        native.windowListeners.set(key, listeners);
        listeners.add(receive);
        return () => { listeners.delete(receive); };
      }
    } : null;
  } }
}));

let stop: () => void;
let canvas: HTMLCanvasElement;
let canvasEscape: ReturnType<typeof vi.fn>;
const host = window as typeof window & { __TAURI__?: unknown };
beforeEach(async () => {
  host.__TAURI__ = {};
  native.visible = true;
  native.exists = true;
  vi.clearAllMocks();
  native.queryVisibility.mockReset().mockImplementation(async () => native.visible);
  stop = installPopoverEscapeRouting();
  await vi.waitFor(() => expect([...native.listeners.keys()].sort()).toEqual([
    "chemdraft://dismiss-toolset-popovers", "chemdraft://toolset-popover-closed", "chemdraft://toolset-popover-content"
  ]));
  canvas = document.createElement("canvas");
  document.body.append(canvas);
  canvasEscape = vi.fn();
  canvas.addEventListener("keydown", canvasEscape);
});
afterEach(() => {
  stop(); canvas?.remove(); delete host.__TAURI__;
  expect([...native.listeners.values()].every(listeners => !listeners.size)).toBe(true);
  expect([...native.windowListeners.values()].every(listeners => !listeners.size)).toBe(true);
  native.listeners.clear();
  native.windowListeners.clear();
});
async function escape() {
  canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  // Native visibility and event transport finish before observing canvas routing.
  await vi.waitFor(() => expect(canvasEscape.mock.calls.length + native.emit.mock.calls.filter(
    ([name]) => name === "chemdraft://dismiss-toolset-popovers").length).toBeGreaterThan(0));
}
async function open(openedAt: number, generation?: number) {
  await setToolsetPopoverContent("core.art", { kind: "flyout", openedAt, generation,
    flyout: { flyoutId: "shapes", title: "Shapes", commands: [] } });
  await vi.waitFor(() => expect(native.windowListeners.get("toolset-popover-core-art:tauri://destroyed")?.size).toBe(1));
}
// Historical renderer notifications may already be queued. They are deliberately
// absent from the routing contract now: only the native visibility query can decide.
function notifyToolsetPopoverVisibility(payload: { toolsetId: string; openedAt: number; visible: boolean }) {
  return native.emit("chemdraft://toolset-popover-visibility", payload);
}
function nativeClose(event: "tauri://close-requested" | "tauri://destroyed") {
  native.windowListeners.get(`toolset-popover-core-art:${event}`)?.forEach(receive => receive());
}

describe.each(["macos", "windows"])("native flyout lifecycle on %s", () => {
  it("a shown notification still requires a live native visibility query", async () => {
    await open(100);
    await notifyToolsetPopoverVisibility({ toolsetId: "core.art", openedAt: 100, visible: true });
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(canvasEscape).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(native.emit).toHaveBeenCalledWith("chemdraft://dismiss-toolset-popovers", expect.anything()));
    expect(native.queryVisibility).toHaveBeenCalledTimes(1);
    await escape();
    expect(canvasEscape).toHaveBeenCalledTimes(1);
  });

  it.each(["dialog", "input", "composition"])("late visibility rechecks the current %s owner", async owner => {
    await open(100);
    let resolveVisibility!: (visible: boolean) => void;
    native.queryVisibility.mockImplementationOnce(() => new Promise(resolve => { resolveVisibility = resolve; }));
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(native.queryVisibility).toHaveBeenCalled());
    const current = document.createElement(owner === "dialog" ? "div" : "input");
    if (owner === "dialog") { current.setAttribute("aria-modal", "true"); current.setAttribute("role", "dialog"); }
    const received = vi.fn();
    current.addEventListener("keydown", received);
    document.body.append(current);
    current.focus();
    try {
      if (owner === "composition") current.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      resolveVisibility(true);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(received).toHaveBeenCalledTimes(owner === "composition" ? 0 : 1);
      expect(canvasEscape).not.toHaveBeenCalled();
      expect(native.emit).not.toHaveBeenCalledWith("chemdraft://dismiss-toolset-popovers", expect.anything());
    } finally {
      current.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      current.remove();
    }
  });

  it.each(["hide", "blur"])("OS %s without a close notification lets Escape reach the canvas", async event => {
    await open(100);
    await notifyToolsetPopoverVisibility({ toolsetId: "core.art", openedAt: 100, visible: true });
    const osWindow = new EventTarget();
    osWindow.addEventListener(event, () => {
      native.visible = false;
      window.dispatchEvent(new Event("blur"));
    });
    osWindow.dispatchEvent(new Event(event));
    await escape();
    expect(canvasEscape).toHaveBeenCalledTimes(1);
    expect(native.emit).not.toHaveBeenCalledWith("chemdraft://dismiss-toolset-popovers", expect.anything());
    expect(native.emit).not.toHaveBeenCalledWith("chemdraft://toolset-popover-closed", expect.anything());
  });

  it("a delayed shown notification after deactivation cannot swallow canvas Escape", async () => {
    await open(100);
    await notifyToolsetPopoverVisibility({ toolsetId: "core.art", openedAt: 100, visible: true });
    native.visible = false;
    window.dispatchEvent(new Event("blur"));
    // The reveal IPC was already queued when AppKit hid the window.
    await notifyToolsetPopoverVisibility({ toolsetId: "core.art", openedAt: 100, visible: true });
    window.dispatchEvent(new Event("focus"));
    await escape();
    expect(canvasEscape).toHaveBeenCalledTimes(1);
    expect(native.emit).not.toHaveBeenCalledWith("chemdraft://dismiss-toolset-popovers", expect.anything());
  });

  it.each(["tauri://close-requested", "tauri://destroyed"] as const)("native %s without a renderer close cannot swallow canvas Escape", async event => {
    await open(100);
    await notifyToolsetPopoverVisibility({ toolsetId: "core.art", openedAt: 100, visible: true });
    native.exists = false;
    nativeClose(event);
    await escape();
    expect(canvasEscape).toHaveBeenCalledTimes(1);
    expect(native.emit).not.toHaveBeenCalledWith("chemdraft://dismiss-toolset-popovers", expect.anything());
    expect(native.queryVisibility).not.toHaveBeenCalled();
  });

  it("a native hide without document blur still requires a live query", async () => {
    await open(100, 1);
    await notifyToolsetPopoverVisibility({ toolsetId: "core.art", openedAt: 100, visible: true });
    native.visible = false;
    await escape();
    expect(canvasEscape).toHaveBeenCalledTimes(1);
    expect(native.queryVisibility).toHaveBeenCalledTimes(1);
    expect(native.emit).not.toHaveBeenCalledWith("chemdraft://dismiss-toolset-popovers", expect.anything());
  });

  it("a destroyed window cannot consume Escape even before its native event is delivered", async () => {
    await open(100, 1);
    await notifyToolsetPopoverVisibility({ toolsetId: "core.art", openedAt: 100, visible: true });
    native.exists = false;
    await escape();
    expect(canvasEscape).toHaveBeenCalledTimes(1);
    expect(native.emit).not.toHaveBeenCalledWith("chemdraft://dismiss-toolset-popovers", expect.anything());
  });

  it.each(["blur", "tauri://close-requested", "tauri://destroyed"] as const)("%s invalidates an in-flight positive reply", async event => {
    await open(100, 1);
    let resolveVisibility!: (visible: boolean) => void;
    native.queryVisibility.mockImplementationOnce(() => new Promise(resolve => { resolveVisibility = resolve; }));
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(native.queryVisibility).toHaveBeenCalledTimes(1));
    if (event === "blur") window.dispatchEvent(new Event("blur"));
    else nativeClose(event);
    resolveVisibility(true);
    await vi.waitFor(() => expect(canvasEscape).toHaveBeenCalledTimes(1));
    expect(native.emit).not.toHaveBeenCalledWith("chemdraft://dismiss-toolset-popovers", expect.anything());
  });

  it("an obsolete positive reply and close cannot consume a newer generation with the same timestamp", async () => {
    await open(100, 1);
    let resolveVisibility!: (visible: boolean) => void;
    native.queryVisibility.mockImplementationOnce(() => new Promise(resolve => { resolveVisibility = resolve; }));
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(native.queryVisibility).toHaveBeenCalledTimes(1));
    await open(100, 2);
    await notifyToolsetPopoverClosed("core.art", 100, 1);
    // A delayed replay must not replace generation 2 with generation 1 either.
    await open(100, 1);
    resolveVisibility(true);
    await vi.waitFor(() => expect(canvasEscape).toHaveBeenCalledTimes(1));
    expect(native.emit).not.toHaveBeenCalledWith("chemdraft://dismiss-toolset-popovers", expect.anything());
    await escape();
    await vi.waitFor(() => expect(native.emit).toHaveBeenCalledWith("chemdraft://dismiss-toolset-popovers", {
      requestedAt: expect.any(Number), reason: "escape", openings: [{ toolsetId: "core.art", openedAt: 100, generation: 2 }]
    }));
    expect(canvasEscape).toHaveBeenCalledTimes(1);
  });

  it("a close resolving after a newer open closes only its original opening", async () => {
    // Use real opening times: the manager retains the newest identity across owner lifetimes.
    const openedAt = toolsetPopoverTimestamp();
    const newerOpenedAt = openedAt + 1;
    await open(openedAt);
    let finishClose!: () => void;
    native.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { finishClose = resolve; }));
    const closing = closeToolsetPopoverWindow("core.art", openedAt);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("close_toolset_popover", { toolsetId: "core.art" }));
    await open(newerOpenedAt);
    finishClose(); await closing;
    expect(native.emit).toHaveBeenCalledWith("chemdraft://toolset-popover-closed", { toolsetId: "core.art", openedAt });
    await escape();
    expect(canvasEscape).not.toHaveBeenCalled();
    expect(native.emit).toHaveBeenCalledWith("chemdraft://dismiss-toolset-popovers", {
      requestedAt: expect.any(Number), reason: "escape", openings: [{ toolsetId: "core.art", openedAt: newerOpenedAt, generation: undefined }]
    });
    await escape();
    expect(canvasEscape).toHaveBeenCalledTimes(1);
  });
});
