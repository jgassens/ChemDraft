import { PluginExternalToolConsentListSchema, PluginExternalToolStatusSchema } from "@chemdraft/plugin-api";
import type {
  PluginExternalToolCancelRequest, PluginExternalToolClearConversationRequest, PluginExternalToolInstallRequest,
  PluginExternalToolPollRequest, PluginExternalToolRunHandle, PluginExternalToolRunPoll, PluginExternalToolRunRequest,
  PluginExternalToolStatus, PluginExternalToolStatusRequest
} from "@chemdraft/plugin-api";
import type { PluginHostExternalTools } from "@chemdraft/plugin-host";
import type { ExternalToolConsent, ExternalToolsEngine, ExternalToolStatus } from "./externalToolsEngine";
import type { ExternalToolPlugin } from "./toolInstallSnapshot";

export interface ExternalToolsPresenter {
  consent(plugin: ExternalToolPlugin, status: ExternalToolStatus, signal: AbortSignal): Promise<"granted" | "declined">;
  install(plugin: ExternalToolPlugin, status: ExternalToolStatus, signal: AbortSignal): Promise<ExternalToolStatus>;
}
const fail = (message: string): Error => Object.assign(new Error(message), { code: message });

/** Host-side policy layer: native commands never receive a plugin request without ownership and consent. */
export class ExternalToolsController implements PluginHostExternalTools {
  private readonly runs = new Map<string, string>();
  private readonly statuses = new Map<string, ExternalToolStatus>();
  private readonly generations = new Map<string, number>();
  private readonly pending = new Map<string, Set<AbortController>>();
  private readonly consents = new Map<string, Promise<void>>();
  private presenter: ExternalToolsPresenter | undefined;
  constructor(private readonly engine: ExternalToolsEngine, presenter?: ExternalToolsPresenter) { this.presenter = presenter; }
  attachPresenter(presenter: ExternalToolsPresenter): () => void { this.presenter = presenter; return () => { if (this.presenter === presenter) this.presenter = undefined; }; }
  installNative(tool: "claude" | "codex", onProgress: (progress: import("./externalToolsEngine").ExternalToolInstallProgress) => void): Promise<unknown> { return this.engine.install(tool, onProgress); }
  cancelNativeInstall(tool: "claude" | "codex"): Promise<void> { return this.engine.cancelInstall(tool); }
  statusNative(tool: "claude" | "codex", pluginId: string): Promise<ExternalToolStatus> { return this.engine.status(tool, true, pluginId); }
  async status(plugin: ExternalToolPlugin, request: PluginExternalToolStatusRequest): Promise<PluginExternalToolStatus> {
    const cached = this.statuses.get(this.key(plugin.id, request.tool));
    if (!request.refresh && cached) return cached;
    const value = PluginExternalToolStatusSchema.parse(await this.engine.status(request.tool, request.refresh, plugin.id)); this.statuses.set(this.key(plugin.id, request.tool), value); return value;
  }
  async install(plugin: ExternalToolPlugin, request: PluginExternalToolInstallRequest, signal: AbortSignal): Promise<PluginExternalToolStatus> {
    return this.withPlugin(plugin.id, async (check, lifecycle) => {
      const status = await this.current(plugin, request.tool, true, check);
      check();
      await this.ensureConsent(plugin, status, check, lifecycle);
      check();
      if (!this.presenter) throw fail("External-tool installation UI is unavailable.");
      const combined = new AbortController();
      const abort = () => combined.abort(signal.aborted ? signal.reason : lifecycle.reason);
      for (const source of [signal, lifecycle]) source.addEventListener("abort", abort, { once: true });
      if (signal.aborted || lifecycle.aborted) abort();
      try {
        const installed = await this.presenter.install(plugin, status, combined.signal);
        check();
        this.statuses.set(this.key(plugin.id, request.tool), installed);
        return installed;
      } finally {
        for (const source of [signal, lifecycle]) source.removeEventListener("abort", abort);
      }
    });
  }
  signIn(plugin: ExternalToolPlugin, request: PluginExternalToolInstallRequest) {
    return this.withPlugin(plugin.id, async check => {
      const result = await this.engine.signIn(request.tool);
      check();
      return result;
    });
  }
  async run(plugin: ExternalToolPlugin, request: PluginExternalToolRunRequest): Promise<PluginExternalToolRunHandle> {
    return this.withPlugin(plugin.id, async (check, signal) => {
      const status = await this.current(plugin, request.tool, true, check);
      check();
      await this.ensureConsent(plugin, status, check, signal);
      check();
      // Rust checks session ownership and reserves it atomically with the run binding.
      const run = await this.engine.runStart({ ...request, pluginId: plugin.id }).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "notOwner") {
          throw fail("notOwner");
        }
        throw error;
      });
      try { check(); }
      catch (error) { await this.engine.runCancel(run.runId).catch(() => undefined); throw error; }
      this.runs.set(run.runId, plugin.id);
      return run;
    });
  }
  async poll(plugin: ExternalToolPlugin, request: PluginExternalToolPollRequest): Promise<PluginExternalToolRunPoll> { this.assertOwner(plugin.id, request.runId); return this.engine.runPoll(request); }
  async cancel(plugin: ExternalToolPlugin, request: PluginExternalToolCancelRequest): Promise<void> { this.assertOwner(plugin.id, request.runId); await this.engine.runCancel(request.runId); }
  async clearConversation(plugin: ExternalToolPlugin, request: PluginExternalToolClearConversationRequest): Promise<void> { await this.engine.conversationClear({ ...request, pluginId: plugin.id }); }
  async consentList(): Promise<ExternalToolConsent[]> { return PluginExternalToolConsentListSchema.parse(await this.engine.consentList()); }
  async consentRevoke(tool: "claude" | "codex", pluginId: string): Promise<void> {
    await this.engine.consentRevoke(tool, pluginId);
    this.statuses.delete(this.key(pluginId, tool));
  }
  async consentClearPlugin(pluginId: string): Promise<void> {
    await this.engine.consentClearPlugin(pluginId);
    for (const tool of ["claude", "codex"] as const) this.statuses.delete(this.key(pluginId, tool));
  }
  cancelAllForPlugin(pluginId: string): void {
    this.generations.set(pluginId, (this.generations.get(pluginId) ?? 0) + 1);
    for (const pending of this.pending.get(pluginId) ?? []) pending.abort(fail("External-tool plugin was unloaded."));
    for (const tool of ["claude", "codex"]) {
      this.statuses.delete(this.key(pluginId, tool));
      this.consents.delete(this.key(pluginId, tool));
    }
    for (const [runId, owner] of this.runs) if (owner === pluginId) {
      this.runs.delete(runId); void this.engine.runCancel(runId).catch(() => undefined);
    }
  }
  private async withPlugin<T>(pluginId: string, action: (check: () => void, signal: AbortSignal) => Promise<T>): Promise<T> {
    const generation = this.generations.get(pluginId) ?? 0;
    const abort = new AbortController();
    const pending = this.pending.get(pluginId) ?? new Set<AbortController>();
    this.pending.set(pluginId, pending); pending.add(abort);
    const check = () => { if ((this.generations.get(pluginId) ?? 0) !== generation) throw fail("External-tool plugin was unloaded."); };
    try { const result = await action(check, abort.signal); check(); return result; }
    catch (error) { check(); throw error; }
    finally { pending.delete(abort); if (!pending.size) this.pending.delete(pluginId); }
  }
  private async current(plugin: ExternalToolPlugin, tool: "claude" | "codex", refresh: boolean, check: () => void): Promise<ExternalToolStatus> {
    const value = PluginExternalToolStatusSchema.parse(await this.engine.status(tool, refresh, plugin.id));
    check(); this.statuses.set(this.key(plugin.id, tool), value); return value;
  }
  private async ensureConsent(plugin: ExternalToolPlugin, status: ExternalToolStatus, check: () => void, signal: AbortSignal): Promise<void> {
    const key = this.key(plugin.id, status.tool);
    if (status.consented || this.statuses.get(key)?.consented) return;
    if (status.state === "unsupported") throw fail("unsupported");
    if (!this.presenter) throw fail("declined");
    const existing = this.consents.get(key);
    if (existing) { await existing; check(); return; }
    const presenter = this.presenter;
    const consent = (async () => {
      const result = await presenter.consent(plugin, status, signal);
      check();
      if (result !== "granted") throw fail("declined");
      await this.engine.consentSet(status.tool, plugin.id, true);
      check();
      this.statuses.set(key, { ...status, consented: true });
    })();
    this.consents.set(key, consent);
    try { await consent; check(); }
    finally { if (this.consents.get(key) === consent) this.consents.delete(key); }
  }
  private assertOwner(pluginId: string, runId: string): void { if (this.runs.get(runId) !== pluginId) throw fail("notOwner"); }
  private key(pluginId: string, tool: string): string { return `${pluginId}\0${tool}`; }
}
