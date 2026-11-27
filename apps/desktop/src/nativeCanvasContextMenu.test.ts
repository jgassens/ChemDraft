import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { estimateNativeMenuSize, placeNativeCanvasMenu, popupNativeCanvasMenu, type NativeMenuScreen } from "./nativeCanvasContextMenu";
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
