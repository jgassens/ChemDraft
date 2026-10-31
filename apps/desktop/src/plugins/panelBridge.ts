import type { AnalysisReport } from "@chemdraft/analysis-core";
import type { PluginManifest, PluginPanelReport, RecognitionProposalReview } from "@chemdraft/plugin-api";
import { isDesktopRuntime } from "../window-manager";
import { listenTauriEvent } from "../window-manager/tauriEvents";
import type { PluginPanelActionRequest } from "./pluginPanelActionTypes";
import type { SpectrumSaveFormat, SaveTextFileResult } from "./spectrumExport";
import type { PluginDiagnostic } from "./types";

export const PLUGIN_PANEL_REPORT_EVENT = "chemdraft://plugin-panel-report";
export const PLUGIN_PANEL_REPORT_CLEARED_EVENT = "chemdraft://plugin-panel-report-cleared";
export const PLUGIN_PANEL_REQUEST_EVENT = "chemdraft://plugin-panel-request";
export const PLUGIN_PANEL_STALENESS_EVENT = "chemdraft://plugin-panel-staleness";
export const PLUGIN_PANEL_RERUN_EVENT = "chemdraft://plugin-panel-rerun";
export const PLUGIN_PANEL_CLOSED_EVENT = "chemdraft://plugin-panel-closed";
export const PLUGIN_PANEL_ACTION_EVENT = "chemdraft://plugin-panel-action";
export const PLUGIN_PANEL_ACTION_RESULT_EVENT = "chemdraft://plugin-panel-action-result";
/** Native → main: the closed window's label. Mirrors `PLUGIN_PANEL_WINDOW_CLOSED_EVENT` in lib.rs. */
export const PLUGIN_PANEL_WINDOW_CLOSED_EVENT = "chemdraft://plugin-panel-window-closed";
const PLUGIN_PANEL_WINDOW_LABEL_PREFIX = "plugin-panel-";
export const ANALYSIS_WINDOW_SNAPSHOT_EVENT = "chemdraft://analysis-window-snapshot";
export const ANALYSIS_WINDOW_ACTION_EVENT = "chemdraft://analysis-window-action";
export const ANALYSIS_WINDOW_ACTION_RESULT_EVENT = "chemdraft://analysis-window-action-result";

function isTauriHost(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

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

export interface PluginPanelActionEnvelope {
  id: string;
  request: PluginPanelActionRequest & { panelId: string };
}

export type PluginPanelActionResult = { ok: true } | { ok: false; reason: string };

export interface PluginPanelActionResultEnvelope {
  id: string;
  result: PluginPanelActionResult;
}

/** A panel must not wait indefinitely if its document window has closed or stopped responding. */
export const PLUGIN_PANEL_ACTION_TIMEOUT_MS = 10_000;

/** Cleanup is immediate; cross-window readiness waits for the native subscription. */
export interface PanelBridgeListener {
  (): void;
  readonly ready: Promise<void>;
}

export interface PluginPanelReportPayload extends PluginPanelIdentity {
  report: PluginPanelReport;
  /** Monotonic per-main-window counter so a late/stale broadcast never regresses a panel. */
  revision: number;
  /** The command "Run again" re-invokes (report.rerunCommandId ?? the panel's default command).
   *  Display-only in the window: the main window re-resolves it before dispatching. */
  commandId?: string;
}

/** A revision tombstone also invalidates late reports already in transit to a hidden webview. */
export interface PluginPanelReportClearedPayload extends PluginPanelIdentity {
  revision: number;
}

export async function broadcastPluginPanelReportCleared(payload: PluginPanelReportClearedPayload): Promise<void> {
  window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_REPORT_CLEARED_EVENT, { detail: payload }));
  if (isDesktopRuntime()) {
    await publishPanelWindowEvent(pluginPanelWindowLabel(payload), PLUGIN_PANEL_REPORT_CLEARED_EVENT, payload);
  }
}

