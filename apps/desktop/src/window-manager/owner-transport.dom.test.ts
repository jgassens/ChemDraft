// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  current: "main",
  failList: false,
  windows: ["main", "document-2", "toolset-core-main", "toolset-popover-core-main", "toolset-tooltip",
    "toolset-core-main--document-2", "toolset-popover-core-main--document-2", "toolset-tooltip--document-2", "preferences", "plugin-panel-v1x61x62", "plugin-panel-v1x61x62--document-2"],
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  deliveries: [] as Array<{ target: string; event: string }>
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command !== "document_window_owner") throw new Error(command);
    if (native.current === "main" || native.current === "document-2") return native.current;
    return native.current.endsWith("--document-2") ? "document-2" : "main";
  })
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: native.current }), getAllWindows: async () => { if (native.failList) throw new Error("native window list unavailable"); return native.windows.map(label => ({ label })); } }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: async (target: string, event: string, payload: unknown) => {
    native.deliveries.push({ target, event });
    for (const handler of native.listeners.get(`${target}:${event}`) ?? []) handler({ payload });
  },
  emit: () => { throw new Error("Global broadcast forbidden"); },
  listen: () => { throw new Error("Global listener forbidden"); }
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => {
    const label = native.current;
    return { listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
      const key = `${label}:${event}`;
      const handlers = native.listeners.get(key) ?? new Set();
      handlers.add(handler); native.listeners.set(key, handlers);
      return () => { handlers.delete(handler); };
    } };
  }
}));
import {
  broadcastToolsetActiveTool, listenForToolsetActiveTool, requestToolsetActiveTool,
  listenForToolsetActiveToolRequests, sendPaletteCommandPreview, listenForPaletteCommandPreviews,
  broadcastQuitSettings, listenForQuitSettings, setToolsetPopoverContent,
  requestToolsetPopoverContent, ownedUtilityWindowLabel, broadcastSharedToolsetLayoutState, listenForSharedToolsetLayoutState
} from "./index";

import {
  broadcastPluginPanelReport, listenForAnalysisWindowActions, requestAnalysisWindowAction,
  respondToCopyMolecularInspector, pluginPanelIdentityFromWindowLabel
} from "../plugins/panelBridge";

