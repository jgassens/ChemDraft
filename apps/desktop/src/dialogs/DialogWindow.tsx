import { isEditableTarget } from "../editableTarget";
import { useExportPreviewEnabled } from "./useExportPreviewEnabled";
import { perfHook, perfProbe, perfSurfaceReady } from "../perf/runtime";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { detectDialogPlatform, dialogEnvelope, sameDialog, type DialogMessage } from "./dialogProtocol";
import { sendDialogMessage, subscribeDialogHost } from "./dialogTransport";
import { performFocusedFieldSelectAll } from "../editHistoryRouting";
import { ArrangementSpacingForm } from "./ArrangementSpacingForm";
import { formatPageSizeFieldValue, PageSizeForm, type PageSizeDraft } from "./PageSizeForm";
import type { ExportDialogState, ExportOptions, ExportPreviewResult, ExportFrame } from "./exportOptions";
import { exportOptions } from "./exportOptionsValidation";
import { EngineInstallForm } from "./EngineInstallForm";
import { ToolInstallForm } from "./ToolInstallForm";
import { InsertTableForm } from "./InsertTableForm";
const ExportForm = lazy(() => import("./ExportForm").then(module => ({ default: module.ExportForm })));

export function DialogWindow({ hostId }: { hostId: string }) {
  useEffect(() => {
    const onMenu = (event: MouseEvent) => { if (!isEditableTarget(event.target)) event.preventDefault(); };
    window.document.addEventListener("contextmenu", onMenu);
    return () => window.document.removeEventListener("contextmenu", onMenu);
  }, []);
  return <DialogWindowContent hostId={hostId} />;
}

