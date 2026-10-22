import { describe, expect, it } from "vitest";
import { toolInstallSnapshot } from "./toolInstallSnapshot";
const base = { state: "missing" as const, pinnedVersion: "1", canInstall: true, consented: false, probedAt: "now" };
describe("toolInstallSnapshot", () => {
  it.each([["claude", "Anthropic"], ["codex", "OpenAI"]] as const)("names %s's publisher", (tool, publisher) => {
    const snapshot = toolInstallSnapshot({ ...base, tool }, { id: "plugin", name: "Plugin" });
    expect(snapshot.publisher).toBe(publisher); expect(snapshot.disclosure).toContain("leaves this computer");
  });
});
