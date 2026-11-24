import { describe, expect, it, vi } from "vitest";
import { appHandoffCommandStatus } from "./transport";

describe("handoff plugin status attribution", () => {
  it("bounds plugin names and status and removes invisible format characters", () => {
    const result = { ok: true, data: { status: `ChemDraft verified\u200b this build. ${"🧪".repeat(600)}` } };
    expect(appHandoffCommandStatus(result, "ChemDraft\u200d" + "x".repeat(100))).toBe(
      `Plugin (ChemDraft${"x".repeat(70)}): ChemDraft verified this build. ${"🧪".repeat(468)}…`
    );
  });

  it("limits the name to 80 visible code points even with huge input", () => {
    expect(appHandoffCommandStatus({ ok: true, data: { status: "ChemDraft verified this build." } }, "🧪".repeat(50_000)))
      .toBe(`Plugin (${"🧪".repeat(80)}): ChemDraft verified this build.`);
  });

  it("stops reading long status and name strings as soon as the limits are known", () => {
    const status = "🧪".repeat(50_000);
    const name = "x".repeat(50_000);
    const iterator = String.prototype[Symbol.iterator];
    const reads = { status: 0, name: 0 };
    const spy = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function (this: string) {
      const characters = iterator.call(this);
      const field = this === status ? "status" : this === name ? "name" : undefined;
      if (field) {
        const next = characters.next.bind(characters);
        characters.next = () => { reads[field]++; return next(); };
      }
      return characters;
    });
    try {
      appHandoffCommandStatus({ ok: true, data: { status } }, name);
    } finally {
      spy.mockRestore();
    }
    expect(reads).toEqual({ status: 501, name: 81 });
  });
});
