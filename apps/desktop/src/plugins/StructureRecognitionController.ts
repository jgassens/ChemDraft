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
  /**
   * True once this dialog's own Install started the running install. A dialog that only joined an
   * install already running (started from Add or Remove Plugins, say) does not own it: closing that
   * dialog ends the plugin's request but leaves the shared install running.
   */
  ownsInstall: boolean;
  progress?: StructureRecognitionInstallProgress;
  error?: StructureRecognitionInstallError;
  /** While installing: when the install and its current phase started (ms since epoch). */
  startedAt?: number;
  phaseStartedAt?: number;
}

/**
 * The engine install currently running, or the last one that failed. It belongs to the controller —
 * not to whichever window started it — so closing and reopening Add or Remove Plugins shows the same
 * install still in progress instead of offering Install again.
 */
export interface StructureRecognitionInstallRun {
  running: boolean;
  startedAt: number;
  phaseStartedAt: number;
  progress?: StructureRecognitionInstallProgress;
  /** Set once a run has stopped without installing: failed, cancelled, or unsupported. */
  error?: StructureRecognitionInstallError;
}

interface InstallRunState extends StructureRecognitionInstallRun {
  promise: Promise<boolean>;
}

export interface StructureRecognitionControllerOptions {
  now?: () => number;
  /** How often a host-owned install this controller did not start is polled for progress. */
  followIntervalMs?: number;
}

/** How an install request ended: installed, declined (or not completed), or cancelled by the user. */
type InstallRequestOutcome = "installed" | "declined" | "cancelled";

interface PendingInstall extends OpenStructureRecognitionInstall {
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (outcome: InstallRequestOutcome) => void;
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
  private run: InstallRunState | undefined;
  private readonly listeners = new Set<() => void>();
  private presenters = 0;
  private readonly now: () => number;
  private readonly followIntervalMs: number;

  constructor(
    private readonly engine: StructureRecognitionEngine,
    private readonly prepareResult: PrepareRecognitionResult,
    options: StructureRecognitionControllerOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.followIntervalMs = options.followIntervalMs ?? 500;
  }

  getStatus(): StructureRecognitionEngineStatus | undefined {
    return this.latestStatus;
  }

  getOpenInstall(): OpenStructureRecognitionInstall | undefined {
    if (!this.pending) return undefined;
    const { resolve: _resolve, signal: _signal, onAbort: _onAbort, ...open } = this.pending;
    const run = this.run;
    if (open.installing && run?.running) {
      return {
        ...open,
        progress: run.progress ?? open.progress,
        startedAt: run.startedAt,
        phaseStartedAt: run.phaseStartedAt
      };
    }
    return open;
  }

  /** The running engine install, or the last one that stopped without installing. */
  getInstallRun(): StructureRecognitionInstallRun | undefined {
    if (!this.run) return undefined;
    const { promise: _promise, ...run } = this.run;
    return run;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The UI that renders the install dialog attaches here for as long as it is mounted. Without one,
   * an install request has nobody to answer it, so recognition reports `engineNotInstalled` at once
   * rather than waiting on a dialog that will never appear. Detaching the last presenter ends an open
   * request the same way: nobody answered it, which is not the user cancelling. */
  attachInstallPresenter(): () => void {
    this.presenters += 1;
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.presenters -= 1;
      if (this.presenters === 0 && this.pending) void this.stop(this.pending.id, "declined");
    };
  }

  async refreshStatus(): Promise<StructureRecognitionEngineStatus> {
    const status = await this.engine.status();
    this.latestStatus = status;
    // An install is running that this controller is not driving (the page was reloaded, say).
    // Follow it through the host's progress snapshot rather than offer a second install.
    if (status.state === "installing" && !this.run?.running) this.follow(status);
    this.notify();
    return status;
  }