function DialogWindowContent({ hostId }: { hostId: string }) {
  const previewEnabled = useExportPreviewEnabled();
  const previewEnabledRef = useRef(previewEnabled);
  previewEnabledRef.current = previewEnabled;
  const [snapshot, setSnapshot] = useState<Extract<DialogMessage, { type: "snapshot" }>>();
  const [frame, setFrame] = useState<ExportFrame>();
  const [draft, setDraft] = useState<PageSizeDraft>();
  const [percent, setPercent] = useState(100);
  const currentPercent = useRef(percent);
  currentPercent.current = percent;
  const [preview, setPreview] = useState<string>();
  const previewRequestId = useRef<string | undefined>(undefined);
  const previewParts = useRef<{ count: number; chunks: string[] } | undefined>(undefined);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [exportDraft, setExportDraft] = useState<ExportDialogState>();
  const [notice, setNotice] = useState<string>();
  const [exported, setExported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const previewPending = useRef<{ id: string; resolve(value: ExportPreviewResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const clearPreview = () => { const pending = previewPending.current; previewPending.current = undefined; if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Preview superseded")); } };
  useEffect(() => { if (!previewEnabled) clearPreview(); }, [previewEnabled]);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const actionPending = useRef(false);
  const cancellationRequested = useRef(false);
  const pendingRequestId = useRef<string | undefined>(undefined);
  const readySession = useRef<string | undefined>(undefined);
  const startAcceptanceDeadline = () => {
    clearTimeout(actionTimer.current);
    actionTimer.current = setTimeout(() => {
      // Missing acceptance must never retry a mutation automatically. Cancel remains available.
      setError("The drawing did not acknowledge this action. Close this window to continue; the action was not retried.");
    }, 10000);
  };
  useEffect(() => {
    const preventReload = (event: KeyboardEvent) => {
      const modifier = detectDialogPlatform() === "macos" ? event.metaKey : event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "a") {
        event.preventDefault();
        performFocusedFieldSelectAll(document);
      }
      if (event.key === "F5" || (modifier && event.key.toLowerCase() === "r")) event.preventDefault();
    };
    window.addEventListener("keydown", preventReload);
    return () => window.removeEventListener("keydown", preventReload);
  }, []);
  useEffect(() => {
    let stopped = false;
    let stop: (() => void) | undefined;
    let latest: DialogMessage | undefined;
    void subscribeDialogHost(hostId, message => {
      if (stopped) return;
      if (message.type === "snapshot") {
        if (latest && (message.sessionId !== latest.sessionId || message.snapshotRevision < latest.snapshotRevision)) return;
        // Replay must not replace the user's draft at the same revision.
        if (!latest || message.snapshotRevision > latest.snapshotRevision || message.dialogKind === "engineInstall" || message.dialogKind === "toolInstall") {
          setSnapshot(message);
          if (message.dialogKind === "toolInstall" && (message.data.state.status === "failed" || message.data.state.status === "broken")) {
            clearTimeout(actionTimer.current);
            actionPending.current = false;
            pendingRequestId.current = undefined;
            setBusy(false);
          }
          if (message.dialogKind === "pageSize") setDraft({ width: formatPageSizeFieldValue(message.data.width), height: formatPageSizeFieldValue(message.data.height), unit: message.data.unit });
          else if (message.dialogKind === "arrangementSpacing") { setPercent(100); setPreview(undefined); }
          else if (message.dialogKind === "export") { setExportDraft({ ...message.data.options, busy: false }); setFrame(message.data.frame); }
          latest = message;
        }
      } else if (latest && sameDialog(message, latest) && message.type === "preview" && message.requestId === previewRequestId.current && message.data.percent === currentPercent.current && !actionPending.current) {
        if (message.data.error) { clearTimeout(previewTimer.current); setError(message.data.error); setPreview(undefined); return; }
        const { index, count, chunk } = message.data;
        if (index === 0) previewParts.current = { count, chunks: [] };
        const parts = previewParts.current;
        if (!parts || parts.count !== count || index !== parts.chunks.length) {
          clearTimeout(previewTimer.current); previewRequestId.current = undefined;
          setError("Preview delivery was incomplete. Move the slider to try again."); setPreview(undefined); return;
        }
        parts.chunks.push(chunk);
        if (parts.chunks.length === count) {
          clearTimeout(previewTimer.current); setError(undefined);
          setPreview(`data:image/svg+xml;base64,${parts.chunks.join("")}`); previewParts.current = undefined;
        }
      } else if (latest && sameDialog(message, latest) && message.type === "result" && message.data.status === "frame" && message.data.frame) {
        // Keep the newest frame even while Choose is pending. A frame may arrive before
        // the picker receipt releases actionPending; dropping it loses that revision forever.
        clearPreview();
        setFrame(message.data.frame);
      } else if (latest && sameDialog(message, latest) && message.type === "result" && message.requestId === previewPending.current?.id) {
        const pending = previewPending.current!;
        previewPending.current = undefined;
        clearTimeout(pending.timer);
        if (message.data.status === "preview" && message.data.preview) pending.resolve(message.data.preview);
        else pending.reject(new Error(message.data.error ?? "Preview unavailable"));
      } else if (!cancellationRequested.current && latest && sameDialog(message, latest) && message.type === "result" && message.requestId === pendingRequestId.current) {
        if (message.data.status === "accepted") {
          clearTimeout(actionTimer.current);
          setError(undefined);
          return;
        }
        if (message.data.status === "progress") {
          setNotice(message.data.notice);
          return;
        }
        clearTimeout(actionTimer.current);
        // A successful terminal receipt precedes native destruction. Never reopen Apply here.
        if (message.data.status !== "applied") { actionPending.current = false; setBusy(false); }
        if (message.data.status === "exported") setExported(true);
        if (message.data.status === "picked" && message.data.destinationPath && message.data.filename) {
          const { destinationPath, filename } = message.data;
          setExportDraft(current => current ? { ...current, destinationPath, filename } : current);
        }
        setNotice(message.data.notice);
        setError(message.data.error);
      }
    }).then(unlisten => { if (stopped) unlisten(); else stop = unlisten; }).catch(e => { if (!stopped) setError(String(e)); });
    return () => { stopped = true; stop?.(); clearTimeout(actionTimer.current); clearTimeout(previewTimer.current); clearPreview(); };
  }, [hostId]);
  // React committed the form, including first-field focus. Hidden webviews suspend rAF: never wait for it.
  const reportReady = useCallback(() => {
    if (!snapshot) return;
    if ((snapshot.dialogKind === "engineInstall" || snapshot.dialogKind === "toolInstall") && readySession.current === snapshot.sessionId) return;
    readySession.current = snapshot.sessionId;
    const sending = sendDialogMessage(hostId, { ...dialogEnvelope(snapshot), requestId: crypto.randomUUID(), type: "ready", data: {} });
    if (perfProbe) void sending.then(() => perfHook(() => perfSurfaceReady("main", snapshot.sessionId, "dialog-open"))).catch(() => undefined);
    void sending.catch(e => setError(String(e)));
  }, [hostId, snapshot]);
  useEffect(() => {
    if (snapshot?.dialogKind !== "arrangementSpacing") return;
    const debounce = setTimeout(() => {
      const requestId = crypto.randomUUID();
      previewRequestId.current = requestId; previewParts.current = undefined;
      clearTimeout(previewTimer.current);
      previewTimer.current = setTimeout(() => { setPreview(undefined); setError("Preview did not arrive. Move the slider to try again."); }, 10000);
      void sendDialogMessage(hostId, { ...dialogEnvelope(snapshot), requestId, type: "action", data: { action: "preview", percent } })
        .catch(e => { if (previewRequestId.current === requestId) { clearTimeout(previewTimer.current); setError(String(e)); } });
    }, percent === 100 ? 0 : 120);
    return () => { clearTimeout(debounce); clearTimeout(previewTimer.current); };
  }, [hostId, snapshot, percent]);
  useEffect(() => { if (snapshot?.dialogKind === "insertTable" || snapshot?.dialogKind === "pageSize" || snapshot?.dialogKind === "arrangementSpacing" || snapshot?.dialogKind === "engineInstall" || snapshot?.dialogKind === "toolInstall") reportReady(); }, [snapshot, reportReady]);
  const sendAction = (data: Extract<DialogMessage, { type: "action" }>["data"]) => {
    if (!snapshot) return;
    clearPreview();
    if (data.action === "cancel" || data.action === "close") {
      cancellationRequested.current = true;
      clearTimeout(actionTimer.current);
      pendingRequestId.current = undefined;
      void sendDialogMessage(hostId, { ...dialogEnvelope(snapshot), requestId: crypto.randomUUID(), type: "action", data }).catch(e => setError(String(e)));
      return;
    }
    if ((snapshot.dialogKind === "engineInstall" || snapshot.dialogKind === "toolInstall") && data.action === "cancelInstall") {
      void sendDialogMessage(hostId, { ...dialogEnvelope(snapshot), requestId: crypto.randomUUID(), type: "action", data }).catch(e => setError(String(e)));
      return;
    }
    if (actionPending.current || cancellationRequested.current) return;
    actionPending.current = true;
    setBusy(true);
    setError(undefined); setNotice(undefined);
    const requestId = crypto.randomUUID();
    pendingRequestId.current = requestId;
    if (perfProbe) {
      if (data.action === "export") perfHook(() => perfProbe?.expectCompletion("export-written", requestId));
      else if (data.action === "apply") perfHook(() => perfProbe?.expectCompletion("document-commit", requestId));
    }
    startAcceptanceDeadline();
    void sendDialogMessage(hostId, { ...dialogEnvelope(snapshot), requestId, type: "action", data }).catch(e => {
      if (cancellationRequested.current) return;
      clearTimeout(actionTimer.current); actionPending.current = false; setBusy(false); setError(String(e));
    });
  };
  if (!snapshot) return <p role="status">{error ?? "Opening dialog…"}</p>;
  if (snapshot.dialogKind === "arrangementSpacing") return <ArrangementSpacingForm {...snapshot.data} percent={percent}
    preview={preview} busy={busy} error={error} onChange={value => {
      previewRequestId.current = undefined; previewParts.current = undefined;
      setPreview(undefined); setError(undefined); setPercent(value);
    }} onCancel={() => sendAction({ action: "cancel" })} onSave={() => sendAction({ action: "apply", percent })} />;
  const renderPreview = (options: ExportOptions, signal?: AbortSignal): Promise<ExportPreviewResult> => {
    clearPreview();
    if (!previewEnabledRef.current || signal?.aborted || !snapshot || actionPending.current || cancellationRequested.current) return Promise.reject(new Error("Preview unavailable"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (previewPending.current?.id === requestId) { const pending = previewPending.current; previewPending.current = undefined; pending.reject(new Error("Preview timed out")); } }, 30000);
      const abort = () => { if (previewPending.current?.id === requestId) clearPreview(); };
      signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => { signal?.removeEventListener("abort", abort); clearTimeout(timer); };
      previewPending.current = { id: requestId, resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); }, timer };
      void sendDialogMessage(hostId, { ...dialogEnvelope(snapshot), requestId, type: "action", data: { action: "preview", options } }).catch(error => {
        if (previewPending.current?.id === requestId) { const pending = previewPending.current; previewPending.current = undefined; pending.reject(error); }
      });
    });
  };
  if (snapshot?.dialogKind === "export" && exportDraft) return <Suspense fallback={<p role="status">Opening Export…</p>}><ExportForm frame={frame} renderPreview={renderPreview} title={snapshot.data.title} onReady={reportReady}
    state={{ ...exportDraft, busy: busy || exported }} onChange={setExportDraft} error={error} notice={notice} completed={exported}
    onCancel={() => sendAction({ action: "cancel" })}
    onChooseDestination={() => sendAction({ action: "chooseDestination", options: exportOptions(exportDraft) })}
    onSubmit={() => sendAction({ action: "export", options: exportOptions(exportDraft) })} /></Suspense>;
  if (snapshot?.dialogKind === "insertTable") return <InsertTableForm key={snapshot.sessionId} title={snapshot.data.title} initial={snapshot.data}
    busy={busy} error={error} onCancel={() => sendAction({ action: "cancel" })}
    onSubmit={options => sendAction({ action: "apply", ...options })} />;
  if (snapshot?.dialogKind === "engineInstall") return <EngineInstallForm snapshot={snapshot.data} onAction={action => sendAction({ action })} busy={busy} error={error} />;
  if (snapshot?.dialogKind === "toolInstall") return <ToolInstallForm snapshot={snapshot.data} onAction={action => sendAction({ action })} busy={busy} error={error} />;
  if (!snapshot || snapshot.dialogKind !== "pageSize" || !draft) return <p role="status">{error ?? "Opening dialog…"}</p>;
  return <PageSizeForm title={snapshot.data.title} state={draft} onChange={setDraft} busy={busy} error={error}
    onCancel={() => sendAction({ action: "cancel" })} onApply={size => sendAction({ action: "apply", ...size })} />;
}