export function listenForPluginPanelReportCleared(
  handler: (payload: PluginPanelReportClearedPayload) => void
): PanelBridgeListener {
  const validate = (payload: unknown): payload is PluginPanelReportClearedPayload =>
    isPanelIdentity(payload) && typeof (payload as Partial<PluginPanelReportClearedPayload>).revision === "number";
  const domListener = (event: Event) => {
    const payload = (event as CustomEvent<unknown>).detail;
    if (validate(payload)) handler(payload);
  };
  window.addEventListener(PLUGIN_PANEL_REPORT_CLEARED_EVENT, domListener);
  return attachTauriListener(PLUGIN_PANEL_REPORT_CLEARED_EVENT, domListener, validate, handler);
}

/**
 * Send panel input to the document window and wait for its authoritative resolution. The panel
 * never sends a command id or payload: it can name only the visible control and its user input.
 */
export async function requestPluginPanelAction(
  request: PluginPanelActionRequest & { panelId: string },
  timeoutMs: number = PLUGIN_PANEL_ACTION_TIMEOUT_MS
): Promise<PluginPanelActionResult> {
  const id = `panel-action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const envelope: PluginPanelActionEnvelope = { id, request: { ...request } };
  let unlistenDom: (() => void) | undefined;
  let unlistenTauri: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let settle: (result: PluginPanelActionResult) => void = () => undefined;
    const answer = new Promise<PluginPanelActionResult>((resolve) => {
      settle = resolve;
      const onResult = (event: Event) => {
        const payload = (event as CustomEvent<unknown>).detail;
        if (isPluginPanelActionResultEnvelope(payload) && payload.id === id) resolve(payload.result);
      };
      window.addEventListener(PLUGIN_PANEL_ACTION_RESULT_EVENT, onResult);
      unlistenDom = () => window.removeEventListener(PLUGIN_PANEL_ACTION_RESULT_EVENT, onResult);
      timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs);
    });
    if (isTauriHost()) {
      try {
        // Attach before the request leaves this window: a fast document-window response must not
        // race the reply subscription.
        unlistenTauri = await listenTauriEvent<unknown>(PLUGIN_PANEL_ACTION_RESULT_EVENT, (event) => {
          if (isPluginPanelActionResultEnvelope(event.payload) && event.payload.id === id) settle(event.payload.result);
        });
        // Rust injects the caller's window label. A frontend event cannot authenticate a sender.
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("plugin_panel_action_forward", { request: envelope });
      } catch {
        settle({ ok: false, reason: "unavailable" });
      }
    } else {
      window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_ACTION_EVENT, { detail: envelope }));
    }
    return await answer;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unlistenDom?.();
    unlistenTauri?.();
  }
}

/** Listen in the document window for requests from detached panels (or the web-build fallback). */
export function listenForPluginPanelActions(
  handler: (id: string, request: PluginPanelActionRequest & { panelId: string }, sourceLabel?: string) => void
): () => void {
  let stopped = false;
  let unlistenTauri: (() => void) | undefined;
  const nativeHost = isTauriHost();
  const receive = (payload: unknown, native: boolean) => {
    if (stopped || !isPluginPanelActionEnvelope(payload)) return;
    if (native) {
      const sourceLabel = (payload as PluginPanelActionEnvelope & { sourceLabel?: unknown }).sourceLabel;
      if (typeof sourceLabel === "string") handler(payload.id, payload.request, sourceLabel);
    } else if (!nativeHost) {
      // MainWindow binds this path to its own rendered inline panel, never a claimed source label.
      handler(payload.id, payload.request);
    }
  };
  const domListener = (event: Event) => receive((event as CustomEvent<unknown>).detail, false);
  window.addEventListener(PLUGIN_PANEL_ACTION_EVENT, domListener);

  if (isTauriHost()) {
    void listenTauriEvent<unknown>(PLUGIN_PANEL_ACTION_EVENT, (event) => receive(event.payload, true))
      .then((unlisten) => {
        if (stopped) unlisten(); else unlistenTauri = unlisten;
      })
      // A partially initialised Tauri marker must not turn a best-effort listener into an
      // unhandled rejection in tests or during window teardown.
      .catch(() => undefined);
  }

  return () => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener(PLUGIN_PANEL_ACTION_EVENT, domListener);
    unlistenTauri?.();
    unlistenTauri = undefined;
  };
}

/** Return the document window's decision to the panel that initiated a request. */
export async function respondToPluginPanelAction(id: string, result: PluginPanelActionResult, sourceLabel?: string): Promise<void> {
  const envelope: PluginPanelActionResultEnvelope = { id, result: result.ok ? { ok: true } : { ok: false, reason: result.reason } };
  // The CustomEvent path keeps the web build and DOM tests independent of Tauri.
  window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_ACTION_RESULT_EVENT, { detail: envelope }));
  if (!isTauriHost() || !sourceLabel) return;
  try {
    await publishPanelWindowEvent(sourceLabel, PLUGIN_PANEL_ACTION_RESULT_EVENT, envelope);
  } catch {
    // A close racing a response is expected. The panel's timeout communicates the failure.
  }
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
  /** Desktop document label, shown when multiple tabs are open. */
  documentName?: string;
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
  | { kind: "copyMolecularInspector"; requestId?: string; text: string }
  | { kind: "changeMolecularInterpretation"; interpretationId?: string }
  | { kind: "acceptPluginProposal"; proposalId: string; requestId?: string }
  | { kind: "rejectPluginProposal"; proposalId: string; requestId?: string }
  // The document handler validates these payloads, including malformed requests it must answer.
  | { kind: "copySpectrum" | "saveBinaryFile" | "saveTextFile"; requestId: string };

/** Main → window: how a `saveTextFile` action ended, keyed to the request that asked. */
export interface AnalysisWindowSaveResult {
  requestId: string;
  result: SaveTextFileResult;
}

/** How the main window handled one Accept or Reject from the review window. `message` is plain text
 *  for the user: what was inserted, or why nothing was. */
export interface ProposalDecisionOutcome {
  ok: boolean;
  message: string;
}

/** Main → window: the outcome of an `acceptPluginProposal`/`rejectPluginProposal` action. */
export interface AnalysisWindowProposalResult {
  requestId: string;
  proposal: ProposalDecisionOutcome;
}

/** Main → window: whether a `copyMolecularInspector` action actually reached the clipboard. */
export interface AnalysisWindowCopyResult {
  requestId: string;
  ok: boolean;
}

export interface OpenPluginPanelRequest extends PluginPanelIdentity {
  title: string;
  width?: number;
  height?: number;
  /** @deprecated Ignored for legacy callers. Only trusted input/text selection leases take focus. */
  focus?: boolean;
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

/** True inside a detached `plugin-panel-*` webview (the route Rust builds as `?window=pluginPanel`). */
export function isPluginPanelWindowRoute(): boolean {
  return new URLSearchParams(globalThis.location?.search ?? "").get("window") === "pluginPanel";
}

/** Detached panels have no generic event-emission grant: Rust allowlists their legacy bridges. */
async function emitPanelEvent(event: string, payload: unknown): Promise<void> {
  if (isTauriHost() && isPluginPanelWindowRoute()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("plugin_panel_event_forward", { event, payload });
  } else {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(event, payload);
  }
}

/** Deliver only into the recipient webview; Tauri targeted events also reach Any listeners. */
async function publishPanelWindowEvent(targetLabel: string, event: string, payload: unknown): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_plugin_panel_window", { publication: { targetLabel, event, payload } });
}

async function listenForPanelResult(handler: (payload: unknown) => void): Promise<() => void> {
  const domListener = (event: Event) => handler((event as CustomEvent<unknown>).detail);
  window.addEventListener(ANALYSIS_WINDOW_ACTION_RESULT_EVENT, domListener);
  const stop = attachTauriListener(
    ANALYSIS_WINDOW_ACTION_RESULT_EVENT,
    domListener,
    (payload): payload is AnalysisWindowSaveResult | AnalysisWindowCopyResult | AnalysisWindowProposalResult =>
      isSaveResult(payload) || isCopyResult(payload) || isProposalResult(payload),
    handler
  );
  try {
    await stop.ready;
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}

/** Panels request a format; the document window owns save metadata and validation. */
export function requestSaveTextFileFromMain(
  filename: string,
  text: string,
  format: SpectrumSaveFormat
): Promise<SaveTextFileResult> {
  return requestSpectrumWindowAction(
    { kind: "saveTextFile", filename, text, format },
    "failed", isSaveResult, (reply) => reply.result, 120_000
  );
}

/** Main → window: answer a `saveTextFile` action. */
export async function respondToSaveTextFile(requestId: string, result: SaveTextFileResult, sourceLabel?: string): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }
  if (!sourceLabel) return;
  await publishPanelWindowEvent(sourceLabel, ANALYSIS_WINDOW_ACTION_RESULT_EVENT, { requestId, result });
}

/** Detached panels never receive clipboard or filesystem permission. Subscribe before forwarding. */
export function requestCopySpectrumFromMain(pngBase64: string, svg: string): Promise<boolean> {
  return requestSpectrumWindowAction({ kind: "copySpectrum", pngBase64, svg }, false, isCopyResult, (reply) => reply.ok, 10_000);
}

export function requestSaveBinaryFileFromMain(
  filename: string,
  bytesBase64: string,
  format: SpectrumSaveFormat
): Promise<SaveTextFileResult> {
  return requestSpectrumWindowAction(
    { kind: "saveBinaryFile", filename, bytesBase64, format },
    "failed", isSaveResult, (reply) => reply.result, 120_000
  );
}

async function requestSpectrumWindowAction<TReply extends { requestId: string }, TResult>(
  action: Record<string, unknown>,
  failure: TResult,
  validateReply: (payload: unknown) => payload is TReply,
  readReply: (reply: TReply) => TResult,
  timeoutMs: number
): Promise<TResult> {
  if (!isDesktopRuntime()) return failure;
  const requestId = `spectrum-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let unlisten: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let answer: (result: TResult) => void = () => undefined;
    const answered = new Promise<TResult>((resolve) => { answer = resolve; });
    unlisten = await listenForPanelResult((payload) => {
      if (validateReply(payload) && payload.requestId === requestId) answer(readReply(payload));
    });
    timer = setTimeout(() => answer(failure), timeoutMs);
    await emitPanelEvent(ANALYSIS_WINDOW_ACTION_EVENT, { ...action, requestId });
    return await answered;
  } catch {
    return failure;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unlisten?.();
  }
}

