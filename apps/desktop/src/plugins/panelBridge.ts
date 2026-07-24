import type { PluginPanelReport } from "@chemdraft/plugin-api";
import { isDesktopRuntime } from "../window-manager";

export const PLUGIN_PANEL_REPORT_EVENT = "chemdraft://plugin-panel-report";
export const PLUGIN_PANEL_REQUEST_EVENT = "chemdraft://plugin-panel-request";
export const PLUGIN_PANEL_STALENESS_EVENT = "chemdraft://plugin-panel-staleness";
export const PLUGIN_PANEL_RERUN_EVENT = "chemdraft://plugin-panel-rerun";
export const PLUGIN_PANEL_CLOSED_EVENT = "chemdraft://plugin-panel-closed";

export interface PluginPanelIdentity {
  panelId: string;
  pluginId: string;
}

export interface PluginPanelReportPayload extends PluginPanelIdentity {
  report: PluginPanelReport;
  /** Monotonic per-main-window counter so a late/stale broadcast never regresses a panel. */
  revision: number;
  /** The command "Run again" re-invokes (report.rerunCommandId ?? the panel's default command).
   *  Display-only in the window: the main window re-resolves it before dispatching. */
  commandId?: string;
}

/** D-09 pushed to a detached window: whether `revision`'s report still matches the live document. */
export interface PluginPanelStalenessPayload extends PluginPanelIdentity {
  stale: boolean;
  /** The report revision this verdict was computed for, so it can never mark a newer report. */
  revision: number;
}

export interface OpenPluginPanelRequest extends PluginPanelIdentity {
  title: string;
  width?: number;
  height?: number;
}

export async function openPluginPanelWindow(request: OpenPluginPanelRequest): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  // Rust uses `request.panelId` in both the native window label and its query string. Pass a
  // reversible, label-safe composite id so two plugins may legally contribute the same panel id
  // without sharing a window. Hex encoding also avoids the old lossy dots-to-dashes transform.
  await invoke("open_plugin_panel_window", {
    request: {
      panelId: pluginPanelWindowId(request.pluginId, request.panelId),
      title: request.title,
      width: request.width,
      height: request.height
    }
  });
}

export async function broadcastPluginPanelReport(payload: PluginPanelReportPayload): Promise<void> {
  window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_REPORT_EVENT, { detail: payload }));
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit<PluginPanelReportPayload>(PLUGIN_PANEL_REPORT_EVENT, payload);
}

export function listenForPluginPanelReports(
  handler: (payload: PluginPanelReportPayload) => void
): () => void {
  const domListener = (event: Event) => {
    const payload = (event as CustomEvent<unknown>).detail;
    if (isPanelReportPayload(payload)) {
      handler(payload);
    }
  };
  window.addEventListener(PLUGIN_PANEL_REPORT_EVENT, domListener);
  return attachTauriListener(PLUGIN_PANEL_REPORT_EVENT, domListener, isPanelReportPayload, handler);
}

export async function requestPluginPanelReport(identity: PluginPanelIdentity): Promise<void> {
  window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_REQUEST_EVENT, { detail: identity }));
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit(PLUGIN_PANEL_REQUEST_EVENT, identity);
}

export function listenForPluginPanelRequests(handler: (identity: PluginPanelIdentity) => void): () => void {
  return listenForPanelIdentityEvent(PLUGIN_PANEL_REQUEST_EVENT, handler);
}

export async function hideCurrentPanelWindow(): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().hide();
}

/** Hide a panel window from the MAIN window (plugin disabled/uninstalled, panel closed
 *  programmatically). Mirrors the Rust `plugin-panel-<request.panelId>` label scheme. */
export async function hidePluginPanelWindow(pluginId: string, panelId: string): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const window = await WebviewWindow.getByLabel(`plugin-panel-${pluginPanelWindowId(pluginId, panelId)}`);
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

export function listenForPluginPanelStaleness(
  handler: (payload: PluginPanelStalenessPayload) => void
): () => void {
  const domListener = (event: Event) => {
    const payload = (event as CustomEvent<unknown>).detail;
    if (isStalenessPayload(payload)) {
      handler(payload);
    }
  };
  window.addEventListener(PLUGIN_PANEL_STALENESS_EVENT, domListener);
  return attachTauriListener(PLUGIN_PANEL_STALENESS_EVENT, domListener, isStalenessPayload, handler);
}

