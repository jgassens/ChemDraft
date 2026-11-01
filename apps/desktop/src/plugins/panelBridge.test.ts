// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PLUGIN_PANEL_ACTION_EVENT,
  PLUGIN_PANEL_CLOSED_EVENT,
  PLUGIN_PANEL_REQUEST_EVENT,
  PLUGIN_PANEL_RERUN_EVENT,
  ANALYSIS_WINDOW_ACTION_EVENT,
  PLUGIN_PANEL_ACTION_TIMEOUT_MS,
  listenForPluginPanelActions,
  requestPluginPanelAction,
  requestPluginPanelReport,
  requestPluginPanelRerun,
  notifyPluginPanelClosed,
  requestAnalysisWindowAction,
  respondToPluginPanelAction
} from "./panelBridge";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), emitTo: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: native.emitTo }));
vi.mock("../window-manager/tauriEvents", () => ({ listenTauriEvent: native.listen }));

describe("plugin panel action bridge", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); window.history.replaceState(null, "", "/"); });

  it("keeps legacy panel requests on the allowlisted native transport", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    window.history.replaceState(null, "", "/?window=pluginPanel");
    native.invoke.mockResolvedValue(undefined);
    const identity = { pluginId: "org.panelA", panelId: "panel.a.chat" };
    await requestPluginPanelReport(identity);
    await requestPluginPanelRerun(identity);
    await notifyPluginPanelClosed(identity);
    await requestAnalysisWindowAction({ kind: "close", windowId: "analysis" });
    expect(native.invoke.mock.calls).toEqual([
      ["plugin_panel_event_forward", { event: PLUGIN_PANEL_REQUEST_EVENT, payload: identity }],
      ["plugin_panel_event_forward", { event: PLUGIN_PANEL_RERUN_EVENT, payload: identity }],
      ["plugin_panel_event_forward", { event: PLUGIN_PANEL_CLOSED_EVENT, payload: identity }],
      ["plugin_panel_event_forward", { event: ANALYSIS_WINDOW_ACTION_EVENT, payload: { kind: "close", windowId: "analysis" } }]
    ]);
  });

  it("uses caller-authenticated IPC rather than a panel-supplied event sender", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.listen.mockResolvedValue(() => undefined);
    native.invoke.mockRejectedValue(new Error("not a panel"));
    await expect(requestPluginPanelAction({ panelId: "panel.b.chat", sectionId: "composer", control: "prompt", text: "draw" }))
      .resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(native.invoke).toHaveBeenCalledWith("plugin_panel_action_forward", { request: {
      id: expect.any(String), request: { panelId: "panel.b.chat", sectionId: "composer", control: "prompt", text: "draw" }
    } });
    expect(native.emitTo).not.toHaveBeenCalled();
  });

  it("requires a native source label and ignores CustomEvents in the desktop host", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    let receive!: (event: { payload: unknown }) => void;
    native.listen.mockImplementation(async (_name, handler) => { receive = handler; return () => undefined; });
    const handler = vi.fn();
    const stop = listenForPluginPanelActions(handler);
    await Promise.resolve();
    const envelope = { id: "action", request: { panelId: "panel.b.chat", sectionId: "ask", control: "prompt", text: "draw" } };
    window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_ACTION_EVENT, { detail: { ...envelope, sourceLabel: "plugin-panel-forged" } }));
    receive({ payload: envelope });
    expect(handler).not.toHaveBeenCalled();
    receive({ payload: { ...envelope, sourceLabel: "plugin-panel-authenticated" } });
    expect(handler).toHaveBeenCalledExactlyOnceWith(envelope.id, envelope.request, "plugin-panel-authenticated");
    stop();
  });

  it("handles partially initialised native IPC without unhandled rejections", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.listen.mockRejectedValue(new Error("IPC unavailable"));
    const stop = listenForPluginPanelActions(vi.fn());
    await expect(requestPluginPanelAction({ panelId: "panel.a.chat", sectionId: "ask", control: "prompt", text: "draw" }))
      .resolves.toEqual({ ok: false, reason: "unavailable" });
    stop();
  });

  it("round-trips an action through CustomEvents", async () => {
    const unlisten = listenForPluginPanelActions((id, request) => {
      expect(request).toEqual({ panelId: "panel.example.chat", sectionId: "composer", control: "prompt", text: "draw water" });
      void respondToPluginPanelAction(id, { ok: true });
    });

    await expect(requestPluginPanelAction({ panelId: "panel.example.chat", sectionId: "composer", control: "prompt", text: "draw water" }))
      .resolves.toEqual({ ok: true });
    unlisten();
  });

  it("times out when the document window does not answer", async () => {
    vi.useFakeTimers();
    const pending = requestPluginPanelAction({ panelId: "panel.example.chat", sectionId: "composer", control: "prompt", text: "draw" });
    await vi.advanceTimersByTimeAsync(PLUGIN_PANEL_ACTION_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  it("stops delivering CustomEvent requests after unlisten", async () => {
    const handler = vi.fn();
    const unlisten = listenForPluginPanelActions(handler);
    unlisten();
    const pending = requestPluginPanelAction({ panelId: "panel.example.chat", sectionId: "composer", control: "prompt", text: "draw" }, 0);
    await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(handler).not.toHaveBeenCalled();
  });
});