/** How long the review window waits for the main window to answer an Accept or Reject. */
export const PROPOSAL_DECISION_TIMEOUT_MS = 10_000;

/**
 * Window → main: accept or reject a queued proposal, and resolve with what the main window did.
 *
 * The review window used to fire the action and forget it, so an Accept that never reached the main
 * window, or reached it and failed, looked exactly like a button that does nothing. Every outcome now
 * comes back — inserted, refused with a reason, already resolved — and silence becomes a message too.
 */
export async function requestProposalDecision(
  decision: "accept" | "reject",
  proposalId: string,
  timeoutMs: number = PROPOSAL_DECISION_TIMEOUT_MS
): Promise<ProposalDecisionOutcome> {
  const kind = decision === "accept" ? "acceptPluginProposal" : "rejectPluginProposal";
  if (!isDesktopRuntime()) {
    // The in-app build: the document lives in this same window and reports in its own status line.
    window.dispatchEvent(new CustomEvent(ANALYSIS_WINDOW_ACTION_EVENT, { detail: { kind, proposalId } }));
    return { ok: true, message: "" };
  }
  const requestId = `proposal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let unlisten: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let answer: (outcome: ProposalDecisionOutcome) => void = () => undefined;
    const answered = new Promise<ProposalDecisionOutcome>((resolve) => {
      answer = resolve;
    });
    unlisten = await listenForPanelResult((payload) => {
      if (isProposalResult(payload) && payload.requestId === requestId) {
        answer(payload.proposal);
      }
    });
    timer = setTimeout(
      () =>
        answer({
          ok: false,
          message: `The document window did not answer the ${decision === "accept" ? "Accept" : "Reject"}. Nothing has changed yet; try again.`
        }),
      timeoutMs
    );
    await emitPanelEvent(ANALYSIS_WINDOW_ACTION_EVENT, { kind, proposalId, requestId });
    return await answered;
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach the document window: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unlisten?.();
  }
}

/** Main → window: answer an `acceptPluginProposal`/`rejectPluginProposal` action. */
export async function respondToProposalDecision(requestId: string, outcome: ProposalDecisionOutcome, sourceLabel?: string): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }
  if (!sourceLabel) return;
  await publishPanelWindowEvent(sourceLabel, ANALYSIS_WINDOW_ACTION_RESULT_EVENT, {
    requestId,
    proposal: { ok: outcome.ok, message: outcome.message }
  });
}

/**
 * Window → main: copy host-rendered analysis text through the main window's native clipboard, and
 * resolve with whether it actually landed.
 *
 * Report windows hold no clipboard permission of their own; the main window performs the write and
 * this returns its real outcome, so the floating window's "Copied" label can say "Copy failed"
 * instead of claiming success regardless (mirrors `requestSaveTextFileFromMain`).
 */
export async function requestCopyAnalysisText(text: string): Promise<boolean> {
  if (!isDesktopRuntime()) {
    return false;
  }
  const requestId = `copy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let unlisten: (() => void) | undefined;
  try {
    let answer: (ok: boolean) => void = () => undefined;
    const answered = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    unlisten = await listenForPanelResult((payload) => {
      if (isCopyResult(payload) && payload.requestId === requestId) {
        answer(payload.ok);
      }
    });
    await emitPanelEvent(ANALYSIS_WINDOW_ACTION_EVENT, { kind: "copyMolecularInspector", requestId, text });
    return await answered;
  } catch {
    return false;
  } finally {
    unlisten?.();
  }
}

