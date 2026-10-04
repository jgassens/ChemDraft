import { useEffect, useRef, useState } from "react";

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
 * earlier with its close button, and a later successful run of the same analyzer clears it. The
 * countdown is held while the notice is hovered or focused, and restarts in full when that ends.
 */
export function analyzerNoticeDurationMs(message: string): number {
  // Reading time: a base long enough to notice the corner at all, plus ~60 ms per character, capped so
  // a long plugin error does not cover the canvas corner after the user has moved on.
  return Math.min(12_000, 4_000 + message.length * 60);
}

export function AnalyzerNoticeBanner({
  notice,
  onDismiss
}: {
  notice: AnalyzerNotice | undefined;
  onDismiss(id: number): void;
}) {
  // Keyed by id: hover and focus belong to one notice. A notice dismissed under the pointer never sees
  // its mouseleave, and an instance reused for the next notice would hold that one's timer forever.
  return notice ? <AnalyzerNoticeBody key={notice.id} notice={notice} onDismiss={onDismiss} /> : null;
}

function AnalyzerNoticeBody({ notice, onDismiss }: { notice: AnalyzerNotice; onDismiss(id: number): void }) {
  // The parent re-renders constantly (every document change); only a new notice may restart the timer.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const { id, message } = notice;
  // A notice that removes itself must not do so while someone is reading it (WCAG 2.2.1).
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(() => onDismissRef.current(id), analyzerNoticeDurationMs(message));
    return () => clearTimeout(timer);
  }, [id, message, held]);

  return (
    <div
      className="analyzer-notice"
      role="alert"
      data-analyzer-notice={notice.pluginId}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
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
