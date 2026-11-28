import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { estimateNativeMenuSize, placeNativeCanvasMenu, popupNativeCanvasMenu, readNativeMenuScreen, type NativeMenuScreen } from "./nativeCanvasContextMenu";
import { pageCanvasMenu, toNativeCanvasMenu, type CanvasMenuItem } from "./canvasContextMenuModel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("native canvas menu transport", () => {
  beforeEach(() => vi.clearAllMocks());
  it("routes a returned popup ID through the existing owner callback once", async () => {
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const { items } = args as { items: { id: string }[] };
      return items[1].id as never;
    });
    const result = await popupNativeCanvasMenu(pageCanvasMenu, { x: 123, y: 45 });
    const onInvoke = vi.fn();
    expect(result?.select(onInvoke)).toBe(true);
    expect(result?.select(onInvoke)).toBe(false);
    expect(onInvoke).toHaveBeenCalledExactlyOnceWith("edit.selectAll");
    expect(invoke).toHaveBeenCalledWith("popup_canvas_context_menu", {
      position: { x: 123, y: 45 }, items: expect.any(Array)
    });
  });
  it("distinguishes cancellation from native unavailability", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const result = await popupNativeCanvasMenu(pageCanvasMenu, { x: 0, y: 0 });
    const onInvoke = vi.fn();
    expect(result).toBeDefined();
    expect(result?.select(onInvoke)).toBe(false);
    expect(onInvoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockRejectedValue(new Error("Native popup unavailable"));
    expect(await popupNativeCanvasMenu(pageCanvasMenu, { x: 0, y: 0 })).toBeUndefined();
  });
  it("never presents once the caller turns inactive during the readout wait", async () => {
    let active = true;
    let finish!: (label: string | undefined) => void;
    const pending = popupNativeCanvasMenu(pageCanvasMenu, { x: 0, y: 0 }, {
      loadStereoReadout: () => new Promise(resolve => { finish = resolve; }), isActive: () => active
    });
    active = false;
    finish("Stereocenter: R");
    expect(await pending).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe.each(["macos", "windows"] as const)("native canvas menu placement (%s)", platform => {
  beforeEach(() => vi.clearAllMocks());
  // A 1440x900 screen with a 25 px menu bar and a 70 px Dock; the window's content starts at (100, 60).
  const screen: NativeMenuScreen = { origin: { x: 100, y: 60 }, workArea: { left: 0, top: 25, right: 1440, bottom: 830 } };
  const size = { width: 240, height: 400 };
  const inside = (placed: { x: number; y: number }, extent = size) => {
    const left = screen.origin.x + placed.x, top = screen.origin.y + placed.y;
    expect(left).toBeGreaterThanOrEqual(screen.workArea.left);
    expect(top).toBeGreaterThanOrEqual(screen.workArea.top);
    expect(left + extent.width).toBeLessThanOrEqual(screen.workArea.right);
    expect(top + extent.height).toBeLessThanOrEqual(screen.workArea.bottom);
  };

  it("opens at the pointer when the whole menu fits", () => {
    expect(placeNativeCanvasMenu({ x: 300, y: 200 }, size, screen)).toEqual({ x: 300, y: 200 });
  });

  it("flips above the pointer near the bottom of the screen", () => {
    // Pointer at screen y 760: 400 px below would end at 1160, past the Dock.
    const placed = placeNativeCanvasMenu({ x: 300, y: 700 }, size, screen);
    expect(placed).toEqual({ x: 300, y: 300 });
    inside(placed);
  });

  it("flips left of the pointer near the right edge of the screen", () => {
    const placed = placeNativeCanvasMenu({ x: 1250, y: 200 }, size, screen);
    expect(placed).toEqual({ x: 1010, y: 200 });
    inside(placed);
  });

  it("flips both ways in the bottom-right corner", () => {
    const placed = placeNativeCanvasMenu({ x: 1300, y: 740 }, size, screen);
    expect(placed).toEqual({ x: 1060, y: 340 });
    inside(placed);
  });

  it("moves a menu that fits neither above nor below in from the bottom edge, never above the top", () => {
    const tall = { width: 240, height: 700 };
    const placed = placeNativeCanvasMenu({ x: 300, y: 380 }, tall, screen);
    expect(screen.origin.y + placed.y + tall.height).toBe(screen.workArea.bottom);
    inside(placed, tall);
    const taller = { width: 240, height: 2000 };
    expect(screen.origin.y + placed.y).toBeGreaterThanOrEqual(screen.workArea.top);
    expect(screen.origin.y + placeNativeCanvasMenu({ x: 300, y: 380 }, taller, screen).y).toBe(screen.workArea.top);
  });

  it("estimates every row of the menu, separators included", () => {
    const route = toNativeCanvasMenu(pageCanvasMenu, "estimate");
    const estimate = estimateNativeMenuSize(route.items, platform);
    const rows = route.items.filter(item => item.kind !== "separator").length;
    expect(estimate.height).toBeGreaterThanOrEqual(rows * 22);
    expect(estimate.width).toBeGreaterThanOrEqual(180);
  });

  it("presents a molecule menu opened near the bottom-right corner fully on the screen", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const molecule: CanvasMenuItem[] = Array.from({ length: 14 }, (_, index) => (
      { kind: "command", label: `Molecule command ${index}`, commandId: "edit.selectAll", enabled: true }));
    await popupNativeCanvasMenu(molecule, { x: 1320, y: 750 }, {
      platform, readScreen: async () => screen, loadStereoReadout: async () => "Stereocenter: R"
    });
    const { position, items } = vi.mocked(invoke).mock.calls[0][1] as { position: { x: number; y: number }; items: [] };
    // The stereo row and its separator are counted: the menu is measured as it opens.
    expect(items).toHaveLength(16);
    inside(position, estimateNativeMenuSize(items, platform));
    expect(position.y).toBeLessThan(750);
    expect(position.x).toBeLessThan(1320);
  });

  it("scales the menu by the pointer monitor's menu scale before fitting it", () => {
    // 200 px tall at screen y 600 fits above the Dock (800 <= 830).
    const short = { width: 240, height: 200 };
    expect(placeNativeCanvasMenu({ x: 300, y: 540 }, short, screen)).toEqual({ x: 300, y: 540 });
    // Drawn half again as large, 300 px tall, it no longer fits below and flips above.
    const placed = placeNativeCanvasMenu({ x: 300, y: 540 }, short, { ...screen, menuScale: 1.5 });
    expect(placed).toEqual({ x: 300, y: 240 });
    inside(placed, { width: 360, height: 300 });
  });

  describe("a pointer on another monitor than the window's", () => {
    // The window's own monitor is 1440x900 on the left; the pointer is on a 1920x1080 monitor to
    // its right whose bottom 48 px are a Dock or taskbar.
    const ownWorkArea = { left: 0, top: 25, right: 1440, bottom: 830 };
    const otherMonitor = { left: 1440, top: 0, right: 3360, bottom: 1080 };
    const otherWorkArea = { left: 1440, top: 0, right: 3360, bottom: 1032 };
    const native = (monitorAt: unknown, pointer = { x: 1600, y: 1010 }) =>
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === "window_logical_position") return { x: 100, y: 60 } as never;
        if (command === "current_window_logical_work_area") return ownWorkArea as never;
        if (command === "monitor_logical_bounds_at") {
          // Looked up in the window's own space, the one its origin and client coordinates are in.
          expect(args).toEqual({ ...pointer, windowSpace: true });
          return monitorAt as never;
        }
        return null as never;
      });
    beforeEach(() => { vi.stubGlobal("__TAURI_INTERNALS__", {}); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it("fits the menu in that monitor's work area, clear of its Dock or taskbar", async () => {
      native({ ...otherMonitor, workArea: otherWorkArea, unitsPerLogicalPixel: 1 });
      expect(await readNativeMenuScreen({ x: 1500, y: 950 }))
        .toEqual({ origin: { x: 100, y: 60 }, workArea: otherWorkArea, menuScale: 1 });
      await popupNativeCanvasMenu(pageCanvasMenu, { x: 1500, y: 950 }, { platform });
      const call = vi.mocked(invoke).mock.calls.find(([command]) => command === "popup_canvas_context_menu")!;
      const { position, items } = call[1] as { position: { x: number; y: number }; items: [] };
      const size = estimateNativeMenuSize(items, platform);
      expect(60 + position.y + size.height).toBeLessThanOrEqual(otherWorkArea.bottom);
      expect(100 + position.x).toBeGreaterThanOrEqual(otherWorkArea.left);
    });

    it("uses the work area the native side finds for a pointer on the window's own monitor", async () => {
      native({ left: 0, top: 0, right: 1440, bottom: 900, workArea: ownWorkArea, unitsPerLogicalPixel: 1 }, { x: 400, y: 260 });
      expect(await readNativeMenuScreen({ x: 300, y: 200 }))
        .toEqual({ origin: { x: 100, y: 60 }, workArea: ownWorkArea, menuScale: 1 });
    });

    it("falls back to the whole monitor, then the window's work area, when the native side says less", async () => {
      native(otherMonitor);
      expect(await readNativeMenuScreen({ x: 1500, y: 950 }))
        .toEqual({ origin: { x: 100, y: 60 }, workArea: otherMonitor, menuScale: 1 });
      native(null);
      expect(await readNativeMenuScreen({ x: 1500, y: 950 })).toEqual({ origin: { x: 100, y: 60 }, workArea: ownWorkArea });
    });

    it("keeps the menu by the pointer on a 150% monitor beside a 100% window", async () => {
      // Windows: a 100% 1920x1080 primary holding the window, and a 150% 3840x2160 monitor to its
      // right. The window's space is the physical desktop, so that monitor spans 1920..5760 there
      // (each monitor divided by its own scale would put it at 1280..3840 x 0..1440 and miss a
      // pointer low on it). Its taskbar takes the bottom 72 units, and a menu on it is drawn at 1.5x.
      const bigWorkArea = { left: 1920, top: 0, right: 5760, bottom: 2088 };
      const route = toNativeCanvasMenu(pageCanvasMenu, "size");
      const size = estimateNativeMenuSize(route.items, platform);
      // Low enough that the menu fits below at 1x but not at 1.5x.
      const pointer = { x: 2000, y: Math.round(bigWorkArea.bottom - size.height * 1.2) };
      const client = { x: pointer.x - 100, y: pointer.y - 60 };
      native({ left: 1920, top: 0, right: 5760, bottom: 2160, workArea: bigWorkArea, unitsPerLogicalPixel: 1.5 }, pointer);
      await popupNativeCanvasMenu(pageCanvasMenu, client, { platform });
      const call = vi.mocked(invoke).mock.calls.find(([command]) => command === "popup_canvas_context_menu")!;
      const { position } = call[1] as { position: { x: number; y: number } };
      // Still at the pointer on the 150% monitor, not pulled back onto the window's own monitor,
      // and flipped above it so the larger menu clears the taskbar.
      expect(position.x).toBe(client.x);
      expect(100 + position.x).toBeGreaterThanOrEqual(bigWorkArea.left);
      expect(position.y).toBe(client.y - size.height * 1.5);
      expect(60 + position.y + size.height * 1.5).toBeLessThanOrEqual(bigWorkArea.bottom);
      expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "current_window_logical_work_area")).toBe(false);
    });
  });

  it("opens at the pointer when the screen cannot be read", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await popupNativeCanvasMenu(pageCanvasMenu, { x: 1320, y: 750 }, {
      platform, readScreen: async () => { throw new Error("no monitor"); }
    });
    expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ position: { x: 1320, y: 750 } });
  });
});

