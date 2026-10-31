import { afterEach, describe, expect, it, vi } from "vitest";
import { hideCurrentPanelWindow } from "./panelWindowControls";

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
const isDesktopRuntime = vi.hoisted(() => vi.fn(() => true));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../window-manager", () => ({ isDesktopRuntime }));

afterEach(() => {
  invoke.mockReset();
  isDesktopRuntime.mockReturnValue(true);
});

describe("panel window controls", () => {
  it("hides only the calling window, without a caller-supplied target", async () => {
    await hideCurrentPanelWindow();
    expect(invoke.mock.calls).toEqual([["hide_plugin_panel_window"]]);
  });

  it("keeps the web fallback free of native calls", async () => {
    isDesktopRuntime.mockReturnValue(false);
    await hideCurrentPanelWindow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("propagates a failed native hide", async () => {
    invoke.mockRejectedValueOnce(new Error("Window unavailable"));
    await expect(hideCurrentPanelWindow()).rejects.toThrow("Window unavailable");
  });
});
