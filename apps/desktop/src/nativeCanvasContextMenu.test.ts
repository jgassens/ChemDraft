import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { popupNativeCanvasMenu } from "./nativeCanvasContextMenu";
import { pageCanvasMenu } from "./canvasContextMenuModel";

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