/** Compatibility name for the inspector's original caller. Both use the same host clipboard path. */
export const requestCopyMolecularInspectorText = requestCopyAnalysisText;

/** Main → window: answer a `copyMolecularInspector` action. */
export async function respondToCopyMolecularInspector(requestId: string, ok: boolean, sourceLabel?: string): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }
  if (!sourceLabel) return;
  await publishPanelWindowEvent(sourceLabel, ANALYSIS_WINDOW_ACTION_RESULT_EVENT, { requestId, ok });
}

export async function broadcastPluginPanelReport(payload: PluginPanelReportPayload): Promise<void> {
  window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_REPORT_EVENT, { detail: payload }));
  if (!isDesktopRuntime()) {
    return;
  }

  await publishPanelWindowEvent(pluginPanelWindowLabel(payload), PLUGIN_PANEL_REPORT_EVENT, payload);
}

export async function broadcastAnalysisWindowSnapshot(payload: AnalysisWindowSnapshotPayload): Promise<void> {
  window.dispatchEvent(new CustomEvent(ANALYSIS_WINDOW_SNAPSHOT_EVENT, { detail: payload }));
  if (!isDesktopRuntime()) {
    return;
  }

  await publishPanelWindowEvent(pluginPanelWindowLabel(payload), ANALYSIS_WINDOW_SNAPSHOT_EVENT, payload);
}