  /**
   * Installs the engine directly — the plugin manager's one-click path, with progress shown where
   * the user already is. Joins an install that is already running rather than starting another.
   * Resolves `true` once installed; never rejects — a failure is recorded on the run for the UI.
   */
  installEngine(): Promise<boolean> {
    if (this.run?.running) return this.run.promise;
    const now = this.now();
    const run = {
      running: true,
      startedAt: now,
      phaseStartedAt: now,
      progress: { phase: "checkingDisk", message: "Checking available disk space…" }
    } as InstallRunState;
    this.run = run;
    run.promise = this.engine
      .install((progress) => this.applyProgress(run, progress))
      .then((status): boolean => {
        this.latestStatus = status;
        if (status.state === "installed") {
          if (this.run === run) this.run = undefined;
          return true;
        }
        this.stopRun(run, {
          code: status.state === "unsupported" ? "unsupported" : "failed",
          message: status.detail ?? "The recognition engine was not installed."
        });
        return false;
      })
      .catch((error: unknown): boolean => {
        const normalized = isStructureRecognitionInstallError(error)
          ? error
          : { code: "failed" as const, message: messageOf(error) };
        if (normalized.code === "unsupported" && this.latestStatus) {
          this.latestStatus = { ...this.latestStatus, state: "unsupported", detail: normalized.message };
        }
        this.stopRun(run, normalized);
        if (normalized.code !== "unsupported") {
          // The host is no longer installing; show what it left (not installed, or the old engine).
          this.engine.status().then(
            (status) => {
              this.latestStatus = status;
              this.notify();
            },
            () => undefined
          );
        }
        return false;
      })
      .finally(() => this.notify());
    this.notify();
    return run.promise;
  }

  /** Cancels the running engine install, whoever started it. The run records the cancellation. */
  async cancelEngineInstall(): Promise<void> {
    if (!this.run?.running) return;
    await this.cancelRunningInstall();
  }

  /**
   * Asks the host to stop its install. The native command returns nothing, so its result is never
   * mistaken for a status: the run that was cancelled reports the outcome itself — the direct install's
   * rejection refreshes the status through `status()`, and a followed install's next poll reads it.
   */
  private async cancelRunningInstall(): Promise<void> {
    try {
      await this.engine.cancelInstall();
    } catch {
      // Cancellation remains cancellation even when native teardown reports an error; the run's own
      // settlement still reports what the host left behind.
    }
  }

