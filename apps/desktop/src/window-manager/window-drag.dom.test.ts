// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaletteWindow } from "../PaletteWindow";
import { PluginPanelWindow } from "../plugins/PluginPanelWindow";
import { pluginPanelWindowId } from "../plugins/panelBridge";
import { createDesktopToolsetRegistry } from "../toolsets";
import { fitCurrentPaletteWindow } from "./index";
import { isScrollOwnerPress } from "./scrollOwnerPress";

const native = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>, _options?: unknown): Promise<unknown> => undefined),
  drag: vi.fn(),
  move: vi.fn(),
  resize: vi.fn()
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging: native.drag, setPosition: native.move, setSize: native.resize,
    innerSize: () => native.invoke("plugin:window|inner_size")
  }),
  LogicalSize: class {
    constructor(public width: number, public height: number) {}
  }
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["macos", "windows"] as const)("native title dragging (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let appCss: HTMLStyleElement | undefined;

  beforeEach(() => {
    native.invoke.mockReset();
    native.drag.mockClear();
    native.move.mockClear();
    native.resize.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    appCss?.remove();
    appCss = undefined;
    clearMocks();
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it("requests content sizing without capturing a position to replay over a drag", async () => {
    useNativeIpc();
    await fitCurrentPaletteWindow({ width: 940, height: 660 }, { left: 0, top: 0, right: 950, bottom: 660 });
    expect(native.invoke.mock.calls).toEqual([
      ["resize_toolset_window", { width: 940, height: 660 }, undefined]
    ]);
    expect(native.move).not.toHaveBeenCalled();
    expect(native.resize).not.toHaveBeenCalled();
  });

  function useNativeIpc(): void {
    (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: native.invoke };
  }

  async function mount(surface: "palette" | "panel", nativeBeforeMount = false, paletteProps?: ComponentProps<typeof PaletteWindow>): Promise<void> {
    // Mount with the real web event transport, then stub the native IPC boundary.
    // The pointerdown capture listener starts popover dismissal alongside dragging.
    // Keep the real Tauri modules so concurrent imports share this same IPC stub.
    if (nativeBeforeMount) {
      mockWindows("toolset-core-main");
      mockIPC((command, args) => native.invoke(command, args as Record<string, unknown> | undefined), { shouldMockEvents: true });
    }
    await act(async () => {
      root.render(surface === "palette"
        ? createElement(PaletteWindow, { toolsetId: "core.main", platform, ...paletteProps })
        : createElement(PluginPanelWindow, { panelId: pluginPanelWindowId("org.test.demo", "panel.demo.result") }));
    });
    for (const owner of container.querySelectorAll<HTMLElement>(".palette-title, main")) {
      // jsdom does not implement pointer capture, including for direct pointer dispatches.
      owner.setPointerCapture = vi.fn();
      owner.hasPointerCapture = () => false;
      owner.releasePointerCapture = vi.fn();
    }
    if (!nativeBeforeMount) useNativeIpc();
  }

  it("retries the same content measurement after a skipped resize", async () => {
    let skipped = false;
    let live: unknown;
    native.invoke.mockImplementation(async (command, args) => {
      if (command === "current_window_logical_work_area") return { left: 0, top: 24, right: 1920, bottom: 1040 };
      if (command === "resize_toolset_window") {
        if (!skipped) {
          skipped = true;
          return null;
        }
        live = args;
        return args;
      }
      if (command === "plugin:window|inner_size") return live;
    });
    const requests = () => native.invoke.mock.calls.filter(([command]) => command === "resize_toolset_window");
    const workAreaReads = () => native.invoke.mock.calls.filter(([command]) => command === "current_window_logical_work_area").length;
    await mount("palette", true);
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1]).toEqual(requests()[0]);
    const previousReads = workAreaReads();
    await dispatch(window, new Event("resize"));
    await vi.waitFor(() => expect(workAreaReads()).toBeGreaterThan(previousReads));
    expect(requests()).toHaveLength(2);
  });

  it("fits a two-column toolbar to its padded grid despite an old oversized preference", async () => {
    const styles = document.createElement("style");
    styles.textContent = readFileSync("apps/desktop/src/App.css", "utf8");
    document.head.append(styles);
    // jsdom does not lay out grids. Use the actual Layout CSS metrics for the measured box.
    let contentHeight = 150;
    const space = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--cd-space-2"));
    const contentWidth = 2 * 24 + space + 2 * space;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("palette-window-shell")
        ? new DOMRect(0, 0, contentWidth, contentHeight)
        : new DOMRect();
    });
    let live: unknown;
    native.invoke.mockImplementation(async (command, args) => {
      if (command === "resize_toolset_window") {
        live = args;
        return args;
      }
      if (command === "plugin:window|inner_size") return live;
    });
    const registry = createDesktopToolsetRegistry({
      version: 1,
      toolsetOverrides: [{ toolsetId: "core.layout", preferredWindowSize: { width: 413, height: 317 } }]
    });
    expect(registry.require("core.layout").preferredWindowSize?.width).toBe(413);
    try {
      await mount("palette", true, { toolsetId: "core.layout", initialRegistry: registry });
      const requests = () => native.invoke.mock.calls.filter(([command]) => command === "resize_toolset_window");
      await vi.waitFor(() => expect(requests()).toHaveLength(1));
      expect(getComputedStyle(container.querySelector(".tool-group")!).gridTemplateColumns).toBe("repeat(2, 24px)");
      expect(contentWidth).toBe(60);
      const [command, initial] = requests()[0]!;
      expect(initial?.width).toBe(contentWidth);
      expect(getComputedStyle(container.querySelector(".palette-title")!).contain).toBe("inline-size");
      expect(container.querySelector("main")?.hasAttribute("data-resizable")).toBe(false);
      const height = initial!.height as number;
      contentHeight += 28;
      await dispatch(window, new Event("resize"));
      await vi.waitFor(() => expect(requests()[1]?.slice(0, 2)).toEqual([command, { width: 60, height: contentHeight }]));
      contentHeight = height;
      await dispatch(window, new Event("resize"));
      await vi.waitFor(() => expect(requests()[2]?.slice(0, 2)).toEqual([command, initial]));
    } finally {
      styles.remove();
    }
  });

  it("keeps a scrolling inspector at the restored native size after mount and resize", async () => {
    await mount("palette", true, { toolsetId: "core.molecularInspector", resizable: true });
    await dispatch(window, new Event("resize"));
    expect(container.querySelector("main")?.dataset.resizable).toBe("true");
    expect(native.invoke.mock.calls.some(([command]) => command === "resize_toolset_window")).toBe(false);
  });

  function loadAppCss(): void {
    // jsdom computes overflow only from loaded rules, and scroll ownership is read from the cascade.
    appCss = document.createElement("style");
    appCss.textContent = readFileSync("apps/desktop/src/App.css", "utf8");
    document.head.append(appCss);
  }

  // A native scrollbar press targets its scroll owner: the palette's content scroller or a nested
  // Object Settings panel body.
  const scrollOwners = [".molecule-inspector-panel-body", ".palette-window-content"] as const;

  it.each(scrollOwners.flatMap(selector => [true, false].map(pointer => [selector, pointer] as const)))(
    "leaves %s scrollbar presses to the webview (pointer: %s)", async (selector, pointer) => {
    loadAppCss();
    await mount("palette", false, { toolsetId: "core.drawnStructureSettings" });
    const scroller = container.querySelector<HTMLElement>(selector)!;
    expect(scroller).not.toBeNull();
    overflow(scroller);
    const down = pointerEvent("pointerdown", 7);
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    await dispatch(scroller, ...(pointer ? [down, mouseDown] : [mouseDown]));
    expect(down.defaultPrevented).toBe(false);
    expect(mouseDown.defaultPrevented).toBe(false);
    expect(container.querySelector<HTMLElement>("main")!.setPointerCapture).not.toHaveBeenCalled();
    expect(native.invoke.mock.calls.filter(([command]) => command === "start_window_drag")).toEqual([]);
    await press(container.querySelector<HTMLElement>(".palette-title-label")!);
    expectOneCompensatedDrag();
  });

  // The palette background stays a drag surface: the input-focus lease classifies these presses as
  // drags (isPaletteWindowDragPress) and, on Windows, leaves the keyboard hand-back to the drag's end.
  const backgrounds = [".palette-window-shell", ".molecule-inspector-target-row"] as const;

  it.each(backgrounds.flatMap(selector => [true, false].map(pointer => [selector, pointer] as const)))(
    "still drags from the %s background inside Object Settings (pointer: %s)", async (selector, pointer) => {
    loadAppCss();
    await mount("palette", false, { toolsetId: "core.drawnStructureSettings" });
    const background = container.querySelector<HTMLElement>(selector)!;
    expect(background).not.toBeNull();
    // Inside the nested scroller, but not a scroll owner itself.
    if (selector !== ".palette-window-shell") {
      expect(background.closest(".molecule-inspector-panel-body")).not.toBeNull();
    }
    await press(background, pointer);
    expectOneCompensatedDrag();
  });

  // A floating tool palette scrolls (overflow-y: auto) with its scrollbars hidden by App.css, so
  // nothing on its own box is a scrollbar: a blank-area press there must still drag the window.
  it.each([true, false])("still drags from the blank background of a floating tool palette with hidden scrollbars (pointer: %s)", async (pointer) => {
    loadAppCss();
    await mount("palette", false, { toolsetId: "core.structure" });
    const palette = container.querySelector<HTMLElement>(".tool-palette.floating.vertical")!;
    expect(palette).not.toBeNull();
    const style = getComputedStyle(palette);
    expect(style.overflowY).toBe("auto");
    expect(style.getPropertyValue("scrollbar-width")).toBe("none");
    // Really overflowing: only the hidden scrollbar keeps this from being a scroll owner.
    overflow(palette);
    expect(isScrollOwnerPress(palette)).toBe(false);
    await press(palette, pointer);
    expectOneCompensatedDrag();
  });

  it("still drags from a scroller whose content fits, since it shows no scrollbar", async () => {
    loadAppCss();
    await mount("palette", false, { toolsetId: "core.drawnStructureSettings" });
    const scroller = container.querySelector<HTMLElement>(".molecule-inspector-panel-body")!;
    expect(getComputedStyle(scroller).overflow).toMatch(/auto|scroll/);
    await press(scroller);
    expectOneCompensatedDrag();
  });

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

  async function dispatch(target: EventTarget, ...events: Event[]): Promise<void> {
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
      .toEqual([["start_window_drag", { grabX: 37, grabY: 11 }, undefined]]);
    expect(native.drag).not.toHaveBeenCalled();
    // Tauri's injected mousedown handler has nothing to match, including the content grip.
    expect(container.querySelector("[data-tauri-drag-region]")).toBeNull();
  }

  it.each(["palette", "panel"] as const)("sends the %s title's client grab point through exactly one app command", async (surface) => {
    await mount(surface);
    await press(container.querySelector<HTMLElement>(".palette-title-label")!);
    expectOneCompensatedDrag();
  });

  // Native palette windows draw no in-content grip (the shell's grip rail replaced it); a press on
  // the toolbar's blank background reaches the shell's drag path instead.
  it("routes a blank toolbar press through that same single path", async () => {
    await mount("palette");
    expect(container.querySelector("[data-palette-content-drag-grip]")).toBeNull();
    await press(container.querySelector<HTMLElement>(".tool-palette")!);
    expectOneCompensatedDrag();
  });

  it("keeps the palette's mouse-only fallback on the compensated path", async () => {
    await mount("palette");
    await press(container.querySelector<HTMLElement>(".palette-title")!, false);
    expectOneCompensatedDrag();
  });

  const dragSurfaces = [
    ["palette", ".palette-title"],
    ["palette", ".tool-palette"],
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

/** Make jsdom report content overflowing `element` on the given axes (jsdom has no layout). */
function overflow(element: HTMLElement, axes: { x?: boolean; y?: boolean } = { y: true }): void {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: 100 },
    clientHeight: { configurable: true, value: 100 },
    scrollWidth: { configurable: true, value: axes.x ? 300 : 100 },
    scrollHeight: { configurable: true, value: axes.y ? 300 : 100 }
  });
}

