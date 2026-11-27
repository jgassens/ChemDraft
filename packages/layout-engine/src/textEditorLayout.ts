import { nativeTextStyleFromObjectStyle, type TextObject, type TextSpan } from "@chemdraft/chem-core";
import { measureNativeTextSpanLineWidth } from "./textMetrics";
import { nativeTextLineAdvance, planTextObjectPlacement } from "./textPlacement";
import {
  nativeTextObjectLineMetrics, nativeTextRenderedSpanMetrics, nativeTextSpanMetrics, textObjectSpanLayout, textObjectWrapsAtWidth, type NativeTextLayoutLine
} from "./textLayout";

/**
 * Text box text holds LF line breaks only (docs/plans/textbox-behavior.md). A textarea's value
 * turns CRLF and a lone CR into LF, so a CR kept in the stored text would put every later model
 * offset one past the editor's: a press, a drag or a typed key would land a character off.
 * Text is normalized wherever it enters a box (paste, creation, every commit), and the editor
 * reads an object that still holds CR (an older file) through this same normalization.
 */
export function normalizeTextLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** The object with CRLF and lone CR turned into LF in its text and runs. A CRLF split across
 * two runs becomes one LF; a run left empty is dropped. Returns the same object when it has no CR. */
export function textObjectWithNormalizedLineBreaks<T extends Pick<TextObject, "text" | "spans">>(object: T): T {
  if (!object.text.includes("\r") && !object.spans.some(span => span.text.includes("\r"))) return object;
  let carriageReturn = false;
  const spans = object.spans.map(span => {
    let text = "";
    for (const character of span.text) {
      if (character === "\n" && carriageReturn) { carriageReturn = false; continue; }
      carriageReturn = character === "\r";
      text += carriageReturn ? "\n" : character;
    }
    return { ...span, text };
  }).filter(span => span.text.length > 0);
  return { ...object, text: normalizeTextLineBreaks(object.text), spans };
}

/**
 * The text box editor's single layout model: the same lines, baselines and alignment anchor
 * the page SVG draws (planTextObjectSvg), with each line's text offsets. The caret, the
 * selection highlight, pointer hit-testing, vertical caret movement and the box height all
 * read this; the editor's textarea is only an input sink and its own browser layout is
 * never shown. Coordinates are page units relative to the object's unrotated frame origin
 * (object.x, object.y).
 */
export interface NativeTextEditorLine {
  index: number;
  paragraphIndex: number;
  /** UTF-16 offsets into the LF-normalized text (the editor's textarea value); hard line
   * breaks belong to no line. */
  start: number;
  end: number;
  /** True when the next line continues the same paragraph (a soft wrap follows this line). */
  softWrapAfter: boolean;
  baseline: number;
  top: number;
  bottom: number;
  /** x of each caret position start..end (end - start + 1 entries). Ascending for
   * left-to-right text; right-to-left runs make them descend. */
  stops: number[];
}

export interface NativeTextEditorLayout {
  lines: NativeTextEditorLine[];
  textLength: number;
}

/** A caret position. At a soft wrap the same offset ends one line and starts the next;
 * "downstream" (the default) is the start of the next line, where typed text goes. */
export type NativeTextCaretAffinity = "upstream" | "downstream";

/** Rendered x of every caret stop on a line, from the browser's SVG glyphs. Optional: hosts
 * without layout (and exports) use the shared character advances. */
export type NativeTextEditorStopMeasure = (line: { index: number; start: number; end: number }) =>
  readonly number[] | undefined;

type TextBoxLayoutInput = Pick<TextObject, "text" | "spans" | "style"> & Partial<Pick<TextObject, "width" | "arrowAttachment">>;

/** Baseline, ascent and descent of each rendered line, as planTextObjectSvg places them:
 * explicit metrics when the box wraps, else a fixed advance per line. Each run's band is the
 * one the text box SVG draws (a script run at the parent's script size and offset); reaction
 * conditions and pluses are drawn with their own script metrics, so they keep those. */
