import type { AnalysisReport } from "@chemdraft/analysis-core";
import type { PluginManifest, PluginPanelReport, RecognitionProposalReview } from "@chemdraft/plugin-api";
import { isDesktopRuntime } from "../window-manager";
import type { SaveTextFileOptions, SaveTextFileResult } from "./spectrumExport";
import type { PluginDiagnostic } from "./types";

export const PLUGIN_PANEL_REPORT_EVENT = "chemdraft://plugin-panel-report";
export const PLUGIN_PANEL_REQUEST_EVENT = "chemdraft://plugin-panel-request";
export const PLUGIN_PANEL_STALENESS_EVENT = "chemdraft://plugin-panel-staleness";
export const PLUGIN_PANEL_RERUN_EVENT = "chemdraft://plugin-panel-rerun";
export const PLUGIN_PANEL_CLOSED_EVENT = "chemdraft://plugin-panel-closed";
export const ANALYSIS_WINDOW_SNAPSHOT_EVENT = "chemdraft://analysis-window-snapshot";
export const ANALYSIS_WINDOW_ACTION_EVENT = "chemdraft://analysis-window-action";
export const ANALYSIS_WINDOW_ACTION_RESULT_EVENT = "chemdraft://analysis-window-action-result";

/** Core-owned identities deliberately use the existing plugin-panel window transport. */
export const ANALYSIS_WINDOW_OWNER_ID = "core.analysis";
export const MOLECULAR_INSPECTOR_WINDOW_ID = "molecular-inspector";
export const VALIDATION_RESULT_WINDOW_ID = "validation-result";
export const PLUGIN_DIAGNOSTICS_WINDOW_ID = "plugin-diagnostics";
export const PATCH_REVIEW_WINDOW_ID = "plugin-proposals";

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

export interface PluginProposalReviewItem {
  id: string;
  pluginId: string;
  pluginName: string;
  reason: string;
  warnings: readonly { code: string; message: string }[];
  recognition?: RecognitionProposalReview;
  /** Host-drawn `image/svg+xml` data URI of the molecule the proposal would insert. */
  structurePreview?: string;
}

export type AnalysisWindowContent =
  | {
      kind: "molecularInspector";
      report?: AnalysisReport;
      busy: boolean;
      stale: boolean;
    }
  | {
      kind: "report";
      report: PluginPanelReport;
    }
  | {
      kind: "pluginDiagnostics";
      plugins: readonly PluginManifest[];
      diagnostics: readonly PluginDiagnostic[];
    }
  | {
      kind: "patchReview";
      proposals: readonly PluginProposalReviewItem[];
    };

export interface AnalysisWindowSnapshotPayload extends PluginPanelIdentity {
  content: AnalysisWindowContent;
  revision: number;
}

export type AnalysisWindowAction =
  | { kind: "close"; windowId: string }
  | { kind: "copyMolecularInspector"; text: string }
  | { kind: "changeMolecularInterpretation"; interpretationId?: string }
  | { kind: "acceptPluginProposal"; proposalId: string }
  | { kind: "rejectPluginProposal"; proposalId: string }
  | ({ kind: "saveTextFile"; requestId: string; filename: string; text: string } & SaveTextFileOptions);

/** Main → window: how a `saveTextFile` action ended, keyed to the request that asked. */
export interface AnalysisWindowSaveResult {
  requestId: string;
  result: SaveTextFileResult;
}

export interface OpenPluginPanelRequest extends PluginPanelIdentity {
  title: string;
  width?: number;
  height?: number;
  /** True only when the user explicitly opened this window (menu command, click). Automatic shows
   *  — a new proposal, a plugin pushing its report — pass false so the canvas keeps keyboard focus. */
  focus: boolean;
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
      height: request.height,
      focus: request.focus
    }
  });
}

/** True inside a detached `plugin-panel-*` webview (the route Rust builds as `?window=pluginPanel`). */
export function isPluginPanelWindowRoute(): boolean {
  return new URLSearchParams(globalThis.location?.search ?? "").get("window") === "pluginPanel";
}

/**
 * Window → main: save a text file through the main window, and resolve with how it ended.
 *
 * Report windows hold no dialog or filesystem permission (capabilities/plugin-panel.json) and must
 * not gain one, so a save the user asks for there — the NMR figure's JCAMP-DX export — is performed
 * by the main window with its own permissions. The listener is attached before the request is sent,
 * so a fast answer cannot be missed.
 */
