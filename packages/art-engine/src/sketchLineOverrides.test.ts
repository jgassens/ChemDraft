import { describe, expect, it } from "vitest";
import { visualEffectPlansForStyle } from "./index";

describe("linear sketch ink overrides", () => {
  it("preserves the remaining rough strokes byte-for-byte after replacing an earlier line", () => {
    const input = {
      objectId: "override-test", style: { visualEffects: [{ kind: "sketch", seed: 7, roughness: 1.25, bowing: 1 }] },
      sketchBasePathD: "M 0 0 L 4 0 M 10 0 L 70 0"
    };
    const original = visualEffectPlansForStyle(input).find((effect) => effect.kind === "sketch")!;
    const replaced = visualEffectPlansForStyle({ ...input, sketchLineOverrides: () => new Map([[0, null]]) })
      .find((effect) => effect.kind === "sketch")!;
    expect(replaced.paths[0]!.d).toBe(original.paths[0]!.d.split("M").slice(3).map((part) => "M" + part).join(""));
    expect(visualEffectPlansForStyle({ ...input, sketchLineOverrides: () => new Map() })).toEqual([original]);
  });
});
