import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { detectDialogPlatform, dialogEnvelope, sameDialog, type DialogMessage } from "./dialogProtocol";
import { sendDialogMessage, subscribeDialogHost } from "./dialogTransport";
import { performFocusedFieldSelectAll } from "../editHistoryRouting";
import { formatPageSizeFieldValue, PageSizeForm, type PageSizeDraft } from "./PageSizeForm";
import type { ExportDialogState } from "./exportOptions";
import { exportOptions } from "./exportOptionsValidation";
const ExportForm = lazy(() => import("./ExportForm").then(module => ({ default: module.ExportForm })));

export function DialogWindow({ hostId }: { hostId: string }) {
  const [snapshot, setSnapshot] = useState<Extract<DialogMessage, { type: "snapshot" }>>();
  const [draft, setDraft] = useState<PageSizeDraft>();
  const [exportDraft, setExportDraft] = useState<ExportDialogState>();
  const [notice, setNotice] = useState<string>();
  const [exported, setExported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const actionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const actionPending = useRef(false);
  const cancellationRequested = useRef(false);
  const pendingRequestId = useRef<string | undefined>(undefined);
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
        if (!latest || message.snapshotRevision > latest.snapshotRevision) {
          setSnapshot(message);
          if (message.dialogKind === "pageSize") setDraft({ width: formatPageSizeFieldValue(message.data.width), height: formatPageSizeFieldValue(message.data.height), unit: message.data.unit });
          else setExportDraft({ ...message.data.options, busy: false });
          latest = message;
        }
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
    return () => { stopped = true; stop?.(); clearTimeout(actionTimer.current); };
  }, [hostId]);
  // React committed the form, including first-field focus. Hidden webviews suspend rAF: never wait for it.
  const reportReady = useCallback(() => {
    if (!snapshot) return;
    void sendDialogMessage(hostId, { ...dialogEnvelope(snapshot), requestId: crypto.randomUUID(), type: "ready", data: {} }).catch(e => setError(String(e)));
  }, [hostId, snapshot]);
  useEffect(() => { if (snapshot?.dialogKind === "pageSize") reportReady(); }, [snapshot, reportReady]);
  const sendAction = (data: Extract<DialogMessage, { type: "action" }>["data"]) => {
    if (!snapshot) return;
    if (data.action === "cancel") {
      cancellationRequested.current = true;
      clearTimeout(actionTimer.current);
      pendingRequestId.current = undefined;
      void sendDialogMessage(hostId, { ...dialogEnvelope(snapshot), requestId: crypto.randomUUID(), type: "action", data }).catch(e => setError(String(e)));
      return;
    }
    if (actionPending.current || cancellationRequested.current) return;
    actionPending.current = true;
    setBusy(true);
    setError(undefined); setNotice(undefined);
    const requestId = crypto.randomUUID();
    pendingRequestId.current = requestId;
    startAcceptanceDeadline();
    void sendDialogMessage(hostId, { ...dialogEnvelope(snapshot), requestId, type: "action", data }).catch(e => {
      if (cancellationRequested.current) return;
      clearTimeout(actionTimer.current); actionPending.current = false; setBusy(false); setError(String(e));
    });
  };
  if (snapshot?.dialogKind === "export" && exportDraft) return <Suspense fallback={<p role="status">Opening Export…</p>}><ExportForm title={snapshot.data.title} onReady={reportReady}
    state={{ ...exportDraft, busy: busy || exported }} onChange={setExportDraft} error={error} notice={notice} completed={exported}
    onCancel={() => sendAction({ action: "cancel" })}
    onChooseDestination={() => sendAction({ action: "chooseDestination", options: exportOptions(exportDraft) })}
    onSubmit={() => sendAction({ action: "export", options: exportOptions(exportDraft) })} /></Suspense>;
  if (!snapshot || snapshot.dialogKind !== "pageSize" || !draft) return <p role="status">{error ?? "Opening dialog…"}</p>;
  return <PageSizeForm title={snapshot.data.title} state={draft} onChange={setDraft} busy={busy} error={error}
    onCancel={() => sendAction({ action: "cancel" })} onApply={size => sendAction({ action: "apply", ...size })} />;
}
