import { useEffect, useState } from "react";

import type { StructureRecognitionInstallProgress } from "./structureRecognitionEngine";
import { describeRecognitionInstall, formatMegabytes } from "./structureRecognitionInstallProgress";

export interface RecognitionInstallProgressProps {
  progress?: StructureRecognitionInstallProgress;
  startedAt?: number;
  phaseStartedAt?: number;
}

/**
 * The one progress display for a recognition-engine install, used by the first-use install dialog
 * and by the plugin manager. It never goes blank: every phase shows its step, the overall bar, and
 * either a byte bar or a time estimate, with the elapsed time ticking once a second.
 */
export function RecognitionInstallProgress({ progress, startedAt, phaseStartedAt }: RecognitionInstallProgressProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const view = describeRecognitionInstall(progress, { now, startedAt, phaseStartedAt });
  const percent = Math.round(view.overallFraction * 100);
  const step = view.step;
  return (
    <div className="recognition-install-progress" data-testid="recognition-install-progress">
      <p aria-live="polite" className="recognition-install-step" data-testid="recognition-install-step">
        Step {view.stepNumber} of {view.stepCount}: {view.stepName}
      </p>
      <progress
        aria-label="Overall install progress"
        data-testid="recognition-install-overall"
        max={100}
        value={percent}
      />
      <p className="recognition-install-caption" data-testid="recognition-install-overall-text">
        {percent}% overall · Elapsed {view.elapsedText}
      </p>
      {step.kind === "bytes" ? (
        <>
          <progress
            aria-label="Current step progress"
            data-testid="recognition-install-phase"
            max={step.total}
            value={step.done}
          />
          <p className="recognition-install-caption" data-testid="recognition-install-phase-text">
            {step.estimated
              ? `About ${formatMegabytes(step.done)} of ${formatMegabytes(step.total)} (estimated)`
              : `${formatMegabytes(step.done)} of ${formatMegabytes(step.total)}`}
          </p>
        </>
      ) : (
        <>
          <progress aria-label="Current step progress" data-testid="recognition-install-phase" />
          <p className="recognition-install-caption" data-testid="recognition-install-phase-text">
            {step.text}
          </p>
        </>
      )}
    </div>
  );
}