/** Window → main: run this panel's "Run again" command in the main window (where plugins live). */
export async function requestPluginPanelRerun(identity: PluginPanelIdentity): Promise<void> {
  window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_RERUN_EVENT, { detail: identity }));
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit(PLUGIN_PANEL_RERUN_EVENT, identity);
}

export function listenForPluginPanelReruns(handler: (identity: PluginPanelIdentity) => void): () => void {
  return listenForPanelIdentityEvent(PLUGIN_PANEL_RERUN_EVENT, handler);
}

/** Window → main: the user dismissed this panel window — a real panel close (ADR-0012). */
export async function notifyPluginPanelClosed(identity: PluginPanelIdentity): Promise<void> {
  window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_CLOSED_EVENT, { detail: identity }));
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit(PLUGIN_PANEL_CLOSED_EVENT, identity);
}

export function listenForPluginPanelCloses(handler: (identity: PluginPanelIdentity) => void): () => void {
  return listenForPanelIdentityEvent(PLUGIN_PANEL_CLOSED_EVENT, handler);
}

/** Shared listener plumbing for the `{ pluginId, panelId }` messages (request/rerun/closed). */
function listenForPanelIdentityEvent(
  eventName: string,
  handler: (identity: PluginPanelIdentity) => void
): () => void {
  const domListener = (event: Event) => {
    const payload = (event as CustomEvent<unknown>).detail;
    if (isPanelIdentity(payload)) {
      handler(payload);
    }
  };
  window.addEventListener(eventName, domListener);
  return attachTauriListener(eventName, domListener, isPanelIdentity, handler);
}

/**
 * Attach the cross-window Tauri half without delaying ownership of the DOM listener.
 *
 * React may run an effect's setup and cleanup before a dynamic import/listen promise settles
 * (notably StrictMode's development probe). Returning cleanup synchronously lets that cleanup mark
 * the registration cancelled immediately; if the native listener finishes later, it is unlistened
 * before it can become an orphan.
 */
function attachTauriListener<T>(
  eventName: string,
  domListener: EventListener,
  validate: (payload: unknown) => payload is T,
  handler: (payload: T) => void
): () => void {
  let cancelled = false;
  let unlistenTauri: (() => void) | undefined;

  if (isDesktopRuntime()) {
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        if (cancelled) {
          return;
        }
        const unlisten = await listen<T>(eventName, (event) => {
          if (!cancelled && validate(event.payload)) {
            handler(event.payload);
          }
        });
        if (cancelled) {
          unlisten();
        } else {
          unlistenTauri = unlisten;
        }
      })
      .catch(() => undefined);
  }

  return () => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    window.removeEventListener(eventName, domListener);
    unlistenTauri?.();
    unlistenTauri = undefined;
  };
}

/** Stable in-memory key for a panel owned by one plugin. */
export function pluginPanelIdentityKey(pluginId: string, panelId: string): string {
  return `${pluginId.length}:${pluginId}${panelId}`;
}

/** Reversible, native-label-safe identity passed through Rust's existing `panelId` field. */
export function pluginPanelWindowId(pluginId: string, panelId: string): string {
  return `v1x${encodeHex(pluginId)}x${encodeHex(panelId)}`;
}

/** Decode the opaque query value supplied to a detached plugin-panel webview. */
export function parsePluginPanelWindowId(windowId: string): PluginPanelIdentity | undefined {
  const match = /^v1x([0-9a-f]+)x([0-9a-f]+)$/.exec(windowId);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  try {
    return { pluginId: decodeHex(match[1]), panelId: decodeHex(match[2]) };
  } catch {
    return undefined;
  }
}

function encodeHex(value: string): string {
  return [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHex(value: string): string {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) {
    throw new Error("Invalid plugin panel window identity.");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isPanelIdentity(payload: unknown): payload is PluginPanelIdentity {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as Partial<PluginPanelIdentity>;
  return typeof candidate.pluginId === "string" && typeof candidate.panelId === "string";
}

function isPanelReportPayload(payload: unknown): payload is PluginPanelReportPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as Partial<PluginPanelReportPayload>;
  return (
    typeof candidate.pluginId === "string" &&
    typeof candidate.panelId === "string" &&
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
    typeof candidate.pluginId === "string" &&
    typeof candidate.panelId === "string" &&
    typeof candidate.stale === "boolean" &&
    typeof candidate.revision === "number"
  );
}
