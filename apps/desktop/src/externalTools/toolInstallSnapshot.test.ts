import { describe, expect, it } from "vitest";
import { toolInstallSnapshot } from "./toolInstallSnapshot";
import states from "../dialogs/toolInstallButtonStates.json";
import { validToolInstallSnapshot, type ToolInstallState } from "../dialogs/dialogProtocol";
const base = { state: "missing" as const, pinnedVersion: "1", pinnedDownloadBytes: 274_675_680, freeDiskBytes: 4_000_000_000, canInstall: true, consented: false, probedAt: "now" };
describe("toolInstallSnapshot", () => {
  it.each(states)("produces the shared buttons for $state.status", row => {
    const snapshot = toolInstallSnapshot({ ...base, tool: "claude", publisher: "Anthropic" }, { id: "plugin", name: "Plugin" }, row.state as ToolInstallState);
    expect(snapshot.buttons).toEqual(row.buttons);
    expect(validToolInstallSnapshot(snapshot)).toBe(true);
  });
  it.each([["claude", "Anthropic"], ["codex", "OpenAI"]] as const)("names %s's publisher", (tool, publisher) => {
    const snapshot = toolInstallSnapshot({ ...base, tool, publisher }, { id: "plugin", name: "Plugin" });
    expect(snapshot.publisher).toBe(publisher);
    expect(snapshot.disclosure.split("The AI can search the web and read web pages.")).toHaveLength(2);
    expect(snapshot.disclosure).toContain(`Your prompt and the open page, including unpublished structures, leave this computer and go to ${publisher}`);
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
