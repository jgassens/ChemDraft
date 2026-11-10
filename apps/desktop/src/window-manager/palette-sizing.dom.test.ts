// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentWindowLogicalWorkArea, getToolsetWindowSize } from "./index";

import { measurePaletteContent, observePaletteContentSize } from "./paletteContentSize";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  currentMonitor: vi.fn(),
  setSize: vi.fn(),
  position: { x: 100, y: 100 }
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor: native.currentMonitor,
  getCurrentWindow: () => ({ setSize: native.setSize }),
  LogicalSize: class {
    constructor(public width: number, public height: number) {}
  }
}));

describe("palette work-area sizing", () => {
  const stops: (() => void)[] = [];
  beforeEach(() => {
    vi.stubGlobal("__TAURI__", {});
    native.position = { x: 100, y: 100 };
    native.setSize.mockReset().mockResolvedValue(undefined);
    native.currentMonitor.mockReset();
    native.invoke.mockReset().mockImplementation(async (command, payload) => {
      if (command === "window_logical_position") return { ...native.position };
      if (command === "set_current_window_global_position") native.position = { ...payload };
    });
  });

  afterEach(() => {
    stops.splice(0).forEach(stop => stop());
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([1, 1.5, 2])("uses the monitor's own scale (%s) and excludes OS chrome", async (scaleFactor) => {
    native.currentMonitor.mockResolvedValue({
      scaleFactor,
      position: { x: -1920 * scaleFactor, y: 0 },
      size: { width: 1920 * scaleFactor, height: 1080 * scaleFactor },
      workArea: {
        position: { x: -1920 * scaleFactor, y: 24 * scaleFactor },
        size: { width: 1920 * scaleFactor, height: 1016 * scaleFactor }
      }
    });
    expect(await currentWindowLogicalWorkArea()).toEqual({ left: -1920, top: 24, right: 0, bottom: 1040 });
  });

  it("uses available screen dimensions when the monitor query fails", async () => {
    native.currentMonitor.mockRejectedValue(new Error("No monitor"));
    vi.spyOn(window.screen, "availHeight", "get").mockReturnValue(720);
    vi.spyOn(window.screen, "availWidth", "get").mockReturnValue(1280);
    expect(await currentWindowLogicalWorkArea()).toEqual({ left: 0, top: 0, right: 1280, bottom: 720 });
  });

  function sizingDOM(orientation: "horizontal" | "vertical") {
    const shell = document.createElement("main");
    shell.innerHTML = `<div class="palette-title"></div><aside class="tool-palette"><div class="toolbar-natural-size"><aside class="tool-palette"><span data-toolbar-item-id="wide"></span></aside></div><span class="toolbar-overflow-measure"></span></aside>`;
    document.body.append(shell);
    const rect = (width: number, height: number) => ({ width, height, left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {} });
    vi.spyOn(shell, "getBoundingClientRect").mockReturnValue(rect(120, 80));
    vi.spyOn(shell.querySelector<HTMLElement>(".palette-title")!, "getBoundingClientRect").mockReturnValue(rect(120, 22));
    const natural = shell.querySelector<HTMLElement>(".toolbar-natural-size > .tool-palette")!;
    natural.style.cssText = "padding: 4px; gap: 2px";
    vi.spyOn(natural, "getBoundingClientRect").mockReturnValue(rect(553, 1214));
    vi.spyOn(natural.firstElementChild!, "getBoundingClientRect").mockReturnValue(rect(54, 24));
    vi.spyOn(shell.querySelector<HTMLElement>(".toolbar-overflow-measure")!, "getBoundingClientRect").mockReturnValue(rect(24, 24));
    return { shell, natural, orientation };
  }

  it.each(["horizontal", "vertical"] as const)("reports full natural %s content in logical pixels without setSize", async orientation => {
    const { shell } = sizingDOM(orientation);
    const stop = observePaletteContentSize(shell, orientation);
    stops.push(stop);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalled());
    expect(native.invoke).toHaveBeenCalledWith("report_toolset_content_size", { size: {
      orientation, width: 553, height: 1236, minLength: orientation === "horizontal" ? 88 : 80
    } });
    expect(native.setSize).not.toHaveBeenCalled();
    stop(); shell.remove();
  });

  it("ignores viewport clipping and deduplicates native resize feedback while reporting content changes", async () => {
    vi.useFakeTimers();
    const { shell, natural } = sizingDOM("horizontal");
    const stop = observePaletteContentSize(shell, "horizontal");
    stops.push(stop);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalled());
    window.dispatchEvent(new Event("chemdraft:toolbar-viewport"));
    await vi.advanceTimersByTimeAsync(20);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    vi.mocked(natural.getBoundingClientRect).mockReturnValue({ width: 800, height: 60 } as DOMRect);
    natural.append(document.createElement("span"));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);
    expect(native.invoke).toHaveBeenLastCalledWith("report_toolset_content_size", { size: {
      orientation: "horizontal", width: 800, height: 82, minLength: 88
    } });
    expect(native.setSize).not.toHaveBeenCalled();
    expect(measurePaletteContent(shell, "horizontal").width).toBe(800);
    const reports = native.invoke.mock.calls.length;
    window.dispatchEvent(new Event("chemdraft:toolbar-dpi"));
    await vi.advanceTimersByTimeAsync(20);
    expect(native.invoke).toHaveBeenCalledTimes(reports + 1);
    window.dispatchEvent(new Event("chemdraft:toolbar-viewport"));
    await vi.advanceTimersByTimeAsync(20);
    expect(native.invoke).toHaveBeenCalledTimes(reports + 1);
    stop(); shell.remove(); vi.useRealTimers();
  });

  it.each(["horizontal", "vertical"] as const)("includes both group padding and border ends in the %s minimum", orientation => {
    const { shell, natural } = sizingDOM(orientation);
    const group = document.createElement("div");
    group.className = "tool-group";
    group.style.cssText = "padding: 4px 8px; border: 1px solid";
    group.append(natural.firstElementChild!);
    natural.append(group);
    expect(measurePaletteContent(shell, orientation).minLength).toBe(orientation === "horizontal" ? 106 : 90);
  });

  it("reads the native length contract rather than setting a webview size", async () => {
    await getToolsetWindowSize();
    expect(native.invoke).toHaveBeenCalledWith("get_toolset_window_size");
    expect(native.setSize).not.toHaveBeenCalled();
  });
});
