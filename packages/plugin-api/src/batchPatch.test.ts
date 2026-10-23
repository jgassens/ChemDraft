import { describe, expect, it } from "vitest";
import { ProposedDocumentPatchSchema } from "./index";

describe("batch patch envelopes for direct writes and proposals", () => {
  const leaf = { op: "moveObject", objectId: "mol_1", x: 1, y: 2 };
  const envelope = (patches: unknown) => ({ reason: "batch", patch: { op: "batch", patches } });

  it("accepts flat batches at both size boundaries", () => {
    for (const length of [1, 256]) {
      const input = envelope(Array.from({ length }, () => leaf));
      expect(ProposedDocumentPatchSchema.parse(input).patch).toEqual(input.patch);
    }
  });

  it("refuses empty, oversized, malformed and nested batches", () => {
    for (const patches of [[], Array.from({ length: 257 }, () => leaf), [null], [{}], [{ op: "" }],
      [{ op: "batch", patches: [leaf] }], undefined]) {
      expect(ProposedDocumentPatchSchema.safeParse(envelope(patches)).success).toBe(false);
    }
  });

  it.each(["__proto__", "constructor", "prototype"])("refuses %s inside a nested operation", (key) => {
    const poison = JSON.parse(`{"${key}": {"polluted": true}}`);
    const patch = { op: "updateObject", objectId: "mol_1", changes: { style: poison } };
    expect(() => ProposedDocumentPatchSchema.parse(envelope([leaf, patch]))).toThrow(/prototype-polluting/);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
