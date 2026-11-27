import { nativeTextStyleFromObjectStyle, type NativeTextStyle, type TextObject, type TextSpan } from "@chemdraft/chem-core";
import { measureNativeTextSpanLineWidth } from "./textMetrics";

type Glyph = { text: string; span: TextSpan; offset: number };
function runs(glyphs: readonly Glyph[]): TextSpan[] {
  const result: TextSpan[] = [];
  let previous: TextSpan | undefined;
  for (const glyph of glyphs) {
    if (previous === glyph.span) result[result.length - 1]!.text += glyph.text;
    else result.push({ ...glyph.span, text: glyph.text });
    previous = glyph.span;
  }
  return result;
}
const breakSpace = (text: string) => /\s/u.test(text) && text !== "\u00a0" && text !== "\u202f";

/** One rendered line. `start`/`end` are UTF-16 offsets into the joined span text (the text
 * object's `text`); hard line breaks belong to no line. An empty line has start === end. */
export type NativeTextLayoutLine = { spans: TextSpan[]; paragraphIndex: number; start: number; end: number };

/** Deterministic wrapping using the current shared font/script metrics; never rewrites source text. */
export function nativeTextSpanLayout(spans: readonly TextSpan[], style: NativeTextStyle, contentWidth?: number):
  NativeTextLayoutLine[] {
  const paragraphs: Glyph[][] = [[]];
  const paragraphStarts = [0];
  let carriageReturn = false;
  let offset = 0;
  for (const span of spans) for (const text of span.text) {
    if (text === "\r" || text === "\n") {
      if (!(text === "\n" && carriageReturn)) { paragraphs.push([]); paragraphStarts.push(offset + 1); }
      else paragraphStarts[paragraphStarts.length - 1] = offset + 1;
      carriageReturn = text === "\r";
    } else {
      carriageReturn = false;
      paragraphs[paragraphs.length - 1]!.push({ span, text, offset });
    }
    offset += text.length;
  }
  const limit = contentWidth === undefined ? Infinity : Math.max(1, contentWidth);
  const measure = (glyphs: readonly Glyph[]) => measureNativeTextSpanLineWidth(runs(glyphs), style);
  const result: NativeTextLayoutLine[] = [];
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    let line: Glyph[] = [];
    let lineStart = paragraphStarts[paragraphIndex]!;
    const flush = () => {
      const start = line.length ? line[0]!.offset : lineStart;
      const last = line[line.length - 1];
      const end = last ? last.offset + last.text.length : start;
      result.push({ spans: runs(line), paragraphIndex, start, end });
      lineStart = end;
      line = [];
    };
    if (limit === Infinity) { line = paragraph; flush(); continue; }
    for (let index = 0; index < paragraph.length;) {
      const whitespace = breakSpace(paragraph[index]!.text);
      let end = index + 1;
      while (end < paragraph.length && breakSpace(paragraph[end]!.text) === whitespace) end++;
      const token = paragraph.slice(index, end);
      if (!whitespace && line.length && measure([...line, ...token]) > limit) flush();
      if (measure([...line, ...token]) <= limit || (!whitespace && !line.length && measure(token) <= limit)) line.push(...token);
      else {
        let rest = token;
        if (whitespace && line.length) { line.push(token[0]!); flush(); rest = token.slice(1); }
        for (const glyph of rest) {
          if (line.length && measure([...line, glyph]) > limit) flush();
          line.push(glyph);
        }
      }
      index = end;
    }
    flush();
  }
  return result;
}

/** Explicit baselines prevent a script run from shifting the following run or line.
 * Reserve each line's actual script ascent/descent before laying out its neighbor. */
export function nativeTextSpanMetrics(span: TextSpan, objectStyle: TextObject['style']): {fontSize:number;offset:number;ascent:number;descent:number} {
  const size=nativeTextStyleFromObjectStyle({...objectStyle,...span.style}).fontSizePx;
  const fontSize=Number((size*(span.script==='normal'?1:.72)).toFixed(6));
  const offset=Number((span.script==='subscript'?size*.22:span.script==='superscript'?-size*.4:0).toFixed(6));
  return {fontSize,offset,ascent:fontSize*.8-offset,descent:fontSize*.2+offset};
}
export function nativeTextObjectLineMetrics(object: Pick<TextObject,'text'|'spans'|'style'> & Partial<Pick<TextObject,'width'|'arrowAttachment'>>): {
  lines:{spans:TextSpan[];baseline:number;ascent:number;descent:number}[];height:number
} {
  const style=nativeTextStyleFromObjectStyle(object.style),layout=textObjectSpanLayout(object);
  let previousBaseline=0,previousDescent=0;
  const measured=layout.map(({spans,paragraphIndex},index)=>{
    const metrics=spans.map(span=>nativeTextSpanMetrics(span,object.style));
    const ascent=Math.max(style.fontSizePx*.8,...metrics.map(m=>m.ascent));
    const descent=Math.max(style.fontSizePx*.2,...metrics.map(m=>m.descent));
    const baseline=index===0?Math.max(style.fontSizePx,ascent+2):previousBaseline+
      Math.max(style.fontSizePx*style.lineHeight,previousDescent+ascent+style.fontSizePx*.18)+
        (paragraphIndex!==layout[index-1]!.paragraphIndex?style.paragraphSpacingPx:0);
    previousBaseline=baseline;previousDescent=descent;
    return {spans,baseline,ascent,descent};
  });
  return {lines:measured,height:previousBaseline+previousDescent+2};
}

type TextLayoutObject = Pick<TextObject, "text" | "spans"> & Partial<Pick<TextObject, "style" | "width" | "arrowAttachment">>;
function isFixedWidthTextObject(object: TextLayoutObject): boolean {
  return typeof object.width === "number" &&
    (object.style?.textBoxSizingMode === "fixed-width" || object.style?.textBoxSizingMode === "fixed-size") &&
    object.arrowAttachment?.kind !== "conditions" && !(object.text === "+" && object.style?.reactionPlus === true);
}
/** @internal Whether a text object wraps at its stored width (fixed width/size, not conditions or reaction plus). */
export function textObjectWrapsAtWidth(object: TextLayoutObject): boolean {
  return isFixedWidthTextObject(object);
}
/** @internal The rendered lines of a text object, with text offsets; shared by SVG, sizing and the editor. */
export function textObjectSpanLayout(object: TextLayoutObject) {
  return nativeTextSpanLayout(textObjectSpansForRendering(object), nativeTextStyleFromObjectStyle(object.style ?? {}),
    isFixedWidthTextObject(object) ? Math.max(1, object.width! - 6) : undefined);
}
export function textObjectSpanLines(object: TextLayoutObject): TextSpan[][] {
  return textObjectSpanLayout(object).map(line => line.spans);
}

export function textObjectSpansForRendering(object: Pick<TextObject, "text" | "spans">): TextSpan[] {
  const spans = object.spans.filter((span) => span.text.length > 0);
  if (spans.length > 0 && spans.map((span) => span.text).join("") === object.text) {
    return spans;
  }

  return [{ text: object.text, script: "normal", style: {} }];
}
