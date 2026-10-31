// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import * as bridge from "./panelBridge";

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

  it("requires native analysis senders and ignores forged desktop CustomEvents", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    let receive!: (event: { payload: unknown }) => void;
    native.listen.mockImplementation(async (_name, handler) => { receive = handler; return () => undefined; });
    const handler = vi.fn();
    const stop = bridge.listenForAnalysisWindowActions(handler);
    await Promise.resolve();
    const action = { kind: "acceptPluginProposal", proposalId: "proposal-1" };
    const sourceLabel = bridge.pluginPanelWindowLabel({ pluginId: bridge.ANALYSIS_WINDOW_OWNER_ID, panelId: bridge.PATCH_REVIEW_WINDOW_ID });
    window.dispatchEvent(new CustomEvent(ANALYSIS_WINDOW_ACTION_EVENT, { detail: { ...action, sourceLabel } }));
    receive({ payload: action });
    receive({ payload: { ...action, sourceLabel: 1 } });
    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    receive({ payload: { ...action, sourceLabel } });
    expect(handler).toHaveBeenCalledExactlyOnceWith({ ...action, sourceLabel }, sourceLabel);
    stop();
    receive({ payload: { ...action, sourceLabel } });
    expect(handler).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("publishes reports, snapshots, tombstones and replies directly to their own webview", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.invoke.mockResolvedValue(undefined);
    const identity = { pluginId: "org.example", panelId: "panel.example.result" };
    const targetLabel = bridge.pluginPanelWindowLabel(identity);
    const report = { ...identity, revision: 1, report: { title: "Result", sections: [] } };
    const snapshot = { ...identity, revision: 2, content: { kind: "patchReview" as const, proposals: [] } };
    const cleared = { ...identity, revision: 3 };
    const stale = { ...identity, revision: 1, stale: true };
    await bridge.broadcastPluginPanelReport(report);
    await bridge.broadcastAnalysisWindowSnapshot(snapshot);
    await bridge.broadcastPluginPanelReportCleared(cleared);
    await bridge.broadcastPluginPanelStaleness(stale);
    await bridge.respondToCopyMolecularInspector("copy", true, targetLabel);
    await bridge.respondToSaveTextFile("save", "saved", targetLabel);
    await bridge.respondToProposalDecision("proposal", { ok: true, message: "Applied" }, targetLabel);
    await bridge.respondToPluginPanelAction("action", { ok: true }, targetLabel);
    const publications = [
      [bridge.PLUGIN_PANEL_REPORT_EVENT, report],
      [bridge.ANALYSIS_WINDOW_SNAPSHOT_EVENT, snapshot],
      [bridge.PLUGIN_PANEL_REPORT_CLEARED_EVENT, cleared],
      [bridge.PLUGIN_PANEL_STALENESS_EVENT, stale],
      [bridge.ANALYSIS_WINDOW_ACTION_RESULT_EVENT, { requestId: "copy", ok: true }],
      [bridge.ANALYSIS_WINDOW_ACTION_RESULT_EVENT, { requestId: "save", result: "saved" }],
      [bridge.ANALYSIS_WINDOW_ACTION_RESULT_EVENT, { requestId: "proposal", proposal: { ok: true, message: "Applied" } }],
      [bridge.PLUGIN_PANEL_ACTION_RESULT_EVENT, { id: "action", result: { ok: true } }]
    ];
    expect(native.invoke.mock.calls).toEqual(publications.map(([event, payload]) => [
      "open_plugin_panel_window", { publication: { targetLabel, event, payload } }
    ]));
    expect(native.emitTo).not.toHaveBeenCalled();
  });

  it("keeps the existing native window-open request unchanged beside private publications", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.invoke.mockResolvedValue(undefined);
    const identity = { pluginId: "org.example", panelId: "panel.example.result" };
    await bridge.openPluginPanelWindow({ ...identity, title: "Spectrum", width: 940, height: 660 });
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("open_plugin_panel_window", { request: {
      panelId: bridge.pluginPanelWindowId(identity.pluginId, identity.panelId), title: "Spectrum", width: 940, height: 660
    } });
  });

  it("round-trips every waiting analysis button through private native delivery", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    window.history.replaceState(null, "", "/?window=pluginPanel");
    native.listen.mockResolvedValue(() => undefined);
    native.invoke.mockImplementation(async (_command, args) => {
      const action = args.payload;
      const reply = action.kind === "acceptPluginProposal" || action.kind === "rejectPluginProposal"
        ? { proposal: { ok: true, message: "Resolved" } }
        : action.kind === "saveBinaryFile" || action.kind === "saveTextFile" ? { result: "saved" } : { ok: true };
      window.dispatchEvent(new CustomEvent(bridge.ANALYSIS_WINDOW_ACTION_RESULT_EVENT, {
        detail: { requestId: action.requestId, ...reply }
      }));
    });
    await expect(bridge.requestCopyAnalysisText("ethanol")).resolves.toBe(true);
    await expect(bridge.requestCopySpectrumFromMain("png", "svg")).resolves.toBe(true);
    await expect(bridge.requestSaveBinaryFileFromMain("spectrum.png", "png", "png")).resolves.toBe("saved");
    for (const format of ["svg", "pdf", "jcamp"] as const) {
      await expect(bridge.requestSaveTextFileFromMain("spectrum", "data", format)).resolves.toBe("saved");
    }
    for (const decision of ["accept", "reject"] as const) {
      await expect(bridge.requestProposalDecision(decision, "proposal-1")).resolves.toEqual({ ok: true, message: "Resolved" });
    }
    expect(native.invoke.mock.calls.every(([command]) => command === "plugin_panel_event_forward")).toBe(true);
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
