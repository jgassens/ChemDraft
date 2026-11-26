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
    // Only the handler still registered under this name: a re-run effect's late cleanup must not
    // drop the listener its successor installed.
    return () => { if (native.workAreaEvents.get(name) === handler) native.workAreaEvents.delete(name); };
  }
}));

describe("palette work-area sizing", () => {
  beforeEach(() => {
    native.workAreaEvents.clear();
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
    expect(resize).toMatch(
      /let area = monitor_logical_work_area\(&monitor\);[\s\S]*let position = window\.outer_position\(\)[^\n]*\n\s*let origin = \(position\.x, position\.y\);[\s\S]*?\.unwrap_or\(origin\);\s*let mut placement = toolset_content_placement\(source, \(width, height\), scale, area\);/,
    );
    // A palette ChemDraft fitted to a smaller work area starts from its saved position (B9).
    expect(resize).toMatch(/let source = fitted\s*\.then\(\|\| saved_toolset_state\(app, label\)\)/);
    expect(resize.match(/let area = /g)).toHaveLength(1);
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
      /let moved_to = recover_offscreen_toolset_window\(app, &window, resizable, "reopen"\);(?:\s*\/\/[^\n]*)*\s*if !palette_first_paint::reopened\(&label\) \{(?:\s*\/\/[^\n]*)*\s*if hidden \{\s*pin_palette_for_map\(app, &window, resizable, moved_to, [^)]*\);\s*\}\s*window\.show\(/,
    );
    expect(open).toMatch(/let \(position, width, height, adjusted\) =\s*clamp_toolset_frame\([\s\S]*?\.inner_size\(width, height\)/);
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

  describe("Linux content fit of a palette wider than its work area: natural size, never scrolled (#304)", () => {
    // The Main toolbar's natural content is 1311 px wide. On a 1024x768 screen, or at 150% on a
    // 1920-px screen (a 1280 CSS px work area), it is wider than the work area. Owner rule: a
    // fixed toolbar keeps its natural size, is never shrunk, scaled, wrapped or given a scrollbar,
    // runs off the screen, and the user drags it. jsdom has no layout, so the shell reports a model
    // of what WebKitGTK lays out: its natural box, whatever the window's width. A scroller turned on
    // the #469 way (overflow-x auto with a max-width) would report the capped width and gain the
    // height of a 15 px classic scrollbar, so the size requests below would show it.
    const NATURAL_WIDTH = 1311;
    const TITLE_HEIGHT = 22;
    const ROW_HEIGHT = 58;
    const SCROLLBAR = 15;
    const NATURAL_SIZE = { width: NATURAL_WIDTH, height: TITLE_HEIGHT + ROW_HEIGHT };
    const WORK_AREA_150 = 1920 / 1.5;

    const scrollerOf = (element: Element) =>
      (element.classList.contains("palette-window-content") ? element : element.querySelector(".palette-window-content")) as HTMLElement | null;
    const scrolling = (scroller: HTMLElement | null) =>
      scroller?.style.overflowX === "auto" || scroller?.style.overflowX === "scroll";
    const rect = (width: number, height: number) =>
      ({ x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) }) as DOMRect;

    const installLayoutModel = () => {
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        if (!this.classList.contains("palette-window-shell")) return rect(0, 0);
        const scroller = scrollerOf(this);
        if (!scroller || !scrolling(scroller)) return rect(NATURAL_WIDTH, TITLE_HEIGHT + ROW_HEIGHT);
        const capped = Math.min(NATURAL_WIDTH, Number.parseFloat(scroller.style.maxWidth) || NATURAL_WIDTH);
        return rect(capped, TITLE_HEIGHT + ROW_HEIGHT + SCROLLBAR);
      });
    };

    const resizeRequests = () => native.invoke.mock.calls
      .filter(([name]) => name === "resize_toolset_window")
      .map(([, payload]) => payload as { width: number; height: number });
    // A size-effect rerun (registry or settings state landing) may resend an identical size, which
    // is harmless; the distinct sizes in order are what the window actually went through.
    const distinctSizes = () => resizeRequests().filter((size, index, all) =>
      index === 0 || size.width !== all[index - 1]!.width || size.height !== all[index - 1]!.height);

    // Mount Main at the given platform and window width, then stand in for the native resize that
    // follows the first fit. `windowWidth` is the webview's inner width: narrower than the content
    // stands in for a window that runs off a narrow screen or one the window manager kept narrower.
    const mountMain = async (platform: "linux" | "macos" | "windows", windowWidth: number, devicePixelRatio = 1) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal("devicePixelRatio", devicePixelRatio);
      vi.stubGlobal("innerWidth", windowWidth);
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
      vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
      native.workArea.mockResolvedValue({ left: 0, top: 0, right: windowWidth, bottom: 768 });
      installLayoutModel();
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const settle = async () => {
        for (let turn = 0; turn < 6; turn += 1) {
          await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 0)); });
        }
      };
      await act(async () => root.render(createElement(PaletteWindow, { toolsetId: "core.main", platform })));
      await settle();
      const nativeResize = async () => {
        window.dispatchEvent(new Event("resize"));
        await settle();
      };
      // The native window moves to a monitor with this work area; the viewport keeps its width (a
      // move alone never resizes it).
      const moveToWorkArea = async (right: number, bottom: number) => {
        native.workArea.mockResolvedValue({ left: 0, top: 0, right, bottom });
        native.workAreaEvents.get("tauri://move")?.();
        await settle();
      };
      // Rust applied a frame of this width; the webview reports the resize.
      const nativeResizeTo = async (width: number) => {
        vi.stubGlobal("innerWidth", width);
        await nativeResize();
      };
      await nativeResize();
      const shell = container.querySelector<HTMLElement>(".palette-window-shell")!;
      const scroller = container.querySelector<HTMLElement>(".palette-window-content")!;
      const unmount = async () => {
        await act(async () => root.unmount());
        container.remove();
      };
      return { shell, scroller, settle, nativeResize, moveToWorkArea, nativeResizeTo, unmount };
    };

    // Never the #469 sideways scroller, and never shrunk or scaled: the body keeps its natural box.
    const expectNaturalAndUnscrolled = (scroller: HTMLElement) => {
      expect(scroller.style.overflowX).toBe("");
      expect(scroller.style.maxWidth).toBe("");
      expect(scroller.style.width).toBe("");
      expect(scroller.style.transform).toBe("");
      expect(scroller.style.getPropertyValue("zoom")).toBe("");
      expect(scroller.hasAttribute("data-palette-horizontal-overflow")).toBe(false);
      expect(scroller.hasAttribute("data-palette-fit-scale")).toBe(false);
    };

    it.each([
      ["a 1024 px screen at 100%", 1024, 1],
      ["a 1920 px screen at 150%", WORK_AREA_150, 1.5]
    ] as const)("keeps the Linux Main toolbar at its natural width with no scrollbar on %s", async (_case, windowWidth, scale) => {
      const { shell, scroller, nativeResize, unmount } = await mountMain("linux", windowWidth, scale);
      try {
        expectNaturalAndUnscrolled(scroller);
        // Every tool sits in the body at its natural place, none behind a scroll offset.
        const tools = shell.querySelectorAll<HTMLElement>("[data-command-id]");
        expect(tools.length).toBeGreaterThan(0);
        for (const tool of Array.from(tools)) expect(scroller.contains(tool)).toBe(true);
        expect(scroller.scrollLeft).toBe(0);
        // Only the natural size is ever asked for: no capped width, no scrollbar height.
        expect(distinctSizes()).toEqual([NATURAL_SIZE]);
        // The palette's document clips an overhang rather than scrolling it.
        expect(document.documentElement.style.overflow).toBe("hidden");
        expect(document.body.style.overflow).toBe("hidden");
        // No resize loop: later resizes ask for nothing new.
        const settled = resizeRequests().length;
        await nativeResize();
        await nativeResize();
        expect(resizeRequests()).toHaveLength(settled);
        expectNaturalAndUnscrolled(scroller);
      } finally {
        await unmount();
      }
      // Unmounting gives the document back its own overflow.
      expect(document.documentElement.style.overflow).toBe("");
      expect(document.body.style.overflow).toBe("");
    });

    it.each(["macos", "windows"] as const)("leaves the same 1024 px window unchanged on %s", async platform => {
      const { scroller, nativeResize, unmount } = await mountMain(platform, 1024);
      try {
        await nativeResize();
        expectNaturalAndUnscrolled(scroller);
        expect(document.documentElement.style.overflow).toBe("");
        expect(document.body.style.overflow).toBe("");
        expect(distinctSizes()).toEqual([NATURAL_SIZE]);
      } finally {
        await unmount();
      }
    });

    it("re-sends the natural size once when a Linux palette moves to a wider work area, and never scrolls", async () => {
      const { scroller, nativeResize, moveToWorkArea, nativeResizeTo, unmount } = await mountMain("linux", 1024);
      try {
        const before = resizeRequests().length;
        await moveToWorkArea(1680, 1050);
        // The natural size did not change, but the monitor did: the size is re-sent once so Rust
        // re-runs its placement against the new work area.
        expect(resizeRequests().slice(before)).toEqual([NATURAL_SIZE]);
        await nativeResizeTo(NATURAL_WIDTH);
        expectNaturalAndUnscrolled(scroller);
        // Settled: the resize after the fit, and further moves on the same monitor, send nothing.
        await nativeResize();
        await moveToWorkArea(1680, 1050);
        expect(resizeRequests().slice(before)).toEqual([NATURAL_SIZE]);
        expectNaturalAndUnscrolled(scroller);
      } finally {
        await unmount();
      }
    });

    it("keeps the natural width when a Linux palette moves to a narrower work area", async () => {
      const { scroller, nativeResize, moveToWorkArea, unmount } = await mountMain("linux", 1680);
      try {
        expectNaturalAndUnscrolled(scroller);
        const before = resizeRequests().length;
        await moveToWorkArea(1024, 768);
        // Re-sent for the new work area, still at the natural width.
        expect(resizeRequests().slice(before)).toEqual([NATURAL_SIZE]);
        expectNaturalAndUnscrolled(scroller);
        await nativeResize();
        await nativeResize();
        expect(resizeRequests()).toHaveLength(before + 1);
        expectNaturalAndUnscrolled(scroller);
      } finally {
        await unmount();
      }
    });

    // A panel added, removed or resized changes the work area with no move, resize or scale event.
    // Only the interval is faked, so the palette's frame callbacks still run on real timeouts.
    const withWorkAreaPoll = async (run: (pollTick: () => Promise<void>) => Promise<void>) => {
      vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const pollTick = async () => {
        await act(async () => { vi.advanceTimersByTime(1000); });
        for (let turn = 0; turn < 6; turn += 1) {
          await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 0)); });
        }
      };
      try {
        await run(pollTick);
      } finally {
        vi.useRealTimers();
      }
    };

    it("re-fits a Linux palette once when only its work area changes", async () => {
      await withWorkAreaPoll(async pollTick => {
        const { scroller, nativeResizeTo, unmount } = await mountMain("linux", 1024);
        try {
          expectNaturalAndUnscrolled(scroller);
          const before = resizeRequests().length;
          // Unchanged work area: the poll asks for nothing.
          await pollTick();
          expect(resizeRequests()).toHaveLength(before);
          // A panel went away: the work area widens, but the window neither moves nor resizes.
          native.workArea.mockResolvedValue({ left: 0, top: 0, right: 1680, bottom: 1050 });
          await pollTick();
          expect(resizeRequests().slice(before)).toEqual([NATURAL_SIZE]);
          await nativeResizeTo(NATURAL_WIDTH);
          expectNaturalAndUnscrolled(scroller);
          // No loop: later polls of the same work area re-send nothing.
          await pollTick();
          await pollTick();
          expect(resizeRequests().slice(before)).toEqual([NATURAL_SIZE]);
          // A panel came back: re-fitted once more, still at the natural width, without being moved.
          native.workArea.mockResolvedValue({ left: 0, top: 0, right: 1024, bottom: 768 });
          await pollTick();
          expect(resizeRequests().slice(before + 1)).toEqual([NATURAL_SIZE]);
          expectNaturalAndUnscrolled(scroller);
        } finally {
          await unmount();
        }
      });
    });

    describe("a live resolution change that leaves the window where it is", () => {
      // 1.2.2 VM retest (KDE Plasma, XWayland): Main at x = 0, 1311 px wide, and 1680 -> 1280 or
      // 1024 neither moves nor resizes the window and fires no tauri://move, tauri://scale-change or
      // webview resize. Nothing re-ran the fit for 20 s and more, until the pointer entered it.
      const changeResolution = async (settle: () => Promise<void>, right: number, bottom: number) => {
        native.workArea.mockResolvedValue({ left: 0, top: 0, right, bottom });
        // No native event: the work area is all that changed.
        await settle();
      };

      it("refits a Linux Main toolbar within one poll, both ways, at its natural width, and then sends nothing more", async () => {
        await withWorkAreaPoll(async pollTick => {
          const { scroller, settle, nativeResize, unmount } = await mountMain("linux", 1680);
          try {
            expectNaturalAndUnscrolled(scroller);
            const before = resizeRequests().length;

            await changeResolution(settle, 1024, 768);
            // Nothing else would ever re-run the fit: this is the gap the poll closes.
            expect(resizeRequests()).toHaveLength(before);
            await pollTick();
            expect(resizeRequests().slice(before)).toEqual([NATURAL_SIZE]);
            expectNaturalAndUnscrolled(scroller);
            // Settled: further polls on the same work area and the resize after the fit send nothing.
            await nativeResize();
            await pollTick();
            await pollTick();
            expect(resizeRequests()).toHaveLength(before + 1);

            await changeResolution(settle, 1680, 1050);
            expect(resizeRequests()).toHaveLength(before + 1);
            await pollTick();
            expect(resizeRequests().slice(before + 1)).toEqual([NATURAL_SIZE]);
            expectNaturalAndUnscrolled(scroller);
            await nativeResize();
            await pollTick();
            await pollTick();
            expect(resizeRequests()).toHaveLength(before + 2);
          } finally {
            await unmount();
          }
        });
      });

      it("refits directly when the window runs no animation frames", async () => {
        await withWorkAreaPoll(async pollTick => {
          const { settle, unmount } = await mountMain("linux", 1680);
          try {
            const before = resizeRequests().length;
            // A window the compositor is not repainting: requestAnimationFrame never calls back.
            const frames = vi.fn(() => 0);
            vi.stubGlobal("requestAnimationFrame", frames);
            await changeResolution(settle, 1024, 768);
            await pollTick();
            expect(resizeRequests().slice(before)).toEqual([NATURAL_SIZE]);
            expect(frames).not.toHaveBeenCalled();
            // Accepted: later polls on the same work area send nothing.
            await pollTick();
            await pollTick();
            expect(resizeRequests()).toHaveLength(before + 1);
          } finally {
            await unmount();
          }
        });
      });

      it("retries a refit the native side refused on the next poll, and records the area only once it is accepted", async () => {
        await withWorkAreaPoll(async pollTick => {
          const { settle, unmount } = await mountMain("linux", 1680);
          try {
            const before = resizeRequests().length;
            // A transient frame (the document minimized mid-switch): resize_toolset_window says no once.
            const answer = native.invoke.getMockImplementation()!;
            let refusals = 1;
            native.invoke.mockImplementation(async (command, payload) => {
              if (command === "resize_toolset_window" && refusals > 0) {
                refusals -= 1;
                return false;
              }
              return answer(command, payload);
            });
            await changeResolution(settle, 1024, 768);
            await pollTick();
            expect(refusals).toBe(0);
            await pollTick();
            expect(resizeRequests().slice(before)).toEqual([NATURAL_SIZE, NATURAL_SIZE]);
            // Accepted now: later polls on the same work area send nothing.
            await pollTick();
            await pollTick();
            expect(resizeRequests()).toHaveLength(before + 2);
          } finally {
            await unmount();
          }
        });
      });

      it("compares with the last accepted fit, so a silent return after a move between polls still refits", async () => {
        await withWorkAreaPoll(async pollTick => {
          const { moveToWorkArea, nativeResize, settle, unmount } = await mountMain("linux", 1680);
          try {
            const before = resizeRequests().length;
            // Between two polls: a move fits Main to a 1024 screen, then the work area silently
            // returns to 1680 (no move, resize or scale event).
            await moveToWorkArea(1024, 768);
            await nativeResize();
            const afterMove = resizeRequests().length;
            expect(afterMove).toBeGreaterThan(before);
            await changeResolution(settle, 1680, 1050);
            expect(resizeRequests()).toHaveLength(afterMove);
            // The poll's earlier read was 1680, but the last accepted fit was for 1024: refit.
            await pollTick();
            expect(resizeRequests().slice(afterMove)).toEqual([NATURAL_SIZE]);
          } finally {
            await unmount();
          }
        });
      });

      it("records the area the accepted fit used, not the one the poll read", async () => {
        await withWorkAreaPoll(async pollTick => {
          const { settle, unmount } = await mountMain("linux", 1680);
          try {
            const before = resizeRequests().length;
            await changeResolution(settle, 1024, 768);
            // The poll reads the new 1024 area, but the fit it starts re-reads a stale 1280 one.
            native.workArea
              .mockResolvedValueOnce({ left: 0, top: 0, right: 1024, bottom: 768 })
              .mockResolvedValueOnce({ left: 0, top: 0, right: 1280, bottom: 768 });
            await pollTick();
            expect(resizeRequests().slice(before)).toEqual([NATURAL_SIZE]);
            // That fit was for 1280, so the 1024 read on the next poll is still a change.
            await pollTick();
            expect(resizeRequests().slice(before)).toEqual([NATURAL_SIZE, NATURAL_SIZE]);
            // Fitted to 1024 now: later polls send nothing.
            await pollTick();
            await pollTick();
            expect(resizeRequests()).toHaveLength(before + 2);
          } finally {
            await unmount();
          }
        });
      });

      it("refits directly on a scale change alone when the window runs no animation frames", async () => {
        await withWorkAreaPoll(async pollTick => {
          const { unmount } = await mountMain("linux", 1680);
          try {
            const before = resizeRequests().length;
            const frames = vi.fn(() => 0);
            vi.stubGlobal("requestAnimationFrame", frames);
            // Same work area, new scale, and no tauri://scale-change reached the fit.
            vi.stubGlobal("devicePixelRatio", (window.devicePixelRatio || 1) * 2);
            await pollTick();
            expect(resizeRequests().slice(before)).toEqual([NATURAL_SIZE]);
            expect(frames).not.toHaveBeenCalled();
            await pollTick();
            await pollTick();
            expect(resizeRequests()).toHaveLength(before + 1);
          } finally {
            await unmount();
          }
        });
      });

      it("polls nothing while the palette is hidden, and refits once it is shown", async () => {
        await withWorkAreaPoll(async pollTick => {
          const { settle, unmount } = await mountMain("linux", 1680);
          const hidden = vi.spyOn(document, "hidden", "get");
          try {
            const before = resizeRequests().length;
            hidden.mockReturnValue(true);
            await changeResolution(settle, 1024, 768);
            await pollTick();
            expect(resizeRequests()).toHaveLength(before);
            hidden.mockReturnValue(false);
            await pollTick();
            expect(resizeRequests().slice(before)).toEqual([NATURAL_SIZE]);
          } finally {
            await unmount();
          }
        });
      });
    });

    it.each(["macos", "windows"] as const)("does not poll a content-fit palette's work area on %s", async platform => {
      await withWorkAreaPoll(async pollTick => {
        const { unmount } = await mountMain(platform, 1024);
        try {
          const before = resizeRequests().length;
          const workAreaReads = native.workArea.mock.calls.length;
          native.workArea.mockResolvedValue({ left: 0, top: 0, right: 1680, bottom: 1050 });
          await pollTick();
          await pollTick();
          expect(resizeRequests()).toHaveLength(before);
          expect(native.workArea.mock.calls).toHaveLength(workAreaReads);
        } finally {
          await unmount();
        }
      });
    });

    it.each(["macos", "windows"] as const)("does not re-send on monitor moves, scale changes or resizes on %s", async platform => {
      const { scroller, nativeResize, moveToWorkArea, nativeResizeTo, unmount } = await mountMain(platform, 1024);
      try {
        const before = resizeRequests().length;
        await moveToWorkArea(1680, 1050);
        native.workAreaEvents.get("tauri://scale-change")?.();
        await nativeResizeTo(NATURAL_WIDTH);
        await moveToWorkArea(1024, 768);
        await nativeResizeTo(1024);
        await nativeResize();
        expect(resizeRequests()).toHaveLength(before);
        expectNaturalAndUnscrolled(scroller);
      } finally {
        await unmount();
      }
    });

    it("gives a Linux palette that fits its window no scrollbar", async () => {
      const { scroller, nativeResize, unmount } = await mountMain("linux", 1400);
      try {
        await nativeResize();
        expectNaturalAndUnscrolled(scroller);
        expect(distinctSizes()).toEqual([NATURAL_SIZE]);
      } finally {
        await unmount();
      }
    });
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
