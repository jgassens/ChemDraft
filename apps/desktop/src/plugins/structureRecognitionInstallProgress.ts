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

/** Decimal gigabytes (10⁹ bytes), the same convention as {@link formatMegabytes}: disk space and
 *  download sizes in the install flow must not mix 1024³ "GB" with 10⁹ ones. */
export function formatGigabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 GB";
  const gigabytes = bytes / 1e9;
  return `${gigabytes >= 10 ? Math.round(gigabytes).toLocaleString("en-US") : gigabytes.toFixed(1).replace(/\.0$/, "")} GB`;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Where a running install is right now: what the progress display shows. */
export interface LiveRecognitionInstallProgress {
  progress?: StructureRecognitionInstallProgress;
  startedAt: number;
  phaseStartedAt: number;
}

/** What the store reads from: the recognition controller's run and its change notifications. */
export interface RecognitionInstallProgressSource {
  subscribe(listener: () => void): () => void;
  getInstallRun():
    | { running: boolean; progress?: StructureRecognitionInstallProgress; startedAt: number; phaseStartedAt: number }
    | undefined;
}

/**
 * The live progress of the running engine install, kept apart from the plugin runtime's shared
 * version. An install sends progress several times a second for ten minutes; routing that through
 * the runtime re-rendered the whole main window and rebuilt the native menu bar on every event. Only
 * the progress display subscribes here (`useSyncExternalStore`), so only it re-renders.
 *
 * Module-level because the one desktop runtime is created once and the progress display is rendered
 * by windows that receive only plain props. The latest connection wins; disconnecting clears it.
 */
export class RecognitionInstallProgressStore {
  private source: RecognitionInstallProgressSource | undefined;
  private unsubscribeSource: (() => void) | undefined;
  private snapshot: LiveRecognitionInstallProgress | undefined;
  private readonly listeners = new Set<() => void>();

  connect(source: RecognitionInstallProgressSource): () => void {
    this.unsubscribeSource?.();
    this.source = source;
    this.unsubscribeSource = source.subscribe(() => this.refresh());
    this.refresh();
    return () => {
      if (this.source !== source) return;
      this.unsubscribeSource?.();
      this.unsubscribeSource = undefined;
      this.source = undefined;
      this.refresh();
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable between changes, as `useSyncExternalStore` requires. Undefined when nothing is running. */
  readonly getSnapshot = (): LiveRecognitionInstallProgress | undefined => this.snapshot;

  private refresh(): void {
    const run = this.source?.getInstallRun();
    const next: LiveRecognitionInstallProgress | undefined = run?.running
      ? { progress: run.progress, startedAt: run.startedAt, phaseStartedAt: run.phaseStartedAt }
      : undefined;
    if (sameLiveProgress(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export const recognitionInstallProgressStore = new RecognitionInstallProgressStore();

function sameLiveProgress(
  a: LiveRecognitionInstallProgress | undefined,
  b: LiveRecognitionInstallProgress | undefined
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.startedAt === b.startedAt &&
    a.phaseStartedAt === b.phaseStartedAt &&
    a.progress?.phase === b.progress?.phase &&
    a.progress?.message === b.progress?.message &&
    a.progress?.bytesDone === b.progress?.bytesDone &&
    a.progress?.bytesTotal === b.progress?.bytesTotal &&
    a.progress?.estimated === b.progress?.estimated
  );
}

