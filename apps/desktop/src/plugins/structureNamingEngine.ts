import { Channel, invoke } from "@tauri-apps/api/core";
import type { OrthonymRawResult } from "@chemdraft/document-workflow-core";
import type { StructureRecognitionEngineState, StructureRecognitionInstallProgress, StructureRecognitionInstallError } from "./structureRecognitionEngine";

// Both native adapters use local_engine's install events and errors.
export type StructureNamingInstallProgress = StructureRecognitionInstallProgress;
export type StructureNamingInstallError = StructureRecognitionInstallError;
export interface InstalledStructureNamingEngine {
  receiptVersion: number;
  engineDir: string;
  uvVersion: string;
  uvAsset: string;
  uvSha256: string;
  pythonVersion: string;
  orthonymVersion: string;
  orthonymCommit: string;
  orthonymWheelSha256: string;
  requirementsSha256: string;
  centresUrl: string;
  centresBytes: number;
  centresSha256: string;
  installedAt: string;
  diskBytes: number;
}
export interface StructureNamingEngineStatus {
  state: StructureRecognitionEngineState;
  installed?: InstalledStructureNamingEngine;
  requiredDiskBytes: number;
  freeDiskBytes: number;
  detail?: string;
  progress?: StructureNamingInstallProgress;
  installElapsedMs?: number;
}
export interface StructureNamingRawResult extends OrthonymRawResult {
  elapsedMs: number;
  opsinReadBack: { smiles: string | null; failureReason: string | null } | null;
}
export interface StructureNamingEngine {
  status(): Promise<StructureNamingEngineStatus>;
  install(onProgress: (progress: StructureNamingInstallProgress) => void): Promise<StructureNamingEngineStatus>;
  cancelInstall(): Promise<void>;
  uninstall(): Promise<StructureNamingEngineStatus>;
  name(smiles: string): Promise<StructureNamingRawResult>;
  /** Resolves only after the native request, including OPSIN read-back, releases its gate. */
  cancel(): Promise<void>;
}
type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export class TauriStructureNamingEngine implements StructureNamingEngine {
  constructor(private readonly call: InvokeCommand = invoke,
    private readonly channel: <T>() => { onmessage: (message: T) => void } = <T>() => new Channel<T>()) {}
  status(): Promise<StructureNamingEngineStatus> { return this.call("naming_engine_status"); }
  install(onProgress: (progress: StructureNamingInstallProgress) => void): Promise<StructureNamingEngineStatus> {
    const channel = this.channel<StructureNamingInstallProgress>();
    channel.onmessage = onProgress;
    return this.call("naming_engine_install", { onProgress: channel });
  }
  async cancelInstall(): Promise<void> { await this.call("naming_engine_cancel_install"); }
  uninstall(): Promise<StructureNamingEngineStatus> { return this.call("naming_engine_uninstall"); }
  name(smiles: string): Promise<StructureNamingRawResult> { return this.call("name_structure_raw", { smiles }); }
  async cancel(): Promise<void> { await this.call("naming_cancel"); }
}
