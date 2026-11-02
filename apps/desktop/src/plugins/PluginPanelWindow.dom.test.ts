// @vitest-environment jsdom

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventCallback } from "@tauri-apps/api/event";

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalysisReport } from "@chemdraft/analysis-core";
import type { PluginPanelReport } from "@chemdraft/plugin-api";
import {
  ANALYSIS_WINDOW_ACTION_EVENT,
  ANALYSIS_WINDOW_ACTION_RESULT_EVENT,
  ANALYSIS_WINDOW_SNAPSHOT_EVENT,
  ANALYSIS_WINDOW_OWNER_ID,
  MOLECULAR_INSPECTOR_WINDOW_ID,
  PATCH_REVIEW_WINDOW_ID,
  PLUGIN_DIAGNOSTICS_WINDOW_ID,
  VALIDATION_RESULT_WINDOW_ID,
  broadcastPluginPanelReport,
  broadcastPluginPanelReportCleared,
  broadcastPluginPanelStaleness,
  broadcastAnalysisWindowSnapshot,
  listenForPluginPanelReruns,
  openPluginPanelWindow,
  PLUGIN_PANEL_CLOSED_EVENT,
  PLUGIN_PANEL_ACTION_EVENT,
  PLUGIN_PANEL_REPORT_EVENT,
  PLUGIN_PANEL_REQUEST_EVENT,
  PLUGIN_PANEL_STALENESS_EVENT,
  PLUGIN_PANEL_RERUN_EVENT,
  PROPOSAL_DECISION_TIMEOUT_MS,
  respondToPluginPanelAction,
  parsePluginPanelWindowId,
  pluginPanelWindowId,
  type PluginPanelReportPayload
} from "./panelBridge";
import { PluginPanelWindow } from "./PluginPanelWindow";
import { PluginPanelSurface } from "./PluginPanelSurface";

const tauriInvoke = vi.hoisted(() => vi.fn(async (command: string, args?: { enabled?: boolean }) => {
  if (command === "set_plugin_panel_full_size") {
    const status = { enabled: args?.enabled ?? false };
    await tauriEvents.emit("chemdraft://plugin-panel-full-size", status);
    return status;
  }
  if (command === "hide_plugin_panel_window") return nativePanel.hide();
  return command === "register_plugin_panel_input_focus" ? "page-token" : true;
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }));

// A minimal cross-window event bus: `emit` reaches every `listen`er of that event name, as Tauri's
// global emit does. `respond` lets a test stand in for the main window.
const tauriEvents = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  const emitted: { name: string; payload: unknown }[] = [];
  const pending = new Map<string, (() => void)[]>();
  const delayed = new Set<string>();
  let respond: ((name: string, payload: unknown) => void) | undefined;
  return {
    listeners,
    emitted,
    delayed,
    pending,
    attachPending(name: string) {
      for (const attach of pending.get(name) ?? []) attach();
      pending.delete(name);
    },
    setResponder(next: typeof respond) {
      respond = next;
    },
    listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
      // Native IPC registration is asynchronous; events before it finishes are lost.
      if (delayed.has(name)) await new Promise<void>((resolve) => {
        pending.set(name, [...(pending.get(name) ?? []), resolve]);
      });
      const set = listeners.get(name) ?? new Set();
      set.add(handler);
      listeners.set(name, set);
      return () => set.delete(handler);
    },
    emit: async (name: string, payload: unknown) => {
      emitted.push({ name, payload });
      for (const handler of [...(listeners.get(name) ?? [])]) handler({ payload });
      respond?.(name, payload);
    }
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriEvents.listen, emit: tauriEvents.emit }));
// Inject the native attachment at the bridge boundary while retaining safeTauriListen's real
// readiness/cleanup logic. This also avoids dynamic-import mock resolution through linked deps.
vi.mock("../window-manager/tauriEvents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../window-manager/tauriEvents")>();
  return {
    ...actual,
    listenTauriEvent: (name: string, handler: EventCallback<unknown>) =>
      actual.safeTauriListen(name, (wrapped) => tauriEvents.listen(name, ({ payload }) =>
        wrapped({ event: name, id: 1, payload })), handler).attached,
    listenCurrentWindowEvent: (name: string, handler: EventCallback<unknown>) =>
      actual.safeTauriListen(name, (wrapped) => tauriEvents.listen(name, ({ payload }) =>
        wrapped({ event: name, id: 1, payload })), handler).attached
  };
});
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: tauriEvents.listen })
}));
const nativeSave = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: nativeSave }));
const nativePanel = vi.hoisted(() => ({
  hide: vi.fn(async () => undefined)
}));
vi.mock("@tauri-apps/api/window", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/window")>(),
  getCurrentWindow: () => { throw new Error("Panel chrome must use caller-bound native controls"); }
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
  delete (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__;
  tauriInvoke.mockClear();
  vi.restoreAllMocks();
  nativeSave.mockReset();
  tauriEvents.listeners.clear();
  tauriEvents.delayed.clear();
  tauriEvents.pending.clear();
  tauriEvents.emitted.length = 0;
  tauriEvents.setResponder(undefined);
  Object.values(nativePanel).forEach((mock) => mock.mockClear());
  window.history.replaceState(null, "", "/");
});

const PANEL_ID = "panel.exampleAnalyzer.result";
const PLUGIN_ID = "org.test.exampleAnalyzer";
const WINDOW_ID = pluginPanelWindowId(PLUGIN_ID, PANEL_ID);

async function mountWindow(windowId = WINDOW_ID): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(PluginPanelWindow, { panelId: windowId }));
    await Promise.resolve();
  });
}

function reportPayload(overrides: Partial<PluginPanelReportPayload> = {}): PluginPanelReportPayload {
  return {
    panelId: PANEL_ID,
    pluginId: PLUGIN_ID,
    revision: 1,
    commandId: "plugin.exampleAnalyzer.run",
    report: {
      title: "Analysis Result",
      sections: [
        { kind: "keyValue", title: "Runtime", rows: [{ label: "Backend", value: "chemdraft.demo-engine" }] },
        {
          kind: "linkedFigure",
          title: "Predicted ¹H spectrum",
          spectrum: {
            nucleus: "1H",
            domain: { min: 0, max: 8 },
            reversed: true,
            peaks: [{ id: "p1", ppm: 7.2, intensity: 1, label: "7.20", atomIndices: [0] }]
          }
        }
      ]
    },
    ...overrides
  };
}

async function broadcast(payload: PluginPanelReportPayload): Promise<void> {
  await act(async () => {
    await broadcastPluginPanelReport(payload);
  });
}

const INSPECTOR_REPORT: AnalysisReport = {
  title: "Molecular properties",
  interpretations: [{ id: "source", label: "as drawn", active: true, changesIdentity: false, ledger: [] }],
  sections: [{ kind: "keyValue", title: "Composition", rows: [{ label: "Formula", value: "C9H8O4" }] }],
  engineSummary: "rdkit-minimallib-wasm 2026.03.3 (sha256:48b725a2)",
  fingerprint: "fnv1a64:0123456789abcdef"
};

