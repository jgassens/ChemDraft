import { describe, expect, it } from "vitest";
import { toolInstallSnapshot } from "./toolInstallSnapshot";
const base = { state: "missing" as const, pinnedVersion: "1", pinnedDownloadBytes: 274_675_680, freeDiskBytes: 4_000_000_000, canInstall: true, consented: false, probedAt: "now" };
describe("toolInstallSnapshot", () => {
  it.each([["claude", "Anthropic"], ["codex", "OpenAI"]] as const)("names %s's publisher", (tool, publisher) => {
    const snapshot = toolInstallSnapshot({ ...base, tool, publisher }, { id: "plugin", name: "Plugin" });
    expect(snapshot.publisher).toBe(publisher); expect(snapshot.disclosure).toContain("leaves this computer");
  });
  it("uses the pinned size and available disk space reported by the host", () => {
    const snapshot = toolInstallSnapshot({ ...base, tool: "claude", publisher: "Anthropic" }, { id: "plugin", name: "Plugin" });
    expect(snapshot.downloadBytes).toBe(274_675_680);
    expect(snapshot.requiredDiskBytes).toBe(616_460_224);
    expect(snapshot.freeDiskBytes).toBe(4_000_000_000);
  });
});