export function listenForAnalysisWindowSnapshots(
  handler: (payload: AnalysisWindowSnapshotPayload) => void
): PanelBridgeListener {
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

  await emitPanelEvent(ANALYSIS_WINDOW_ACTION_EVENT, action);
}

export function listenForAnalysisWindowActions(
  handler: (action: AnalysisWindowAction, sourceLabel?: string) => void
): () => void {
  const nativeHost = isTauriHost();
  const domListener = (event: Event) => {
    const payload = (event as CustomEvent<unknown>).detail;
    if (!nativeHost && isAnalysisWindowAction(payload)) handler(payload);
  };
  window.addEventListener(ANALYSIS_WINDOW_ACTION_EVENT, domListener);
  return attachTauriListener(ANALYSIS_WINDOW_ACTION_EVENT, domListener, isAnalysisWindowAction, (action) => {
    const sourceLabel = (action as AnalysisWindowAction & { sourceLabel?: unknown }).sourceLabel;
    if (typeof sourceLabel === "string") handler(action, sourceLabel);
    else console.warn("Rejected analysis window action without a native source", action.kind);
  });
}

export function listenForPluginPanelReports(
  handler: (payload: PluginPanelReportPayload) => void
): PanelBridgeListener {
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

  await emitPanelEvent(PLUGIN_PANEL_REQUEST_EVENT, identity);
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
  const window = await WebviewWindow.getByLabel(
    `${PLUGIN_PANEL_WINDOW_LABEL_PREFIX}${pluginPanelWindowId(pluginId, panelId)}`
  );
  await window?.hide();
}

