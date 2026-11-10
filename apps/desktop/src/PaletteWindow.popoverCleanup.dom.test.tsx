// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaletteWindow } from "./PaletteWindow";

// Keep the real manager: mocking closeToolsetPopoverWindow would miss its identity guard.
const native = vi.hoisted(() => ({
  visible: false,
  open: vi.fn(async () => {}),
  invoke: vi.fn(async (command: string, _args?: unknown) => {
    if (command === "window_logical_position") return { x: 100, y: 100 };
    if (command === "open_toolset_popover") await native.open();
    if (command === "close_toolset_popover") native.visible = false;
  }),
  emit: vi.fn(async (event: string, _payload?: unknown) => {
    if (event === "chemdraft://toolset-popover-content") native.visible = true;
  })
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: native.emit,
  listen: async () => () => {}
}));
vi.mock("./window-manager/tauriEvents", async original => ({
  ...await original<typeof import("./window-manager/tauriEvents")>(),
  listenTauriEvent: async () => () => {}
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: async () => () => {} })
}));
vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor: async () => null,
  getCurrentWindow: () => ({ setSize: async () => {} }),
  LogicalSize: class { constructor(public width: number, public height: number) {} }
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = window as typeof window & { __TAURI__?: unknown };

describe.each(["macos", "windows"] as const)("palette cleanup during native open on %s", platform => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  beforeEach(async () => {
    vi.clearAllMocks();
    native.visible = false;
    host.__TAURI__ = {};
    vi.spyOn(performance, "now").mockReturnValue(100);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(PaletteWindow, { toolsetId: "core.art", platform })));
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container.remove();
    delete host.__TAURI__;
    vi.restoreAllMocks();
  });

  async function openFlyout() {
    const button = container.querySelector<HTMLButtonElement>(".command-flyout-button")!;
    expect(button).not.toBeNull();
    await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  }

  it.each(["later timestamp", "same timestamp", "first opening"] as const)(
    "closes the native popover when unmounted before a %s registers content", async opening => {
      const warm = opening !== "first opening";
      if (warm) {
        await openFlyout();
        expect(native.visible).toBe(true);
      }
      const contentCalls = () => native.emit.mock.calls.filter(([event]) => event === "chemdraft://toolset-popover-content");
      expect(contentCalls()).toHaveLength(warm ? 1 : 0);
      if (opening === "later timestamp") vi.mocked(performance.now).mockReturnValue(101);

      let finishOpen!: () => void;
      native.open.mockImplementationOnce(() => new Promise<void>(resolve => { finishOpen = resolve; }));
      await openFlyout();
      expect(native.open).toHaveBeenCalledTimes(warm ? 2 : 1);
      // A warm native open leaves the previous popover visible until content is replaced.
      expect(native.visible).toBe(warm);
      await act(async () => root!.unmount());
      root = undefined;
      expect(native.invoke).not.toHaveBeenCalledWith("close_toolset_popover", expect.anything());

      await act(async () => finishOpen());
      await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("close_toolset_popover", { toolsetId: "core.art" }));
      expect(native.invoke.mock.calls.filter(([command]) => command === "close_toolset_popover")).toHaveLength(1);
      expect(native.visible).toBe(false);
      // The cancelled continuation must not publish content that would reveal the window again.
      expect(contentCalls()).toHaveLength(warm ? 1 : 0);
    }
  );
});