export async function requestSaveTextFileFromMain(
  filename: string,
  text: string,
  options: SaveTextFileOptions
): Promise<SaveTextFileResult> {
  if (!isDesktopRuntime()) {
    return "failed";
  }
  const requestId = `save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let unlisten: (() => void) | undefined;
  try {
    const { emit, listen } = await import("@tauri-apps/api/event");
    let answer: (result: SaveTextFileResult) => void = () => undefined;
    const answered = new Promise<SaveTextFileResult>((resolve) => {
      answer = resolve;
    });
    unlisten = await listen<unknown>(ANALYSIS_WINDOW_ACTION_RESULT_EVENT, (event) => {
      if (isSaveResult(event.payload) && event.payload.requestId === requestId) {
        answer(event.payload.result);
      }
    });
    await emit<AnalysisWindowAction>(ANALYSIS_WINDOW_ACTION_EVENT, {
      kind: "saveTextFile",
      requestId,
      filename,
      text,
      ...options,
      extensions: [...options.extensions]
    });
    return await answered;
  } catch {
    return "failed";
  } finally {
    unlisten?.();
  }
}

/** Main → window: answer a `saveTextFile` action. */
export async function respondToSaveTextFile(requestId: string, result: SaveTextFileResult): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }
  const { emit } = await import("@tauri-apps/api/event");
  await emit<AnalysisWindowSaveResult>(ANALYSIS_WINDOW_ACTION_RESULT_EVENT, { requestId, result });
}

export async function broadcastPluginPanelReport(payload: PluginPanelReportPayload): Promise<void> {
  window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_REPORT_EVENT, { detail: payload }));
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit<PluginPanelReportPayload>(PLUGIN_PANEL_REPORT_EVENT, payload);
}

export async function broadcastAnalysisWindowSnapshot(payload: AnalysisWindowSnapshotPayload): Promise<void> {
  window.dispatchEvent(new CustomEvent(ANALYSIS_WINDOW_SNAPSHOT_EVENT, { detail: payload }));
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit<AnalysisWindowSnapshotPayload>(ANALYSIS_WINDOW_SNAPSHOT_EVENT, payload);
}

export function listenForAnalysisWindowSnapshots(
  handler: (payload: AnalysisWindowSnapshotPayload) => void
): () => void {
  const domListener = (event: Event) => {
    const payload = (event as CustomEvent<unknown>).detail;
    if (isAnalysisWindowSnapshotPayload(payload)) {
      handler(payload);
    }
  };
  window.addEventListener(ANALYSIS_WINDOW_SNAPSHOT_EVENT, domListener);
  return attachTauriListener(
    ANALYSIS_WINDOW_SNAPSHOT_EVENT,
    domListener,
    isAnalysisWindowSnapshotPayload,
    handler
  );
}

export async function requestAnalysisWindowAction(action: AnalysisWindowAction): Promise<void> {
  window.dispatchEvent(new CustomEvent(ANALYSIS_WINDOW_ACTION_EVENT, { detail: action }));
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit<AnalysisWindowAction>(ANALYSIS_WINDOW_ACTION_EVENT, action);
}

export function listenForAnalysisWindowActions(handler: (action: AnalysisWindowAction) => void): () => void {
  const domListener = (event: Event) => {
    const payload = (event as CustomEvent<unknown>).detail;
    if (isAnalysisWindowAction(payload)) {
      handler(payload);
    }
  };
  window.addEventListener(ANALYSIS_WINDOW_ACTION_EVENT, domListener);
  return attachTauriListener(ANALYSIS_WINDOW_ACTION_EVENT, domListener, isAnalysisWindowAction, handler);
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

function isAnalysisWindowSnapshotPayload(payload: unknown): payload is AnalysisWindowSnapshotPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as Partial<AnalysisWindowSnapshotPayload>;
  return (
    typeof candidate.pluginId === "string" &&
    typeof candidate.panelId === "string" &&
    typeof candidate.revision === "number" &&
    typeof candidate.content === "object" &&
    candidate.content !== null &&
    typeof (candidate.content as { kind?: unknown }).kind === "string"
  );
}

function isAnalysisWindowAction(payload: unknown): payload is AnalysisWindowAction {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as { kind?: unknown; [key: string]: unknown };
  switch (candidate.kind) {
    case "close":
      return typeof candidate.windowId === "string";
    case "copyMolecularInspector":
      return typeof candidate.text === "string";
    case "changeMolecularInterpretation":
      return candidate.interpretationId === undefined || typeof candidate.interpretationId === "string";
    case "acceptPluginProposal":
    case "rejectPluginProposal":
      return typeof candidate.proposalId === "string";
    case "saveTextFile":
      return (
        typeof candidate.requestId === "string" &&
        typeof candidate.filename === "string" &&
        typeof candidate.text === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.formatLabel === "string" &&
        typeof candidate.mimeType === "string" &&
        Array.isArray(candidate.extensions) &&
        candidate.extensions.every((extension) => typeof extension === "string")
      );
    default:
      return false;
  }
}

function isSaveResult(payload: unknown): payload is AnalysisWindowSaveResult {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as Partial<AnalysisWindowSaveResult>;
  return (
    typeof candidate.requestId === "string" &&
    (candidate.result === "saved" || candidate.result === "cancelled" || candidate.result === "failed")
  );
}
