import type { ToolInstallSnapshot } from "./dialogProtocol";

export const toolInstallFixture = (publisher = "Anthropic"): ToolInstallSnapshot => ({
  title: "Install Claude Code", toolName: "Claude Code", publisher, version: "2.0.0",
  downloadHost: "downloads.example.test", downloadBytes: 125_000_000,
  pluginName: "ChemDraft Assistant", pluginId: "org.chemdraft.assistant",
  disclosure: "Use of this tool is subject to the publisher's terms.",
  requiredDiskBytes: 500_000_000, freeDiskBytes: 2_000_000_000,
  state: { status: "notInstalled" }, buttons: ["install", "close"]
});