describe("native menu document ownership guards", () => {
  const nativeRoot = resolve(import.meta.dirname, "../src-tauri/src");
  const lib = readFileSync(resolve(nativeRoot, "lib.rs"), "utf8");
  it("keeps install_app_menu app-wide on macOS and document-only elsewhere", () => {
    const install = lib.slice(lib.indexOf("fn install_app_menu<"), lib.indexOf("fn reinstall_app_menu<"));
    expect(install).toContain('#[cfg(target_os = "macos")]\n    app.set_menu(menu)?;');
    expect(install).toContain('#[cfg(not(target_os = "macos"))]');
    expect(install).toContain("app.get_webview_window(MAIN_WINDOW_LABEL)");
    expect(install).toContain("window.set_menu(menu)?;");
    expect(install).not.toMatch(/toolset|palette|popover|webview_windows\(/);
  });
  it("does not introduce application-menu attachments on palettes or popovers", () => {
    const sites: string[] = [];
    function scan(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (entry.name.endsWith(".rs")) {
          const source = readFileSync(path, "utf8");
          for (const match of source.matchAll(/^\s*(\w+)\.set_menu\(/gm)) sites.push(`${entry.name}:${match[1]}`);
        }
      }
    }
    scan(nativeRoot);
    expect(sites.sort()).toEqual(["lib.rs:app", "lib.rs:window"]);
  });
});
