import { describe, expect, it } from "vitest";
import { toolInstallSnapshot } from "./toolInstallSnapshot";
import states from "../dialogs/toolInstallButtonStates.json";
import { validToolInstallSnapshot, type ToolInstallState } from "../dialogs/dialogProtocol";
const base = { state: "missing" as const, pinnedVersion: "1", pinnedDownloadBytes: 274_675_680, freeDiskBytes: 4_000_000_000, canInstall: true, consented: false, probedAt: "now" };
describe("toolInstallSnapshot", () => {
  it.each([["codex", "Codex"], ["claude", "Claude Code"]] as const)("explains the managed %s update at consent", (tool, name) => {
    const status = { ...base, tool, publisher: "", state: "broken" as const, source: "managed" as const };
    const snapshot = toolInstallSnapshot(status, { id: "plugin", name: "Plugin" }, { status: "consent" });
    expect(snapshot.title).toBe(`Update ${name}`);
    expect(snapshot.intent).toBe("update");
    expect(snapshot.disclosure).toContain(`ChemDraft's copy of ${name} is from an older ChemDraft version.`);
    expect(snapshot.disclosure).toContain(`Updating downloads ${name} ${base.pinnedVersion} from ${snapshot.downloadHost} and replaces ChemDraft's copy; your own installs and your sign-in are not touched.`);
    expect(snapshot.downloadBytes).toBe(base.pinnedDownloadBytes);
    expect(snapshot.requiredDiskBytes).toBeGreaterThan(0);
    expect(validToolInstallSnapshot(snapshot)).toBe(true);
    for (const other of [{ state: "missing" as const }, { state: "installed" as const }, { source: "user" as const }, { canInstall: false }]) {
      const unchanged = toolInstallSnapshot({ ...status, ...other }, { id: "plugin", name: "Plugin" }, { status: "consent" });
      expect(unchanged.intent).not.toBe("update");
      expect(unchanged.title).not.toContain("Update");
      expect(unchanged.disclosure).not.toContain("older ChemDraft version");
    }
    const installed = toolInstallSnapshot(status, { id: "plugin", name: "Plugin" }, { status: "installed" });
    expect(installed.intent).toBe("use");
    expect(installed.title).not.toContain("Update");
    expect(installed.requiredDiskBytes).toBe(0);
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