function renderedLineBands(object: TextBoxLayoutInput, layout: readonly NativeTextLayoutLine[]) {
  const style = nativeTextStyleFromObjectStyle(object.style);
  const metrics = textObjectWrapsAtWidth(object) ? nativeTextObjectLineMetrics(object) : undefined;
  const lineAdvance = nativeTextLineAdvance(style);
  const ownScriptMetrics = object.arrowAttachment?.kind === "conditions" ||
    (object.text === "+" && object.style?.reactionPlus === true);
  const spanMetrics = ownScriptMetrics ? nativeTextSpanMetrics : nativeTextRenderedSpanMetrics;
  return layout.map((line, index) => {
    const runs = line.spans.map(span => spanMetrics(span, object.style));
    return {
      baseline: metrics ? metrics.lines[index]!.baseline : style.fontSizePx + index * lineAdvance,
      ascent: Math.max(style.fontSizePx * 0.8, ...runs.map(metric => metric.ascent)),
      descent: Math.max(style.fontSizePx * 0.2, ...runs.map(metric => metric.descent))
    };
  });
}

/** Offsets are the editor's: the object's text with its line breaks normalized to LF, which
 * is what the textarea holds. Lines, baselines and glyph x are the same either way. */
export function planNativeTextEditorLayout(source: TextObject, measureStops?: NativeTextEditorStopMeasure): NativeTextEditorLayout {
  const object = textObjectWithNormalizedLineBreaks(source);
  const placement = planTextObjectPlacement(object);
  const style = placement.style;
  const layout = textObjectSpanLayout(object);
  const bands = renderedLineBands(object, layout);
  const anchorX = placement.x - object.x;
  const lines = layout.map((line, index): NativeTextEditorLine => {
    const { baseline, ascent, descent } = bands[index]!;
    const next = layout[index + 1];
    const measured = measureStops?.({ index, start: line.start, end: line.end });
    const stops = measured && measured.length === line.end - line.start + 1 && measured.every(Number.isFinite)
      ? [...measured]
      : estimatedStops(line.spans, style, anchorX, placement.alignment);
    return {
      index, paragraphIndex: line.paragraphIndex, start: line.start, end: line.end,
      softWrapAfter: next !== undefined && next.paragraphIndex === line.paragraphIndex,
      baseline, top: baseline - ascent, bottom: baseline + descent, stops
    };
  });
  return { lines, textLength: object.text.length };
}

function estimatedStops(spans: readonly TextSpan[], style: ReturnType<typeof nativeTextStyleFromObjectStyle>,
  anchorX: number, alignment: number): number[] {
  const prefixes: number[] = [0];
  const done: TextSpan[] = [];
  for (const span of spans) {
    let text = "";
    for (const character of span.text) {
      text += character;
      const width = measureNativeTextSpanLineWidth([...done, { ...span, text }], style);
      // Surrogate pairs are one glyph but two offsets; the inner offset shares the glyph start.
      if (character.length === 2) prefixes.push(prefixes[prefixes.length - 1]!);
      prefixes.push(width);
    }
    done.push(span);
  }
  const left = anchorX - alignment * prefixes[prefixes.length - 1]!;
  return prefixes.map(prefix => left + prefix);
}

function clampOffset(layout: NativeTextEditorLayout, offset: number): number {
  return Math.max(0, Math.min(layout.textLength, Math.round(offset)));
}

/** The rendered line that shows a caret at this offset. */
export function nativeTextEditorLineIndex(layout: NativeTextEditorLayout, offset: number,
  affinity: NativeTextCaretAffinity = "downstream"): number {
  const at = clampOffset(layout, offset);
  const { lines } = layout;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (at < line.start) return Math.max(0, index - 1);
    if (at < line.end) return index;
    if (at === line.end) {
      // At a soft wrap the downstream caret belongs to the next line (where typing lands).
      if (line.softWrapAfter && affinity === "downstream" && lines[index + 1]!.start === at) continue;
      return index;
    }
  }
  return Math.max(0, lines.length - 1);
}

