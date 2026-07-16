import type { PluginPanelReport } from "@chemdraft/plugin-api";
import { isDesktopRuntime } from "../window-manager";

export const PLUGIN_PANEL_REPORT_EVENT = "chemdraft://plugin-panel-report";
export const PLUGIN_PANEL_REQUEST_EVENT = "chemdraft://plugin-panel-request";

export interface PluginPanelReportPayload {
  panelId: string;
  pluginId: string;
  report: PluginPanelReport;
  /** Monotonic per-main-window counter so a late/stale broadcast never regresses a panel. */
  revision: number;
}

export interface OpenPluginPanelRequest {
  panelId: string;
  title: string;
  width?: number;
  height?: number;
}

export async function openPluginPanelWindow(request: OpenPluginPanelRequest): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_plugin_panel_window", { request });
}

export async function broadcastPluginPanelReport(payload: PluginPanelReportPayload): Promise<void> {
  window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_REPORT_EVENT, { detail: payload }));
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit<PluginPanelReportPayload>(PLUGIN_PANEL_REPORT_EVENT, payload);
}

export async function listenForPluginPanelReports(
  handler: (payload: PluginPanelReportPayload) => void
): Promise<() => void> {
  const domListener = (event: Event) => {
    const payload = (event as CustomEvent<unknown>).detail;
    if (isPanelReportPayload(payload)) {
      handler(payload);
    }
  };
  window.addEventListener(PLUGIN_PANEL_REPORT_EVENT, domListener);
  if (!isDesktopRuntime()) {
    return () => window.removeEventListener(PLUGIN_PANEL_REPORT_EVENT, domListener);
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlistenTauri = await listen<PluginPanelReportPayload>(PLUGIN_PANEL_REPORT_EVENT, (event) => {
    if (isPanelReportPayload(event.payload)) {
      handler(event.payload);
    }
  });
  return () => {
    window.removeEventListener(PLUGIN_PANEL_REPORT_EVENT, domListener);
    unlistenTauri();
  };
}

export async function requestPluginPanelReport(panelId: string): Promise<void> {
  window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_REQUEST_EVENT, { detail: { panelId } }));
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit(PLUGIN_PANEL_REQUEST_EVENT, { panelId });
}

export async function listenForPluginPanelRequests(handler: (panelId: string) => void): Promise<() => void> {
  const domListener = (event: Event) => {
    const payload = (event as CustomEvent<{ panelId?: unknown }>).detail;
    if (typeof payload?.panelId === "string") {
      handler(payload.panelId);
    }
  };
  window.addEventListener(PLUGIN_PANEL_REQUEST_EVENT, domListener);
  if (!isDesktopRuntime()) {
    return () => window.removeEventListener(PLUGIN_PANEL_REQUEST_EVENT, domListener);
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlistenTauri = await listen<{ panelId?: unknown }>(PLUGIN_PANEL_REQUEST_EVENT, (event) => {
    if (typeof event.payload?.panelId === "string") {
      handler(event.payload.panelId);
    }
  });
  return () => {
    window.removeEventListener(PLUGIN_PANEL_REQUEST_EVENT, domListener);
    unlistenTauri();
  };
}

export async function hideCurrentPanelWindow(): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().hide();
}

function isPanelReportPayload(payload: unknown): payload is PluginPanelReportPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as Partial<PluginPanelReportPayload>;
  return (
    typeof candidate.panelId === "string" &&
    typeof candidate.pluginId === "string" &&
    typeof candidate.revision === "number" &&
    typeof candidate.report === "object" &&
    candidate.report !== null
  );
}