describe("PluginPanelWindow (unified renderer, ADR-0030)", () => {
  it("forgets a hidden webview's report and rejects late replay after its owner is unregistered", async () => {
    await mountWindow();
    await broadcast(reportPayload());
    expect(container!.textContent).toContain("Analysis Result");
    await act(async () => {
      await broadcastPluginPanelReportCleared({ pluginId: PLUGIN_ID, panelId: PANEL_ID, revision: 2 });
    });
    expect(container!.textContent).not.toContain("Analysis Result");
    await broadcast(reportPayload());
    expect(container!.textContent).toContain("Waiting for plugin content");
    await broadcast(reportPayload({ revision: 3 }));
    expect(container!.textContent).toContain("Analysis Result");
    // An out-of-order clear cannot erase a newer report.
    await act(async () => {
      await broadcastPluginPanelReportCleared({ pluginId: PLUGIN_ID, panelId: PANEL_ID, revision: 2 });
    });
    expect(container!.textContent).toContain("Analysis Result");
  });

  const contentEvents = [
    PLUGIN_PANEL_REPORT_EVENT,
    ANALYSIS_WINDOW_SNAPSHOT_EVENT,
    PLUGIN_PANEL_STALENESS_EVENT
  ];

  it.each(["plugin", "analysis"] as const)(
    "replays the first %s content only after all native content listeners attach",
    async (kind) => {
      (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
      for (const name of contentEvents) tauriEvents.delayed.add(name);
      // The focus subscription is independent of the content handshake, even if it never answers.
      tauriEvents.delayed.add("chemdraft://plugin-panel-focus");
      const identity = kind === "plugin"
        ? { pluginId: PLUGIN_ID, panelId: PANEL_ID }
        : { pluginId: ANALYSIS_WINDOW_OWNER_ID, panelId: MOLECULAR_INSPECTOR_WINDOW_ID };
      const eventName = kind === "plugin" ? PLUGIN_PANEL_REPORT_EVENT : ANALYSIS_WINDOW_SNAPSHOT_EVENT;
      const cached = kind === "plugin" ? reportPayload() : {
        ...identity, revision: 1,
        content: { kind: "molecularInspector", report: INSPECTOR_REPORT, busy: false, stale: false }
      };
      // MainWindow caches before publishing/opening. The first push has no mounted receiver.
      await tauriEvents.emit(eventName, cached);
      tauriEvents.setResponder((name, requested) => {
        if (name !== PLUGIN_PANEL_REQUEST_EVENT) return;
        expect(requested).toEqual(identity);
        // Cross-webview replies use only the native bus: a same-page CustomEvent would mask the race.
        void tauriEvents.emit(eventName, cached);
        if (kind === "plugin") void tauriEvents.emit(PLUGIN_PANEL_STALENESS_EVENT, {
          ...identity, revision: 1, stale: true
        });
      });
      await mountWindow(pluginPanelWindowId(identity.pluginId, identity.panelId));
      await vi.waitFor(() => {
        expect([...tauriEvents.pending.keys()]).toEqual(expect.arrayContaining(contentEvents));
      });
      expect(container!.textContent).toContain(`Waiting for ${kind} content`);
      const requests = () => tauriEvents.emitted.filter(({ name }) => name === PLUGIN_PANEL_REQUEST_EVENT);
      expect(requests()).toHaveLength(0);
      for (const name of contentEvents.slice(0, -1)) {
        await act(async () => tauriEvents.attachPending(name));
        expect(requests()).toHaveLength(0);
      }
      await act(async () => tauriEvents.attachPending(PLUGIN_PANEL_STALENESS_EVENT));
      expect(requests()).toHaveLength(1);
      expect(container!.textContent).not.toContain("Waiting for");
      expect(container!.textContent).toContain(kind === "plugin" ? "chemdraft.demo-engine" : "C9H8O4");
      if (kind === "plugin") expect(container!.querySelector("[data-testid='plugin-panel-stale']")).not.toBeNull();
    }
  );

  it("does not request replay from an unmounted page when native subscription finishes late", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    for (const name of contentEvents) tauriEvents.delayed.add(name);
    await mountWindow();
    await vi.waitFor(() => {
      for (const name of contentEvents) expect(tauriEvents.pending.get(name)).toHaveLength(1);
    });
    act(() => root!.unmount());
    root = undefined;
    await act(async () => {
      for (const name of contentEvents) tauriEvents.attachPending(name);
    });
    expect(tauriEvents.emitted.filter(({ name }) => name === PLUGIN_PANEL_REQUEST_EVENT)).toHaveLength(0);
    for (const name of contentEvents) expect(tauriEvents.listeners.get(name)?.size ?? 0).toBe(0);
  });

  it("uses an AppKit key-window operation only for native panel clicks instead of Tao activation", () => {
    const nativePath = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src");
    const source = readFileSync(join(nativePath, "lib.rs"), "utf8");
    const command = source.split("fn set_plugin_panel_activation(")[1]!.split("/// Sent to the main window")[0]!;
    const mac = readFileSync(join(nativePath, "panel_focus_macos.rs"), "utf8");
    // Click activation moved from a live NSWindow subclass to a supported local monitor.
    const click = mac.split("let number = panel.windowNumber();")[1]!.split("pub(super) fn resize_edge")[0]!;
    expect(click).toContain("makeKeyWindow()");
    expect(click).toContain("target.is_visible()");
    expect(click).toContain("!target.is_minimized()");
    expect(click).toContain("native.windowNumber() == number");
    expect(click).toContain("addLocalMonitorForEventsMatchingMask_handler");
    for (const button of ["LeftMouseDown", "RightMouseDown", "OtherMouseDown"]) {
      expect(click).toContain(`NSEventMask::${button}`);
    }
    expect(click).toContain("event.as_ptr()");
    expect(mac).not.toMatch(/\.set_focus\(|activateIgnoringOtherApps|makeKeyAndOrderFront/);
    expect(command).not.toMatch(/target\.set_focus\(|makeKeyWindow/);
    expect(command).toMatch(/if !panel_window::is_active\(&target\)\?[\s\S]*return Ok\(false\)[\s\S]*webview\.set_focus\(\)/);
    expect(command).toContain("run_on_main_thread_blocking");
  });

  it("keeps Windows pointer activation and refuses delayed input focus after the panel loses foreground", () => {
    const nativePath = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src");
    const source = readFileSync(join(nativePath, "lib.rs"), "utf8");
    const command = source.split("fn set_plugin_panel_activation(")[1]!.split("/// Sent to the main window")[0]!;
    expect(command).toMatch(/if !panel_window::is_active\(&target\)\?[\s\S]*return Ok\(false\)[\s\S]*webview\.set_focus\(\)/);
    expect(command).not.toContain("target.set_focus()");
    const release = command.split("if !editing {")[1]!.split("let result =")[0]!;
    expect(release).toContain("return Ok(false)");
    expect(release).not.toMatch(/set_focus\(|return_focus|focus_main_document/);
    const panel = readFileSync(join(nativePath, "panel_window.rs"), "utf8");
    const active = panel.split("pub(crate) fn is_active<")[1]!.split("pub(crate) fn reset_for_webview")[0]!;
    expect(active).toContain("!window.is_visible()");
    expect(active).toContain("window.is_minimized()");
    expect(active).toMatch(/#\[cfg\(windows\)\][\s\S]*GetForegroundWindow\(\)\s*== window\.hwnd\(\)/);
    expect(active.split("pub(crate) fn end_pointer_guard")[0]!).not.toMatch(/SetActiveWindow\(|SetForegroundWindow\(|SendInput\(|return_focus_to_document/);
    const resizeSubclass = panel.split("unsafe extern \"system\" fn resize_subclass")[1]!
      .split("unsafe extern \"system\" fn")[0]!;
    expect(resizeSubclass).toMatch(/if message == WM_MOUSEACTIVATE \{[\s\S]*return MA_ACTIVATE as isize;/);
    expect(resizeSubclass).not.toMatch(/return_focus|set_focus\(/);
    const overlaySubclass = panel.split("unsafe extern \"system\" fn overlay_subclass")[1]!
      .split("unsafe fn panel_resize_hit")[0]!;
    expect(overlaySubclass).toMatch(/if message == WM_MOUSEACTIVATE \{\s*return SendMessageW\(parent, message, wparam, lparam\);/);
  });

  it("uses an AppKit key-window operation instead of Tao activation for palette input focus", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/lib.rs"), "utf8");
    const command = source.split("async fn set_plugin_panel_input_focus(")[1]!.split("fn set_plugin_panel_activation(")[0]!;
    const mac = command.split('#[cfg(target_os = "macos")]')[1]!.split('#[cfg(windows)]')[0]!;
    expect(mac).toContain("makeKeyWindow()");
    expect(mac).not.toMatch(/\.set_focus\(|activateIgnoringOtherApps|makeKeyAndOrderFront/);
    expect(command).toContain("run_on_main_thread_blocking");
  });

  it("uses guarded thread-local activation for Windows palette input, release and drag completion", () => {
    const nativePath = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src");
    const source = readFileSync(join(nativePath, "lib.rs"), "utf8");
    const command = source.split("async fn set_plugin_panel_input_focus(")[1]!.split("fn set_plugin_panel_activation(")[0]!;
    const windows = command.split('#[cfg(windows)]')[1]?.split('#[cfg(not(any(')[0] ?? "";
    expect(windows).toContain("if !panel_window::focus_if_app_active(hwnd)");
    expect(windows).toContain("return Ok(false)");
    expect(windows).not.toContain("target.set_focus()");
    expect(command).toContain("WindowsAndMessaging::GetForegroundWindow()");
    // Release now delegates to the shared interaction helper. Guard both the command
    // branch and the helper's Windows path against Tao's forced activation fallback.
    const release = command.split("result.map(|_| held)")[1]!;
    const compactRelease = release.replace(/\s+/g, "");
    const returnFocusCall = "panel_window::return_focus_after_interaction(&target, return_focus.unwrap_or(false)".replace(/\s+/g, "");
    expect(compactRelease).toContain(returnFocusCall);
    const returnFocusIndex = compactRelease.indexOf(returnFocusCall);
    const nonFocusableIndex = compactRelease.indexOf(".set_focusable(false)");
    expect(returnFocusIndex).toBeGreaterThanOrEqual(0);
    expect(nonFocusableIndex).toBeGreaterThan(returnFocusIndex);
    // A hand-back error must not skip making the palette non-focusable.
    expect(compactRelease.slice(returnFocusIndex + returnFocusCall.length, nonFocusableIndex)).not.toMatch(/\?|returnErr/);
    expect(release).not.toMatch(/focus_main_document_window_impl|(?:main|document)\.set_focus\(/);
    const panel = readFileSync(join(nativePath, "panel_window.rs"), "utf8");
    const interactionReturn = panel.split("pub(crate) fn return_focus_after_interaction<")[1]!
      .split("pub(crate) fn reset_for_webview<")[0]!;
    const windowsReturn = interactionReturn.split('#[cfg(target_os = "macos")]')[0]!;
    expect(windowsReturn).toContain("focus_return::should_return(");
    expect(windowsReturn).toContain("return_focus_to_document(");
    expect(windowsReturn).not.toMatch(/focus_main_document_window_impl|(?:main|document)\.set_focus\(/);
    const focus = panel.split("pub(crate) fn focus_if_app_active(")[1]!.split('#[cfg(target_os')[0]!;
    expect(focus).toContain("GetForegroundWindow()");
    expect(focus).toContain("IsWindowVisible(hwnd) == 0");
    expect(focus).toContain("IsIconic(hwnd) != 0");
    expect(focus).toContain("GetWindowThreadProcessId");
    expect(focus).toContain("with_owned_foreground");
    expect(focus).toContain("SetActiveWindow(hwnd)");
    // SetForegroundWindow is allowed only to move the foreground from ChemDraft's own palette to its own document window while ChemDraft owns the foreground;
    // it must never be used to take the foreground from another app, and synthetic input is never allowed.
    expect(panel).not.toMatch(/SendInput\(/);
    const handBackStart = panel.indexOf("pub(crate) fn return_focus_to_document<");
    expect(handBackStart).toBeGreaterThanOrEqual(0);
    const handBackEnd = panel.indexOf("\n}\n", handBackStart) + 2;
    const handBackBody = panel.slice(handBackStart, handBackEnd);
    expect(panel.replace(handBackBody, "")).not.toMatch(/SetForegroundWindow\(/);
    expect(handBackBody.match(/SetForegroundWindow\(owner\)/g)).toHaveLength(1);
    const setForegroundIndex = handBackBody.indexOf("SetForegroundWindow(owner)");
    const appForegroundGuardIndex = handBackBody.indexOf("super::foreground_belongs_to_app()");
    expect(appForegroundGuardIndex).toBeGreaterThanOrEqual(0);
    expect(appForegroundGuardIndex).toBeLessThan(setForegroundIndex);
    const foregroundWindowGuardIndex = handBackBody.indexOf("GetForegroundWindow() == foreground");
    expect(foregroundWindowGuardIndex).toBeGreaterThanOrEqual(0);
    expect(foregroundWindowGuardIndex).toBeLessThan(setForegroundIndex);
    const handBack = panel.split("pub(crate) fn return_focus_to_document<")[1]!.split('#[cfg(target_os')[0]!;
    expect(handBack).toContain("foreground_can_return_to_document");
    expect(handBack).toContain("webview.set_focus()");
    // Panel resize presses retain activation. Palette drag completion still hands back.
    const observer = panel.split('unsafe extern "system" fn focus_subclass')[1]!
      .split('pub(crate) fn install_resize_hit_test')[0]!;
    expect(observer).toContain("message == WM_EXITSIZEMOVE");
    expect(observer.split("let result = DefSubclassProc").at(-1)!).toContain("drag_finished()");
    const install = panel.split("let drag_target = window.clone()")[1]!.split("struct FocusObserver")[0]!;
    expect(install).toContain('drag_target.label().starts_with("toolset-")');
    expect(install).toContain("return_focus_after_interaction(&drag_target, true)");
  });

  it("separates native panel activation from palette leases before either can change focus", () => {
    const nativePath = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src");
    const source = readFileSync(join(nativePath, "lib.rs"), "utf8");
    const dispatch = source.split("async fn set_plugin_panel_input_focus(")[1]!.split("let result: Result")[0]!;
    expect(dispatch).toMatch(/if is_plugin_panel_window_label\(window.label\(\)\) \{\s*return set_plugin_panel_activation/);
    const mac = readFileSync(join(nativePath, "panel_focus_macos.rs"), "utf8");
    // Only panels observe visibility and pointer activation; palettes keep their input leases.
    expect(mac).toMatch(/if super::super::is_plugin_panel_window_label\(window.label\(\)\) \{\s*observe_panel\(window, panel, &mut tokens\)\?/);
    const panel = readFileSync(join(nativePath, "panel_window.rs"), "utf8");
    const observe = panel.split('pub(crate) fn install_input_focus')[1]!.split('#[cfg(')[0]!;
    expect(observe).not.toContain("install_resize_hit_test");
  });

  it("never replaces live AppKit/WebKit classes, preserving their KVO and tracking-area state", () => {
    const nativePath = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src");
    function check(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) check(path);
        else if (entry.name.endsWith(".rs") && entry.name !== "macos_quit.rs") {
          expect(readFileSync(path, "utf8"), path).not.toMatch(/\b(?:set_class|object_setClass)\b/);
        }
      }
    }
    check(nativePath);
  });

  it("pairs visibility observation and the mouse monitor with synchronous native-close cleanup", () => {
    const nativePath = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src");
    const mac = readFileSync(join(nativePath, "panel_focus_macos.rs"), "utf8");
    expect(mac).toContain("observeValueForKeyPath:ofObject:change:context:");
    // Old and new values, after the change: only a real visible -> hidden change restores.
    expect(mac).not.toContain("notificationIsPrior");
    expect(mac).toContain("options: NS_KEY_VALUE_OBSERVING_OPTION_OLD | NS_KEY_VALUE_OBSERVING_OPTION_NEW");
    expect(mac).toMatch(/change_flag\(change, ns_string!\("old"\)\) == Some\(true\)\s*&& change_flag\(change, ns_string!\("new"\)\) == Some\(false\)/);
    expect(mac).toMatch(/!APP_HIDDEN\.load\(Ordering::SeqCst\)\s*&& !target\.is_visible\(\)\.unwrap_or\(true\)\s*&& super::super::panel_full_size::is_enlarged\(&window\)/);
    // Cmd+H orders panels out too; the backstop stands aside from will-hide until unhide.
    expect(mac).toMatch(/\(NSApplicationWillHideNotification, true\),\s*\(NSApplicationDidUnhideNotification, false\)/);
    expect(mac).toContain("addObserver: &*observer");
    expect(mac).toContain("removeObserver: &*self.observer");
    expect(mac.match(/forKeyPath: ns_string!\("visible"\)/g)).toHaveLength(2);
    expect(mac).toContain("panel_full_size::will_hide(&webview.window())");
    expect(mac).toContain("NSWindowWillCloseNotification");
    expect(mac).toContain("forget(&label)");
    expect(mac).toContain("NSEvent::removeMonitor(&monitor)");
    // Reinstall first removes the old registrations, so reloads cannot duplicate callbacks.
    expect(mac).toContain("forget(window.label())");
  });

  it("restores an enlarged panel on ChemDraft's own hides, keeps it on app hide, and never activates under a modal", () => {
    const nativePath = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src");
    const source = readFileSync(join(nativePath, "lib.rs"), "utf8");
    // Utility suspension (file pickers) and screen capture restore before their own hides.
    expect(source).toMatch(/panel_window::end_for_hide\(window\.app_handle\(\), window\.label\(\)\);\s*panel_full_size::before_hide\(&window\);\s*if let Err\(error\) = window\.hide\(\)/);
    const capture = readFileSync(join(nativePath, "screen_capture.rs"), "utf8");
    // Screen capture restores and hides together on the main thread (the restore requires it).
    expect(capture).toMatch(/run_on_main_thread_blocking\(app, move \|\| hide_visible_windows\(&on_main\)\)/);
    expect(capture).toMatch(/crate::panel_full_size::before_hide,\s*\|window\| window\.hide\(\)\.is_ok\(\)/);
    // Closing (CloseRequested) and the panel's own hide command restore explicitly too.
    expect(source).toMatch(/if let WindowEvent::CloseRequested \{ api, \.\. \} = event \{\s*panel_full_size::will_hide\(window\);/);
    const controls = readFileSync(join(nativePath, "panel_window_controls.rs"), "utf8");
    expect(controls).toMatch(/panel_full_size::set\(window, false, 0\.0, 0\.0\)\?;\s*window\.hide\(\)/);
    // So does the document window's hide of a panel, on the main thread, through a caller-bound command.
    expect(controls).toMatch(/authorize_main_hide\(window\.label\(\), &label\)\?;/);
    expect(controls).toMatch(/\|\| super::panel_full_size::before_hide\(window\),\s*\|\| window\.hide\(\)/);
    expect(controls).toMatch(/run_on_main_thread_blocking\(&target, move \|\| restore_then_hide\(&task\)\)/);
    // Cmd+H keeps enlarged panels as they were; quit still restores every panel.
    const appHide = source.split("fn observe_hide_for_document_key_restore<")[1]!.split("\n}\n")[0]!;
    expect(appHide).not.toContain("restore_all");
    expect(source).toMatch(/WindowEvent::Destroyed => \{[\s\S]*?panel_full_size::restore_all\(window\.app_handle\(\)\)/);
    const sizes = readFileSync(join(nativePath, "panel_full_size.rs"), "utf8");
    expect(sizes).toMatch(/#\[cfg\(target_os = "macos"\)\]\s*pub\(super\) fn before_hide/);
    expect(sizes).toMatch(/#\[cfg\(not\(target_os = "macos"\)\)\]\s*pub\(super\) fn before_hide<R: Runtime>\(_window: &tauri::WebviewWindow<R>\) \{\}/);
    const mac = readFileSync(join(nativePath, "panel_focus_macos.rs"), "utf8");
    const click = mac.split("let number = panel.windowNumber();")[1]!.split("pub(super) fn resize_edge")[0]!;
    expect(click).toMatch(/NSApplication::sharedApplication\(mtm\)\s*\.modalWindow\(\)\s*\.is_none\(\)/);
    expect(click).toMatch(/native\.windowNumber\(\) == number\s*&& outside_modal/);
    // Our Objective-C classes carry a ChemDraft prefix.
    expect(mac).toContain('#[name = "ChemDraftPanelVisibilityObserver"]');
    expect(mac).toContain('#[name = "ChemDraftPanelResizeOverlay"]');
  });

  it("leaves Wry's content root, webview attachment and first responder alone during resize installation", () => {
    const mac = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/panel_focus_macos.rs"), "utf8");
    const install = mac.split("pub(super) fn install_resize_hit_test<")[1]!.split("fn find_webview(")[0]!;
    // The old test required detaching and then restoring Wry's responder. Keeping its view
    // in the window throughout installation avoids that transition and WebKit's window KVO.
    expect(mac).not.toMatch(/\.setContentView\(|\.removeFromSuperview\(/);
    expect(install).not.toMatch(/\.makeFirstResponder\(|content\.setFrame\(|content\.setAutoresizingMask\(/);
    expect(install).toContain("content.addSubview_positioned_relativeTo(&overlay, NSWindowOrderingMode::Above, None)");
    expect(install).toContain(".any(|view| view.isKindOfClass(PanelResizeOverlay::class()))");
  });

  it("routes only the two-point native Mac band to AppKit's frame and lets other hits reach WebKit", () => {
    const mac = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/panel_focus_macos.rs"), "utf8");
    // AppKit's measured band is narrower than Windows' 6 px zone; the wider Mac strip ate page hits.
    expect(mac).toContain("const MAC_NATIVE_RESIZE_BAND_PT: f64 = 2.0;");
    const band = mac.split("pub(super) fn resize_edge")[1]!.split("fn resize_enabled")[0]!;
    // Both callers must get the Mac band from this helper, never the shared Windows constant.
    expect(band).toContain("let edge = MAC_NATIVE_RESIZE_BAND_PT;");
    expect(mac).not.toContain("super::RESIZE_ZONE_LOGICAL_PX");
    expect(mac).toContain("#[unsafe(super(NSView))]");
    expect(mac).toContain("struct PanelResizeOverlay");
    expect(mac).toContain("PanelResizeOverlay::alloc(mtm)");
    expect(mac).toContain("#[unsafe(method(hitTest:))]");
    const hitTest = mac.split("fn hit_test(")[1]!.split("pub(super) fn install_resize_hit_test<")[0]!;
    expect(hitTest).toMatch(/resize_enabled\(panel.styleMask\(\)\)[\s\S]*&& resize_edge\(/);
    expect(hitTest).toContain(".and_then(|content| unsafe { content.superview() })");
    expect(hitTest).toContain("Retained::as_ptr(&frame).cast_mut()");
    expect(hitTest).toMatch(/std::ptr::null_mut\(\)\s*\}\s*\}\s*\);/);
    // Interior hits must fall through to the WKWebView.
    expect(hitTest).not.toMatch(/super\(self\)\s*,\s*hitTest/);
    expect(mac).toContain("initWithFrame: content.bounds()");
    expect(mac).toContain("overlay.setAutoresizingMask(autoresize)");
    const click = mac.split("let number = panel.windowNumber();")[1]!.split("pub(super) fn resize_edge")[0]!;
    // Activation must skip exactly the same band that the overlay yields to AppKit.
    expect(click).toMatch(/resize_enabled\(panel.styleMask\(\)\)[\s\S]*&& resize_edge\(/);
    expect(click).toContain("content.convertPoint_fromView(native.locationInWindow(), None)");
    expect(click).toMatch(/if !resizing \{\s*let _ = target.set_focusable\(true\);\s*panel.makeKeyWindow\(\);/);
    expect(click).toContain("event.as_ptr()");
    expect(mac).not.toContain("setStyleMask");
  });

  it("logs the panel's native view hierarchy once after installation through the existing diagnostic gate", () => {
    const mac = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/panel_focus_macos.rs"), "utf8");
    const install = mac.split("pub(super) fn install_resize_hit_test<")[1]!.split("fn find_webview(")[0]!;
    expect(install.indexOf("log_view_hierarchy(window.label(), panel)")).toBeGreaterThan(install.indexOf("content.addSubview_positioned_relativeTo"));
    expect(mac).toContain("super::super::palette_focus_log(format_args!(");
    expect(mac).toContain("panel-view label={}");
    expect(mac).toContain("content_class={} content_frame={:?} wk_descendant={}");
    expect(mac).toContain("wk_frame={:?} wk_hidden={:?} wk_in_window={} style_mask={:#x}");
    expect(mac).toContain("view.isKindOfClass(objc2_web_kit::WKWebView::class())");
    expect(mac).not.toContain(".with_webview(");
    expect(mac).toContain("view.isDescendantOf(content)");
    expect(mac).toContain("view.isHidden()");
    expect(mac).toContain("panel.styleMask().bits()");
  });

  it("keeps resizing a creation trait and skips redundant AppKit style-mask setters", () => {
    const nativePath = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src");
    const source = readFileSync(join(nativePath, "lib.rs"), "utf8");
    const build = source.split("fn build_or_show_plugin_panel<")[1]!.split("fn current_plugin_panel_geometry<")[0]!;
    expect(build.indexOf(".resizable(true)")).toBeLessThan(build.indexOf("builder.build()"));
    const install = build.split("let installed = run_on_main_thread_blocking")[1]!;
    expect(install).toMatch(/#\[cfg\(target_os = "macos"\)\]\s*\{[\s\S]*configure_analysis_window_traits\(&target, native\)\?;/);
    expect(install.indexOf("configure_analysis_window_traits")).toBeLessThan(install.indexOf("panel_full_size::apply"));
    expect(install.indexOf("configure_analysis_window_traits")).toBeLessThan(install.indexOf("install_resize_hit_test"));
    const configure = source.split("fn configure_analysis_window_traits<")[1]!.split("/// Makes `child`")[0]!;
    expect(configure).toContain("panel_window::configure_macos_style(ns_window.styleMask()");
    expect(configure.indexOf("let responder = ns_window.firstResponder()")).toBeLessThan(configure.indexOf("ns_window.setStyleMask(style)"));
    expect(configure.indexOf("ns_window.makeFirstResponder(Some(&responder))")).toBeGreaterThan(configure.indexOf("ns_window.setStyleMask(style)"));
    const panel = readFileSync(join(nativePath, "panel_window.rs"), "utf8");
    const style = panel.split("pub(crate) fn macos_style(")[1]!.split("pub(crate) fn install_input_focus<")[0]!;
    expect(style).toContain("if required != current");
    expect(style).not.toMatch(/\|\s*objc2_app_kit::NSWindowStyleMask::Resizable/);
  });

  it("preserves Tao's Win10 zero top inset and adapts the single existing resize overlay", () => {
    const panel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/panel_window.rs"), "utf8");
    // A positive NCCALCSIZE top override restores WS_CAPTION on Windows 10.
    expect(panel).not.toContain("WM_NCCALCSIZE");
    expect(panel).not.toContain("SWP_FRAMECHANGED");
    expect(panel).toContain("TAURI_DRAG_RESIZE_WINDOW");
    expect(panel).toContain("SetWindowSubclass(overlay, Some(overlay_subclass)");
    expect(panel).toContain("HTTRANSPARENT");
    expect(panel).toContain("GetDpiForWindow(hwnd)");
    expect(panel).toContain("geometry::resize_border(GetDpiForWindow(hwnd))");
    expect(panel).toContain("ClientToScreen(hwnd, &mut origin)");
    expect(panel).toContain("FindWindowExW(parent, std::ptr::null_mut(), class.as_ptr(), name.as_ptr())");
    expect(panel).toContain("geometry::overlay_cutout(");
    const geometry = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/panel_window_geometry.rs"), "utf8");
    expect(panel).toContain("const RESIZE_ZONE_LOGICAL_PX: f64 = 6.0");
    expect(geometry).toContain("(super::RESIZE_ZONE_LOGICAL_PX * f64::from(dpi) / 96.0).round()");
    expect(geometry).toContain("let top = (client.top + border).min(client.bottom)");
    expect(panel).not.toMatch(/CreateWindow|controller\.SetBounds|controller\.ParentWindow|ResizeWebview/);
  });

  it("observes native top-level loss synchronously and tags the single focus event with its lease", () => {
    const nativePath = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src");
    const panel = readFileSync(join(nativePath, "panel_window.rs"), "utf8");
    expect(panel).toContain('"chemdraft://plugin-panel-focus"');
    expect(panel).toContain("WM_ACTIVATEAPP");
    expect(panel).toContain("lease.deactivate()");
    expect(panel).toContain("generation");
    expect(panel).not.toContain("WM_KILLFOCUS");
    const mac = readFileSync(join(nativePath, "panel_focus_macos.rs"), "utf8");
    expect(mac).toContain("NSWindowDidBecomeKeyNotification");
    expect(mac).toContain("NSWindowDidResignKeyNotification");
    expect(mac).toContain("super::activation(&target, active)");
  });

  it("resets native generations before a reloaded panel webview can acquire focus", () => {
    const nativePath = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src");
    const source = readFileSync(join(nativePath, "lib.rs"), "utf8");
    const pageLoad = source.split(".on_page_load(")[1]!.split(".on_menu_event(")[0]!;
    expect(pageLoad).toContain("is_input_focus_window_label(webview.label())");
    expect(pageLoad).toContain("PageLoadEvent::Started");
    expect(pageLoad).toContain("panel_window::reset_for_webview(&webview.window())");
    const panel = readFileSync(join(nativePath, "panel_window.rs"), "utf8");
    const reset = panel.split("fn reset_for_webview")[1]!.split("#[derive")[0]!;
    expect(reset).toContain(".reset()");
    expect(reset).toContain("set_focusable(false)");
    // The pure Rust regression also exercises generation reuse and an old UI task's epoch.
    const command = source.split("fn set_plugin_panel_activation(")[1]!.split("/// Sent to the main window")[0]!;
    expect(command).toContain("panel_window::is_current(&target, generation, epoch)");
  });

  it("destroys a newly built panel if native focus/resize installation fails", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/lib.rs"), "utf8");
    const build = source.split("fn build_or_show_plugin_panel")[1]!.split("fn analysis_window_initial_position")[0]!;
    expect(build).toMatch(/let installed = run_on_main_thread_blocking[\s\S]*install_resize_hit_test[\s\S]*\.and_then/);
    expect(build).toMatch(/finish_installation\(installed, \|\| \{[\s\S]*window\.destroy\(\)[\s\S]*\}\)\?/);
  });

  it("keeps panel focus after a full-size control blurs and Escape restores the frame", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    const bodyListen = vi.spyOn(document.body, "addEventListener");
    await mountWindow();
    await broadcast(reportPayload());
    const fullSize = [...container!.querySelectorAll<HTMLButtonElement>(".lf-btn")]
      .find((button) => button.textContent === "Full size")!;
    await act(async () => { fullSize.click(); });
    expect(tauriInvoke).toHaveBeenCalledWith("set_plugin_panel_full_size", {
      enabled: true, width: 1392, height: 660
    });
    expect(tauriEvents.listeners.get("chemdraft://plugin-panel-full-size")?.size).toBe(1);
    const select = document.querySelector<HTMLSelectElement>(".lf-modal select")!;
    expect(select).not.toBeNull();
    expect(container!.contains(select)).toBe(false);
    // jsdom has no trusted pointer source: invoke the installed browser listener explicitly.
    const pointer = bodyListen.mock.calls.find(([type]) => type === "pointerdown")?.[1] as EventListener | undefined;
    await act(async () => {
      pointer?.({ target: select, isTrusted: true, button: 0 } as unknown as Event);
      select.focus();
    });
    expect(tauriInvoke).toHaveBeenCalledWith("set_plugin_panel_input_focus", { editing: true, generation: expect.any(Number), pageToken: "page-token" });
    await act(async () => {
      select.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).not.toBe(select);
    expect(document.querySelector(".lf-modal")).not.toBeNull();
    expect(tauriInvoke).not.toHaveBeenCalledWith("set_plugin_panel_full_size", {
      enabled: false, width: 0, height: 0
    });
    await act(async () => {
      select.focus();
      select.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    const focusCalls = tauriInvoke.mock.calls.filter(([command]) => command === "set_plugin_panel_input_focus");
    expect(focusCalls).toEqual([
      ["set_plugin_panel_input_focus", { editing: true, generation: expect.any(Number), pageToken: "page-token" }]
    ]);
    expect(tauriInvoke).toHaveBeenCalledWith("set_plugin_panel_full_size", {
      enabled: false, width: 0, height: 0
    });
    expect(document.querySelector(".lf-modal")).toBeNull();
    expect(nativePanel.hide).not.toHaveBeenCalled();
    expect(container!.querySelector(".plugin-panel-shell")).not.toBeNull();
  });

  it("opens plugin and built-in analysis identities through the one existing native transport", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    await openPluginPanelWindow({
      pluginId: ANALYSIS_WINDOW_OWNER_ID,
      panelId: VALIDATION_RESULT_WINDOW_ID,
      title: "Validation Result",
      width: 500,
      height: 520
    });

    expect(tauriInvoke).toHaveBeenCalledExactlyOnceWith("open_plugin_panel_window", {
      request: {
        panelId: pluginPanelWindowId(ANALYSIS_WINDOW_OWNER_ID, VALIDATION_RESULT_WINDOW_ID),
        title: "Validation Result",
        width: 500,
        height: 520
      }
    });
  });

  it.each([true, false])("drops the legacy focus=%s hint so opening always keeps the document focused", async (focus) => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    await openPluginPanelWindow({
      pluginId: ANALYSIS_WINDOW_OWNER_ID,
      panelId: PATCH_REVIEW_WINDOW_ID,
      title: "Plugin Proposals",
      focus
    });

    expect(tauriInvoke).toHaveBeenCalledExactlyOnceWith("open_plugin_panel_window", {
      request: {
        panelId: pluginPanelWindowId(ANALYSIS_WINDOW_OWNER_ID, PATCH_REVIEW_WINDOW_ID),
        title: "Plugin Proposals",
        width: undefined,
        height: undefined
      }
    });
  });

  it("closes Full size on the first Escape and the window only on the second", async () => {
    await mountWindow();
    const closes: string[] = [];
    const onClosed = (event: Event) => {
      const detail = (event as CustomEvent<{ panelId?: unknown }>).detail;
      if (typeof detail?.panelId === "string") closes.push(detail.panelId);
    };
    window.addEventListener(PLUGIN_PANEL_CLOSED_EVENT, onClosed);
    try {
      await broadcast(reportPayload());
      const fullSize = [...container!.querySelectorAll<HTMLButtonElement>(".lf-btn")].find(
        (button) => button.textContent === "Full size"
      )!;
      await act(async () => {
        fullSize.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(document.querySelector(".lf-modal")).not.toBeNull();

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      expect(document.querySelector(".lf-modal")).toBeNull();
      expect(closes).toEqual([]);

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      expect(closes).toEqual([PANEL_ID]);
    } finally {
      window.removeEventListener(PLUGIN_PANEL_CLOSED_EVENT, onClosed);
    }
  });

  it("exports JCAMP-DX through the main window, which holds the save permission", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    window.history.replaceState(null, "", `/?window=pluginPanel&panelId=${WINDOW_ID}`);
    // Stand in for the main window: answer a save request as saved.
    tauriEvents.setResponder((name, payload) => {
      const action = payload as { kind?: string; requestId?: string };
      if (name === ANALYSIS_WINDOW_ACTION_EVENT && action.kind === "saveTextFile") {
        void tauriEvents.emit(ANALYSIS_WINDOW_ACTION_RESULT_EVENT, { requestId: action.requestId, result: "saved" });
      }
    });
    await mountWindow();
    await act(async () => {
      await broadcastPluginPanelReport(reportPayload());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const exportButton = [...container!.querySelectorAll<HTMLButtonElement>(".lf-btn")].find(
      (button) => button.textContent === "Export"
    )!;
    expect(exportButton).toBeDefined();

    await act(async () => {
      exportButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const request = tauriEvents.emitted.find(
      (event) =>
        event.name === ANALYSIS_WINDOW_ACTION_EVENT && (event.payload as { kind?: string }).kind === "saveTextFile"
    );
    expect(request?.payload).toMatchObject({
      kind: "saveTextFile",
      filename: "predicted-1H-nmr.jdx",
      format: "jcamp"
    });
    expect((request?.payload as { text: string }).text).toContain("##JCAMP-DX=");
    // The report window never reached for a dialog of its own.
    expect(nativeSave).not.toHaveBeenCalled();
    expect(exportButton.textContent).toBe("Exported");
  });

  it("shows Export failed when the main window reports the save failed", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    window.history.replaceState(null, "", `/?window=pluginPanel&panelId=${WINDOW_ID}`);
    tauriEvents.setResponder((name, payload) => {
      const action = payload as { kind?: string; requestId?: string };
      if (name === ANALYSIS_WINDOW_ACTION_EVENT && action.kind === "saveTextFile") {
        void tauriEvents.emit(ANALYSIS_WINDOW_ACTION_RESULT_EVENT, { requestId: action.requestId, result: "failed" });
      }
    });
    await mountWindow();
    await act(async () => {
      await broadcastPluginPanelReport(reportPayload());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const exportButton = [...container!.querySelectorAll<HTMLButtonElement>(".lf-btn")].find(
      (button) => button.textContent === "Export"
    )!;
    await act(async () => {
      exportButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(exportButton.textContent).toBe("Export failed");
  });

  it("copies a chemical name through the main window without granting the panel clipboard access", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    tauriEvents.setResponder((name, payload) => {
      const action = payload as { kind?: string; requestId?: string };
      if (name === ANALYSIS_WINDOW_ACTION_EVENT && action.kind === "copyMolecularInspector") {
        void tauriEvents.emit(ANALYSIS_WINDOW_ACTION_RESULT_EVENT, { requestId: action.requestId, ok: true });
      }
    });
    await mountWindow();
    const payload = reportPayload();
    payload.report = { title: "Name", sections: [{ kind: "chemicalName", label: "Name", name: "ethanol", kindLabel: "Preferred IUPAC name", warnings: [] }] };
    await act(async () => { await broadcastPluginPanelReport(payload); });
    const copy = [...container!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Copy")!;
    await act(async () => {
      copy.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const request = tauriEvents.emitted.find(event => event.name === ANALYSIS_WINDOW_ACTION_EVENT && (event.payload as { kind?: string }).kind === "copyMolecularInspector");
    expect((request?.payload as { text: string }).text).toBe("ethanol");
    expect(tauriInvoke).not.toHaveBeenCalledWith("write_clipboard_text_items", expect.anything());
  });

  it("copies through the main window's native clipboard and shows Copied on success", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    const windowId = pluginPanelWindowId(ANALYSIS_WINDOW_OWNER_ID, MOLECULAR_INSPECTOR_WINDOW_ID);
    window.history.replaceState(null, "", `/?window=pluginPanel&panelId=${windowId}`);
    tauriEvents.setResponder((name, payload) => {
      const action = payload as { kind?: string; requestId?: string };
      if (name === ANALYSIS_WINDOW_ACTION_EVENT && action.kind === "copyMolecularInspector") {
        void tauriEvents.emit(ANALYSIS_WINDOW_ACTION_RESULT_EVENT, { requestId: action.requestId, ok: true });
      }
    });
    await mountWindow(windowId);
    await act(async () => {
      await broadcastAnalysisWindowSnapshot({
        pluginId: ANALYSIS_WINDOW_OWNER_ID,
        panelId: MOLECULAR_INSPECTOR_WINDOW_ID,
        revision: 1,
        content: { kind: "molecularInspector", report: INSPECTOR_REPORT, busy: false, stale: false }
      });
    });
    const copyButton = [...container!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Copy"
    )!;

    await act(async () => {
      copyButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const request = tauriEvents.emitted.find(
      (event) =>
        event.name === ANALYSIS_WINDOW_ACTION_EVENT &&
        (event.payload as { kind?: string }).kind === "copyMolecularInspector"
    );
    expect((request?.payload as { text: string }).text).toContain("C9H8O4");
    expect(copyButton.textContent).toBe("Copied");
  });

  it("shows Copy failed when the main window reports the clipboard write failed", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    const windowId = pluginPanelWindowId(ANALYSIS_WINDOW_OWNER_ID, MOLECULAR_INSPECTOR_WINDOW_ID);
    window.history.replaceState(null, "", `/?window=pluginPanel&panelId=${windowId}`);
    tauriEvents.setResponder((name, payload) => {
      const action = payload as { kind?: string; requestId?: string };
      if (name === ANALYSIS_WINDOW_ACTION_EVENT && action.kind === "copyMolecularInspector") {
        void tauriEvents.emit(ANALYSIS_WINDOW_ACTION_RESULT_EVENT, { requestId: action.requestId, ok: false });
      }
    });
    await mountWindow(windowId);
    await act(async () => {
      await broadcastAnalysisWindowSnapshot({
        pluginId: ANALYSIS_WINDOW_OWNER_ID,
        panelId: MOLECULAR_INSPECTOR_WINDOW_ID,
        revision: 1,
        content: { kind: "molecularInspector", report: INSPECTOR_REPORT, busy: false, stale: false }
      });
    });
    const copyButton = [...container!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Copy"
    )!;

    await act(async () => {
      copyButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(copyButton.textContent).toBe("Copy failed");
  });

  it("returns listener cleanup synchronously so an immediate effect cleanup cannot leak", () => {
    const handler = vi.fn();
    const cleanup = listenForPluginPanelReruns(handler);
    cleanup();

    window.dispatchEvent(
      new CustomEvent(PLUGIN_PANEL_RERUN_EVENT, { detail: { pluginId: PLUGIN_ID, panelId: PANEL_ID } })
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("uses a reversible collision-free native identity instead of lossy panel-id punctuation", () => {
    const dotted = pluginPanelWindowId("org.test.a", "panel.shared.a-b");
    const dashed = pluginPanelWindowId("org.test.a", "panel.shared.a.b");
    const otherOwner = pluginPanelWindowId("org.test.b", "panel.shared.a-b");

    expect(new Set([dotted, dashed, otherOwner]).size).toBe(3);
    expect(parsePluginPanelWindowId(dotted)).toEqual({ pluginId: "org.test.a", panelId: "panel.shared.a-b" });
  });

  it("renders reports through the shared PluginReportRenderer — the linkedFigure survives in the window", async () => {
    await mountWindow();
    expect(container!.textContent).toContain("Waiting for plugin content…");

    await broadcast(reportPayload());

    // The shared renderer, not a window-private section switch: report chrome classes are the
    // plugin-report family, and the interactive linked figure actually renders (main's original
    // window switch silently dropped unknown kinds, losing this entire section).
    expect(container!.querySelector(".plugin-report")).not.toBeNull();
    expect(container!.textContent).toContain("Backend");
    expect(container!.textContent).toContain("chemdraft.demo-engine");
    expect(container!.querySelector(".lf-root")).not.toBeNull();
    expect(container!.textContent).toContain("Predicted ¹H spectrum");
  });

  it("applies the revision guard so a late broadcast never regresses the panel", async () => {
    await mountWindow();
    await broadcast(reportPayload({ revision: 2, report: { title: "Result", sections: [] } }));
    await broadcast(reportPayload({ revision: 1, report: { title: "Stale pending", sections: [] } }));

    expect(container!.textContent).toContain("Result");
    expect(container!.textContent).not.toContain("Stale pending");
  });

  it("relays Run again over the bridge instead of running anything locally", async () => {
    await mountWindow();
    const reruns: string[] = [];
    const onRerun = (event: Event) => {
      const detail = (event as CustomEvent<{ pluginId?: unknown; panelId?: unknown }>).detail;
      if (detail?.pluginId === PLUGIN_ID && typeof detail.panelId === "string") {
        reruns.push(detail.panelId);
      }
    };
    window.addEventListener(PLUGIN_PANEL_RERUN_EVENT, onRerun);
    try {
      await broadcast(reportPayload());
      const runAgain = container!.querySelector<HTMLButtonElement>(".plugin-panel-run-again");
      expect(runAgain).not.toBeNull();
      await act(async () => {
        runAgain!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(reruns).toEqual([PANEL_ID]);
    } finally {
      window.removeEventListener(PLUGIN_PANEL_RERUN_EVENT, onRerun);
    }
  });

  it("lays the title strip out as one row so Run again never drops under the title", async () => {
    await mountWindow();
    await broadcast(reportPayload());
    const strip = container!.querySelector<HTMLElement>(".plugin-panel-window-title");
    expect(strip).not.toBeNull();
    expect(strip!.classList.contains("palette-title")).toBe(true);
    expect(strip!.querySelector(".palette-title-label")?.textContent).toBe("Analysis Result");
    expect(strip!.querySelector(".plugin-panel-run-again")).not.toBeNull();
    expect(strip!.querySelector(".palette-close-button")).not.toBeNull();

    // jsdom has no layout, so pin the rules that fix the cramped header: a flex row whose label
    // takes (and ellipsizes within) the remaining width while the button keeps its size.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../App.css"), "utf8");
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      expect(start).toBeGreaterThan(-1);
      return css.slice(start, css.indexOf("}", start));
    };
    expect(rule(".plugin-panel-window-title")).toContain("display: flex;");
    expect(rule(".plugin-panel-window-title .palette-title-label")).toContain("flex: 1 1 auto;");
    expect(rule(".plugin-panel-window-title .plugin-panel-run-again")).toContain("flex-shrink: 0;");
    expect(rule(".plugin-panel-window-title .plugin-panel-run-again")).toContain("white-space: nowrap;");
  });

  it("hides Run again when the payload carries no command", async () => {
    await mountWindow();
    await broadcast(reportPayload({ commandId: undefined }));
    expect(container!.querySelector(".plugin-panel-run-again")).toBeNull();
  });

  it("routes prompt actions through the document window and shows its refusal", async () => {
    await mountWindow();
    const received: unknown[] = [];
    const onAction = (event: Event) => {
      const action = (event as CustomEvent<{ id: string; request: unknown }>).detail;
      received.push(action.request);
      void respondToPluginPanelAction(action.id, { ok: false, reason: "The assistant is busy." });
    };
    window.addEventListener(PLUGIN_PANEL_ACTION_EVENT, onAction);
    try {
      await broadcast(reportPayload({ report: {
        title: "Assistant",
        sections: [{ kind: "prompt", id: "ask", commandId: "plugin.exampleAnalyzer.run", submitLabel: "Send", maxLength: 4000, rows: 3, disabled: false }]
      } }));
      const textarea = container!.querySelector<HTMLTextAreaElement>("textarea")!;
      const send = container!.querySelector<HTMLButtonElement>(".plugin-report-action-primary")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Draw aspirin");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(received).toEqual([{ panelId: PANEL_ID, sectionId: "ask", control: "prompt", text: "Draw aspirin" }]);
      expect(container!.textContent).toContain("The assistant is busy.");
    } finally {
      window.removeEventListener(PLUGIN_PANEL_ACTION_EVENT, onAction);
    }
  });

  it("tells the reader when the document window does not answer a prompt", async () => {
    vi.useFakeTimers();
    try {
      await mountWindow();
      await broadcast(reportPayload({ report: {
        title: "Assistant",
        sections: [{ kind: "prompt", id: "ask", commandId: "plugin.exampleAnalyzer.run", submitLabel: "Send", maxLength: 4000, rows: 3, disabled: false }]
      } }));
      await act(async () => {
        const textarea = container!.querySelector("textarea")!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Draw benzene");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const send = container!.querySelector<HTMLButtonElement>(".plugin-report-action-primary")!;
      await act(async () => {
        send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(container!.textContent).toContain("ChemDraft did not answer; try again.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides Run again for reports with a prompt and keeps it for output-only reports", async () => {
    await mountWindow();
    await broadcast(reportPayload({ report: {
      title: "Assistant",
      sections: [{ kind: "prompt", id: "ask", commandId: "plugin.exampleAnalyzer.run", maxLength: 4000, rows: 3, submitLabel: "Send", disabled: false }]
    } }));
    expect(container!.querySelector(".plugin-panel-run-again")).toBeNull();
    await broadcast(reportPayload({ revision: 2 }));
    expect(container!.querySelector(".plugin-panel-run-again")).not.toBeNull();
  });

  it("opens result reports at the top and resets on a new result or same-revision reopen", async () => {
    await mountWindow();
    const content = container!.querySelector<HTMLDivElement>(".plugin-panel-content")!;
    Object.defineProperties(content, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 900 }
    });
    await broadcast(reportPayload());
    expect(content.scrollTop).toBe(0);
    content.scrollTop = 900;
    await broadcast(reportPayload({ revision: 2 }));
    expect(content.scrollTop).toBe(0);
    content.scrollTop = 120;
    await broadcast(reportPayload({ revision: 2 }));
    expect(content.scrollTop).toBe(0);
    content.scrollTop = 120;
    await broadcast(reportPayload({ revision: 1 }));
    expect(content.scrollTop).toBe(120);
  });

  it("keeps every shift table header and cell inside its own horizontal scroll box", async () => {
    await mountWindow();
    const columns = ["Nucleus", "δ (ppm)", "Equiv.", "Mult. est.", "J (Hz) est.", "Confidence", "Atoms", "Environment"];
    const cells = ["¹³C", "140.85", "1", "—", "—", "medium", "12", "Long environment description".repeat(20)];
    await broadcast(reportPayload({ report: { title: "Shifts", sections: [{ kind: "table", title: "Predicted shifts", columns, rows: [cells] }] } }));
    const box = container!.querySelector(".plugin-report-table-scroll")!;
    expect([...box.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual(columns);
    expect([...box.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual(cells);
  });

  it("starts replacement web fallback results at the top too", async () => {
    const payload = reportPayload();
    const panel = { pluginId: PLUGIN_ID, panelId: PANEL_ID, title: "Results", openedAt: "2026-10-31T00:00:00Z", report: payload.report };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const render = (report: PluginPanelReport) => root!.render(createElement(PluginPanelSurface, {
      openPanel: { ...panel, report }, diagnosticsOpen: false, plugins: [], diagnostics: [],
      onClose: vi.fn(), onCloseDiagnostics: vi.fn(), onRunAgain: vi.fn()
    }));
    act(() => render(panel.report));
    const report = container.querySelector<HTMLElement>(".plugin-report")!;
    report.scrollTop = 500;
    act(() => render({ ...panel.report }));
    expect(report.scrollTop).toBe(0);
  });

  it("restores the original native frame before the close button hides a full-size panel", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    await mountWindow();
    await broadcast(reportPayload());
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>(".lf-btn")].find((button) => button.textContent === "Full size")!.click());
    expect(tauriInvoke).toHaveBeenCalledWith("set_plugin_panel_full_size", {
      enabled: true, width: 1392, height: 660
    });
    expect(document.querySelector(".lf-modal")).not.toBeNull();
    let finishRestore!: (status: { enabled: boolean }) => void;
    tauriInvoke.mockImplementationOnce(() => new Promise<{ enabled: boolean }>((resolve) => { finishRestore = resolve; }));
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Close panel"]')!.click());
    expect(tauriInvoke).toHaveBeenLastCalledWith("set_plugin_panel_full_size", {
      enabled: false, width: 0, height: 0
    });
    expect(nativePanel.hide).not.toHaveBeenCalled();
    expect(tauriEvents.emitted.filter(({ name }) => name === PLUGIN_PANEL_CLOSED_EVENT)).toHaveLength(0);
    expect(document.querySelector(".lf-modal")).not.toBeNull();
    await act(async () => {
      await tauriEvents.emit("chemdraft://plugin-panel-full-size", { enabled: false });
    });
    expect(document.querySelector(".lf-modal")).toBeNull();
    expect(nativePanel.hide).not.toHaveBeenCalled();
    await act(async () => { finishRestore({ enabled: false }); });
    expect(nativePanel.hide).toHaveBeenCalledTimes(1);
    expect(tauriInvoke).toHaveBeenCalledWith("hide_plugin_panel_window");
    expect(tauriEvents.emitted.filter(({ name }) => name === PLUGIN_PANEL_CLOSED_EVENT)).toHaveLength(1);
    expect(document.querySelector(".lf-modal")).toBeNull();
    await broadcast(reportPayload());
    expect(container!.querySelector(".lf-root")).not.toBeNull();
  });

  it("keeps the panel open with a visible reason if frame restoration fails, and lets close retry", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    await mountWindow();
    await broadcast(reportPayload());
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>(".lf-btn")].find((button) => button.textContent === "Full size")!.click());
    expect(document.querySelector(".lf-modal")).not.toBeNull();
    tauriInvoke.mockRejectedValueOnce(new Error("Restore unavailable"));
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Close panel"]')!.click());
    expect(tauriInvoke).toHaveBeenLastCalledWith("set_plugin_panel_full_size", {
      enabled: false, width: 0, height: 0
    });
    expect(nativePanel.hide).not.toHaveBeenCalled();
    expect(tauriEvents.emitted.filter(({ name }) => name === PLUGIN_PANEL_CLOSED_EVENT)).toHaveLength(0);
    expect(container!.querySelector('[role="alert"]')!.textContent).toContain("Could not restore the panel's previous size and position. Try closing it again.");
    expect(document.querySelector('.lf-modal [role="status"]')!.textContent).toContain("Try closing it again");
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Close panel"]')!.click());
    expect(tauriInvoke.mock.calls.filter(([command, args]) => command === "set_plugin_panel_full_size" && args?.enabled === false)).toHaveLength(2);
    expect(nativePanel.hide).toHaveBeenCalledTimes(1);
    expect(tauriEvents.emitted.filter(({ name }) => name === PLUGIN_PANEL_CLOSED_EVENT)).toHaveLength(1);
    expect(container!.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector(".lf-modal")).toBeNull();
  });

  it("follows replacement output only at the bottom or after the reader submits", async () => {
    await mountWindow();
    const assistantReport: PluginPanelReport = {
      title: "Assistant",
      sections: [{ kind: "prompt", id: "ask", commandId: "plugin.exampleAnalyzer.run", maxLength: 4000, rows: 3, submitLabel: "Send", disabled: false }]
    };
    await broadcast(reportPayload({ report: assistantReport }));
    const content = container!.querySelector<HTMLDivElement>(".plugin-panel-content")!;
    Object.defineProperties(content, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 900 }
    });
    await broadcast(reportPayload({ revision: 2, report: assistantReport }));
    expect(content.scrollTop).toBe(1000);

    content.scrollTop = 120;
    await broadcast(reportPayload({ revision: 3, report: assistantReport }));
    expect(content.scrollTop).toBe(120);

    const onAction = (event: Event) => {
      const action = (event as CustomEvent<{ id: string }>).detail;
      void respondToPluginPanelAction(action.id, { ok: true });
    };
    window.addEventListener(PLUGIN_PANEL_ACTION_EVENT, onAction);
    try {
      const textarea = container!.querySelector<HTMLTextAreaElement>("textarea")!;
      const send = container!.querySelector<HTMLButtonElement>(".plugin-report-action-primary")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Continue");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      await broadcast(reportPayload({ revision: 4, report: assistantReport }));
      expect(content.scrollTop).toBe(1000);
    } finally {
      window.removeEventListener(PLUGIN_PANEL_ACTION_EVENT, onAction);
    }
  });

  it("keeps a prompt textarea focused when its report is replaced", async () => {
    await mountWindow();
    const prompt = { kind: "prompt" as const, id: "ask", commandId: "plugin.exampleAnalyzer.run", maxLength: 4000, rows: 3, submitLabel: "Send", disabled: false };
    await broadcast(reportPayload({ report: { title: "Assistant", sections: [prompt, { kind: "text", body: "Working" }] } }));
    const textarea = container!.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.focus();
    await broadcast(reportPayload({ revision: 2, report: { title: "Assistant", sections: [prompt, { kind: "text", body: "Done" }] } }));
    expect(container!.querySelector("textarea")).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
  });

  it("shows the staleness banner for the current revision and clears it for a newer report", async () => {
    await mountWindow();
    await broadcast(reportPayload({ revision: 1 }));
    expect(container!.querySelector('[data-testid="plugin-panel-stale"]')).toBeNull();

    await act(async () => {
      await broadcastPluginPanelStaleness({ pluginId: PLUGIN_ID, panelId: PANEL_ID, stale: true, revision: 1 });
    });
    expect(container!.querySelector('[data-testid="plugin-panel-stale"]')).not.toBeNull();

    // A newer report is a fresh result; the old verdict must not carry over to it.
    await broadcast(reportPayload({ revision: 2 }));
    expect(container!.querySelector('[data-testid="plugin-panel-stale"]')).toBeNull();

    await act(async () => {
      await broadcastPluginPanelStaleness({ pluginId: PLUGIN_ID, panelId: PANEL_ID, stale: true, revision: 2 });
    });
    expect(container!.querySelector('[data-testid="plugin-panel-stale"]')).not.toBeNull();
  });

  it("retains a replayed staleness verdict that arrives before its matching report", async () => {
    await mountWindow();
    await act(async () => {
      await broadcastPluginPanelStaleness({
        pluginId: PLUGIN_ID,
        panelId: PANEL_ID,
        stale: true,
        revision: 7
      });
    });
    await broadcast(reportPayload({ revision: 7 }));

    expect(container!.querySelector('[data-testid="plugin-panel-stale"]')).not.toBeNull();
  });

  it("draws its stoplight close button without a stray glyph, and closes by click or Escape", async () => {
    await mountWindow();
    const closes: string[] = [];
    const onClosed = (event: Event) => {
      const detail = (event as CustomEvent<{ pluginId?: unknown; panelId?: unknown }>).detail;
      if (detail?.pluginId === PLUGIN_ID && typeof detail.panelId === "string") {
        closes.push(detail.panelId);
      }
    };
    window.addEventListener(PLUGIN_PANEL_CLOSED_EVENT, onClosed);
    try {
      await broadcast(reportPayload());
      const close = container!.querySelector<HTMLButtonElement>(".palette-close-button");
      expect(close).not.toBeNull();
      expect(close!.getAttribute("aria-label")).toBe("Close panel");
      expect(close!.textContent).toBe("");
      expect(container!.querySelector(".palette-title")!.textContent).not.toContain("×");
      await act(async () => {
        close!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(closes).toEqual([PANEL_ID]);
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await Promise.resolve();
      });
      expect(closes).toEqual([PANEL_ID, PANEL_ID]);
    } finally {
      window.removeEventListener(PLUGIN_PANEL_CLOSED_EVENT, onClosed);
    }
  });

  it("does not retain duplicate bridge listeners through StrictMode's setup/cleanup probe", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(StrictMode, null, createElement(PluginPanelWindow, { panelId: WINDOW_ID })));
      await Promise.resolve();
    });

    await broadcast(reportPayload({ revision: 1, report: { title: "First", sections: [] } }));
    await broadcast(reportPayload({ revision: 2, report: { title: "Second", sections: [] } }));

    expect(container.querySelectorAll(".plugin-report")).toHaveLength(1);
    expect(container.textContent).toContain("Second");
    expect(container.textContent).not.toContain("First");
  });

  it("ignores a same-named panel report owned by a different plugin", async () => {
    await mountWindow();
    await broadcast(reportPayload({ pluginId: "org.test.other", report: { title: "Wrong owner", sections: [] } }));
    expect(container!.textContent).toContain("Waiting for plugin content…");

    await broadcast(reportPayload({ report: { title: "Correct owner", sections: [] } }));
    expect(container!.textContent).toContain("Correct owner");
    expect(container!.textContent).not.toContain("Wrong owner");
  });

  it("renders proposal review in the shared analysis window and relays Accept/Reject", async () => {
    await mountWindow(pluginPanelWindowId(ANALYSIS_WINDOW_OWNER_ID, PATCH_REVIEW_WINDOW_ID));
    await act(async () => {
      await broadcastAnalysisWindowSnapshot({
        pluginId: ANALYSIS_WINDOW_OWNER_ID,
        panelId: PATCH_REVIEW_WINDOW_ID,
        revision: 1,
        content: {
          kind: "patchReview",
          proposals: [
            {
              id: "proposal-1",
              pluginId: "org.test.proposer",
              pluginName: "Test Proposer",
              reason: "Insert the recognized structure",
              warnings: [{ code: "low-confidence", message: "Review the stereochemistry." }],
              recognition: {
                sourceImageRef: "data:image/png;base64,iVBORw==",
                proposedSmiles: "[C@H](F)Cl",
                proposedMolfile: "fixture molfile",
                confidenceTier: "low",
                elapsedMs: 125,
                engine: {
                  name: "MolScribe",
                  molscribeCommit: "abc123",
                  modelSha256: "a".repeat(64)
                }
              },
              structurePreview: "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E"
            }
          ]
        }
      });
    });

    expect(container!.textContent).toContain("Insert the recognized structure");
    expect(container!.textContent).toContain("Low confidence");
    expect(container!.textContent).toContain("[C@H](F)Cl");
    expect(container!.querySelector<HTMLImageElement>('[alt="Source submitted for structure recognition"]')?.src).toContain(
      "data:image/png;base64,iVBORw=="
    );
    expect(
      container!.querySelector<HTMLImageElement>('[data-testid="recognition-structure-preview"]')?.getAttribute("src")
    ).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E");
    const actions: unknown[] = [];
    const onAction = (event: Event) => actions.push((event as CustomEvent<unknown>).detail);
    window.addEventListener(ANALYSIS_WINDOW_ACTION_EVENT, onAction);
    try {
      const [accept, reject] = [...container!.querySelectorAll<HTMLButtonElement>(".patch-review-actions button")];
      await act(async () => {
        accept!.click();
        reject!.click();
        await Promise.resolve();
      });
      expect(actions).toEqual([
        { kind: "acceptPluginProposal", proposalId: "proposal-1" },
        { kind: "rejectPluginProposal", proposalId: "proposal-1" }
      ]);
    } finally {
      window.removeEventListener(ANALYSIS_WINDOW_ACTION_EVENT, onAction);
    }
  });

  it("renders the built-in Molecular Inspector, validation result, and diagnostics snapshot kinds", async () => {
    await mountWindow(pluginPanelWindowId(ANALYSIS_WINDOW_OWNER_ID, MOLECULAR_INSPECTOR_WINDOW_ID));
    await act(async () => {
      await broadcastAnalysisWindowSnapshot({
        pluginId: ANALYSIS_WINDOW_OWNER_ID,
        panelId: MOLECULAR_INSPECTOR_WINDOW_ID,
        revision: 1,
        content: { kind: "molecularInspector", busy: false, stale: false }
      });
    });
    expect(container!.textContent).toContain("Select a structure to see its analyses here.");

    act(() => root!.unmount());
    root = createRoot(container!);
    await act(async () => {
      root!.render(
        createElement(PluginPanelWindow, {
          panelId: pluginPanelWindowId(ANALYSIS_WINDOW_OWNER_ID, VALIDATION_RESULT_WINDOW_ID)
        })
      );
      await Promise.resolve();
    });
    await act(async () => {
      await broadcastAnalysisWindowSnapshot({
        pluginId: ANALYSIS_WINDOW_OWNER_ID,
        panelId: VALIDATION_RESULT_WINDOW_ID,
        revision: 1,
        content: {
          kind: "report",
          report: {
            title: "Validation Result",
            sections: [{ kind: "text", body: "No validation warnings or errors were reported." }]
          }
        }
      });
    });
    expect(container!.textContent).toContain("No validation warnings or errors were reported.");

    act(() => root!.unmount());
    root = createRoot(container!);
    await act(async () => {
      root!.render(
        createElement(PluginPanelWindow, {
          panelId: pluginPanelWindowId(ANALYSIS_WINDOW_OWNER_ID, PLUGIN_DIAGNOSTICS_WINDOW_ID)
        })
      );
      await Promise.resolve();
    });
    await act(async () => {
      await broadcastAnalysisWindowSnapshot({
        pluginId: ANALYSIS_WINDOW_OWNER_ID,
        panelId: PLUGIN_DIAGNOSTICS_WINDOW_ID,
        revision: 1,
        content: { kind: "pluginDiagnostics", plugins: [], diagnostics: [] }
      });
    });
    expect(container!.querySelector('[data-testid="plugin-diagnostics"]')).not.toBeNull();
    expect(container!.textContent).toContain("No bundled plugins are registered.");
  });

  describe("proposal review over the desktop bridge", () => {
    const reviewWindowId = pluginPanelWindowId(ANALYSIS_WINDOW_OWNER_ID, PATCH_REVIEW_WINDOW_ID);

    async function mountReview(): Promise<void> {
      (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
      window.history.replaceState(null, "", `/?window=pluginPanel&panelId=${reviewWindowId}`);
      await mountWindow(reviewWindowId);
      await act(async () => {
        await broadcastAnalysisWindowSnapshot({
          pluginId: ANALYSIS_WINDOW_OWNER_ID,
          panelId: PATCH_REVIEW_WINDOW_ID,
          revision: 1,
          content: {
            kind: "patchReview",
            proposals: [
              {
                id: "proposal_1",
                pluginId: "org.chemdraft.ocsr.molscribe",
                pluginName: "Structure from Image (MolScribe)",
                reason: "Insert the locally recognized structure (medium confidence) after review.",
                warnings: []
              }
            ]
          }
        });
      });
    }

    function acceptButton(): HTMLButtonElement {
      return [...container!.querySelectorAll<HTMLButtonElement>(".patch-review-actions button")].find(
        (button) => button.textContent === "Accept"
      )!;
    }

    it("shows the main window's reason on the proposal when an Accept is refused", async () => {
      tauriEvents.setResponder((name, payload) => {
        const action = payload as { kind?: string; requestId?: string };
        if (name === ANALYSIS_WINDOW_ACTION_EVENT && action.kind === "acceptPluginProposal") {
          void tauriEvents.emit(ANALYSIS_WINDOW_ACTION_RESULT_EVENT, {
            requestId: action.requestId,
            proposal: { ok: false, message: "Could not insert the proposal: page page_1 does not exist" }
          });
        }
      });
      await mountReview();

      await act(async () => {
        acceptButton().click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const request = tauriEvents.emitted.find((event) => event.name === ANALYSIS_WINDOW_ACTION_EVENT);
      expect(request?.payload).toMatchObject({
        kind: "acceptPluginProposal",
        proposalId: "proposal_1",
        requestId: expect.any(String)
      });
      expect(container!.querySelector('[role="alert"]')?.textContent).toBe(
        "Could not insert the proposal: page page_1 does not exist"
      );
      expect(acceptButton().disabled).toBe(false);
    });

    it("says so when the main window never answers an Accept, instead of doing nothing", async () => {
      vi.useFakeTimers();
      try {
        await mountReview();
        await act(async () => {
          acceptButton().click();
          await vi.advanceTimersByTimeAsync(0);
        });
        // Waiting for the answer: a second click cannot queue a duplicate Accept.
        expect(acceptButton().disabled).toBe(true);
        expect(container!.querySelector('[role="alert"]')).toBeNull();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(PROPOSAL_DECISION_TIMEOUT_MS);
        });
        expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
          "The document window did not answer the Accept"
        );
        expect(acceptButton().disabled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
