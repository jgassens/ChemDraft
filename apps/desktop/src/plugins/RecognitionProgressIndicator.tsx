import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";

import type { RecognitionActivity } from "./StructureRecognitionController";

/** What the indicator reads: the recognition controller, or a stand-in in tests. */
export interface RecognitionActivitySource {
  getActiveRecognition(): RecognitionActivity | undefined;
  subscribeActivity(listener: () => void): () => void;
}

export interface RecognitionProgressIndicatorProps {
  source: RecognitionActivitySource;
  onCancel: (id: number) => void;
  /** The clock the elapsed time is measured with; the controller's `startedAt` uses the same one. */
  now?: () => number;
}

/**
 * A small status card shown while an image is being recognized. It is deliberately not a dialog:
 * it takes no focus, traps nothing and covers only its own corner, so the user keeps drawing. Only
 * the stage line is a live region; the elapsed time ticks every second and would otherwise be read
 * out every second.
 */
export function RecognitionProgressIndicator({ source, onCancel, now = Date.now }: RecognitionProgressIndicatorProps) {
  const subscribe = useCallback((listener: () => void) => source.subscribeActivity(listener), [source]);
  const activity = useSyncExternalStore(subscribe, () => source.getActiveRecognition());
  const titleId = useId();
  if (!activity) return null;
  return <IndicatorCard key={activity.id} activity={activity} titleId={titleId} onCancel={onCancel} now={now} />;
}

function IndicatorCard({
  activity,
  titleId,
  onCancel,
  now
}: {
  activity: RecognitionActivity;
  titleId: string;
  onCancel: (id: number) => void;
  now: () => number;
}) {
  const elapsedMs = useElapsed(activity.startedAt, now);
  const reading = activity.stage === "reading" ? activity.reading : undefined;
  return (
    <section className="recognition-progress" aria-labelledby={titleId} data-stage={activity.stage}>
      <div className="recognition-progress-heading">
        <span id={titleId} className="recognition-progress-title">
          Recognizing structure
        </span>
        <span className="recognition-progress-plugin">{activity.pluginName}</span>
      </div>
      <p className="recognition-progress-stage" role="status" aria-live="polite">
        {recognitionStageText(activity)}
      </p>
      {reading ? (
        <progress
          className="recognition-progress-bar"
          aria-label="Readings done"
          max={reading.runsPlanned}
          value={reading.run - 1}
        />
      ) : (
        <progress className="recognition-progress-bar" aria-label="Working" />
      )}
      <div className="recognition-progress-footer">
        <span className="recognition-progress-elapsed">
          <span className="recognition-progress-elapsed-label">Elapsed </span>
          <time dateTime={`PT${Math.floor(elapsedMs / 1000)}S`}>{formatElapsed(elapsedMs)}</time>
        </span>
        <button type="button" className="plugin-manager-button" onClick={() => onCancel(activity.id)}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** The stage in plain words. A reading count appears only when the engine reported one. */
export function recognitionStageText(activity: Pick<RecognitionActivity, "stage" | "reading">): string {
  switch (activity.stage) {
    case "checking":
      return "Checking the recognition engine…";
    case "starting":
      return "Starting the recognition engine…";
    case "reading":
      return activity.reading
        ? `Reading the structure… (reading ${activity.reading.run} of ${activity.reading.runsPlanned})`
        : "Reading the structure…";
    case "validating":
      return "Checking the result…";
  }
}

/** m:ss, then h:mm:ss past an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function useElapsed(startedAt: number, now: () => number): number {
  const [current, setCurrent] = useState(() => now());
  useEffect(() => {
    setCurrent(now());
    const timer = setInterval(() => setCurrent(now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt, now]);
  return current - startedAt;
}