export function nativeTextEditorCaret(layout: NativeTextEditorLayout, offset: number,
  affinity: NativeTextCaretAffinity = "downstream"): { lineIndex: number; x: number; top: number; bottom: number } {
  const lineIndex = nativeTextEditorLineIndex(layout, offset, affinity);
  const line = layout.lines[lineIndex]!;
  const local = Math.max(0, Math.min(line.end, clampOffset(layout, offset)) - line.start);
  return { lineIndex, x: line.stops[Math.min(local, line.stops.length - 1)]!, top: line.top, bottom: line.bottom };
}

/** One rectangle per rendered line the range covers, spanning the glyph stops the range
 * touches on that line, so right-to-left runs (descending stops) are highlighted too. A range
 * continuing past a line's end includes a small break marker, on the side where the line
 * ends, so a selected line break is visible. */
export function nativeTextEditorSelectionRects(layout: NativeTextEditorLayout, start: number, end: number):
  Array<{ lineIndex: number; left: number; right: number; top: number; bottom: number }> {
  const from = clampOffset(layout, Math.min(start, end)), to = clampOffset(layout, Math.max(start, end));
  if (from === to) return [];
  return layout.lines.flatMap(line => {
    const lineFrom = Math.max(from, line.start), lineTo = Math.min(to, line.end);
    const continues = to > line.end && from <= line.end && !line.softWrapAfter && line.index < layout.lines.length - 1;
    if (lineFrom > lineTo || (lineFrom === lineTo && !continues)) return [];
    const touched = line.stops.slice(lineFrom - line.start, lineTo - line.start + 1);
    let left = Math.min(...touched), right = Math.max(...touched);
    if (continues) {
      const marker = (line.bottom - line.top) * 0.3;
      // A right-to-left line ends at its left edge.
      if (line.stops[line.stops.length - 1]! < line.stops[0]!) left -= marker; else right += marker;
    }
    return [{ lineIndex: line.index, left, right, top: line.top, bottom: line.bottom }];
  });
}

/** The caret stop nearest x. Past either visual edge, the stop at that edge (the logical start
 * or end of a line in one direction; a right-to-left line starts at its right edge). */
function offsetOnLine(line: NativeTextEditorLine, x: number): { offset: number; affinity: NativeTextCaretAffinity } {
  const { stops } = line;
  const leftmost = Math.min(...stops), rightmost = Math.max(...stops);
  let best = 0;
  if (x >= rightmost) best = stops.lastIndexOf(rightmost);
  else if (x <= leftmost) best = stops.indexOf(leftmost);
  else {
    for (let index = 1; index < stops.length; index++) {
      if (Math.abs(stops[index]! - x) < Math.abs(stops[best]! - x)) best = index;
    }
  }
  const offset = line.start + best;
  return { offset, affinity: offset === line.end && line.softWrapAfter ? "upstream" : "downstream" };
}

/** Caret position for a point over the rendered text (object-relative, unrotated page units). */
export function nativeTextEditorOffsetAtPoint(layout: NativeTextEditorLayout, point: { x: number; y: number }):
  { offset: number; affinity: NativeTextCaretAffinity } {
  const { lines } = layout;
  let lineIndex = lines.length - 1;
  for (let index = 0; index < lines.length - 1; index++) {
    // Split neighbouring lines halfway between their caret extents.
    if (point.y < (lines[index]!.bottom + lines[index + 1]!.top) / 2) { lineIndex = index; break; }
  }
  return offsetOnLine(lines[Math.max(0, lineIndex)]!, point.x);
}

/** ArrowUp/ArrowDown over the rendered lines, keeping the goal column. */
export function nativeTextEditorVerticalMove(layout: NativeTextEditorLayout, offset: number,
  affinity: NativeTextCaretAffinity, direction: -1 | 1, goalX?: number):
  { offset: number; affinity: NativeTextCaretAffinity; goalX: number } {
  const caret = nativeTextEditorCaret(layout, offset, affinity);
  const x = goalX ?? caret.x;
  const target = layout.lines[caret.lineIndex + direction];
  if (!target) return { offset: direction < 0 ? 0 : layout.textLength, affinity: "downstream", goalX: x };
  return { ...offsetOnLine(target, x), goalX: x };
}

