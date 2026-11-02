import { nativeTextStyleFromObjectStyle, type TextSpan } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";
import { measureNativeTextSpanLineWidth, sansSerifAdvanceEm } from "./index";
import { measureTextRun, textAdvanceEm } from "./textMetrics";
import { chemistryAdvanceCeilings } from "./nativeFontCeilings.generated";
import * as core14 from "./textMetrics.generated";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("offline font ceiling generator", () => {
  it("selects reordered TTC faces by name and rejects missing or duplicate names", async () => {
    const { namedFace } = await import(new URL("../scripts/generate-native-font-ceilings.mjs", import.meta.url).href);
    // Minimal, synthetic OpenType tables; no host font files or proprietary font data.
    function collection(names: string[]) {
      const header = Buffer.alloc(12 + names.length * 4);
      header.write("ttcf"); header.writeUInt32BE(0x10000, 4); header.writeUInt32BE(names.length, 8);
      let offset = header.length;
      const faces = names.map((name, index) => {
        header.writeUInt32BE(offset, 12 + index * 4);
        const head = Buffer.alloc(20); head.writeUInt32BE(0x10000, 4); head.writeUInt16BE(1000, 18);
        const hhea = Buffer.alloc(36); hhea.writeUInt16BE(2, 34);
        const hmtx = Buffer.alloc(8); hmtx.writeUInt16BE(500, 0); hmtx.writeUInt16BE(700 + index * 100, 4);
        const faceName = Buffer.alloc(18 + name.length * 2);
        faceName.writeUInt16BE(1, 2); faceName.writeUInt16BE(18, 4);
        faceName.writeUInt16BE(3, 6); faceName.writeUInt16BE(1, 8); faceName.writeUInt16BE(0x409, 10);
        faceName.writeUInt16BE(6, 12); faceName.writeUInt16BE(name.length * 2, 14);
        [...name].forEach((c, i) => faceName.writeUInt16BE(c.charCodeAt(0), 18 + i * 2));
        const cmap = Buffer.alloc(44); cmap.writeUInt16BE(1, 2); cmap.writeUInt16BE(3, 4);
        cmap.writeUInt16BE(1, 6); cmap.writeUInt32BE(12, 8);
        cmap.writeUInt16BE(4, 12); cmap.writeUInt16BE(32, 14); cmap.writeUInt16BE(4, 18);
        cmap.writeUInt16BE(65, 26); cmap.writeUInt16BE(65535, 28);
        cmap.writeUInt16BE(65, 32); cmap.writeUInt16BE(65535, 34);
        cmap.writeInt16BE(-64, 36); cmap.writeInt16BE(1, 38); // A -> glyph 1
        const tables = { head, hhea, hmtx, name: faceName, cmap };
        const directory = Buffer.alloc(12 + Object.keys(tables).length * 16);
        directory.writeUInt32BE(0x10000); directory.writeUInt16BE(Object.keys(tables).length, 4);
        let start = offset + directory.length;
        Object.entries(tables).forEach(([tag, bytes], i) => {
          directory.write(tag, 12 + i * 16); directory.writeUInt32BE(start, 20 + i * 16);
          directory.writeUInt32BE(bytes.length, 24 + i * 16); start += bytes.length;
        });
        const face = Buffer.concat([directory, ...Object.values(tables)]);
        offset += face.length;
        return face;
      });
      return Buffer.concat([header, ...faces]);
    }
    const directory = mkdtempSync(join(tmpdir(), "font-ceiling-test-"));
    try {
      const path = join(directory, "faces.ttc");
      writeFileSync(path, collection(["Example-Bold", "Example-Regular"]));
      expect(namedFace(path, "Example-Regular").advance(65)).toBe(0.8);
      expect(namedFace(path, "Example-Bold").advance(65)).toBe(0.7);
      expect(() => namedFace(path, "Example-Italic")).toThrow("found 0");
      writeFileSync(path, collection(["Example-Regular", "Example-Regular"]));
      expect(() => namedFace(path, "Example-Regular")).toThrow("found 2");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("includes characters found only in a non-Helvetica face", async () => {
    const { core14CodePoints } = await import(new URL("../scripts/generate-native-font-ceilings.mjs", import.meta.url).href);
    expect(core14CodePoints({ helveticaAdvances: { 65: 0.667 }, timesItalicAdvances: { 937: 0.768 }, courierAdvances: { 66: 0.6 } }))
      .toEqual([65, 66, 937]);
  });
});

describe("native span sizing", () => {
  const style = nativeTextStyleFromObjectStyle({ fontSizePx: 18 });
  const span = (text: string, overrides: Partial<TextSpan> = {}): TextSpan =>
    ({ text, script: "normal", style: {}, ...overrides });
  const width = (text: string, overrides = {}) =>
    measureNativeTextSpanLineWidth([span(text)], { ...style, ...overrides });

  it("fits nine Cs using Helvetica advances and keeps narrow legacy estimates", () => {
    expect(width("CCCCCCCCC")).toBeCloseTo(117.126, 10);
    expect(width("CCCCCCCCC")).toBeGreaterThanOrEqual(116.964);
    expect(width("iiii")).toBeCloseTo(4 * 18 * 0.28);
  });
  it("honours bold and font/size overrides per span", () => {
    expect(width("AA", { fontWeight: 700 })).toBeCloseTo(2 * 18 * 0.723);
    expect(measureNativeTextSpanLineWidth([
      span("A", { style: { fontWeight: 700, fontSizePx: 24 } }), span("C")
    ], style)).toBeCloseTo(24 * 0.723 + 18 * 0.723);
  });
  it("continues tracking across spans, including scripts at the parent's 72% size", () => {
    for (const script of ["subscript", "superscript"] as const) {
      expect(measureNativeTextSpanLineWidth([
        span("C"), span("C", { script, style: { fontSizePx: 99 } }), span("C")
      ], { ...style, letterSpacingPx: 2 })).toBeCloseTo(18 * 0.723 * 2.72 + 6);
    }
    expect(width("CCC", { letterSpacingPx: 3 })).toBeCloseTo(18 * 0.723 * 3 + 9);
  });
  it("uses named Times/Courier faces and per-character maxima for generics", () => {
    expect(width("WW", { fontFamily: "Times New Roman, serif" })).toBeCloseTo(18 * 0.944 * 2);
    expect(width("WW", { fontFamily: "serif", fontWeight: 700 })).toBeCloseTo(18 * 1.127 * 2);
    expect(width("f", { fontFamily: "serif", fontStyle: "italic" })).toBeCloseTo(18 * 0.601);
    expect(width("A", { fontFamily: "serif", fontStyle: "italic" })).toBeCloseTo(18 * 0.671);
    expect(width("A", { fontFamily: "serif", fontStyle: "italic", fontWeight: 700 })).toBeCloseTo(18 * 0.759);
    expect(width("ii", { fontFamily: "Courier New, monospace", fontStyle: "italic", fontWeight: 700 }))
      .toBeCloseTo(18 * 0.601 * 2);
  });
  it("falls back deterministically for an unknown font or uncovered character", () => {
    expect(width("🧪")).toBeCloseTo(18);
    expect(width("C", { fontFamily: "Unknown face" })).toBeCloseTo(18 * 0.723);
    expect(width("ii", { fontFamily: "Unknown face, monospace" })).toBeCloseTo(18 * 0.601 * 2);
  });

  it.each(["Arial", "Helvetica", "sans-serif"])("bounds the real %s C advance", fontFamily => {
    expect(width("CCCCCCCCC", { fontFamily })).toBeGreaterThanOrEqual(9 * 1479 / 2048 * 18);
  });
  it.each(["Times New Roman", "Times", "serif"])("bounds the real %s macron advance", fontFamily => {
    expect(width("¯¯¯", { fontFamily })).toBeGreaterThanOrEqual(3 * 0.5 * 18);
  });
  it.each(["Courier New", "Courier", "monospace"])("bounds the real %s cell advance", fontFamily => {
    expect(width("ii", { fontFamily })).toBeGreaterThanOrEqual(2 * 1229 / 2048 * 18);
  });
  it("uses the known-face maximum for generic monospace", () => {
    expect(width("ii", { fontFamily: "monospace" })).toBeCloseTo(2 * 0.601 * 18);
    expect(width("HH", { fontFamily: "monospace" })).toBeCloseTo(2 * 0.815 * 18);
  });
  it.each(["Helvetica Neue", "Menlo", "Monaco", "Consolas", "Unknown face, Arial", "sans-serif", "serif", "monospace"])(
    "uses per-character maxima for %s in all four styles", fontFamily => {
      for (const [fontWeight, fontStyle, h, a, w] of [
        [400, "normal", 0.815, 0.723, 0.976], [700, "normal", 0.914, 0.759, 1.127],
        [400, "italic", 0.815, 0.671, 0.976], [700, "italic", 0.914, 0.759, 1.127]
      ] as const) {
        // Independent real-font ceilings, not a sample-word scale or production helper.
        expect(width("HiAW", { fontFamily, fontWeight, fontStyle })).toBeCloseTo(18 * (h + 0.601 + a + w));
      }
    }
  );
  it("never skips an unknown first family for a known fallback", () => {
    expect(width("HH", { fontFamily: "'Installed face', Arial" })).toBeCloseTo(18 * 0.815 * 2);
    expect(width("HH", { fontFamily: '"Arial", serif' })).toBeCloseTo(18 * 0.723 * 2);
  });
  it("bounds every tabulated face's characters with the unknown-family maximum", () => {
    const characters = [...new Set(Object.values(core14).flatMap(table => Object.keys(table)))].map(cp => String.fromCodePoint(Number(cp)));
    for (const fontStyle of ["normal", "italic"]) for (const fontWeight of [400, 700]) {
      for (const character of characters) {
        const maximum = width(character, { fontFamily: "Unknown", fontStyle, fontWeight });
        for (const fontFamily of ["Arial", "Helvetica", "Times", "Times New Roman", "Courier", "Courier New", "Georgia"]) {
          expect(maximum, `${character} ${fontFamily} ${fontStyle} ${fontWeight}`).toBeGreaterThanOrEqual(width(character, { fontFamily, fontStyle, fontWeight }));
        }
      }
    }
  });
  it("ships sourced chemistry/typography maxima for each style", () => {
    const characters = "→←↔≡≈±×·′″°⁺⁻⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉αβγδεζηθικλμνξοπρςστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩµÅ‰";
    for (const table of chemistryAdvanceCeilings) {
      for (const character of characters) expect(table[character.codePointAt(0)!], character).toBeGreaterThan(0);
    }
    // The sources have no ⇌/⇄ glyph: these explicitly follow the 1 em uncovered policy.
    expect(width("⇌⇄≡≈′⁺⁻₂")).toBeCloseTo(18 * (2 + 0.601 + 0.644 + 0.601 * 4));
    expect(width("≡≈′⁺⁻₂", { fontWeight: 700, fontStyle: "italic" }))
      .toBeCloseTo(18 * (0.601 + 0.704 + 0.601 * 4));
    expect(width("‰", { fontFamily: "Unknown" })).toBeCloseTo(18 * 1.206);
    expect(width("‰", { fontFamily: "Unknown", fontWeight: 700, fontStyle: "italic" })).toBeCloseTo(18 * 1.317);
  });
  it.each([false, true])("bounds Georgia's real advances (italic: %s)", italic => {
    const fontStyle = italic ? "italic" : "normal";
    expect(width("HHHHHHHHH", { fontFamily: "Georgia, serif", fontStyle })).toBeGreaterThanOrEqual(9 * 0.815 * 18);
    expect(width("HHHHHHHHH", { fontFamily: "Georgia", fontStyle, fontWeight: 700 })).toBeGreaterThanOrEqual(9 * 1870 / 2048 * 18);
    // A global scale derived from H alone misses Georgia's much wider punctuation.
    expect(width("||||", { fontFamily: "Georgia", fontStyle })).toBeGreaterThanOrEqual(4 * 0.375 * 18);
    expect(width("¯¯", { fontFamily: "Georgia", fontStyle, fontWeight: 700 })).toBeGreaterThanOrEqual(2 * 0.703125 * 18);
  });
  it("counts trailing tracking once per character, with the span's own spacing", () => {
    expect(width("C", { letterSpacingPx: 5 })).toBeCloseTo(18 * 0.723 + 5);
    expect(measureNativeTextSpanLineWidth([
      span("C", { style: { letterSpacingPx: 2 } }), span("C", { style: { letterSpacingPx: 5 } }), span("")
    ], style)).toBeCloseTo(18 * 0.723 * 2 + 7);
    expect(width("", { letterSpacingPx: 5 })).toBe(0);
    expect(width("ii", { letterSpacingPx: -2 })).toBeCloseTo(18 * 0.28 * 2 - 2);
  });
  it("clamps only the final tracking at zero for negative spacing, including across spans", () => {
    // Before per-glyph ceilings/trailing tracking: 9 * .722 * 18 - 8 * 2 = 100.964.
    expect(width("CCCCCCCCC", { letterSpacingPx: -2 })).toBeCloseTo(101.126);
    expect(width("CCCCCCCCC", { letterSpacingPx: -2 })).toBeGreaterThanOrEqual(100.964);
    expect(width("C", { letterSpacingPx: -20 })).toBeCloseTo(18 * 0.723);
    expect(measureNativeTextSpanLineWidth([
      span("C", { style: { letterSpacingPx: -2 } }), span("C", { style: { letterSpacingPx: -5 } }),
      span("", { style: { letterSpacingPx: 10 } })
    ], style)).toBeCloseTo(18 * 0.723 * 2 - 2);
    expect(measureNativeTextSpanLineWidth([
      span("C", { style: { letterSpacingPx: -2 } }), span("C", { style: { letterSpacingPx: 5 } })
    ], style)).toBeCloseTo(18 * 0.723 * 2 + 3);
  });
});
