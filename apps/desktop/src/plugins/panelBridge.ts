import type { PluginPanelReport } from "@chemdraft/plugin-api";
import { isDesktopRuntime } from "../window-manager";

export const PLUGIN_PANEL_REPORT_EVENT = "chemdraft://plugin-panel-report";
export const PLUGIN_PANEL_REQUEST_EVENT = "chemdraft://plugin-panel-request";
export const PLUGIN_PANEL_STALENESS_EVENT = "chemdraft://plugin-panel-staleness";
export const PLUGIN_PANEL_RERUN_EVENT = "chemdraft://plugin-panel-rerun";
export const PLUGIN_PANEL_CLOSED_EVENT = "chemdraft://plugin-panel-closed";

export interface PluginPanelReportPayload {
  panelId: string;
  pluginId: string;
  report: PluginPanelReport;
  /** Monotonic per-main-window counter so a late/stale broadcast never regresses a panel. */
  revision: number;
  /** The command "Run again" re-invokes (report.rerunCommandId ?? the panel's default command).
   *  Display-only in the window: the main window re-resolves it before dispatching. */
  commandId?: string;
}

/** D-09 pushed to a detached window: whether `revision`'s report still matches the live document. */
export interface PluginPanelStalenessPayload {
  panelId: string;
  stale: boolean;
  /** The report revision this verdict was computed for, so it can never mark a newer report. */
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
  return listenForPanelIdEvent(PLUGIN_PANEL_REQUEST_EVENT, handler);
}

export async function hideCurrentPanelWindow(): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().hide();
}

/** Hide a panel window from the MAIN window (plugin disabled/uninstalled, panel closed
 *  programmatically). Mirrors the Rust label scheme: `plugin-panel-<panelId, dots→dashes>`. */
export async function hidePluginPanelWindow(panelId: string): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const window = await WebviewWindow.getByLabel(`plugin-panel-${panelId.replace(/\./g, "-")}`);
  await window?.hide();
}

export async function broadcastPluginPanelStaleness(payload: PluginPanelStalenessPayload): Promise<void> {
  window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_STALENESS_EVENT, { detail: payload }));
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit<PluginPanelStalenessPayload>(PLUGIN_PANEL_STALENESS_EVENT, payload);
}

export async function listenForPluginPanelStaleness(
  handler: (payload: PluginPanelStalenessPayload) => void
): Promise<() => void> {
  const domListener = (event: Event) => {
    const payload = (event as CustomEvent<unknown>).detail;
    if (isStalenessPayload(payload)) {
      handler(payload);
    }
  };
  window.addEventListener(PLUGIN_PANEL_STALENESS_EVENT, domListener);
  if (!isDesktopRuntime()) {
    return () => window.removeEventListener(PLUGIN_PANEL_STALENESS_EVENT, domListener);
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlistenTauri = await listen<PluginPanelStalenessPayload>(PLUGIN_PANEL_STALENESS_EVENT, (event) => {
    if (isStalenessPayload(event.payload)) {
      handler(event.payload);
    }
  });
  return () => {
    window.removeEventListener(PLUGIN_PANEL_STALENESS_EVENT, domListener);
    unlistenTauri();
  };
}

/** Window → main: run this panel's "Run again" command in the main window (where plugins live). */
export async function requestPluginPanelRerun(panelId: string): Promise<void> {
  window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_RERUN_EVENT, { detail: { panelId } }));
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit(PLUGIN_PANEL_RERUN_EVENT, { panelId });
}

export async function listenForPluginPanelReruns(handler: (panelId: string) => void): Promise<() => void> {
  return listenForPanelIdEvent(PLUGIN_PANEL_RERUN_EVENT, handler);
}

/** Window → main: the user dismissed this panel window — a real panel close (ADR-0012). */
export async function notifyPluginPanelClosed(panelId: string): Promise<void> {
  window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_CLOSED_EVENT, { detail: { panelId } }));
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit(PLUGIN_PANEL_CLOSED_EVENT, { panelId });
}

export async function listenForPluginPanelCloses(handler: (panelId: string) => void): Promise<() => void> {
  return listenForPanelIdEvent(PLUGIN_PANEL_CLOSED_EVENT, handler);
}

/** Shared listener plumbing for the `{ panelId }` messages (request/rerun/closed). */
async function listenForPanelIdEvent(
  eventName: string,
  handler: (panelId: string) => void
): Promise<() => void> {
  const domListener = (event: Event) => {
    const payload = (event as CustomEvent<{ panelId?: unknown }>).detail;
    if (typeof payload?.panelId === "string") {
      handler(payload.panelId);
    }
  };
  window.addEventListener(eventName, domListener);
  if (!isDesktopRuntime()) {
    return () => window.removeEventListener(eventName, domListener);
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlistenTauri = await listen<{ panelId?: unknown }>(eventName, (event) => {
    if (typeof event.payload?.panelId === "string") {
      handler(event.payload.panelId);
    }
  });
  return () => {
    window.removeEventListener(eventName, domListener);
    unlistenTauri();
  };
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
    candidate.report !== null &&
    (candidate.commandId === undefined || typeof candidate.commandId === "string")
  );
}

function isStalenessPayload(payload: unknown): payload is PluginPanelStalenessPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as Partial<PluginPanelStalenessPayload>;
  return (
    typeof candidate.panelId === "string" &&
    typeof candidate.stale === "boolean" &&
    typeof candidate.revision === "number"
  );
}
