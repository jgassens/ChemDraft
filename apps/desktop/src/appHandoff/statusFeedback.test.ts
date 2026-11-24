import { describe, expect, it } from "vitest";
import { appHandoffCommandStatus } from "./transport";

describe("handoff plugin status attribution", () => {
  it("bounds plugin names and status and removes invisible format characters", () => {
    const result = { ok: true, data: { status: `ChemDraft verified\u200b this build. ${"🧪".repeat(600)}` } };
    expect(appHandoffCommandStatus(result, "ChemDraft\u200d" + "x".repeat(100))).toBe(
      `Plugin (ChemDraft${"x".repeat(70)}…): ChemDraft verified this build. ${"🧪".repeat(468)}…`
    );
  });
});
