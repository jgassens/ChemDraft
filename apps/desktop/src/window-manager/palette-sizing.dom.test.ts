// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { currentWindowLogicalWorkArea, fitCurrentPaletteWindow, monitorLogicalBoundsAt } from "./index";
import { PaletteWindow } from "../PaletteWindow";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  workArea: vi.fn(),
  boundsAt: vi.fn(),
  workAreaEvents: new Map<string, () => void>()
}));
vi.mock("./tauriEvents", async original => ({
  ...await original<typeof import("./tauriEvents")>(),
  listenTauriEvent: async () => () => {},
  listenCurrentWindowEvent: async (name: string, handler: () => void) => {
    native.workAreaEvents.set(name, handler);
    return () => { native.workAreaEvents.delete(name); };
  }
}));

describe("palette work-area sizing", () => {
  beforeEach(() => {
    native.workArea.mockReset().mockResolvedValue(null);
    native.boundsAt.mockReset().mockResolvedValue(null);
    native.invoke.mockReset().mockImplementation(async (command, payload) => {
      if (command === "current_window_logical_work_area") return native.workArea();
      if (command === "monitor_logical_bounds_at") return native.boundsAt(payload);
      if (command === "resize_toolset_window") return true;
    });
    mockIPC(native.invoke);
  });

  afterEach(() => {
    clearMocks();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The scale conversion itself is tested in Rust (monitor_query.rs).
  it("uses the native work area, which excludes OS chrome", async () => {
    native.workArea.mockResolvedValue({ left: -1920, top: 24, right: 0, bottom: 1040 });
    expect(await currentWindowLogicalWorkArea()).toEqual({ left: -1920, top: 24, right: 0, bottom: 1040 });
    expect(native.invoke).toHaveBeenCalledWith("current_window_logical_work_area", {});
  });

  it.each([
    ["fails", () => native.workArea.mockRejectedValue(new Error("No monitor"))],
    ["finds no monitor", () => native.workArea.mockResolvedValue(null)]
  ])("uses available screen dimensions when the monitor query %s", async (_case, arrange) => {
    arrange();
    vi.spyOn(window.screen, "availHeight", "get").mockReturnValue(720);
    vi.spyOn(window.screen, "availWidth", "get").mockReturnValue(1280);
    expect(await currentWindowLogicalWorkArea()).toEqual({ left: 0, top: 0, right: 1280, bottom: 720 });
  });

  it("asks the native side for the monitor under a point", async () => {
    native.boundsAt.mockResolvedValue({ left: 1920, top: 0, right: 4480, bottom: 1440 });
    expect(await monitorLogicalBoundsAt(2000, 100)).toEqual({ left: 1920, top: 0, right: 4480, bottom: 1440 });
    expect(native.boundsAt).toHaveBeenCalledWith({ x: 2000, y: 100 });
    native.boundsAt.mockResolvedValue(null);
    expect(await monitorLogicalBoundsAt(9000, 0)).toBeUndefined();
    native.boundsAt.mockRejectedValue(new Error("no runtime"));
    expect(await monitorLogicalBoundsAt(0, 0)).toBeUndefined();
  });

  it("caps an oversized inspector without supplying a replacement origin", async () => {
    await fitCurrentPaletteWindow({ width: 553, height: 1214 }, { left: 0, top: 24, right: 1920, bottom: 1040 });
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("resize_toolset_window", { width: 553, height: 1016 });
  });

  it("re-clamps the resizable inspector after native moves, scale changes, and work-area resizes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    native.workArea.mockResolvedValue({ left: 0, top: 0, right: 1920, bottom: 1000 });
    vi.useFakeTimers();
    const root = createRoot(document.createElement("div"));
    const clampCalls = () => native.invoke.mock.calls.filter(([name]) => name === "clamp_current_inspector_frame");
    try {
      await act(async () => root.render(createElement(PaletteWindow, { toolsetId: "core.molecularInspector", resizable: true })));
      expect(native.invoke).toHaveBeenCalledWith("current_window_logical_work_area", {});
      for (const notify of [
        () => native.workAreaEvents.get("tauri://move")?.(),
        () => native.workAreaEvents.get("tauri://scale-change")?.(),
        () => window.dispatchEvent(new Event("resize"))
      ]) {
        const previousCalls = clampCalls().length;
        notify();
        notify();
        expect(clampCalls()).toHaveLength(previousCalls);
        await act(async () => vi.advanceTimersByTimeAsync(200));
        expect(clampCalls()).toHaveLength(previousCalls + 1);
      }
      native.workArea.mockResolvedValue({ left: 0, top: 0, right: 900, bottom: 600 });
      const previousCalls = clampCalls().length;
      await act(async () => vi.advanceTimersByTimeAsync(1200));
      expect(clampCalls()).toHaveLength(previousCalls + 1);
      expect(native.invoke.mock.calls.some(([name]) => name === "resize_toolset_window")).toBe(false);
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
    expect(native.workAreaEvents.has("tauri://move")).toBe(false);
  });

  it("grants the native inspector clamp command only to inspector windows", () => {
    const tauriDir = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri");
    const command = "clamp_current_inspector_frame";
    const permission = "allow-clamp-current-inspector-frame";
    const manifest = readFileSync(join(tauriDir, "build.rs"), "utf8");
    expect(manifest).toContain(`"${command}"`);
    const resize = JSON.parse(readFileSync(join(tauriDir, "capabilities/toolset-window-size.json"), "utf8"));
    expect(resize.windows).toEqual(["toolset-*"]);
    expect(resize.permissions).toEqual(["allow-resize-toolset-window"]);
    const capability = JSON.parse(readFileSync(join(tauriDir, "capabilities/inspector-window-clamp.json"), "utf8"));
    expect(capability.windows).toEqual([
      "toolset-core-molecularInspector", "toolset-core-drawnStructureSettings", "toolset-core-ringInspector"
    ]);
    expect(capability.windows).not.toContain("toolset-core-main");
    expect(capability.permissions).toEqual([permission]);
    const generated = readFileSync(join(tauriDir, "permissions/autogenerated", `${command}.toml`), "utf8");
    expect(generated).toContain(`identifier = "${permission}"`);
    expect(generated).toContain(`commands.allow = ["${command}"]`);
  });

  it("uses the calling palette's live position and native work area for title-strip recovery", () => {
    const nativeSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/lib.rs"), "utf8");
    const resize = nativeSource.split("fn resize_toolset_window(")[1]!.split("/// Pre-build")[0]!;
    expect(resize).toMatch(/window\.outer_position\(\)[\s\S]*toolset_content_placement\([\s\S]*monitor_logical_work_area\(&monitor\)/);
    expect(resize).toContain("toolset_position_in_work_area(position, width, height, area)");
    const recover = nativeSource.split("fn toolset_position_in_work_area(")[1]!.split("/// Pull a palette")[0]!;
    expect(recover).toContain("area.contains_title_strip(position.x, position.y, width, TOOLSET_TITLE_HEIGHT)");
    const reopen = nativeSource.split("fn clamp_toolset_frame<")[1]!.split("fn toolset_frame_in_work_area")[0]!;
    expect(reopen).toMatch(/toolset_work_area_for_origin\([\s\S]*area\.contains_title_strip\(/);
  });

  it("checks full display bounds before title visibility when restoring a logical inspector frame", () => {
    const nativeSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/lib.rs"), "utf8");
    const restore = nativeSource.split("fn clamp_toolset_frame<")[1]!.split("fn toolset_frame_in_work_area")[0]!;
    expect(restore).toMatch(/monitor_logical_bounds\(monitor\)[\s\S]*toolset_work_area_for_origin\(/);
    expect(restore).toMatch(/\.find\(\|\(bounds, _\)\|[\s\S]*\.contains\(&position\.y\)[\s\S]*\.or_else\([\s\S]*contains_title_strip\(/);
  });

  it("recovers the Windows inspector from its native physical origin and applies the destination frame", () => {
    const nativeSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/lib.rs"), "utf8");
    const recover = nativeSource.split("#[cfg(windows)]\nfn recover_offscreen_toolset_window<")[1]
      ?.split("fn persisted_toolset_position<")[0] ?? "";
    expect(recover).toMatch(/window\.outer_position\(\)[\s\S]*ToolsetFrameOrigin::Physical\([\s\S]*panel_full_size::apply\(&window, placement,/);
  });

  it("samples the visible native palette instead of persisting queued move coordinates", () => {
    const nativeSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/lib.rs"), "utf8");
    const moved = nativeSource.split("WindowEvent::Moved(_) => {")[1]!.split("WindowEvent::CloseRequested")[0]!;
    expect(moved).toMatch(/visible_toolset_physical_position\(window\)[\s\S]*persist_toolset_position\(/);
    const sample = nativeSource.split("fn visible_toolset_physical_position<")[1]!.split("fn current_toolset_window_position<")[0]!;
    expect(sample).toMatch(/!window\.is_visible\(\)[\s\S]*toolset_frame_is_transient\([\s\S]*return None;[\s\S]*window\.outer_position\(\)/);
  });

  it("fits a restored inspector frame to the work area before creating or showing the window", () => {
    const nativeSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/lib.rs"), "utf8");
    const open = nativeSource.split("fn ensure_toolset_window<")[1]!.split("fn install_toolset_input_focus<")[0]!;
    expect(open).toMatch(
      /recover_offscreen_toolset_window\(app, &window, resizable\);(?:\s*\/\/[^\n]*)*\s*if !palette_first_paint::reopened\(&label\) \{\s*window\.show\(/,
    );
    expect(open).toMatch(/let \(position, width, height\) = clamp_toolset_frame\([\s\S]*?\.inner_size\(width, height\)/);
    // Windows: clamp, build hidden through palette_first_paint, place, then the reveal is armed.
    expect(open).toMatch(
      /clamp_windows_toolset_frame\([\s\S]*?palette_first_paint::builder_step\([\s\S]*?builder\.build\(\)[\s\S]*?panel_full_size::apply\([\s\S]*?palette_first_paint::arm_toolbar\(&target\)/,
    );
    // The new window is never shown directly: only palette_first_paint reveals it. The creation path
    // (everything from the builder on) has no `.show(` call on any receiver.
    const creationStart = open.indexOf("let builder = utility_window_builder(");
    expect(creationStart).toBeGreaterThan(open.indexOf("palette_first_paint::reopened(&label)"));
    const creation = open.slice(creationStart);
    expect(creation).toContain("builder.build()");
    expect(creation).not.toMatch(/\.show\s*\(/);
    expect(creation).not.toMatch(/\bshow\s*\(\s*&?(?:window|target)\b/);
  });

  it("sends the requested size unchanged when it fits within the work area", async () => {
    await fitCurrentPaletteWindow({ width: 520, height: 600 }, { left: 0, top: 24, right: 1920, bottom: 1040 });
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("resize_toolset_window", { width: 520, height: 600 });
  });

  it("reports a skipped native resize so the caller can retry the same measurement", async () => {
    native.invoke.mockResolvedValueOnce(false);
    const size = { width: 520, height: 600 };
    const area = { left: 0, top: 24, right: 1920, bottom: 1040 };
    await expect(fitCurrentPaletteWindow(size, area)).resolves.toBe(false);
    await expect(fitCurrentPaletteWindow(size, area)).resolves.toBe(true);
    expect(native.invoke.mock.calls).toEqual([
      ["resize_toolset_window", size],
      ["resize_toolset_window", size]
    ]);
  });
});
