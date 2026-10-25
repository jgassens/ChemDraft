import { describe, expect, it } from "vitest";
import { PluginOverlayTranscriptRequestSchema } from "./index";

const overlayId = "overlay.chat.main";
const valid = (entries: unknown) => PluginOverlayTranscriptRequestSchema.safeParse({ overlayId, entries }).success;

describe("overlay transcript limits", () => {
  it("accepts every role, empty transcripts and exact entry/text limits", () => {
    expect(valid([])).toBe(true);
    expect(valid(["user", "assistant", "tool", "notice", "error"].map(role => ({ role, text: "Hello" })))).toBe(true);
    expect(valid(Array(50).fill({ role: "user", text: "" }))).toBe(true);
    expect(valid([{ role: "assistant", text: "x".repeat(4000) }])).toBe(true);
    expect(valid(Array(51).fill({ role: "user", text: "" }))).toBe(false);
    expect(valid([{ role: "assistant", text: "x".repeat(4001) }])).toBe(false);
  });
  it("counts UTF-8 serialized bytes, including JSON overhead, at the 64 KiB boundary", () => {
    const entries = Array.from({ length: 17 }, () => ({ role: "tool", text: "x".repeat(3800) }));
    const bytes = new TextEncoder().encode(JSON.stringify(entries)).byteLength;
    let remaining = 65536 - bytes;
    // Distribute the remaining bytes without exceeding the per-entry limit.
    for (const entry of entries) {
      const extra = Math.min(200, remaining);
      entry.text += "x".repeat(extra);
      remaining -= extra;
    }
    expect(new TextEncoder().encode(JSON.stringify(entries)).byteLength).toBe(65536);
    expect(valid(entries)).toBe(true);
    entries[16]!.text += "x";
    expect(valid(entries)).toBe(false);
    expect(valid(Array(6).fill({ role: "assistant", text: "漢".repeat(4000) }))).toBe(false);
  });
  it("rejects malformed roles, nontext content, unknown keys and non-array entries", () => {
    for (const entries of [[{ role: "system", text: "x" }], [{ role: "user", text: 3 }],
      [{ role: "user", text: "x", html: "<b>x</b>" }], null, {}]) expect(valid(entries)).toBe(false);
  });
});
