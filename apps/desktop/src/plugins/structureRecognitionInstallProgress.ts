import type {
  StructureRecognitionInstallPhase,
  StructureRecognitionInstallProgress
} from "./structureRecognitionEngine";

/**
 * Turns the host's install events into what the install UI shows in every phase: "Step N of M",
 * one overall bar across the whole install, and a bar or an estimate for the current step.
 *
 * The overall bar weights each step by roughly how much it moves: uv ≈ 20 MB, Python ≈ 40 MB,
 * packages ≈ 1.2 GB, the model 1.13 GB, the final check a little. Weights are for the bar only and
 * are approximate; the per-step byte counts come from the host.
 */

interface PhaseInfo {
  step: number;
  name: string;
  weightBytes: number;
  /** Used only when a step reports no bytes, to say how long it usually takes. */
  typicalSeconds: number;
}

const PHASES: Record<Exclude<StructureRecognitionInstallPhase, "done">, PhaseInfo> = {
  checkingDisk: { step: 1, name: "Checking free disk space", weightBytes: 0, typicalSeconds: 2 },
  downloadingUv: { step: 1, name: "Downloading the installer", weightBytes: 20e6, typicalSeconds: 15 },
  installingPython: { step: 2, name: "Installing Python", weightBytes: 40e6, typicalSeconds: 45 },
  installingPackages: {
    step: 3,
    name: "Installing PyTorch and MolScribe",
    weightBytes: 1.2e9,
    typicalSeconds: 240
  },
  downloadingModel: {
    step: 4,
    name: "Downloading the recognition model",
    weightBytes: 1.13e9,
    typicalSeconds: 180
  },
  verifying: { step: 5, name: "Checking the installation", weightBytes: 10e6, typicalSeconds: 45 }
};

const ORDER = [
  "checkingDisk",
  "downloadingUv",
  "installingPython",
  "installingPackages",
  "downloadingModel",
  "verifying"
] as const;

export const RECOGNITION_INSTALL_STEP_COUNT = 5;

const TOTAL_WEIGHT = ORDER.reduce((sum, phase) => sum + PHASES[phase].weightBytes, 0);

/** A step that reports no bytes never fills more than this share of its overall-bar slot on time
 *  alone; only the next phase (or the end) moves the bar past it. */
const TIME_ESTIMATE_CAP = 0.9;

export type RecognitionInstallStepProgress =
  | { kind: "bytes"; done: number; total: number; estimated: boolean }
  | { kind: "estimate"; text: string };

export interface RecognitionInstallProgressView {
  stepNumber: number;
  stepCount: number;
  stepName: string;
  /** 0–1 across the whole install. */
  overallFraction: number;
  step: RecognitionInstallStepProgress;
  elapsedText: string;
}

export interface RecognitionInstallTiming {
  now: number;
  /** When the whole install started (ms since epoch). */
  startedAt?: number;
  /** When the current phase started (ms since epoch). */
  phaseStartedAt?: number;
}

export function describeRecognitionInstall(
  progress: StructureRecognitionInstallProgress | undefined,
  timing: RecognitionInstallTiming
): RecognitionInstallProgressView {
  const elapsedText = formatElapsed(timing.now - (timing.startedAt ?? timing.now));
  const phase = progress?.phase ?? "checkingDisk";
  if (phase === "done") {
    return {
      stepNumber: RECOGNITION_INSTALL_STEP_COUNT,
      stepCount: RECOGNITION_INSTALL_STEP_COUNT,
      stepName: "Finished",
      overallFraction: 1,
      step: { kind: "estimate", text: "The recognition engine is installed." },
      elapsedText
    };
  }

  const info = PHASES[phase];
  const phaseSeconds = Math.max(0, (timing.now - (timing.phaseStartedAt ?? timing.now)) / 1000);
  const hasBytes =
    progress?.bytesDone !== undefined && progress.bytesTotal !== undefined && progress.bytesTotal > 0;
  const phaseFraction = hasBytes
    ? clamp(progress!.bytesDone! / progress!.bytesTotal!)
    : Math.min(TIME_ESTIMATE_CAP, phaseSeconds / info.typicalSeconds);
  const before = ORDER.slice(0, ORDER.indexOf(phase)).reduce((sum, earlier) => sum + PHASES[earlier].weightBytes, 0);
  const overallFraction = clamp((before + info.weightBytes * phaseFraction) / TOTAL_WEIGHT);

  return {
    stepNumber: info.step,
    stepCount: RECOGNITION_INSTALL_STEP_COUNT,
    stepName: info.name,
    overallFraction,
    step: hasBytes
      ? {
          kind: "bytes",
          done: progress!.bytesDone!,
          total: progress!.bytesTotal!,
          estimated: progress!.estimated === true
        }
      : { kind: "estimate", text: timeEstimateText(info.typicalSeconds, phaseSeconds) },
    elapsedText
  };
}

function timeEstimateText(typicalSeconds: number, phaseSeconds: number): string {
  if (phaseSeconds > typicalSeconds * 1.5) {
    return "This step is taking longer than usual. It is still working.";
  }
  return `This step usually takes about ${formatDuration(typicalSeconds)}.`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Decimal megabytes, as download sizes are usually quoted. */
export function formatMegabytes(bytes: number): string {
  const megabytes = Math.max(0, bytes) / 1e6;
  return `${megabytes < 10 ? megabytes.toFixed(1).replace(/\.0$/, "") : Math.round(megabytes).toLocaleString("en-US")} MB`;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
