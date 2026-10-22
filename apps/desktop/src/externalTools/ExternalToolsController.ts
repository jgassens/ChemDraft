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
  consent(plugin: ExternalToolPlugin, status: ExternalToolStatus): Promise<"granted" | "declined">;
  install(plugin: ExternalToolPlugin, status: ExternalToolStatus, signal: AbortSignal): Promise<ExternalToolStatus>;
}
const fail = (message: string): Error => Object.assign(new Error(message), { code: message });

/** Host-side policy layer: native commands never receive a plugin request without ownership and consent. */
export class ExternalToolsController implements PluginHostExternalTools {
  private readonly runs = new Map<string, string>();
  private readonly statuses = new Map<string, ExternalToolStatus>();
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
    const status = await this.current(plugin, request.tool, true);
    await this.ensureConsent(plugin, status);
    if (!this.presenter) throw fail("External-tool installation UI is unavailable.");
    const installed = await this.presenter.install(plugin, status, signal);
    this.statuses.set(this.key(plugin.id, request.tool), installed);
    return installed;
  }
  signIn(_plugin: ExternalToolPlugin, request: PluginExternalToolInstallRequest) { return this.engine.signIn(request.tool); }
  async run(plugin: ExternalToolPlugin, request: PluginExternalToolRunRequest): Promise<PluginExternalToolRunHandle> {
    const status = await this.current(plugin, request.tool, true);
    await this.ensureConsent(plugin, status);
    const run = await this.engine.runStart({ ...request, pluginId: plugin.id }); this.runs.set(run.runId, plugin.id); return run;
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
  cancelAllForPlugin(pluginId: string): void { for (const [runId, owner] of this.runs) if (owner === pluginId) { this.runs.delete(runId); void this.engine.runCancel(runId); } }
  private async current(plugin: ExternalToolPlugin, tool: "claude" | "codex", refresh: boolean): Promise<ExternalToolStatus> {
    const value = PluginExternalToolStatusSchema.parse(await this.engine.status(tool, refresh, plugin.id)); this.statuses.set(this.key(plugin.id, tool), value); return value;
  }
  private async ensureConsent(plugin: ExternalToolPlugin, status: ExternalToolStatus): Promise<void> {
    if (status.consented) return;
    if (status.state === "unsupported") throw fail("unsupported");
    if (!this.presenter) throw fail("declined");
    if (await this.presenter.consent(plugin, status) !== "granted") throw fail("declined");
    await this.engine.consentSet(status.tool, plugin.id, true);
    this.statuses.set(this.key(plugin.id, status.tool), { ...status, consented: true });
  }
  private assertOwner(pluginId: string, runId: string): void { if (this.runs.get(runId) !== pluginId) throw fail("notOwner"); }
  private key(pluginId: string, tool: string): string { return `${pluginId}\0${tool}`; }
}
