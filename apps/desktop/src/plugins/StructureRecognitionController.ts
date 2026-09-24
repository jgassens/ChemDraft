import type { PluginProvidedImage, PluginRecognitionResult } from "@chemdraft/plugin-api";

import {
  isStructureRecognitionInstallError,
  type StructureRecognitionEngine,
  type StructureRecognitionEngineStatus,
  type StructureRecognitionInstallError,
  type StructureRecognitionInstallProgress,
  type StructureRecognitionOutcome
} from "./structureRecognitionEngine";

export interface OpenStructureRecognitionInstall {
  id: number;
  pluginId: string;
  pluginName: string;
  status: StructureRecognitionEngineStatus;
  installing: boolean;
  progress?: StructureRecognitionInstallProgress;
  error?: StructureRecognitionInstallError;
}

interface PendingInstall extends OpenStructureRecognitionInstall {
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (installed: boolean) => void;
}

export type PrepareRecognitionResult = (
  outcome: Extract<StructureRecognitionOutcome, { status: "recognized" }>,
  image: PluginProvidedImage
) => Promise<PluginRecognitionResult>;

/** Coordinates status/install UI and inference without exposing either Tauri or download authority to
 * plugin code. One persistent instance belongs to the one persistent desktop plugin runtime. */
export class StructureRecognitionController {
  private nextId = 1;
  private pending: PendingInstall | undefined;
  private latestStatus: StructureRecognitionEngineStatus | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly engine: StructureRecognitionEngine,
    private readonly prepareResult: PrepareRecognitionResult
  ) {}

  getStatus(): StructureRecognitionEngineStatus | undefined {
    return this.latestStatus;
  }

  getOpenInstall(): OpenStructureRecognitionInstall | undefined {
    if (!this.pending) return undefined;
    const { resolve: _resolve, signal: _signal, onAbort: _onAbort, ...open } = this.pending;
    return open;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refreshStatus(): Promise<StructureRecognitionEngineStatus> {
    this.latestStatus = await this.engine.status();
    this.notify();
    return this.latestStatus;
  }

  async recognize(
    plugin: { id: string; name: string },
    image: PluginProvidedImage,
    signal: AbortSignal
  ): Promise<PluginRecognitionResult> {
    if (signal.aborted) return { status: "engineNotInstalled" };
    let status: StructureRecognitionEngineStatus;
    try {
      status = await this.refreshStatus();
    } catch (error) {
      return { status: "failed", code: "installFailed", message: `Recognition engine status failed: ${messageOf(error)}` };
    }

    if (status.state !== "installed") {
      const installed = await this.requestInstall(plugin, status, signal);
      if (!installed || signal.aborted) return { status: "engineNotInstalled" };
    }

    let outcome: StructureRecognitionOutcome;
    try {
      outcome = await this.engine.recognizeImage({ mediaType: image.mediaType, bytes: image.bytes });
    } catch (error) {
      return { status: "failed", code: "recognitionFailed", message: messageOf(error) };
    }
    if (outcome.status === "notInstalled") return { status: "engineNotInstalled" };
    if (outcome.status === "failed") return outcome;
    return this.prepareResult(outcome, image);
  }

  /** Opens the same host-owned installer from the plugin manager. */
  async manageInstall(plugin: { id: string; name: string }): Promise<boolean> {
    const status = await this.refreshStatus();
    if (status.state === "installed") return true;
    return this.requestInstall(plugin, status);
  }

  async uninstall(): Promise<StructureRecognitionEngineStatus> {
    this.latestStatus = await this.engine.uninstall();
    this.notify();
    return this.latestStatus;
  }

  async install(id: number): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.installing || pending.status.state === "unsupported") return;
    pending.installing = true;
    pending.error = undefined;
    pending.progress = { phase: "checkingDisk", message: "Checking available disk space…" };
    this.notify();
    try {
      const status = await this.engine.install((progress) => {
        if (this.pending !== pending) return;
        pending.progress = progress;
        this.notify();
      });
      if (this.pending !== pending) return;
      pending.status = status;
      this.latestStatus = status;
      if (status.state === "installed") {
        this.settle(pending, true);
      } else if (status.state === "unsupported") {
        pending.installing = false;
        this.notify();
      } else {
        pending.installing = false;
        pending.error = { code: "failed", message: status.detail ?? "The recognition engine was not installed." };
        this.notify();
      }
    } catch (error) {
      if (this.pending !== pending) return;
      const normalized = isStructureRecognitionInstallError(error)
        ? error
        : { code: "failed" as const, message: messageOf(error) };
      if (normalized.code === "cancelled") {
        this.settle(pending, false);
        return;
      }
      pending.installing = false;
      pending.error = normalized;
      if (normalized.code === "unsupported") {
        pending.status = { ...pending.status, state: "unsupported", detail: normalized.message };
        this.latestStatus = pending.status;
      }
      this.notify();
    }
  }

  async cancel(id: number): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.id !== id) return;
    if (pending.installing || pending.status.state === "installing") {
      try {
        this.latestStatus = await this.engine.cancelInstall();
      } catch {
        // Cancellation remains cancellation even when native teardown cannot return a fresh status.
      }
    }
    if (this.pending === pending) this.settle(pending, false);
  }

  decline(id: number): void {
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.installing) return;
    this.settle(pending, false);
  }

  private requestInstall(
    plugin: { id: string; name: string },
    status: StructureRecognitionEngineStatus,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.pending) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const pending: PendingInstall = {
        id: this.nextId++,
        pluginId: plugin.id,
        pluginName: plugin.name,
        status,
        installing: status.state === "installing",
        signal,
        resolve
      };
      if (signal) {
        pending.onAbort = () => void this.cancel(pending.id);
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending = pending;
      this.notify();
    });
  }

  private settle(pending: PendingInstall, installed: boolean): void {
    if (this.pending !== pending) return;
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    this.pending = undefined;
    pending.resolve(installed);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