  async recognize(
    plugin: { id: string; name: string },
    image: PluginProvidedImage,
    signal: AbortSignal
  ): Promise<PluginRecognitionResult> {
    if (signal.aborted) return { status: "cancelled" };
    let status: StructureRecognitionEngineStatus;
    try {
      status = await this.refreshStatus();
    } catch (error) {
      return { status: "failed", code: "installFailed", message: `Recognition engine status failed: ${messageOf(error)}` };
    }

    // An engine this computer cannot run is not something the user declined: offering an install
    // that can never succeed (or letting the plugin suggest one) would be a false promise.
    if (status.state === "unsupported") return unsupportedResult(status);

    if (status.state !== "installed") {
      const outcome = await this.requestInstall(plugin, status, signal);
      // A cancel or an abandoned invocation is the user's own act: the plugin stays silent. Only a
      // declined or incomplete install is `engineNotInstalled`, which a plugin may explain.
      if (outcome === "cancelled" || signal.aborted) return { status: "cancelled" };
      // The install itself found the computer unsupported (the dialog said so before closing).
      if (outcome !== "installed" && this.latestStatus?.state === "unsupported") {
        return unsupportedResult(this.latestStatus);
      }
      if (outcome !== "installed") return { status: "engineNotInstalled" };
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
    return (await this.requestInstall(plugin, status)) === "installed";
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
    // Owned only if this click starts the install; one already running (from the plugin manager) is joined.
    pending.ownsInstall = !this.run?.running;
    pending.error = undefined;
    pending.progress = { phase: "checkingDisk", message: "Checking available disk space…" };
    this.notify();
    await this.awaitRun(pending);
  }

  /** Ties an open install dialog to the shared run, so the dialog and the plugin manager always
   *  show the same install, and the dialog settles when that install ends. */
  private async awaitRun(pending: PendingInstall): Promise<void> {
    const installed = await this.installEngine();
    if (this.pending !== pending) return;
    if (installed) {
      if (this.latestStatus) pending.status = this.latestStatus;
      this.settle(pending, "installed");
      return;
    }
    const error = this.run?.error ?? { code: "failed" as const, message: "The recognition engine was not installed." };
    if (error.code === "cancelled") {
      this.settle(pending, "cancelled");
      return;
    }
    pending.installing = false;
    pending.error = error;
    if (error.code === "unsupported") {
      pending.status = { ...pending.status, state: "unsupported", detail: error.message };
      this.latestStatus = pending.status;
    }
    this.notify();
  }

  private applyProgress(run: InstallRunState, progress: StructureRecognitionInstallProgress): void {
    if (this.run !== run || !run.running) return;
    if (run.progress?.phase !== progress.phase) run.phaseStartedAt = this.now();
    run.progress = progress;
    this.notify();
  }

  private stopRun(run: InstallRunState, error: StructureRecognitionInstallError): void {
    if (this.run !== run) return;
    run.running = false;
    run.error = error;
  }

  /** Polls the host's progress snapshot until an install this controller did not start ends. */
  private follow(status: StructureRecognitionEngineStatus): void {
    const now = this.now();
    const run = {
      running: true,
      startedAt: now - (status.installElapsedMs ?? 0),
      phaseStartedAt: now,
      progress: status.progress
    } as InstallRunState;
    this.run = run;
    run.promise = new Promise<boolean>((resolve) => {
      const poll = (): void => {
        setTimeout(() => {
          if (this.run !== run) {
            resolve(false);
            return;
          }
          this.engine.status().then(
            (next) => {
              if (this.run !== run) {
                resolve(false);
                return;
              }
              this.latestStatus = next;
              if (next.state === "installing") {
                if (next.progress) this.applyProgress(run, next.progress);
                else this.notify();
                poll();
                return;
              }
              if (next.state === "installed") {
                this.run = undefined;
                this.notify();
                resolve(true);
                return;
              }
              this.stopRun(run, {
                code: "failed",
                message: "The recognition engine install stopped before it finished."
              });
              this.notify();
              resolve(false);
            },
            () => poll()
          );
        }, this.followIntervalMs);
      };
      poll();
    });
  }

  /**
   * The user clicked Cancel (or pressed Escape) in the install dialog.
   *
   * Who may stop the shared install: only the dialog whose own Install started it. A dialog that
   * joined an install already running — typically one the user started from Add or Remove Plugins —
   * only ends this plugin's request; the install carries on, and Add or Remove Plugins still offers
   * Cancel install. Either way the request settles as cancelled.
   */
  cancel(id: number): Promise<void> {
    return this.stop(id, "cancelled", { cancelOwnedInstall: true });
  }

  /**
   * Ends a request nobody explicitly cancelled: the invocation that opened it was abandoned (`abort`)
   * or the dialog host went away (`declined`). These never stop the shared install — the user did not
   * ask for that, and the install stays visible and cancellable in Add or Remove Plugins.
   */
  private async stop(
    id: number,
    outcome: Exclude<InstallRequestOutcome, "installed">,
    { cancelOwnedInstall = false }: { cancelOwnedInstall?: boolean } = {}
  ): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.id !== id) return;
    if (cancelOwnedInstall && pending.installing && pending.ownsInstall && this.run?.running) {
      await this.cancelRunningInstall();
    }
    if (this.pending === pending) this.settle(pending, outcome);
  }

  decline(id: number): void {
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.installing) return;
    this.settle(pending, "declined");
  }

  private requestInstall(
    plugin: { id: string; name: string },
    status: StructureRecognitionEngineStatus,
    signal?: AbortSignal
  ): Promise<InstallRequestOutcome> {
    if (signal?.aborted) return Promise.resolve("cancelled");
    // Nobody can answer a dialog (or one is already open): the engine is simply not installed.
    if (this.pending || this.presenters === 0) return Promise.resolve("declined");
    return new Promise<InstallRequestOutcome>((resolve) => {
      const pending: PendingInstall = {
        id: this.nextId++,
        pluginId: plugin.id,
        pluginName: plugin.name,
        status,
        installing: status.state === "installing" || this.run?.running === true,
        ownsInstall: false,
        signal,
        resolve
      };
      if (signal) {
        pending.onAbort = () => void this.stop(pending.id, "cancelled");
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending = pending;
      this.notify();
      // An install is already running (started from the plugin manager, say): show it, and
      // continue once it finishes.
      if (pending.installing) void this.awaitRun(pending);
    });
  }

  private settle(pending: PendingInstall, outcome: InstallRequestOutcome): void {
    if (this.pending !== pending) return;
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    this.pending = undefined;
    pending.resolve(outcome);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function unsupportedResult(status: StructureRecognitionEngineStatus): PluginRecognitionResult {
  const message =
    status.detail?.trim() || "This computer isn’t supported by the MolScribe recognition engine.";
  return { status: "failed", code: "unsupported", message: message.slice(0, 2_000) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
