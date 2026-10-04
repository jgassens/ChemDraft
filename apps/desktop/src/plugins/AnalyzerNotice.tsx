import { useEffect, useRef } from "react";

/**
 * Why an analyzer run produced no report. An analyzer that refuses its input (ADR-0010: it resolves
 * `{ ok: false }` or throws) opens no window, and the status line alone was easy to miss — a refused
 * "select exactly one molecule" run was once filed as "the report window never opens". The status
 * line still carries the message; this notice is the part the user notices.
 */
export interface AnalyzerNotice {
  /** Increases per notice, so a repeat of the same refusal restarts its timer and a stale dismiss
   *  (a timer from an earlier notice) cannot clear a newer one. */
  id: number;
  pluginId: string;
  pluginName: string;
  message: string;
}

/**
 * How long a notice stays up before it dismisses itself, in milliseconds. It can always be dismissed
 * earlier with its close button, and a later successful run of the same analyzer clears it.
 */
export function analyzerNoticeDurationMs(message: string): number {
  // TODO(human)
}

export function AnalyzerNoticeBanner({
  notice,
  onDismiss
}: {
  notice: AnalyzerNotice | undefined;
  onDismiss(id: number): void;
}) {
  // The parent re-renders constantly (every document change); only a new notice may restart the timer.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const id = notice?.id;
  const message = notice?.message;
  useEffect(() => {
    if (id === undefined || message === undefined) return;
    const timer = setTimeout(() => onDismissRef.current(id), analyzerNoticeDurationMs(message));
    return () => clearTimeout(timer);
  }, [id, message]);

  if (!notice) return null;
  return (
    <div className="analyzer-notice" role="alert" data-analyzer-notice={notice.pluginId}>
      <div className="analyzer-notice-text">
        <span className="analyzer-notice-plugin">{notice.pluginName}</span>
        <span className="analyzer-notice-message">{notice.message}</span>
      </div>
      <button
        type="button"
        className="analyzer-notice-dismiss"
        aria-label="Dismiss"
        onClick={() => onDismiss(notice.id)}
      >
        ×
      </button>
    </div>
  );
}
