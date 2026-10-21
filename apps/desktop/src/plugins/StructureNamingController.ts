import type { MoleculeObject } from "@chemdraft/chem-core";
import type { PluginStructureToNameResult } from "@chemdraft/plugin-api";
import { nameStructureForPlugin, type NamingCanonicalizer } from "./pluginStructureNaming";
import type { StructureNamingEngine, StructureNamingEngineStatus, StructureNamingInstallProgress, StructureNamingInstallError } from "./structureNamingEngine";
import { isStructureRecognitionInstallError } from "./structureRecognitionEngine";

export interface StructureNamingInstallRun {
  running: boolean;
  startedAt: number;
  phaseStartedAt: number;
  progress?: StructureNamingInstallProgress;
  error?: StructureNamingInstallError;
}
export interface OpenStructureNamingInstall {
  id: number;
  pluginId: string;
  pluginName: string;
  status: StructureNamingEngineStatus;
  installing: boolean;
  ownsInstall: boolean;
}
export interface NamingActivity { id: number; pluginName: string; startedAt: number }
type InstallOutcome = "installed" | "declined" | "cancelled" | "failed";
interface PendingInstall extends OpenStructureNamingInstall { resolve(outcome: InstallOutcome): void }

/** One controller per persistent runtime. Native errors never become chemical declines. */
export class StructureNamingController {
  private latestStatus?: StructureNamingEngineStatus;
  private pending?: PendingInstall;
  private run?: StructureNamingInstallRun;
  private installPromise?: Promise<boolean>;
  private active?: { id: number; stop: AbortController; engineRunning: boolean };
  private activity?: NamingActivity;
  private nextId = 1;
  private presenters = 0;
  private documentTabId?: () => string | undefined;
  private revealInstall?: () => void;
  private installDocumentTabId?: string;
  getInstallDocumentTabId = (): string | undefined => this.installDocumentTabId;
  private listeners = new Set<() => void>();
  constructor(private readonly engine: StructureNamingEngine,
    private readonly canonicalizer?: NamingCanonicalizer) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private notify(): void { for (const listener of this.listeners) listener(); }
  getStatus = (): StructureNamingEngineStatus | undefined => this.latestStatus;
  getOpenInstall = (): OpenStructureNamingInstall | undefined => this.pending;
  getInstallRun = (): StructureNamingInstallRun | undefined => this.run;
  getActivity = (): NamingActivity | undefined => this.pending ? undefined : this.activity;
  attachInstallPresenter(documentTabId?: () => string | undefined, revealInstall?: () => void): () => void {
    this.documentTabId = documentTabId;
    this.revealInstall = revealInstall;
    this.presenters++;
    return () => { if (--this.presenters === 0 && this.pending) this.decline(this.pending.id); };
  }
  async refreshStatus(): Promise<StructureNamingEngineStatus> {
    this.latestStatus = await this.engine.status();
    this.notify();
    return this.latestStatus;
  }
  installEngine(): Promise<boolean> {
    if (this.installPromise) return this.installPromise;
    this.run = { running: true, startedAt: Date.now(), phaseStartedAt: Date.now() };
    const run = this.run;
    this.installPromise = this.engine.install(progress => {
      const previous = this.run ?? run;
      this.run = { ...previous, progress, phaseStartedAt: previous.progress?.phase === progress.phase ? previous.phaseStartedAt : Date.now() };
      this.notify();
    }).then(status => {
      this.latestStatus = status;
      if (status.state !== "installed") throw { code: status.state === "unsupported" ? "unsupported" : "failed", message: status.detail ?? "The naming engine was not installed." };
      this.run = undefined;
      return true;
    }).catch((error: unknown) => {
      const normalized = isStructureRecognitionInstallError(error) ? error : { code: "failed" as const, message: messageOf(error) };
      this.run = { ...(this.run ?? run), running: false, error: normalized };
      if (normalized.code === "unsupported") this.latestStatus = { state: "unsupported", requiredDiskBytes: 0, freeDiskBytes: 0, detail: normalized.message };
      return false;
    }).finally(() => { this.installPromise = undefined; this.notify(); });
    this.notify();
    return this.installPromise;
  }
  async cancelEngineInstall(): Promise<void> { await this.engine.cancelInstall(); }
  async uninstall(): Promise<void> { this.latestStatus = await this.engine.uninstall(); this.run = undefined; this.notify(); }
  async install(id: number): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.installing) return;
    this.pending = { ...pending, installing: true, ownsInstall: !this.installPromise };
    this.notify();
    const installed = await this.installEngine();
    if (this.pending?.id === id) this.finishInstall(installed ? "installed" : this.run?.error?.code === "cancelled" ? "cancelled" : "failed");
  }
  decline(id: number): void {
    if (this.pending?.id !== id) return;
    if (this.pending.ownsInstall) void this.engine.cancelInstall().catch(() => undefined);
    this.finishInstall("declined");
  }
  cancelNaming(id: number): void { if (this.active?.id === id) this.active.stop.abort(); }
  private finishInstall(outcome: InstallOutcome): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(outcome);
    this.notify();
  }
  async name(plugin: { id: string; name: string }, molecule: MoleculeObject, signal: AbortSignal): Promise<PluginStructureToNameResult> {
    if (signal.aborted) return { status: "cancelled" };
    if (this.active) {
      if (this.pending) this.revealInstall?.();
      return { status: "failed", code: "busy", message: "Another structure is already being named." };
    }
    this.installDocumentTabId = this.documentTabId?.();
    const active = { id: this.nextId++, stop: new AbortController(), engineRunning: false };
    this.active = active;
    const abort = () => active.stop.abort();
    const stop = () => {
      if (active.engineRunning) void this.engine.cancel().catch(() => undefined);
      if (this.pending) {
        if (this.pending.ownsInstall) void this.engine.cancelInstall().catch(() => undefined);
        this.finishInstall("cancelled");
      }
      this.activity = undefined;
      this.notify();
    };
    signal.addEventListener("abort", abort, { once: true });
    active.stop.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => {
      if (!active.stop.signal.aborted) { this.activity = { id: active.id, pluginName: plugin.name, startedAt: Date.now() - 1000 }; this.notify(); }
    }, 1000);
    try {
      const result = await untilNamingStopped(this.runNaming(plugin, molecule, active), active.stop.signal);
      return result ?? { status: "cancelled" };
    } catch (error) { return namingFailure(error); }
    finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      active.stop.signal.removeEventListener("abort", stop);
      if (this.active === active) { this.active = undefined; this.activity = undefined; this.notify(); }
    }
  }
  private async runNaming(plugin: { id: string; name: string }, molecule: MoleculeObject,
    active: { id: number; stop: AbortController; engineRunning: boolean }): Promise<PluginStructureToNameResult> {
    let status: StructureNamingEngineStatus;
    try { status = await this.refreshStatus(); }
    catch (error) { return { status: "failed", code: "installFailed", message: `Naming engine status failed: ${messageOf(error)}` }; }
    if (active.stop.signal.aborted) return { status: "cancelled" };
    if (status.state === "unsupported") return { status: "unsupported", reason: status.detail ?? "This computer cannot run the local naming engine." };
    if (status.state !== "installed") {
      if (!this.presenters) return { status: "engineNotInstalled" };
      if (!this.installPromise) this.run = undefined;
      const outcome = await new Promise<InstallOutcome>(resolve => {
        this.pending = { id: active.id, pluginId: plugin.id, pluginName: plugin.name, status, installing: status.state === "installing", ownsInstall: false, resolve };
        this.notify();
        if (status.state === "installing") void this.followInstall(active.id);
      });
      if (active.stop.signal.aborted || outcome === "cancelled") return { status: "cancelled" };
      if (this.latestStatus?.state === "unsupported") return { status: "unsupported", reason: this.latestStatus.detail ?? "This computer cannot run the local naming engine." };
      if (outcome === "failed") return { status: "failed", code: "installFailed", message: this.run?.error?.message ?? "The naming engine could not be installed." };
      if (outcome !== "installed") return { status: "engineNotInstalled" };
      status = this.latestStatus!;
    }
    if (active.stop.signal.aborted) return { status: "cancelled" };
    active.engineRunning = true;
    const engine = Object.create(this.engine) as StructureNamingEngine;
    engine.name = smiles => {
      if (active.stop.signal.aborted) return Promise.reject({ code: "cancelled", message: "Naming cancelled." });
      return this.engine.name(smiles);
    };
    try { return await nameStructureForPlugin(molecule, engine, status, this.canonicalizer); }
    finally { active.engineRunning = false; }
  }
  private async followInstall(id: number): Promise<void> {
    try {
      if (this.installPromise) {
        const ok = await this.installPromise;
        if (this.pending?.id === id) this.finishInstall(ok ? "installed" : "failed");
        return;
      }
      while (this.pending?.id === id) {
        const status = await this.refreshStatus();
        if (this.pending?.id !== id) return;
        if (status.state !== "installing") {
          this.run = status.state === "installed" ? undefined : { running: false, startedAt: Date.now(), phaseStartedAt: Date.now(), error: { code: "failed", message: status.detail ?? "The naming engine was not installed." } };
          this.finishInstall(status.state === "installed" ? "installed" : "failed"); return;
        }
        const now = Date.now();
        this.run = { running: true, startedAt: now - (status.installElapsedMs ?? 0), phaseStartedAt: this.run?.progress?.phase === status.progress?.phase ? this.run?.phaseStartedAt ?? now : now, progress: status.progress };
        this.notify();
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch { if (this.pending?.id === id) this.finishInstall("failed"); }
  }
}
function namingFailure(error: unknown): PluginStructureToNameResult {
  const candidate = error as { code?: string } | null;
  if (candidate?.code === "cancelled") return { status: "cancelled" };
  if (candidate?.code === "notInstalled") return { status: "engineNotInstalled" };
  const code = candidate?.code === "busy" || candidate?.code === "timeout" || candidate?.code === "engineCrashed" ? candidate.code : "invalidResult";
  return { status: "failed", code, message: messageOf(error).slice(0, 2000) || "The naming engine failed." };
}
function messageOf(error: unknown): string {
  return error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
}
function untilNamingStopped<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); resolve(undefined); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