export async function broadcastPluginPanelStaleness(payload: PluginPanelStalenessPayload): Promise<void> {
  window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_STALENESS_EVENT, { detail: payload }));
  if (!isDesktopRuntime()) {
    return;
  }

  await publishPanelWindowEvent(pluginPanelWindowLabel(payload), PLUGIN_PANEL_STALENESS_EVENT, payload);
}

export function listenForPluginPanelStaleness(
  handler: (payload: PluginPanelStalenessPayload) => void
): PanelBridgeListener {
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

  await emitPanelEvent(PLUGIN_PANEL_RERUN_EVENT, identity);
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

  await emitPanelEvent(PLUGIN_PANEL_CLOSED_EVENT, identity);
}

export function listenForPluginPanelCloses(handler: (identity: PluginPanelIdentity) => void): () => void {
  return listenForPanelIdentityEvent(PLUGIN_PANEL_CLOSED_EVENT, handler);
}

/**
 * Native → main: a panel window was closed through the OS — Window ▸ Close Window or ⌘W — rather than
 * its own close control. The host hides it instead of destroying it and sends its label; the handler
 * gets the panel, so the main window can take the same close path as the window's own button.
 */
export function listenForNativePanelWindowCloses(handler: (identity: PluginPanelIdentity) => void): () => void {
  const deliver = (label: string): void => {
    const identity = pluginPanelIdentityFromWindowLabel(label);
    if (identity) handler(identity);
  };
  const domListener = (event: Event) => {
    const label = (event as CustomEvent<unknown>).detail;
    if (typeof label === "string") deliver(label);
  };
  window.addEventListener(PLUGIN_PANEL_WINDOW_CLOSED_EVENT, domListener);
  return attachTauriListener(
    PLUGIN_PANEL_WINDOW_CLOSED_EVENT,
    domListener,
    (payload): payload is string => typeof payload === "string",
    deliver
  );
}

/** The panel behind a native `plugin-panel-<windowId>` label, for the app's own encoded ids only. */
export function pluginPanelIdentityFromWindowLabel(label: string): PluginPanelIdentity | undefined {
  return label.startsWith(PLUGIN_PANEL_WINDOW_LABEL_PREFIX)
    ? parsePluginPanelWindowId(label.slice(PLUGIN_PANEL_WINDOW_LABEL_PREFIX.length))
    : undefined;
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
 * before it can become an orphan. The separate readiness promise lets a receiving page request a
 * replay AFTER native subscription; installing the synchronous DOM listener alone is not enough.
 */
function attachTauriListener<T>(
  eventName: string,
  domListener: EventListener,
  validate: (payload: unknown) => payload is T,
  handler: (payload: T) => void
): PanelBridgeListener {
  let cancelled = false;
  let unlistenTauri: (() => void) | undefined;
  let ready = Promise.resolve();

  if (isDesktopRuntime()) {
    ready = listenTauriEvent<T>(eventName, (event) => {
      if (!cancelled && validate(event.payload)) {
        handler(event.payload);
      }
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          unlistenTauri = unlisten;
        }
      });
    // Existing fire-and-forget consumers still own cleanup synchronously. Readiness consumers
    // receive the original rejection and must not announce readiness if attachment failed.
    void ready.catch(() => undefined);
  }

  const stop = () => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    window.removeEventListener(eventName, domListener);
    unlistenTauri?.();
    unlistenTauri = undefined;
  };
  return Object.assign(stop, { ready });
}

/** Stable in-memory key for a panel owned by one plugin. */
export function pluginPanelIdentityKey(pluginId: string, panelId: string): string {
  return `${pluginId.length}:${pluginId}${panelId}`;
}

