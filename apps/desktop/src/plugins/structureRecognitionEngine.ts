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

export type StructureRecognitionOutcome =
  | {
      status: "recognized";
      smiles: string;
      molfile: string;
      confidence: number | null;
      atoms: StructureRecognitionAtom[];
      bonds: StructureRecognitionBond[];
      elapsedMs: number;
      engine: { name: "MolScribe"; molscribeCommit: string; modelSha256: string };
    }
  | { status: "notInstalled" }
  | {
      status: "failed";
      code: "invalidImage" | "recognitionFailed" | "engineCrashed" | "timeout" | "busy";
      message: string;
    };

/** The only desktop seam that knows the Tauri command names. UI, plugin-host wiring, and tests depend
 * on this interface so a future engine/platform can be added without changing their callers. */
export interface StructureRecognitionEngine {
  status(): Promise<StructureRecognitionEngineStatus>;
  install(onProgress: (progress: StructureRecognitionInstallProgress) => void): Promise<StructureRecognitionEngineStatus>;
  cancelInstall(): Promise<StructureRecognitionEngineStatus>;
  uninstall(): Promise<StructureRecognitionEngineStatus>;
  recognizeImage(input: { mediaType: string; bytes: Uint8Array }): Promise<StructureRecognitionOutcome>;
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

  cancelInstall(): Promise<StructureRecognitionEngineStatus> {
    return this.invokeCommand("ocsr_engine_cancel_install");
  }

  uninstall(): Promise<StructureRecognitionEngineStatus> {
    return this.invokeCommand("ocsr_engine_uninstall");
  }

  recognizeImage(input: { mediaType: string; bytes: Uint8Array }): Promise<StructureRecognitionOutcome> {
    return this.invokeCommand("ocsr_recognize_image", {
      mediaType: input.mediaType,
      bytesBase64: bytesToBase64(input.bytes)
    });
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
  async cancelInstall(): Promise<StructureRecognitionEngineStatus> {
    return this.unsupported;
  }
  async uninstall(): Promise<StructureRecognitionEngineStatus> {
    return this.unsupported;
  }
  async recognizeImage(): Promise<StructureRecognitionOutcome> {
    return { status: "notInstalled" };
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
