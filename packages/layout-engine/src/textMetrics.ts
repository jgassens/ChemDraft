import type { NativeTextStyle, TextSpan } from "@chemdraft/chem-core";
import { patrickHandAdvances } from "./patrickHandMetrics.generated";
import {
  helveticaAdvances, helveticaBoldAdvances, timesAdvances, timesBoldAdvances,
  timesItalicAdvances, timesBoldItalicAdvances, courierAdvances
} from "./textMetrics.generated";
import {
  arialAdvanceCeilings, timesAdvanceCeilings, courierAdvanceCeilings, georgiaAdvanceCeilings,
  chemistryAdvanceCeilings
} from "./nativeFontCeilings.generated";

export function isPatrickHandFont(fontFamily: string): boolean {
  return fontFamily.split(",")[0]!.trim().replace(/["']/g, "").toLowerCase() === "patrick hand";
}

/** Exact advances from the bundled 1.003 face; independent of installed system fonts. */
export function patrickHandTextAdvanceEm(text: string): number {
  return [...text].reduce((sum, character) => sum + (patrickHandAdvances[character.codePointAt(0)!] ?? textAdvanceEm(character)), 0);
}

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

function nativeTextAdvances(fontFamily: string, bold: boolean, italic: boolean): {
  advances: Readonly<Record<number, number>>;
  ceilings: Readonly<Record<number, number>>;
} | undefined {
  // Do not skip an unknown first family: it may be installed and wider than its fallback.
  const family = fontFamily.split(",")[0]!.trim().toLowerCase().replace(/["']/g, "");
  if (isPatrickHandFont(fontFamily)) return {
    advances: { ...helveticaAdvances, ...patrickHandAdvances },
    ceilings: { ...arialAdvanceCeilings[(bold ? 1 : 0) + (italic ? 2 : 0)]!, ...patrickHandAdvances }
  };
  const face = (bold ? 1 : 0) + (italic ? 2 : 0);
  if (["courier", "courier new"].includes(family)) {
    return { advances: courierAdvances, ceilings: courierAdvanceCeilings[face]! };
  }
  if (["times", "times new roman", "georgia"].includes(family)) {
    return {
      advances: italic ? (bold ? timesBoldItalicAdvances : timesItalicAdvances) : (bold ? timesBoldAdvances : timesAdvances),
      ceilings: (family === "georgia" ? georgiaAdvanceCeilings : timesAdvanceCeilings)[face]!
    };
  }
  if (["arial", "helvetica"].includes(family)) {
    return { advances: bold ? helveticaBoldAdvances : helveticaAdvances, ceilings: arialAdvanceCeilings[face]! };
  }
  return undefined;
}

// Resolve once from the shipped tables, never from host fonts. Generic CSS families
// have no fixed real face, so they use the same per-character maximum as unknown ones.
const fallbackAdvances = [0, 1, 2, 3].map(face => {
  const bold = (face & 1) !== 0, italic = (face & 2) !== 0;
  const tables = ["Arial", "Times", "Courier", "Georgia"].flatMap(family => {
    const metrics = nativeTextAdvances(family, bold, italic)!;
    return [metrics.advances, metrics.ceilings];
  });
  const codePoints = new Set(tables.flatMap(table => Object.keys(table).map(Number)));
  return Object.fromEntries([...codePoints].map(cp => [cp, Math.max(...tables.map(table => table[cp] ?? 0))]));
});

/** Content width for ONE explicit line, without box padding or implicit wrapping.
 * Core14 Helvetica (sans), Times (serif), Courier (mono), with Symbol Greek/arrows.
 * Known families use per-glyph upward corrections from real font advances (README.md).
 * Unknown/generic first families take the per-character maximum of the known faces.
 * Uncovered glyphs use the sourced chemistry fallback, then 1 em. No host font access or shaping.
 * Return max(legacy whole-line estimate, metric whole-line width), so existing sizing
 * never gets narrower. Scripts use the renderer's parent-size scale; tracking continues
 * after EVERY character; the final character's tracking is clamped at zero so negative
 * tracking never removes the final advance. This shared
 * result feeds both automatic stored-box sizing and the transient editor frame. */
export function measureNativeTextSpanLineWidth(spans: readonly TextSpan[], style: NativeTextStyle): number {
  let legacyWidth = 0;
  let metricWidth = 0;
  let count = 0;
  let finalLetterSpacing = 0;
  for (const span of spans) {
    const fontSize = span.script === "normal"
      ? (typeof span.style.fontSizePx === "number" ? span.style.fontSizePx : style.fontSizePx)
      : style.fontSizePx * nativeTextScriptFontScale;
    const letterSpacing = typeof span.style.letterSpacingPx === "number" ? span.style.letterSpacingPx : style.letterSpacingPx;
    const bold = (typeof span.style.fontWeight === "number" ? span.style.fontWeight : style.fontWeight) >= 600;
    const italic = (span.style.fontStyle ?? style.fontStyle) === "italic";
    const face = (bold ? 1 : 0) + (italic ? 2 : 0);
    const advances = nativeTextAdvances(
      typeof span.style.fontFamily === "string" ? span.style.fontFamily : style.fontFamily,
      bold, italic
    );
    for (const character of span.text) {
      const codePoint = character.codePointAt(0)!;
      // Keep the historical whole-line floor verbatim, including negative tracking.
      legacyWidth += fontSize * nativeTextCharacterWidthFactor(character) + (count > 0 ? letterSpacing : 0);
      const advance = advances
        ? (advances.advances[codePoint] === undefined && advances.ceilings[codePoint] === undefined ? undefined
          : Math.max(advances.advances[codePoint] ?? 0, advances.ceilings[codePoint] ?? 0))
        : fallbackAdvances[face]![codePoint];
      metricWidth += fontSize * (advance ?? chemistryAdvanceCeilings[face]![codePoint] ?? 1) + letterSpacing;
      finalLetterSpacing = letterSpacing;
      count += 1;
    }
  }
  metricWidth -= Math.min(0, finalLetterSpacing);
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
