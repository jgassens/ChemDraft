import { useEffect, useMemo, useState } from "react";
import {
  appendSpin3dTraceEvent,
  computedSpin3dTraceStatus,
  listenForSpin3dTraceEvents,
  mergeSpin3dTraceRows,
  spin3dTraceDuration,
  spin3dTraceNow,
  type Spin3dTraceComputedStatus,
  type Spin3dTraceEvent,
  type Spin3dTraceRow
} from "./conformerDebug";

export function Spin3dDebuggerWindow({ initialEvents = [] }: { initialEvents?: readonly Spin3dTraceEvent[] }) {
  const [events, setEvents] = useState<Spin3dTraceEvent[]>(() => [...initialEvents]);
  const [now, setNow] = useState(() => spin3dTraceNow());

  useEffect(() => {
    document.documentElement.classList.add("spin3d-debugger-window-html");
    document.body.classList.add("spin3d-debugger-window-body");
    return () => {
      document.documentElement.classList.remove("spin3d-debugger-window-html");
      document.body.classList.remove("spin3d-debugger-window-body");
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForSpin3dTraceEvents((event) => {
      setEvents((current) => appendSpin3dTraceEvent(current, event));
    }).then((listener) => {
      if (disposed) {
        listener();
        return;
      }
      unlisten = listener;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(spin3dTraceNow()), 400);
    return () => window.clearInterval(timer);
  }, []);

  const rows = useMemo(() => mergeSpin3dTraceRows(events), [events]);
  const activeRow = rows.find((row) => row.status === "started");

  return (
    <main className="spin3d-debugger-shell">
      <header className="spin3d-debugger-header">
        <div>
          <h1>3D Debugger</h1>
          <p>{activeRow ? activeStageLabel(activeRow, now) : "Idle"}</p>
        </div>
        <dl className="spin3d-debugger-summary">
          <div>
            <dt>Events</dt>
            <dd>{events.length}</dd>
          </div>
          <div>
            <dt>Active</dt>
            <dd>{rows.filter((row) => row.status === "started").length}</dd>
          </div>
        </dl>
      </header>

      {rows.length === 0 ? (
        <section className="spin3d-debugger-empty" aria-live="polite">
          <h2>No 3D trace events yet</h2>
          <p>Use Spin 3D on a selected molecule.</p>
        </section>
      ) : (
        <section className="spin3d-debugger-log" aria-label="3D trace log">
          <div className="spin3d-debugger-row spin3d-debugger-row-header">
            <span>Status</span>
            <span>Stage</span>
            <span>Path</span>
            <span>Time</span>
            <span>Details</span>
          </div>
          <div role="log" aria-live="polite">
            {rows.map((row) => (
              <TraceRow key={row.spanId} row={row} now={now} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function TraceRow({ row, now }: { row: Spin3dTraceRow; now: number }) {
  const status = computedSpin3dTraceStatus(row, now);
  const duration = spin3dTraceDuration(row, now);
  return (
    <article className="spin3d-debugger-row" data-status={status}>
      <span className="spin3d-debugger-status">{statusLabel(status)}</span>
      <span>
        <strong>{row.stage}</strong>
        <small>{row.kind}{row.requestId ? ` #${row.requestId}` : ""}</small>
      </span>
      <span>{row.path ?? "-"}</span>
      <span>{formatDuration(duration)}</span>
      <span>{detailText(row)}</span>
    </article>
  );
}

function activeStageLabel(row: Spin3dTraceRow, now: number): string {
  const status = computedSpin3dTraceStatus(row, now);
  return `${statusLabel(status)}: ${row.stage}`;
}

function statusLabel(status: Spin3dTraceComputedStatus): string {
  switch (status) {
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "info":
      return "Info";
    case "still-running":
      return "Still running";
    case "likely-hung":
      return "Likely hung";
    case "running":
    case "started":
      return "Running";
  }
}

function detailText(row: Spin3dTraceRow): string {
  const details = [
    row.atomCount === undefined ? undefined : `${row.atomCount} atom${row.atomCount === 1 ? "" : "s"}`,
    row.cacheStatus === undefined ? undefined : `cache ${row.cacheStatus}`,
    row.queueDepth === undefined ? undefined : `queue ${row.queueDepth}`,
    row.warningCount === undefined ? undefined : `${row.warningCount} warning${row.warningCount === 1 ? "" : "s"}`,
    row.error,
    row.message
  ].filter(Boolean);
  return details.length > 0 ? details.join(" | ") : "-";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}
