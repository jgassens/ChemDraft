import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { JournalRequest } from "@chemdraft/chem-core";
import type { ExportPreviewResult } from "../dialogs/exportOptions";
const Form = lazy(() => import("./JournalPresetForm").then(module => ({ default: module.JournalPresetForm })));
/** The browser has no native windows. Desktop never uses this fallback. */
export function JournalPresetsBrowser({ title, selectionCount, renderPreview, onApply, onCancel }: {
  title: string; selectionCount: number;
  renderPreview(request: JournalRequest, signal: AbortSignal): Promise<ExportPreviewResult>;
  onApply(request: JournalRequest): Promise<void>; onCancel(): void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const pending = useRef(false), focus = useRef(document.activeElement);
  useEffect(() => () => { if (focus.current instanceof HTMLElement && focus.current.isConnected) focus.current.focus(); }, []);
  return <div className="journal-preset-browser" role="presentation"><Suspense fallback={<p>Opening Journal Presets…</p>}><Form
    title={title} selectionCount={selectionCount} renderPreview={renderPreview} busy={busy} error={error} onCancel={onCancel}
    onApply={request => {
      if (pending.current) return;
      pending.current = true; setBusy(true); setError(undefined);
      void onApply(request).catch(error => { pending.current = false; setBusy(false); setError(String(error)); });
    }} /></Suspense></div>;
}
