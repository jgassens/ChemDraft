import { Channel, invoke } from "@tauri-apps/api/core";

export type StructureRecognitionEngineState =
  | "notInstalled"
  | "installing"
  | "installed"
  | "broken"
  | "unsupported";

export interface InstalledStructureRecognitionEngine {
  uvVersion: string;
  pythonVersion: string;
  molscribeCommit: string;
  modelSha256: string;
  installedAt: string;
  diskBytes: number;
}

export interface StructureRecognitionEngineStatus {
  state: StructureRecognitionEngineState;
  installed?: InstalledStructureRecognitionEngine;
  requiredDiskBytes: number;
  freeDiskBytes: number;
  detail?: string;
  /** While `installing`: the host's latest progress event, so a window that did not start the
   *  install — or was closed and reopened — can show where it is. */
  progress?: StructureRecognitionInstallProgress;
  /** While `installing`: milliseconds since the install started. */
  installElapsedMs?: number;
  /** While `installing`: what runs is the one-time check of an engine already on disk (after an app
   *  update), not a download. Recognition waits for it behind its progress indicator instead of
   *  opening the install dialog. Absent when false. */
  engineCheck?: boolean;
}

export type StructureRecognitionInstallPhase =
  | "checkingDisk"
  | "downloadingUv"
  | "installingPython"
  | "installingPackages"
  | "downloadingModel"
  | "verifying"
  | "done";

export interface StructureRecognitionInstallProgress {
  phase: StructureRecognitionInstallPhase;
  message: string;
  bytesDone?: number;
  bytesTotal?: number;
  /** The byte counts are the host's estimate from directory growth (uv reports none), not a
   *  transfer count. They stay below the total until the step finishes. */
  estimated?: boolean;
}

export type StructureRecognitionInstallErrorCode =
  | "insufficientDisk"
  | "network"
  | "checksumMismatch"
  | "cancelled"
  | "unsupported"
  | "failed";

export interface StructureRecognitionInstallError {
  code: StructureRecognitionInstallErrorCode;
  message: string;
}

export interface StructureRecognitionAtom {
  index: number;
  symbol: string;
  x: number;
  y: number;
  confidence: number;
}

export interface StructureRecognitionBond {
  begin: number;
  end: number;
  bondType: string;
  confidence: number;
}

/** How far the engine's runs agreed: the image is recognized once per size in `scalesPx` (the longer
 * side, in pixels) and the answers compared by canonical SMILES; `agreeing` counts the runs, the
 * returned one included, that gave the returned structure, and `invalidRuns` the runs whose answer
 * did not parse (they never win, but they count in `runs`). */
export interface StructureRecognitionAgreement {
  runs: number;
  agreeing: number;
  invalidRuns: number;
  scalesPx: number[];
}

export type StructureRecognitionOutcome =
  | {
      status: "recognized";
      smiles: string;
      molfile: string;
      confidence: number | null;
      atoms: StructureRecognitionAtom[];
      bonds: StructureRecognitionBond[];
      agreement: StructureRecognitionAgreement;
      elapsedMs: number;
      engine: { name: "MolScribe"; molscribeCommit: string; modelSha256: string };
    }
  | { status: "notInstalled" }
  /** The user cancelled this recognition through `cancelRecognition`. */
  | { status: "cancelled" }
  | {
      status: "failed";
      code: "invalidImage" | "recognitionFailed" | "engineCrashed" | "timeout" | "busy";
      message: string;
    };

/**
 * Where a running recognition is, as the engine reports it. Engine-neutral: any engine or platform
 * may report these stages, and one that reports nothing is still correct — the host then shows the
 * stage it knows itself.
 *
 * - `starting`: the engine is being launched and its model loaded.
 * - `reading`: reading `run` (from 1) of `runsPlanned` has started. `runsPlanned` may grow once
 *   during a request, when the engine widens its vote (MolScribe: 5, then 15).
 */
export type StructureRecognitionProgress =
  | { stage: "starting" }
  | { stage: "reading"; run: number; runsPlanned: number };

/** The only desktop seam that knows the Tauri command names. UI, plugin-host wiring, and tests depend
 * on this interface so a future engine/platform can be added without changing their callers. */
