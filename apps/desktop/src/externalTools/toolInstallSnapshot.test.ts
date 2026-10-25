import { describe, expect, it } from "vitest";
import { toolInstallSnapshot } from "./toolInstallSnapshot";
import states from "../dialogs/toolInstallButtonStates.json";
import { validToolInstallSnapshot, type ToolInstallState } from "../dialogs/dialogProtocol";
import { parseDialogMessage } from "../dialogs/dialogProtocol";
import managedUpdates from "../dialogs/managedUpdateSnapshots.json";
import type { ExternalToolStatus } from "./externalToolsEngine";
const base = { state: "missing" as const, pinnedVersion: "1", pinnedDownloadBytes: 274_675_680, freeDiskBytes: 4_000_000_000, canInstall: true, consented: false, probedAt: "now" };
const managedUpdateDetail = (tool: "codex" | "claude") => managedUpdates.find(row => row.status.tool === tool)!.status.detail;
describe("toolInstallSnapshot", () => {
  // Rust dialog_windows::tool_install_ts_managed_update_snapshots validates these exact envelopes.
  it.each(managedUpdates)("matches the Rust-validated $status.tool managed-update envelope ($message.data.state.status)", row => {
    const data = row.fixtureOnly ? row.message.data : toolInstallSnapshot(row.status as ExternalToolStatus, row.plugin, row.state as ToolInstallState | undefined);
    const message = { ...row.message, data };
    if (!row.fixtureOnly) expect(JSON.stringify(message)).toBe(JSON.stringify(row.message));
    expect(parseDialogMessage(message)).toEqual(message);
    expect(data.disclosure.length).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(JSON.stringify(message), "utf8")).toBeLessThanOrEqual(3400);
    expect(data).not.toHaveProperty("managedUpdateDetail");
    expect(data.state.status).not.toBe("broken");
    if (row.fixtureOnly) {
      expect(data.disclosure).toHaveLength(1024);
      expect(data.state).toEqual({ status: "failed", message: "M".repeat(1024) });
    }
  });

  it.each(["codex", "claude"] as const)("keeps %s update disclosure and distinct failure within native limits", tool => {
    const data = toolInstallSnapshot({ ...base, tool, publisher: "P".repeat(80), state: "broken", source: "managed",
      detail: managedUpdateDetail(tool), pinnedVersion: "v".repeat(40) }, { id: "p".repeat(256), name: "n".repeat(128) },
    { status: "failed", message: "A distinct failure." });
    const message = { ...managedUpdates[0]!.message, data };
    expect(data.disclosure.length).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(JSON.stringify(message), "utf8")).toBeLessThanOrEqual(3400);
    expect(parseDialogMessage(message)).toEqual(message);
    expect(data.state).toEqual({ status: "failed", message: "A distinct failure." });
  });

  it.each([["codex", "Codex"], ["claude", "Claude Code"]] as const)("explains the managed %s update at consent", (tool, name) => {
    const status = { ...base, tool, publisher: "", state: "broken" as const, source: "managed" as const,
      detail: managedUpdateDetail(tool) };
    const snapshot = toolInstallSnapshot(status, { id: "plugin", name: "Plugin" }, { status: "consent" });
    expect(snapshot.title).toBe(`Update ${name}`);
    expect(snapshot.intent).toBe("update");
    expect(snapshot.disclosure).toContain(status.detail);
    expect(snapshot).not.toHaveProperty("managedUpdateDetail");
    expect(snapshot.disclosure).toContain(`Updating downloads ${name} ${base.pinnedVersion} from ${snapshot.downloadHost} and replaces ChemDraft's copy; your own installs and your sign-in are not touched.`);
    expect(snapshot.downloadBytes).toBe(base.pinnedDownloadBytes);
    expect(snapshot.requiredDiskBytes).toBeGreaterThan(0);
    expect(validToolInstallSnapshot(snapshot)).toBe(true);
    for (const other of [{ state: "missing" as const }, { state: "installed" as const }, { source: "user" as const }, { canInstall: false }]) {
      const unchanged = toolInstallSnapshot({ ...status, ...other }, { id: "plugin", name: "Plugin" }, { status: "consent" });
      expect(unchanged.intent).not.toBe("update");
      expect(unchanged.title).not.toContain("Update");
      expect(unchanged.disclosure).not.toContain(status.detail);
      expect(unchanged).not.toHaveProperty("managedUpdateDetail");
    }
    const installed = toolInstallSnapshot(status, { id: "plugin", name: "Plugin" }, { status: "installed" });
    expect(installed.intent).toBe("use");
    expect(installed.title).not.toContain("Update");
    expect(installed.requiredDiskBytes).toBe(0);
  });
  it.each(["codex", "claude"] as const)("keeps a broken managed %s executable distinct from an update", tool => {
    const status = { ...base, tool, publisher: "", state: "broken" as const, source: "managed" as const,
      detail: "The executable is missing." };
    const snapshot = toolInstallSnapshot(status, { id: "plugin", name: "Plugin" });
    expect(snapshot.intent).toBe("download");
    expect(snapshot.state).toEqual({ status: "broken", detail: status.detail });
    expect(snapshot.disclosure).not.toContain(status.detail);
    expect(snapshot.title).not.toContain("Update");
  });
  it.each(["user", "managed"] as const)("requires no download or disk budget for a %s installation at consent", source => {
    const snapshot = toolInstallSnapshot({ ...base, tool: "codex", publisher: "OpenAI", state: "installed", source },
      { id: "plugin", name: "Plugin" }, { status: "consent" });
    expect(snapshot.downloadBytes).toBe(0);
    expect(snapshot.requiredDiskBytes).toBe(0);
    expect(validToolInstallSnapshot(snapshot)).toBe(true);
  });
  it.each(states)("produces the shared buttons for $state.status", row => {
    const snapshot = toolInstallSnapshot({ ...base, tool: "claude", publisher: "Anthropic" }, { id: "plugin", name: "Plugin" }, row.state as ToolInstallState);
    expect(snapshot.buttons).toEqual(row.buttons);
    expect(validToolInstallSnapshot(snapshot)).toBe(true);
  });
  it.each([["claude", "Anthropic"], ["codex", "OpenAI"]] as const)("names %s's publisher", (tool, publisher) => {
    const snapshot = toolInstallSnapshot({ ...base, tool, publisher }, { id: "plugin", name: "Plugin" });
    expect(snapshot.publisher).toBe(publisher);
    expect(snapshot.disclosure.match(/leaves? this computer/g)).toHaveLength(1);
    expect(snapshot.disclosure.match(/The AI can search the web and read web pages\./g)).toHaveLength(1);
    expect(snapshot.disclosure).toContain(`Your prompt and the open page, including any unpublished structures, leave this computer and go to ${publisher}`);
    expect(snapshot.disclosure).toContain("The vendor program uses your own account; Clear conversation removes ChemDraft's local conversation files.");
  });
  it("uses the pinned size and available disk space reported by the host", () => {
    const snapshot = toolInstallSnapshot({ ...base, tool: "claude", publisher: "Anthropic" }, { id: "plugin", name: "Plugin" });
    expect(snapshot.downloadBytes).toBe(274_675_680);
    expect(snapshot.requiredDiskBytes).toBe(616_460_224);
    expect(snapshot.freeDiskBytes).toBe(4_000_000_000);
  });
  it("preserves unknown free disk space reported by the host", () => {
    const snapshot = toolInstallSnapshot({ ...base, tool: "claude", publisher: "Anthropic", freeDiskBytes: null }, { id: "plugin", name: "Plugin" });
    expect(snapshot.freeDiskBytes).toBeNull();
  });
});