/** Reversible, native-label-safe identity passed through Rust's existing `panelId` field. */
export function pluginPanelWindowId(pluginId: string, panelId: string): string {
  return `v1x${encodeHex(pluginId)}x${encodeHex(panelId)}`;
}

/** The exact native destination shared by reports, snapshots, and action authorization. */
export function pluginPanelWindowLabel(identity: PluginPanelIdentity): string {
  return `${PLUGIN_PANEL_WINDOW_LABEL_PREFIX}${pluginPanelWindowId(identity.pluginId, identity.panelId)}`;
}

/** Decode only the native panel label scheme used by openPluginPanelWindow and lib.rs. */
export function parsePluginPanelWindowLabel(label: string): PluginPanelIdentity | undefined {
  if (!label.startsWith(PLUGIN_PANEL_WINDOW_LABEL_PREFIX)) return undefined;
  return parsePluginPanelWindowId(label.slice(PLUGIN_PANEL_WINDOW_LABEL_PREFIX.length));
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

function isPluginPanelActionEnvelope(payload: unknown): payload is PluginPanelActionEnvelope {
  if (typeof payload !== "object" || payload === null) return false;
  const candidate = payload as Partial<PluginPanelActionEnvelope>;
  return typeof candidate.id === "string" && isPluginPanelActionRequest(candidate.request);
}

function isPluginPanelActionRequest(payload: unknown): payload is PluginPanelActionRequest & { panelId: string } {
  if (typeof payload !== "object" || payload === null) return false;
  const candidate = payload as Partial<PluginPanelActionRequest & { panelId: unknown }>;
  return (
    typeof candidate.panelId === "string" &&
    typeof candidate.sectionId === "string" &&
    (candidate.control === "prompt" || candidate.control === "select" || candidate.control === "button") &&
    (candidate.controlId === undefined || typeof candidate.controlId === "string") &&
    (candidate.text === undefined || typeof candidate.text === "string") &&
    (candidate.selected === undefined || typeof candidate.selected === "string")
  );
}

function isPluginPanelActionResultEnvelope(payload: unknown): payload is PluginPanelActionResultEnvelope {
  if (typeof payload !== "object" || payload === null) return false;
  const candidate = payload as Partial<PluginPanelActionResultEnvelope>;
  if (typeof candidate.id !== "string" || typeof candidate.result !== "object" || candidate.result === null) return false;
  const result = candidate.result as Partial<PluginPanelActionResult>;
  return result.ok === true || (result.ok === false && typeof result.reason === "string");
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
      return (
        (candidate.requestId === undefined || typeof candidate.requestId === "string") &&
        typeof candidate.text === "string"
      );
    case "changeMolecularInterpretation":
      return candidate.interpretationId === undefined || typeof candidate.interpretationId === "string";
    case "acceptPluginProposal":
    case "rejectPluginProposal":
      return (
        typeof candidate.proposalId === "string" &&
        (candidate.requestId === undefined || typeof candidate.requestId === "string")
      );
    case "saveTextFile":
    case "copySpectrum":
    case "saveBinaryFile":
      // Forward malformed data to the bounded document handler so the requester gets a failure.
      return typeof candidate.requestId === "string" && candidate.requestId.length > 0 && candidate.requestId.length <= 200;
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

/** Distinguished from a save result by shape (`ok` vs. `result`) on the same shared result event. */
function isCopyResult(payload: unknown): payload is AnalysisWindowCopyResult {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as Partial<AnalysisWindowCopyResult>;
  return typeof candidate.requestId === "string" && typeof candidate.ok === "boolean";
}

/** Distinguished from save and copy results by its `proposal` object on the same shared result event. */
function isProposalResult(payload: unknown): payload is AnalysisWindowProposalResult {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as Partial<AnalysisWindowProposalResult>;
  return (
    typeof candidate.requestId === "string" &&
    typeof candidate.proposal === "object" &&
    candidate.proposal !== null &&
    typeof candidate.proposal.ok === "boolean" &&
    typeof candidate.proposal.message === "string"
  );
}
