import type { PluginExternalToolId } from "@chemdraft/plugin-api";
import type { ToolInstallSnapshot } from "../dialogs/dialogProtocol";
import type { ExternalToolStatus } from "./externalToolsEngine";

export interface ExternalToolPlugin { id: string; name: string }
export const TOOL_DOWNLOAD_HOSTS: Record<PluginExternalToolId, string> = {
  claude: "downloads.claude.ai",
  codex: "github.com"
};
export function publisherForTool(tool: PluginExternalToolId): string { return tool === "claude" ? "Anthropic" : "OpenAI"; }
export function toolNameFor(tool: PluginExternalToolId): string { return tool === "claude" ? "Claude Code" : "Codex"; }
export function toolInstallSnapshot(status: ExternalToolStatus, plugin: ExternalToolPlugin, state?: ToolInstallSnapshot["state"]): ToolInstallSnapshot {
  const publisher = status.publisher || publisherForTool(status.tool);
  const selected = state ?? (status.state === "installed" ? { status: "installed" } : status.state === "broken" ? { status: "broken", detail: status.detail ?? "The installed tool needs attention." } : { status: "notInstalled" });
  const needsDownload = status.state !== "installed" && selected.status !== "installed";
  const needsUpdate = needsDownload && status.state === "broken" && status.source === "managed" && status.canInstall;
  const updateDetail = needsUpdate ? status.detail : undefined;
  return {
    intent: needsUpdate ? "update" : needsDownload ? "download" : "use",
    ...(updateDetail ? { managedUpdateDetail: updateDetail } : {}),
    title: needsUpdate ? `Update ${toolNameFor(status.tool)}` : `${toolNameFor(status.tool)} for ${plugin.name}`,
    toolName: toolNameFor(status.tool), publisher, version: status.pinnedVersion,
    downloadHost: TOOL_DOWNLOAD_HOSTS[status.tool], downloadBytes: needsDownload ? status.pinnedDownloadBytes : 0, pluginName: plugin.name, pluginId: plugin.id,
    disclosure: `${needsUpdate ? `${updateDetail ? `${updateDetail} ` : ""}Updating downloads ${toolNameFor(status.tool)} ${status.pinnedVersion} from ${TOOL_DOWNLOAD_HOSTS[status.tool]} and replaces ChemDraft's copy; your own installs and your sign-in are not touched. ` : ""}The AI can search the web and read web pages. Your prompt and the open page, including any unpublished structures, leave this computer and go to ${publisher} when you send a request. The vendor program uses your own account; Clear conversation removes ChemDraft's local conversation files.`,
    requiredDiskBytes: needsDownload ? status.pinnedDownloadBytes * 2 + 64 * 1024 * 1024 : 0, freeDiskBytes: status.freeDiskBytes, state: selected,
    buttons: selected.status === "consent" ? ["allow", "close"] : selected.status === "installing" ? ["cancelInstall", "close"] : selected.status === "installed" ? ["close"] : ["install", "close"]
  };
}
