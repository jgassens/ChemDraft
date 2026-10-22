// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaletteWindow } from "../PaletteWindow";
import { PluginPanelWindow } from "../plugins/PluginPanelWindow";
import { pluginPanelWindowId } from "../plugins/panelBridge";

const native = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined),
  drag: vi.fn(),
  move: vi.fn()
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: native.drag, setPosition: native.move })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("native title dragging", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    native.invoke.mockClear();
    native.drag.mockClear();
    native.move.mockClear();
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

  async function mount(surface: "palette" | "panel", toolsetId = "core.main"): Promise<void> {
    // Mount with the real web event transport, then enable only the native drag invocation.
    // No unrelated window sizing/focus IPC needs to be mocked for this call-path regression.
    await act(async () => {
      root.render(surface === "palette"
        ? createElement(PaletteWindow, { toolsetId })
        : createElement(PluginPanelWindow, { panelId: pluginPanelWindowId("org.test.demo", "panel.demo.result") }));
    });
    for (const owner of container.querySelectorAll<HTMLElement>(".palette-title, main")) {
      // jsdom does not implement pointer capture, including for direct pointer dispatches.
      owner.setPointerCapture = vi.fn();
      owner.hasPointerCapture = () => false;
      owner.releasePointerCapture = vi.fn();
    }
    (window as typeof window & { __TAURI__?: unknown }).__TAURI__ = {};
  }

  function pointerEvent(type: string, pointerId: number, isPrimary = true): MouseEvent {
    // jsdom has no PointerEvent; supply the pointer fields alongside real mouse coordinates.
    const event = new MouseEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      clientX: 37, clientY: 11, screenX: -1240, screenY: 630
    });
    Object.defineProperties(event, {
      pointerId: { value: pointerId },
      isPrimary: { value: isPrimary }
    });
    return event;
  }

  async function dispatch(target: HTMLElement, ...events: Event[]): Promise<void> {
    await act(async () => {
      events.forEach((event) => target.dispatchEvent(event));
      // startPaletteWindowDrag awaits a dynamic import before invoking the native command.
      await vi.dynamicImportSettled();
    });
  }

  async function press(target: HTMLElement, pointer = true, button = 0): Promise<void> {
    await act(async () => {
      const init = {
        bubbles: true, cancelable: true, button, buttons: button === 0 ? 1 : 2,
        clientX: 37, clientY: 11, screenX: -1240, screenY: 630, detail: 1
      };
      if (pointer) {
        // jsdom has no PointerEvent; MouseEvent carries the coordinates and button fields React uses.
        const down = new MouseEvent("pointerdown", init);
        Object.defineProperty(down, "pointerId", { value: 7 });
        Object.defineProperty(down, "isPrimary", { value: true });
        target.dispatchEvent(down);
      }
      // Deliberately send a compatibility mousedown even though pointerdown prevented default.
      // This proves the fallback cannot submit a second drag if a webview delivers both.
      target.dispatchEvent(new MouseEvent("mousedown", init));
      await vi.dynamicImportSettled();
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

  it.each([true, false])("leaves inspector scrollbar-owner presses to the browser (pointer: %s)", async (pointer) => {
    await mount("palette", "core.drawnStructureSettings");
    const scroller = container.querySelector<HTMLElement>(".molecule-inspector-panel-body")!;
    expect(scroller).not.toBeNull();
    // Native scrollbar thumbs have no DOM node. WebView2 can target their scrolling div;
    // jsdom tests event routing only, so actual thumb scrolling still needs a desktop check.
    const down = pointerEvent("pointerdown", 7);
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    await dispatch(scroller, ...(pointer ? [down, mouseDown] : [mouseDown]));
    expect(down.defaultPrevented).toBe(false);
    expect(mouseDown.defaultPrevented).toBe(false);
    expect(container.querySelector<HTMLElement>("main")!.setPointerCapture).not.toHaveBeenCalled();
    expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag")).toEqual([]);
    expect(native.drag).not.toHaveBeenCalled();
    expect(native.move).not.toHaveBeenCalled();
    await press(container.querySelector<HTMLElement>(".palette-title-label")!);
    expectOneCompensatedDrag();
  });

  it("does not drag from unmarked palette background", async () => {
    await mount("palette");
    await press(container.querySelector<HTMLElement>("main")!);
    expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag")).toEqual([]);
  });

  it("keeps the content grip's mouse-only fallback on the compensated path", async () => {
    await mount("palette");
    await press(container.querySelector<HTMLElement>("[data-palette-content-drag-grip]")!, false);
    expectOneCompensatedDrag();
  });

  it("keeps the palette's mouse-only fallback on the compensated path", async () => {
    await mount("palette");
    await press(container.querySelector<HTMLElement>(".palette-title")!, false);
    expectOneCompensatedDrag();
  });

  const dragSurfaces = [
    ["palette", ".palette-title"],
    ["palette", "[data-palette-content-drag-grip]"],
    ["panel", ".palette-title"]
  ] as const;

  it.each(dragSurfaces)("ignores non-primary pointers on %s %s", async (surface, selector) => {
    await mount(surface);
    await dispatch(container.querySelector<HTMLElement>(selector)!, pointerEvent("pointerdown", 8, false));
    expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag")).toEqual([]);
  });

  it.each(dragSurfaces)("starts a new %s %s drag after a missing pointerup", async (surface, selector) => {
    await mount(surface);
    const target = container.querySelector<HTMLElement>(selector)!;
    await dispatch(target, pointerEvent("pointerdown", 7));
    await dispatch(target, pointerEvent("pointerdown", 8));
    expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag")).toHaveLength(2);
  });

  it.each(dragSurfaces)("clears the %s %s drag on lost pointer capture", async (surface, selector) => {
    await mount(surface);
    const target = container.querySelector<HTMLElement>(selector)!;
    const owner = target.closest<HTMLElement>(".palette-title") ?? container.querySelector<HTMLElement>("main")!;
    await press(target);
    // Capture has already been removed when the browser delivers lostpointercapture.
    owner.hasPointerCapture = () => false;
    owner.releasePointerCapture = vi.fn();
    await dispatch(target, pointerEvent("lostpointercapture", 7));
    expect(owner.releasePointerCapture).not.toHaveBeenCalled();
    // A repeated ending event must find no matching drag ref, even if capture is reported.
    owner.hasPointerCapture = () => true;
    await dispatch(target, pointerEvent("lostpointercapture", 7));
    expect(owner.releasePointerCapture).not.toHaveBeenCalled();
    if (surface === "palette") {
      // A primary press also replaces stale refs; mouse fallback proves the pointer ref cleared.
      await press(target, false);
      expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag")).toHaveLength(2);
    }
    await dispatch(target, pointerEvent("pointerdown", 8));
    expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag"))
      .toHaveLength(surface === "palette" ? 3 : 2);
  });

  it.each(dragSurfaces)("replaces primary drags and ignores non-primary presses on %s %s", async (surface, selector) => {
    await mount(surface);
    const target = container.querySelector<HTMLElement>(selector)!;
    const owner = target.closest<HTMLElement>(".palette-title") ?? container.querySelector<HTMLElement>("main")!;
    for (const end of ["pointerup", "pointercancel"]) {
      for (const hasCapture of [true, false]) {
        native.invoke.mockClear();
        await press(target);
        owner.hasPointerCapture = () => hasCapture;
        owner.releasePointerCapture = vi.fn();
        await dispatch(target,
          pointerEvent("pointerdown", 8, false),
          pointerEvent("pointermove", 7),
          new MouseEvent("mousemove", { bubbles: true, screenX: -1200, screenY: 650 }),
          pointerEvent(end, 8, false)
        );
        await press(target, false);
        expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag")).toHaveLength(1);
        expect(native.move).not.toHaveBeenCalled();
        expect(owner.releasePointerCapture).not.toHaveBeenCalled();

        // A new primary press replaces pointer 7 even when the OS swallowed its ending event.
        await dispatch(target, pointerEvent("pointerdown", 9));
        await press(target, false);
        expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag")).toHaveLength(2);
        // Neither the old pointer nor a non-primary press can end the replacement drag.
        await dispatch(target, pointerEvent(end, 7), pointerEvent("pointerdown", 10, false));
        await press(target, false);
        expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag")).toHaveLength(2);
        expect(owner.releasePointerCapture).not.toHaveBeenCalled();

        owner.hasPointerCapture = () => hasCapture;
        await dispatch(target, pointerEvent(end, 9));
        if (hasCapture) {
          expect(owner.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(9);
        } else {
          expect(owner.releasePointerCapture).not.toHaveBeenCalled();
        }
        if (surface === "palette") {
          // Cleanup enables fallback; a mouse drag itself must not block another mouse press.
          await press(target, false);
          await press(target, false);
          expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag")).toHaveLength(4);
        }
        await press(target);
        expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag"))
          .toHaveLength(surface === "palette" ? 5 : 3);
        await dispatch(target, pointerEvent(end, 7));
      }
    }
  });

  it.each(["palette", "panel"] as const)("does not drag the %s on a right press or a title button", async (surface) => {
    await mount(surface);
    await press(container.querySelector<HTMLElement>(".palette-title")!, true, 2);
    await press(container.querySelector<HTMLElement>(".palette-close-button")!);
    expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag")).toEqual([]);
    expect(native.drag).not.toHaveBeenCalled();
  });
});
