import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  PluginExternalToolClearConversationRequest,
  PluginExternalToolId,
  PluginExternalToolPollRequest,
  PluginExternalToolRunHandle,
  PluginExternalToolRunPoll,
  PluginExternalToolRunRequest,
  PluginExternalToolStatus
} from "@chemdraft/plugin-api";

export interface ExternalToolInstallProgress { phase: string; message: string; bytesDone?: number; bytesTotal?: number }
export interface ExternalToolStatus extends PluginExternalToolStatus { publisher?: string; progress?: ExternalToolInstallProgress }
export interface ExternalToolsEngine {
  status(tool: PluginExternalToolId, refresh?: boolean, pluginId?: string): Promise<ExternalToolStatus>;
  install(tool: PluginExternalToolId, onProgress: (progress: ExternalToolInstallProgress) => void): Promise<unknown>;
  cancelInstall(tool: PluginExternalToolId): Promise<void>;
  uninstall(tool: PluginExternalToolId): Promise<void>;
  signIn(tool: PluginExternalToolId): Promise<{ launched: boolean; method: "terminal.command" | "newConsole"; detail?: string }>;
  consentSet(tool: PluginExternalToolId, pluginId: string, granted: boolean): Promise<void>;
  consentList(): Promise<unknown>;
  runStart(request: PluginExternalToolRunRequest & { pluginId: string }): Promise<PluginExternalToolRunHandle>;
  runPoll(request: PluginExternalToolPollRequest): Promise<PluginExternalToolRunPoll>;
  runCancel(runId: string): Promise<void>;
  conversationClear(request: PluginExternalToolClearConversationRequest & { pluginId: string }): Promise<void>;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export interface ProgressChannel<T> { onmessage: (message: T) => void }
type CreateChannel = <T>() => ProgressChannel<T>;

/** The exact TypeScript adapter for Rust's host-owned external-tools commands. */
export class TauriExternalToolsEngine implements ExternalToolsEngine {
  constructor(private readonly call: Invoke = invoke, private readonly createChannel: CreateChannel = <T>() => new Channel<T>()) {}
  status(tool: PluginExternalToolId, refresh = false, pluginId?: string): Promise<ExternalToolStatus> {
    return this.call("external_tool_status", { tool, refresh, ...(pluginId ? { pluginId } : {}) });
  }
  install(tool: PluginExternalToolId, onProgress: (progress: ExternalToolInstallProgress) => void): Promise<unknown> {
    const onProgressChannel = this.createChannel<ExternalToolInstallProgress>();
    onProgressChannel.onmessage = onProgress;
    return this.call("external_tool_install", { tool, onProgress: onProgressChannel });
  }
  async cancelInstall(tool: PluginExternalToolId): Promise<void> { await this.call<void>("external_tool_cancel_install", { tool }); }
  async uninstall(tool: PluginExternalToolId): Promise<void> { await this.call<void>("external_tool_uninstall", { tool }); }
  signIn(tool: PluginExternalToolId) { return this.call<{ launched: boolean; method: "terminal.command" | "newConsole"; detail?: string }>("external_tool_sign_in", { tool }); }
  async consentSet(tool: PluginExternalToolId, pluginId: string, granted: boolean): Promise<void> { await this.call<void>("external_tool_consent_set", { tool, pluginId, granted }); }
  consentList(): Promise<unknown> { return this.call("external_tool_consent_list"); }
  runStart(request: PluginExternalToolRunRequest & { pluginId: string }): Promise<PluginExternalToolRunHandle> { return this.call("external_tool_run_start", { request }); }
  runPoll(request: PluginExternalToolPollRequest): Promise<PluginExternalToolRunPoll> { return this.call("external_tool_run_poll", { runId: request.runId, cursor: request.cursor, maxLines: request.maxLines, waitMs: request.waitMs }); }
  async runCancel(runId: string): Promise<void> { await this.call<void>("external_tool_run_cancel", { runId }); }
  async conversationClear(request: PluginExternalToolClearConversationRequest & { pluginId: string }): Promise<void> { await this.call<void>("external_tool_conversation_clear", { tool: request.tool, pluginId: request.pluginId, conversationId: request.conversationId }); }
}

const unsupported = (tool: PluginExternalToolId): ExternalToolStatus => ({ tool, state: "unsupported", pinnedVersion: "", canInstall: false, consented: false, probedAt: new Date(0).toISOString(), detail: "External tools are available only in a supported ChemDraft desktop build." });
/** Browser builds never pretend an OS process can be launched. */
export class UnsupportedExternalToolsEngine implements ExternalToolsEngine {
  async status(tool: PluginExternalToolId): Promise<ExternalToolStatus> { return unsupported(tool); }
  async install(): Promise<unknown> { throw new Error("unsupported"); }
  async cancelInstall(): Promise<void> { throw new Error("unsupported"); }
  async uninstall(): Promise<void> { throw new Error("unsupported"); }
  async signIn(): Promise<{ launched: boolean; method: "terminal.command" | "newConsole" }> { throw new Error("unsupported"); }
  async consentSet(): Promise<void> { throw new Error("unsupported"); }
  async consentList(): Promise<unknown> { return []; }
  async runStart(): Promise<PluginExternalToolRunHandle> { throw new Error("unsupported"); }
  async runPoll(): Promise<PluginExternalToolRunPoll> { throw new Error("unsupported"); }
  async runCancel(): Promise<void> { throw new Error("unsupported"); }
  async conversationClear(): Promise<void> { throw new Error("unsupported"); }
}
