import { describe, expect, it, vi } from "vitest";
import { reconcileNativePaletteWindows, type NativePaletteReconcileDeps } from "./reconcileNativePalettes";
import type { ToolsetWindowState } from "../window-manager";

function state(toolsetId: string, open: boolean): ToolsetWindowState {
  return { toolsetId, open, focused: false };
}

function baseDeps(overrides: Partial<NativePaletteReconcileDeps> = {}): NativePaletteReconcileDeps {
  return {
    listToolsetWindowStates: async () => [],
    openToolsetWindow: async (toolsetId) => state(toolsetId, true),
    closeToolsetWindow: async (toolsetId) => state(toolsetId, false),
    isKnownToolset: () => true,
    desiredVisibleToolsetIds: () => ["core.main"],
    delay: async () => undefined, // no real timers in tests
    maxAttempts: 3,
    retryDelayMs: 0,
    ...overrides
  };
}

describe("reconcileNativePaletteWindows", () => {
  it("stays native when a toolset window opens on the first try", async () => {
    const openToolsetWindow = vi.fn(async (id: string) => state(id, true));
    const result = await reconcileNativePaletteWindows(baseDeps({ openToolsetWindow }));

    expect(result).toEqual({ outcome: "native", openedToolsetIds: ["core.main"] });
    expect(openToolsetWindow).toHaveBeenCalledTimes(1);
  });

  // The regression guard for "toolboxes stuck in the viewport": open_toolset_window reports the
  // window via is_visible(), which can be briefly false on the frame the window is created. A
  // one-shot reconciler saw zero open windows and permanently fell back to in-window palettes.
  // Retrying must rescue that transient miss instead of trapping the user.
  it("does NOT fall back when the first pass transiently reports no open window, then succeeds", async () => {
    let calls = 0;
    const openToolsetWindow = vi.fn(async (id: string) => {
      calls += 1;
      return state(id, calls >= 2); // first attempt: not-yet-visible; second: visible
    });

    const result = await reconcileNativePaletteWindows(baseDeps({ openToolsetWindow }));

    expect(result).toEqual({ outcome: "native", openedToolsetIds: ["core.main"] });
    expect(openToolsetWindow).toHaveBeenCalledTimes(2); // proves it retried rather than giving up
  });

  it("recovers from a transient IPC error before falling back", async () => {
    let listed = 0;
    const listToolsetWindowStates = vi.fn(async () => {
      listed += 1;
      if (listed === 1) {
        throw new Error("bridge not ready");
      }
      return [] as ToolsetWindowState[];
    });

    const result = await reconcileNativePaletteWindows(baseDeps({ listToolsetWindowStates }));

    expect(result.outcome).toBe("native");
    expect(listToolsetWindowStates).toHaveBeenCalledTimes(2);
  });

  it("falls back to in-window palettes only when native windows never open", async () => {
    const openToolsetWindow = vi.fn(async (id: string) => state(id, false));
    const result = await reconcileNativePaletteWindows(baseDeps({ openToolsetWindow, maxAttempts: 3 }));

    expect(result).toEqual({ outcome: "fallback" });
    expect(openToolsetWindow).toHaveBeenCalledTimes(3); // one open attempt per retry
  });

  it("reuses windows the OS already restored without reopening them", async () => {
    const openToolsetWindow = vi.fn(async (id: string) => state(id, true));
    const result = await reconcileNativePaletteWindows(
      baseDeps({
        listToolsetWindowStates: async () => [state("core.main", true)],
        openToolsetWindow
      })
    );

    expect(result).toEqual({ outcome: "native", openedToolsetIds: ["core.main"] });
    expect(openToolsetWindow).not.toHaveBeenCalled();
  });

  it("ignores stale toolset ids that are no longer in the registry", async () => {
    const openToolsetWindow = vi.fn(async (id: string) => state(id, true));
    const result = await reconcileNativePaletteWindows(
      baseDeps({
        desiredVisibleToolsetIds: () => ["core.main", "plugin.removed"],
        isKnownToolset: (id) => id !== "plugin.removed",
        openToolsetWindow
      })
    );

    expect(result).toEqual({ outcome: "native", openedToolsetIds: ["core.main"] });
    expect(openToolsetWindow).toHaveBeenCalledTimes(1);
    expect(openToolsetWindow).toHaveBeenCalledWith("core.main");
  });

  it("abandons quietly when the effect is cancelled (unmounted) mid-reconcile", async () => {
    const result = await reconcileNativePaletteWindows(baseDeps({ isCancelled: () => true }));
    expect(result).toEqual({ outcome: "cancelled" });
  });

  // An empty desired set means "hide everything" — a successful native outcome (opening nothing), not
  // a failure. It is honored exactly, never replaced with a default set. Misreading it as "native
  // windows unavailable" would exhaust the retries and trap the session in in-window palettes.
  it("stays native (opening nothing) when nothing is desired", async () => {
    const openToolsetWindow = vi.fn(async (id: string) => state(id, true));
    const result = await reconcileNativePaletteWindows(
      baseDeps({ desiredVisibleToolsetIds: () => [], openToolsetWindow })
    );

    expect(result).toEqual({ outcome: "native", openedToolsetIds: [] });
    expect(openToolsetWindow).not.toHaveBeenCalled();
  });

  // Convergence: a toolset saved as hidden but restored open by the OS must be CLOSED, not left open.
  it("closes a known window that is open but not desired", async () => {
    const closeToolsetWindow = vi.fn(async (id: string) => state(id, false));
    const result = await reconcileNativePaletteWindows(
      baseDeps({
        listToolsetWindowStates: async () => [state("core.main", true), state("core.art", true)],
        desiredVisibleToolsetIds: () => ["core.main"],
        closeToolsetWindow
      })
    );

    expect(closeToolsetWindow).toHaveBeenCalledTimes(1);
    expect(closeToolsetWindow).toHaveBeenCalledWith("core.art");
    expect(result).toEqual({ outcome: "native", openedToolsetIds: ["core.main"] });
  });

  // "Hide all": every open known window is closed and the outcome is still native (not fallback).
  it("closes every open window and stays native when the user hid everything", async () => {
    const closeToolsetWindow = vi.fn(async (id: string) => state(id, false));
    const openToolsetWindow = vi.fn(async (id: string) => state(id, true));
    const result = await reconcileNativePaletteWindows(
      baseDeps({
        listToolsetWindowStates: async () => [state("core.main", true), state("core.art", true)],
        desiredVisibleToolsetIds: () => [],
        closeToolsetWindow,
        openToolsetWindow
      })
    );

    expect(closeToolsetWindow.mock.calls.map((call) => call[0]).sort()).toEqual(["core.art", "core.main"]);
    expect(openToolsetWindow).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "native", openedToolsetIds: [] });
  });

  // An open window for an UNKNOWN toolset (a plugin mid-load, or one being uninstalled) is left alone
  // — closing it here would fight a plugin about to claim its OS-restored window.
  it("leaves an unknown/orphan open window alone", async () => {
    const closeToolsetWindow = vi.fn(async (id: string) => state(id, false));
    const result = await reconcileNativePaletteWindows(
      baseDeps({
        listToolsetWindowStates: async () => [state("core.main", true), state("plugin.pending", true)],
        isKnownToolset: (id) => id !== "plugin.pending",
        desiredVisibleToolsetIds: () => ["core.main"],
        closeToolsetWindow
      })
    );

    expect(closeToolsetWindow).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "native", openedToolsetIds: ["core.main"] });
  });
});
