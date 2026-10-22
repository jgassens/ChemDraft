import type { PluginExternalToolId } from "@chemdraft/plugin-api";
import type { ToolInstallSnapshot } from "../dialogs/dialogProtocol";
import type { ExternalToolStatus } from "./externalToolsEngine";

export interface ExternalToolPlugin { id: string; name: string }
export interface ToolPinFacts { version: string; downloadHost: string; downloadBytes: number }
export const TOOL_PIN_FACTS: Record<PluginExternalToolId, ToolPinFacts> = {
  claude: { version: "2.1.308", downloadHost: "downloads.claude.ai", downloadBytes: 0 },
  codex: { version: "0.163.0", downloadHost: "github.com", downloadBytes: 0 }
};
export function publisherForTool(tool: PluginExternalToolId): string { return tool === "claude" ? "Anthropic" : "OpenAI"; }
export function toolNameFor(tool: PluginExternalToolId): string { return tool === "claude" ? "Claude Code" : "Codex"; }
export function toolInstallSnapshot(status: ExternalToolStatus, plugin: ExternalToolPlugin, state?: ToolInstallSnapshot["state"]): ToolInstallSnapshot {
  const facts = TOOL_PIN_FACTS[status.tool];
  const publisher = status.publisher || publisherForTool(status.tool);
  const selected = state ?? (status.state === "installed" ? { status: "installed" } : status.state === "broken" ? { status: "broken", detail: status.detail ?? "The installed tool needs attention." } : { status: "notInstalled" });
  return {
    title: `${toolNameFor(status.tool)} for ${plugin.name}`,
    toolName: toolNameFor(status.tool), publisher, version: status.pinnedVersion || facts.version,
    downloadHost: facts.downloadHost, downloadBytes: facts.downloadBytes, pluginName: plugin.name, pluginId: plugin.id,
    disclosure: `${publisher} receives your prompt and the open page when this tool is used; the open page leaves this computer and may contain unpublished research. The vendor program uses your own account; Clear conversation removes ChemDraft's local conversation files.`,
    requiredDiskBytes: facts.downloadBytes * 2 + 64 * 1024 * 1024, freeDiskBytes: 0, state: selected,
    buttons: selected.status === "consent" ? ["allow", "close"] : selected.status === "installing" ? ["cancelInstall", "close"] : selected.status === "installed" ? ["close"] : ["install", "close"]
  };
}