export interface StructureRecognitionEngine {
  status(): Promise<StructureRecognitionEngineStatus>;
  install(onProgress: (progress: StructureRecognitionInstallProgress) => void): Promise<StructureRecognitionEngineStatus>;
  /** Asks the host to stop its running install. Returns nothing (Rust `ocsr_engine_cancel_install`
   *  returns `()`); the install's own settlement and `status()` report what was left. */
  cancelInstall(): Promise<void>;
  uninstall(): Promise<StructureRecognitionEngineStatus>;
  /** `onProgress`, when given, hears the stages the engine reports while it works. */
  recognizeImage(
    input: { mediaType: string; bytes: Uint8Array },
    onProgress?: (progress: StructureRecognitionProgress) => void
  ): Promise<StructureRecognitionOutcome>;
  /** Stops the running recognition, which then settles as `cancelled`. Optional: an engine that
   *  cannot stop one leaves it running, and the host stops waiting for it all the same. */
  cancelRecognition?(): Promise<void>;
}

type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface ProgressChannel<T> {
  onmessage: (message: T) => void;
}

type CreateProgressChannel = <T>() => ProgressChannel<T>;

/** Exact adapter for the Rust-owned OCSR command contract. It performs no network work in
 * TypeScript; installation and recognition are both delegated to the native host. */
export class TauriStructureRecognitionEngine implements StructureRecognitionEngine {
  constructor(
    private readonly invokeCommand: InvokeCommand = invoke,
    private readonly createChannel: CreateProgressChannel = <T>() => new Channel<T>()
  ) {}

  status(): Promise<StructureRecognitionEngineStatus> {
    return this.invokeCommand("ocsr_engine_status");
  }

  install(
    onProgress: (progress: StructureRecognitionInstallProgress) => void
  ): Promise<StructureRecognitionEngineStatus> {
    const channel = this.createChannel<StructureRecognitionInstallProgress>();
    channel.onmessage = onProgress;
    return this.invokeCommand("ocsr_engine_install", { onProgress: channel });
  }

  async cancelInstall(): Promise<void> {
    await this.invokeCommand<void>("ocsr_engine_cancel_install");
  }

  uninstall(): Promise<StructureRecognitionEngineStatus> {
    return this.invokeCommand("ocsr_engine_uninstall");
  }

  recognizeImage(
    input: { mediaType: string; bytes: Uint8Array },
    onProgress?: (progress: StructureRecognitionProgress) => void
  ): Promise<StructureRecognitionOutcome> {
    const args: Record<string, unknown> = {
      mediaType: input.mediaType,
      bytesBase64: bytesToBase64(input.bytes)
    };
    if (onProgress) {
      const channel = this.createChannel<StructureRecognitionProgress>();
      channel.onmessage = onProgress;
      args.onProgress = channel;
    }
    return this.invokeCommand("ocsr_recognize_image", args);
  }

  async cancelRecognition(): Promise<void> {
    await this.invokeCommand<void>("ocsr_recognize_cancel");
  }
}

/** Browser/test fallback: the capability remains honest and opens an unsupported-state dialog instead
 * of attempting native IPC that does not exist. */
export class UnsupportedStructureRecognitionEngine implements StructureRecognitionEngine {
  private readonly unsupported: StructureRecognitionEngineStatus = {
    state: "unsupported",
    requiredDiskBytes: 0,
    freeDiskBytes: 0,
    detail: "Local MolScribe recognition is available only in a supported ChemDraft desktop build."
  };

  async status(): Promise<StructureRecognitionEngineStatus> {
    return this.unsupported;
  }
  async install(): Promise<StructureRecognitionEngineStatus> {
    throw {
      code: "unsupported",
      message: this.unsupported.detail ?? "Local MolScribe recognition is unsupported."
    } satisfies StructureRecognitionInstallError;
  }
  async cancelInstall(): Promise<void> {
    // Nothing is ever installing here.
  }
  async uninstall(): Promise<StructureRecognitionEngineStatus> {
    return this.unsupported;
  }
  /** Reports no progress: nothing ever runs here. */
  async recognizeImage(): Promise<StructureRecognitionOutcome> {
    return { status: "notInstalled" };
  }
  async cancelRecognition(): Promise<void> {
    // Nothing is ever recognizing here.
  }
}

export function isStructureRecognitionInstallError(value: unknown): value is StructureRecognitionInstallError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    typeof candidate.message === "string" &&
    ["insufficientDisk", "network", "checksumMismatch", "cancelled", "unsupported", "failed"].includes(
      String(candidate.code)
    )
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