/** Start or end of the rendered line holding the caret (Home/End, Cmd+Left/Right). */
export function nativeTextEditorLineBoundary(layout: NativeTextEditorLayout, offset: number,
  affinity: NativeTextCaretAffinity, edge: "start" | "end"): { offset: number; affinity: NativeTextCaretAffinity } {
  const line = layout.lines[nativeTextEditorLineIndex(layout, offset, affinity)]!;
  return edge === "start" ? { offset: line.start, affinity: "downstream" }
    : { offset: line.end, affinity: line.softWrapAfter ? "upstream" : "downstream" };
}

type Grapheme = { start: number; end: number; text: string };

/** User-perceived characters with their UTF-16 offsets: Intl.Segmenter where the runtime has
 * it, else code points (so a surrogate pair is never split). */
function graphemes(text: string): Grapheme[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
      .map(({ index, segment }) => ({ start: index, end: index + segment.length, text: segment }));
  }
  const result: Grapheme[] = [];
  let offset = 0;
  for (const character of text) {
    result.push({ start: offset, end: offset + character.length, text: character });
    offset += character.length;
  }
  return result;
}

/** Double-click word: a run of letters/digits (or of whitespace, or one other character), in
 * whole graphemes, so an emoji or an astral letter is never cut in half. */
export function nativeTextEditorWordRange(text: string, offset: number): { start: number; end: number } {
  const at = Math.max(0, Math.min(text.length, offset));
  const kind = (grapheme: Grapheme | undefined) => grapheme === undefined ? undefined
    : /^[\p{L}\p{N}\p{M}_'’]/u.test(grapheme.text) ? "word"
      : /^\s/u.test(grapheme.text) && !/[\r\n]/.test(grapheme.text) ? "space" : "other";
  const all = graphemes(text);
  if (all.length === 0) return { start: at, end: at };
  // The grapheme under the offset (even mid-grapheme), else the last one (at the end of the text).
  const found = all.findIndex(grapheme => grapheme.start <= at && at < grapheme.end);
  const index = found < 0 ? all.length - 1 : found;
  const here = kind(all[index]);
  if (here === "other") return { start: all[index]!.start, end: all[index]!.end };
  let first = index, last = index;
  while (first > 0 && kind(all[first - 1]) === here) first--;
  while (last < all.length - 1 && kind(all[last + 1]) === here) last++;
  return { start: all[first]!.start, end: all[last]!.end };
}

/** Triple-click paragraph: between hard line breaks. */
export function nativeTextEditorParagraphRange(text: string, offset: number): { start: number; end: number } {
  const at = Math.max(0, Math.min(text.length, offset));
  let start = at, end = at;
  while (start > 0 && text[start - 1] !== "\n" && text[start - 1] !== "\r") start--;
  while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end++;
  return { start, end };
}

/** Same vertical allowance as native text sizing (document-workflow-core textObjects.ts). */
export const nativeTextBoxVerticalPaddingPx = 4;

/** Below the lowest drawn line: the same allowance as nativeTextObjectLineMetrics's height. */
const nativeTextBoxContentBottomPaddingPx = 2;

/** Natural box height from the lines the SVG draws: one source for both wrap modes. Auto
 * width never wraps, so its height counts only its paragraphs, even when its width is capped.
 * Never below the lowest drawn line (H2), in either mode: a small line height, a large run or
 * a subscript can draw below the line count's nominal height. */
export function nativeTextObjectBoxHeight(object: TextBoxLayoutInput): number {
  const style = nativeTextStyleFromObjectStyle(object.style);
  const lines = textObjectSpanLayout(object);
  const paragraphs = lines.length ? lines[lines.length - 1]!.paragraphIndex + 1 : 1;
  const lineCount = Math.max(1, lines.length);
  const natural = lineCount * style.fontSizePx * style.lineHeight
    + Math.max(0, paragraphs - 1) * style.paragraphSpacingPx + nativeTextBoxVerticalPaddingPx;
  const contentBottom = Math.max(0, ...renderedLineBands(object, lines).map(band => band.baseline + band.descent));
  return Math.max(natural, contentBottom + nativeTextBoxContentBottomPaddingPx);
}
