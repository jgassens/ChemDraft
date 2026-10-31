import { describe, expect, it } from "vitest";
import { sansSerifAdvanceEm } from "./index";
import { measureTextRun, textAdvanceEm } from "./textMetrics";

describe("headless text metrics", () => {
  it("uses Helvetica regular and bold, Symbol Greek and arrows, and the fallback", () => {
    expect(textAdvanceEm("A")).toBe(0.667);
    expect(textAdvanceEm("A", { bold: true })).toBe(0.722);
    expect(textAdvanceEm("i")).toBe(0.222);
    expect(textAdvanceEm("α")).toBe(0.631);
    expect(textAdvanceEm("α", { bold: true })).toBe(0.631);
    expect(textAdvanceEm("→")).toBe(0.987);
    expect(textAdvanceEm("é")).toBe(0.556);
    expect(textAdvanceEm("🧪")).toBe(0.62);
  });

  it("measures bold at weight 600 and scripts at 72 percent", () => {
    expect(measureTextRun("AA", { fontSizePx: 10, fontWeight: 599 })).toBe(13.34);
    expect(measureTextRun("AA", { fontSizePx: 10, fontWeight: 600 })).toBe(14.44);
    for (const script of ["subscript", "superscript"] as const) {
      expect(measureTextRun("AA", { fontSizePx: 10, script })).toBeCloseTo(13.34 * 0.72, 12);
    }
  });

  it("pins every legacy atom-label key and excludes all newly supported characters", () => {
    expect(sansSerifAdvanceEm).toEqual({
      A: 0.667, B: 0.667, C: 0.722, D: 0.722, E: 0.667, F: 0.611, G: 0.778, H: 0.722, I: 0.278, J: 0.5,
      K: 0.667, L: 0.556, M: 0.833, N: 0.722, O: 0.778, P: 0.667, Q: 0.778, R: 0.722, S: 0.667, T: 0.611,
      U: 0.722, V: 0.667, W: 0.944, X: 0.667, Y: 0.667, Z: 0.611,
      a: 0.556, b: 0.556, c: 0.5, d: 0.556, e: 0.556, f: 0.278, g: 0.556, h: 0.556, i: 0.222, j: 0.222,
      k: 0.5, l: 0.222, m: 0.833, n: 0.556, o: 0.556, p: 0.556, q: 0.556, r: 0.333, s: 0.5, t: 0.278,
      u: 0.556, v: 0.5, w: 0.722, x: 0.5, y: 0.5, z: 0.5,
      "0": 0.556, "1": 0.556, "2": 0.556, "3": 0.556, "4": 0.556, "5": 0.556, "6": 0.556, "7": 0.556,
      "8": 0.556, "9": 0.556, "+": 0.584, "-": 0.333
    });
  });
});