describe("scroll owner presses", () => {
  const both = { x: true, y: true };
  it.each([
    ["overflow: auto", both, true],
    ["overflow: scroll", both, true],
    ["overflow-y: auto", { y: true }, true],
    ["overflow: hidden auto", { y: true }, true],
    ["overflow: auto hidden", { y: true }, false],
    ["overflow-x: scroll; overflow-y: hidden", { x: true }, true],
    ["overflow-x: scroll; overflow-y: hidden", { y: true }, false],
    ["overflow-y: scroll; overflow-x: hidden", { y: true }, true],
    // Scrolls, but the content fits: no scrollbar to press.
    ["overflow: auto", {}, false],
    ["overflow: scroll", {}, false],
    // Scrolls with the scrollbar hidden, as App.css does for .tool-palette.floating.
    ["overflow-y: auto; scrollbar-width: none", both, false],
    ["overflow-y: auto; scrollbar-width: thin", both, true],
    ["overflow: hidden", both, false],
    ["overflow: clip", both, false],
    ["overflow: visible", both, false],
    ["", both, false]
  ] as const)("classifies a press on an element with %j overflowing %j as scroll owner: %s", (style, axes, owner) => {
    const element = document.createElement("div");
    element.setAttribute("style", style);
    overflow(element, axes);
    document.body.append(element);
    try {
      expect(isScrollOwnerPress(element)).toBe(owner);
      // A scrollbar press never targets a child; the owner's descendants are background.
      const child = element.appendChild(document.createElement("span"));
      expect(isScrollOwnerPress(child)).toBe(false);
    } finally {
      element.remove();
    }
  });

  // Older WebKit (before Safari 18.2) has no scrollbar-width; App.css hides the floating palette's
  // scrollbars there through ::-webkit-scrollbar { width: 0; height: 0 }. jsdom lacks both `CSS` and
  // pseudo-element styles, so stand them in.
  it.each([
    [{ width: "0px", height: "0px" }, both, false],
    [{ width: "0px", height: "auto" }, { y: true }, false],
    [{ width: "0px", height: "auto" }, { x: true }, true],
    [{ display: "none" }, both, false],
    [{ width: "8px", height: "8px" }, both, true]
  ] as const)("reads a ::-webkit-scrollbar style %j on a scroller overflowing %j as scroll owner: %s", (bar, axes, owner) => {
    const element = document.createElement("div");
    element.setAttribute("style", "overflow: auto");
    overflow(element, axes);
    document.body.append(element);
    vi.stubGlobal("CSS", { supports: () => false });
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((target, pseudo) =>
      pseudo === "::-webkit-scrollbar"
        ? ({ display: "block", width: "auto", height: "auto", ...bar } as unknown as CSSStyleDeclaration)
        : computed(target));
    try {
      expect(isScrollOwnerPress(element)).toBe(owner);
    } finally {
      element.remove();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("ignores non-element targets", () => {
    expect(isScrollOwnerPress(null)).toBe(false);
    expect(isScrollOwnerPress(window)).toBe(false);
    expect(isScrollOwnerPress(document.createTextNode("x"))).toBe(false);
  });
});
