// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaletteWindow } from "../PaletteWindow";
import { PluginPanelWindow } from "../plugins/PluginPanelWindow";
import { pluginPanelWindowId } from "../plugins/panelBridge";

const native = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined),
  drag: vi.fn()
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: native.drag })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("native title dragging", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    native.invoke.mockClear();
    native.drag.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
    vi.restoreAllMocks();
  });

  async function mount(surface: "palette" | "panel"): Promise<void> {
    // Mount with the real web event transport, then enable only the native drag invocation.
    // No unrelated window sizing/focus IPC needs to be mocked for this call-path regression.
    await act(async () => {
      root.render(surface === "palette"
        ? createElement(PaletteWindow, { toolsetId: "core.main" })
        : createElement(PluginPanelWindow, { panelId: pluginPanelWindowId("org.test.demo", "panel.demo.result") }));
    });
    (window as typeof window & { __TAURI__?: unknown }).__TAURI__ = {};
  }

  async function press(target: HTMLElement, pointer = true, button = 0): Promise<void> {
    const title = target.closest<HTMLElement>(".palette-title") ?? container.querySelector<HTMLElement>("main")!;
    title.setPointerCapture = vi.fn();
    title.hasPointerCapture = () => false;
    await act(async () => {
      const init = {
        bubbles: true, cancelable: true, button, buttons: button === 0 ? 1 : 2,
        clientX: 37, clientY: 11, screenX: -1240, screenY: 630, detail: 1
      };
      if (pointer) {
        // jsdom has no PointerEvent; MouseEvent carries the coordinates and button fields React uses.
        const down = new MouseEvent("pointerdown", init);
        Object.defineProperty(down, "pointerId", { value: 7 });
        target.dispatchEvent(down);
      }
      // Deliberately send a compatibility mousedown even though pointerdown prevented default.
      // This proves the fallback cannot submit a second drag if a webview delivers both.
      target.dispatchEvent(new MouseEvent("mousedown", init));
    });
  }

  function expectOneCompensatedDrag(): void {
    expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag"))
      .toEqual([["start_window_drag", { grabX: 37, grabY: 11 }]]);
    expect(native.drag).not.toHaveBeenCalled();
    // Tauri's injected mousedown handler has nothing to match, including the content grip.
    expect(container.querySelector("[data-tauri-drag-region]")).toBeNull();
  }

  it.each(["palette", "panel"] as const)("sends the %s title's client grab point through exactly one app command", async (surface) => {
    await mount(surface);
    await press(container.querySelector<HTMLElement>(".palette-title-label")!);
    expectOneCompensatedDrag();
  });

  it("routes the palette content grip through that same single path", async () => {
    await mount("palette");
    await press(container.querySelector<HTMLElement>("[data-palette-content-drag-grip]")!);
    expectOneCompensatedDrag();
  });

  it("keeps the palette's mouse-only fallback on the compensated path", async () => {
    await mount("palette");
    await press(container.querySelector<HTMLElement>(".palette-title")!, false);
    expectOneCompensatedDrag();
  });

  it.each(["palette", "panel"] as const)("does not drag the %s on a right press or a title button", async (surface) => {
    await mount(surface);
    await press(container.querySelector<HTMLElement>(".palette-title")!, true, 2);
    await press(container.querySelector<HTMLElement>(".palette-close-button")!);
    expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag")).toEqual([]);
    expect(native.drag).not.toHaveBeenCalled();
  });
});