beforeEach(() => {
  (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
  native.current = "main"; native.failList = false; native.listeners.clear(); native.deliveries.length = 0;
  // Each native webview has its own DOM; this harness shares one and exercises native delivery only.
  vi.spyOn(window, "dispatchEvent").mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); delete (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__; });

describe("document-owned utility transport", () => {
  it("keeps active tool snapshots within each document's palette group", async () => {
    native.current = "toolset-core-main";
    const main = vi.fn(); const stopMain = await listenForToolsetActiveTool(main);
    native.current = "toolset-core-main--document-2";
    const second = vi.fn(); const stopSecond = await listenForToolsetActiveTool(second);
    native.current = "document-2";
    await broadcastToolsetActiveTool("tool.bond");
    expect(second).toHaveBeenCalledWith("tool.bond");
    expect(main).not.toHaveBeenCalled();
    expect(native.deliveries.every(delivery => delivery.target.endsWith("--document-2"))).toBe(true);
    stopMain(); stopSecond();
  });

  it("routes secondary palette requests and previews only to the owning document", async () => {
    const mainRequest = vi.fn(), mainPreview = vi.fn(), secondRequest = vi.fn(), secondPreview = vi.fn();
    const stops = [await listenForToolsetActiveToolRequests(mainRequest), await listenForPaletteCommandPreviews(mainPreview)];
    native.current = "document-2";
    stops.push(await listenForToolsetActiveToolRequests(secondRequest), await listenForPaletteCommandPreviews(secondPreview));
    native.current = "toolset-core-main--document-2";
    await requestToolsetActiveTool();
    await sendPaletteCommandPreview("style.test");
    expect(secondRequest).toHaveBeenCalledOnce();
    expect(secondPreview).toHaveBeenCalledWith("style.test");
    expect(mainRequest).not.toHaveBeenCalled(); expect(mainPreview).not.toHaveBeenCalled();
    for (const stop of stops) stop();
  });

  it("targets exact same-owner palette/popover siblings and retains legacy main labels", async () => {
    native.current = "toolset-core-main--document-2";
    await setToolsetPopoverContent("core.main", { kind: "artColor" });
    await requestToolsetPopoverContent("core.main");
    expect(native.deliveries.map(delivery => delivery.target)).toEqual([
      "toolset-popover-core-main--document-2", "toolset-core-main--document-2"
    ]);
    expect(ownedUtilityWindowLabel("main", "toolset-tooltip")).toBe("toolset-tooltip");
  });

  it("shares toolbar customization with peer documents while retaining local snapshot ownership", async () => {
    const main = vi.fn(); const stopMain = await listenForSharedToolsetLayoutState(main);
    native.current = "document-2";
    const second = vi.fn(); const stopSecond = await listenForSharedToolsetLayoutState(second);
    native.current = "main";
    await broadcastSharedToolsetLayoutState({ version: 1 });
    expect(second).toHaveBeenCalledWith({ version: 1 });
    expect(main).not.toHaveBeenCalled();
    expect(native.deliveries.map(delivery => delivery.target)).toEqual(["document-2"]);
    stopMain(); stopSecond();
  });

  it("routes panel reports and receipts within the owner and panel actions back to that document", async () => {
    const mainAction = vi.fn(); const stopMain = listenForAnalysisWindowActions(mainAction);
    await (stopMain as typeof stopMain & { ready: Promise<void> }).ready;
    native.current = "document-2";
    const secondAction = vi.fn(); const stopSecond = listenForAnalysisWindowActions(secondAction);
    await (stopSecond as typeof stopSecond & { ready: Promise<void> }).ready;
    await broadcastPluginPanelReport({ pluginId: "a", panelId: "b", report: { title: "Result", sections: [] }, revision: 1 });
    expect(native.deliveries.map(delivery => delivery.target)).toEqual(["plugin-panel-v1x61x62--document-2"]);
    native.current = "plugin-panel-v1x61x62--document-2";
    await requestAnalysisWindowAction({ kind: "copyMolecularInspector", text: "drawing" });
    expect(secondAction).toHaveBeenCalledWith({ kind: "copyMolecularInspector", text: "drawing" });
    expect(mainAction).not.toHaveBeenCalled();
    native.current = "document-2";
    native.deliveries.length = 0;
    await respondToCopyMolecularInspector("request-1", true);
    expect(native.deliveries.map(delivery => delivery.target)).toEqual(["plugin-panel-v1x61x62--document-2"]);
    expect(pluginPanelIdentityFromWindowLabel("plugin-panel-v1x61x62--document-2")).toEqual({ pluginId: "a", panelId: "b" });
    expect(pluginPanelIdentityFromWindowLabel("plugin-panel-v1x61x62--document-invalid")).toBeUndefined();
    stopMain(); stopSecond();
  });

  it("reports shared preference delivery failure without rejecting a fire-and-forget UI callback", async () => {
    native.failList = true;
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(broadcastQuitSettings(true)).resolves.toBeUndefined();
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("Could not synchronize shared preference"), expect.any(Error));
  });

  it("synchronizes shared settings through explicit targets across document windows", async () => {
    const main = vi.fn(); const stopMain = await listenForQuitSettings(main);
    native.current = "document-2";
    const second = vi.fn(); const stopSecond = await listenForQuitSettings(second);
    native.current = "preferences";
    await broadcastQuitSettings(true);
    expect(main).toHaveBeenCalledWith(true); expect(second).toHaveBeenCalledWith(true);
    expect(native.deliveries.map(delivery => delivery.target)).toEqual(native.windows);
    stopMain(); stopSecond();
  });
});
