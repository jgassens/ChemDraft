import type { NativeTextStyle, TextSpan } from "@chemdraft/chem-core";
import {
  helveticaAdvances, helveticaBoldAdvances, timesAdvances, timesBoldAdvances,
  timesItalicAdvances, timesBoldItalicAdvances, courierAdvances
} from "./textMetrics.generated";

/** Explicit SVG script metrics. Offsets are in PARENT em, independent of script size.
 * WebKit/Chromium's historical sub/super placement was approximately this offset;
 * explicit sizes and coordinates also work in svg2pdf without host font metrics. */
export const nativeTextScriptFontScale = 0.72;
export const nativeTextSubscriptOffsetEm = 0.4;
export const nativeTextSuperscriptOffsetEm = nativeTextSubscriptOffsetEm;

/** Native text estimates for the default Arial/Helvetica stack. Ink metrics are em fractions. */
export const nativeTextMetrics = {
  descentEm: 0.21,
  capHeightEm: 0.716
} as const;

/** Subscript ink reaches its baseline unless the span contains a descender glyph. */
export function nativeTextSubscriptBottomEm(text: string): number {
  const hasDescender = /[gjpqyQ()[\]{},;|_]/.test(text);
  return nativeTextSubscriptOffsetEm
    + (hasDescender ? nativeTextScriptFontScale * nativeTextMetrics.descentEm : 0);
}

export function nativeTextCharacterWidthFactor(character: string): number {
  if (character === "\t") return 1.6;
  if (character.trim().length === 0) return 0.34;
  if ("ilI.,:;!|".includes(character)) return 0.28;
  if ("mwMW@#%&".includes(character)) return 0.82;
  if (/[A-Z0-9]/.test(character)) return 0.62;
  return 0.54;
}

function nativeTextAdvances(fontFamily: string, bold: boolean, italic: boolean): Readonly<Record<number, number>> {
  // Resolve the first known family in a CSS stack. Unknown stacks use Helvetica.
  for (const family of fontFamily.toLowerCase().split(",").map(name => name.trim().replace(/["']/g, ""))) {
    if (["courier", "courier new", "monospace", "menlo", "monaco", "consolas"].includes(family)) return courierAdvances;
    if (["times", "times new roman", "georgia", "serif"].includes(family)) {
      return italic ? (bold ? timesBoldItalicAdvances : timesItalicAdvances) : (bold ? timesBoldAdvances : timesAdvances);
    }
    if (["arial", "helvetica", "helvetica neue", "sans-serif"].includes(family)) break;
  }
  return bold ? helveticaBoldAdvances : helveticaAdvances;
}

/** Content width for ONE explicit line, without box padding or implicit wrapping.
 * Core14 Helvetica (sans), Times (serif), Courier (mono), with Symbol Greek/arrows.
 * Unknown fonts use the first known stack fallback, otherwise Helvetica; uncovered glyphs
 * use 0.62 em. This is deterministic advance measurement, without kerning or shaping.
 * Return max(legacy whole-line estimate, metric whole-line width), so existing sizing
 * never gets narrower. Scripts use the renderer's parent-size scale; tracking continues
 * across spans. Helvetica oblique and every Courier face share upright advances. */
export function measureNativeTextSpanLineWidth(spans: readonly TextSpan[], style: NativeTextStyle): number {
  let legacyWidth = 0;
  let metricWidth = 0;
  let count = 0;
  for (const span of spans) {
    const fontSize = span.script === "normal"
      ? (typeof span.style.fontSizePx === "number" ? span.style.fontSizePx : style.fontSizePx)
      : style.fontSizePx * nativeTextScriptFontScale;
    const letterSpacing = typeof span.style.letterSpacingPx === "number" ? span.style.letterSpacingPx : style.letterSpacingPx;
    const advances = nativeTextAdvances(
      typeof span.style.fontFamily === "string" ? span.style.fontFamily : style.fontFamily,
      (typeof span.style.fontWeight === "number" ? span.style.fontWeight : style.fontWeight) >= 600,
      (span.style.fontStyle ?? style.fontStyle) === "italic"
    );
    for (const character of span.text) {
      const spacing = count > 0 ? letterSpacing : 0;
      legacyWidth += fontSize * nativeTextCharacterWidthFactor(character) + spacing;
      metricWidth += fontSize * (advances[character.codePointAt(0)!] ?? 0.62) + spacing;
      count += 1;
    }
  }
  // Round metrics upward at sub-pixel precision to avoid summation undershooting an advance.
  return Math.max(legacyWidth, Math.ceil(metricWidth * 1e9) / 1e9);
}

export function textAdvanceEm(character: string, { bold = false }: { bold?: boolean } = {}): number {
  const codePoint = character.codePointAt(0);
  return codePoint === undefined ? 0.62 : (bold ? helveticaBoldAdvances : helveticaAdvances)[codePoint] ?? 0.62;
}

export function measureTextRun(text: string, {
  fontSizePx, fontWeight = 400, script = "normal"
}: { fontSizePx: number; fontWeight?: number; script?: "normal" | "subscript" | "superscript" }): number {
  const em = [...text].reduce((sum, character) => sum + textAdvanceEm(character, { bold: fontWeight >= 600 }), 0);
  return em * fontSizePx * (script === "normal" ? 1 : nativeTextScriptFontScale);
}
