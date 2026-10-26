import { nativeTextStyleFromObjectStyle, type NativeTextStyle, type TextSpan } from "@chemdraft/chem-core";

// Deterministic font estimates: shared by document sizing and SVG layout, including headless export.
// Native font metrics differ, so these are deliberately the same estimates used by text insertion.
export function estimateNativeTextLineWidth(line: string, style: NativeTextStyle): number {
  return [...line].reduce((width, character, index) => width +
    style.fontSizePx * characterWidthFactor(character) + (index > 0 ? style.letterSpacingPx : 0), 0);
}

function characterWidthFactor(character: string): number {
  if (character === "\t") return 1.6;
  if (character.trim().length === 0) return 0.34;
  if ("ilI.,:;!|".includes(character)) return 0.28;
  if ("mwMW@#%&".includes(character)) return 0.82;
  return /[A-Z0-9]/.test(character) ? 0.62 : 0.54;
}

type Glyph = { text: string; span: TextSpan; width: number; spacing: number };

/** Wrap at word boundaries, splitting overlong words without dropping characters or span styles. */
export function nativeTextSpanLines(
  spans: TextSpan[], style: NativeTextStyle, contentWidth?: number
): TextSpan[][] {
  return nativeTextSpanLayout(spans, style, contentWidth).map(line => line.spans);
}

export function nativeTextSpanLayout(
  spans: TextSpan[], style: NativeTextStyle, contentWidth?: number
): Array<{ spans: TextSpan[]; paragraphIndex: number }> {
  const paragraphs: Glyph[][] = [[]];
  let previousCarriageReturn = false;
  for (const span of spans) {
    const resolved = nativeTextStyleFromObjectStyle({ ...style, ...span.style });
    const scale = span.script === "normal" ? 1 : 0.72;
    for (const character of span.text) {
      if (character === "\r" || character === "\n") {
        if (!(character === "\n" && previousCarriageReturn)) paragraphs.push([]);
        previousCarriageReturn = character === "\r";
        continue;
      }
      previousCarriageReturn = false;
      paragraphs[paragraphs.length - 1]!.push({ text: character, span,
        width: resolved.fontSizePx * scale * characterWidthFactor(character), spacing: resolved.letterSpacingPx });
    }
  }
  const limit = contentWidth === undefined ? Infinity : Math.max(1, contentWidth);
  const result: Array<{ spans: TextSpan[]; paragraphIndex: number }> = [];
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    let line: Glyph[] = [];
    let width = 0;
    const flush = () => {
      const runs: TextSpan[] = [];
      let previous: TextSpan | undefined;
      for (const glyph of line) {
        if (glyph.span === previous) runs[runs.length - 1]!.text += glyph.text;
        else runs.push({ ...glyph.span, text: glyph.text });
        previous = glyph.span;
      }
      result.push({ spans: runs, paragraphIndex });
      line = [];
      width = 0;
    };
    for (let index = 0; index < paragraph.length;) {
      const whitespace = /\s/u.test(paragraph[index]!.text);
      let end = index + 1;
      while (end < paragraph.length && /\s/u.test(paragraph[end]!.text) === whitespace) end++;
      const token = paragraph.slice(index, end);
      const tokenWidth = token.reduce((total, glyph, i) => total + glyph.width +
        (i > 0 || line.length > 0 ? glyph.spacing : 0), 0);
      // Spaces remain at the end of the preceding line, as in pre-wrap CSS. They carry no ink.
      if (!whitespace && line.length > 0 && width + tokenWidth > limit) flush();
      for (const glyph of token) {
        const advance = glyph.width + (line.length > 0 ? glyph.spacing : 0);
        if (!whitespace && line.length > 0 && width + advance > limit) flush();
        width += glyph.width + (line.length > 0 ? glyph.spacing : 0);
        line.push(glyph);
      }
      index = end;
    }
    flush();
  }
  return result;
}
