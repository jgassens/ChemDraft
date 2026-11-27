import { describe, expect, it } from "vitest";
import type { TextObject } from "@chemdraft/chem-core";
import {
  nativeTextEditorCaret, nativeTextEditorLineBoundary, nativeTextEditorOffsetAtPoint, nativeTextEditorParagraphRange,
  nativeTextEditorSelectionRects, nativeTextEditorVerticalMove, nativeTextEditorWordRange, nativeTextObjectBoxHeight,
  planNativeTextEditorLayout, planTextObjectSvg, textObjectSpanLines, textObjectWithNormalizedLineBreaks
} from "./index";

const TEXT = "now is the time for all good men to come to the aid of their party. and do other things in this day and age... jhehehehe'";

function box(text: string, width: number, mode: "fixed-width" | "auto" = "fixed-width", extra: Partial<TextObject["style"]> = {}): TextObject {
  return {
    id: "t1", type: "text", x: 100, y: 50, width, height: 40, rotation: 0,
    style: { fontFamily: "Arial", fontSizePx: 12, lineHeight: 1.2, textBoxSizingMode: mode, ...extra },
    compatibility: { sourceFormat: "chemdraft-native", warnings: [], unknown: {} },
    text, spans: [{ text, script: "normal", style: {} }]
  } as TextObject;
}

describe("text editor layout model", () => {
  it("partitions the text into the SVG's rendered lines, with hard breaks on no line", () => {
    for (const text of [TEXT, "alpha\nbeta\r\ngamma\r", "\n\nx", "", "hehehe ".repeat(9)]) {
      const object = box(text, 120);
      const layout = planNativeTextEditorLayout(object);
      // Offsets are the editor's: line breaks normalized to LF, as the textarea holds them.
      const editorText = text.replace(/\r\n?/g, "\n");
      expect(layout.textLength).toBe(editorText.length);
      expect(layout.lines.map(line => editorText.slice(line.start, line.end)))
        .toEqual(textObjectSpanLines(object).map(line => line.map(span => span.text).join("")));
      for (const line of layout.lines) expect(line.stops).toHaveLength(line.end - line.start + 1);
      // Every non-break character sits on exactly one line.
      const covered = layout.lines.reduce((sum, line) => sum + line.end - line.start, 0);
      expect(covered).toBe(text.replace(/[\r\n]/g, "").length);
    }
  });

  it("counts a CRLF or a lone CR as one offset, as the editor's textarea does", () => {
    // A textarea's value turns CRLF into LF; model offsets must be the textarea's offsets.
    const layout = planNativeTextEditorLayout(box("a\r\nb", 120));
    expect(layout.textLength).toBe(3);
    expect(layout.lines.map(line => [line.start, line.end])).toEqual([[0, 1], [2, 3]]);
    expect(nativeTextEditorCaret(layout, 3).lineIndex).toBe(1);
    expect(nativeTextEditorCaret(layout, 3).x).toBe(layout.lines[1]!.stops[1]);
    // A long wrapped paragraph after CRLF, and a lone CR, lay out exactly like their LF text.
    for (const [raw, lf] of [[`first\r\n${TEXT}`, `first\n${TEXT}`], [`first\r${TEXT}\r\rlast`, `first\n${TEXT}\n\nlast`]]) {
      const fromRaw = planNativeTextEditorLayout(box(raw!, 200));
      const fromLf = planNativeTextEditorLayout(box(lf!, 200));
      expect(fromRaw.lines.length).toBeGreaterThan(3);
      expect(fromRaw).toEqual(fromLf);
    }
  });

  it("normalizes CRLF and lone CR in text and runs, a CRLF split across runs to one LF", () => {
    const object = {
      text: "a\r\nb\rc\r\nd",
      spans: [
        { text: "a\r", script: "normal", style: { fontWeight: "bold" } },
        { text: "\nb\r", script: "normal", style: {} },
        { text: "c\r\nd", script: "subscript", style: {} }
      ]
    } as Pick<TextObject, "text" | "spans">;
    const normalized = textObjectWithNormalizedLineBreaks(object);
    expect(normalized.text).toBe("a\nb\nc\nd");
    expect(normalized.spans).toEqual([
      { text: "a\n", script: "normal", style: { fontWeight: "bold" } },
      { text: "b\n", script: "normal", style: {} },
      { text: "c\nd", script: "subscript", style: {} }
    ]);
    expect(normalized.spans.map(span => span.text).join("")).toBe(normalized.text);
    const plain = { text: "a\nb", spans: [] };
    expect(textObjectWithNormalizedLineBreaks(plain)).toBe(plain);
  });

  it("uses the SVG's own baselines in both wrap modes (C1)", () => {
    for (const mode of ["fixed-width", "auto"] as const) {
      const object = box("one two three four five six\nseven", 80, mode);
      const layout = planNativeTextEditorLayout(object);
      const svg = planTextObjectSvg(object, 0) as unknown as { children: Array<{ attrs: { y?: number } }> };
      if (mode === "fixed-width") {
        const baselines = svg.children.map(child => child.attrs.y! - object.y);
        expect(baselines).toHaveLength(layout.lines.length);
        baselines.forEach((baseline, index) => expect(layout.lines[index]!.baseline).toBeCloseTo(baseline, 9));
      } else {
        expect(layout.lines.map(line => line.baseline)).toEqual([12, 12 + 14.4]);
      }
    }
  });

  it("draws the caret at the end of wrapped text on the last rendered line (C1)", () => {
    const object = box(TEXT, 230);
    const layout = planNativeTextEditorLayout(object);
    const last = layout.lines[layout.lines.length - 1]!;
    const caret = nativeTextEditorCaret(layout, TEXT.length);
    expect(caret.lineIndex).toBe(layout.lines.length - 1);
    expect(caret.x).toBe(last.stops[last.stops.length - 1]);
  });

  it("puts a soft-wrap caret on the next line (downstream) unless asked for the line end (C1)", () => {
    const layout = planNativeTextEditorLayout(box(TEXT, 230));
    const [first, second] = layout.lines;
    expect(first!.softWrapAfter).toBe(true);
    expect(nativeTextEditorCaret(layout, first!.end).lineIndex).toBe(1);
    expect(nativeTextEditorCaret(layout, first!.end).x).toBe(second!.stops[0]);
    expect(nativeTextEditorCaret(layout, first!.end, "upstream").lineIndex).toBe(0);
  });

  it("puts a trailing space that overflows on a new empty line, where the next character goes (C1, H1)", () => {
    const base = "it should not have delete";
    let text = base;
    // Grow until a trailing space overflows the first line.
    while (planNativeTextEditorLayout(box(`${text} `, 140)).lines.length === 1) text += "x";
    const layout = planNativeTextEditorLayout(box(`${text} `, 140));
    expect(layout.lines).toHaveLength(2);
    expect(nativeTextEditorCaret(layout, text.length + 1).lineIndex).toBe(1);
    const typed = planNativeTextEditorLayout(box(`${text} b`, 140));
    expect(typed.lines).toHaveLength(2);
    expect(nativeTextEditorCaret(typed, text.length + 2).lineIndex).toBe(1);
  });

  it("hit-tests every caret stop back to its offset (C2)", () => {
    const object = box(`${TEXT}\nsecond paragraph`, 200);
    const layout = planNativeTextEditorLayout(object);
    for (const line of layout.lines) {
      for (let offset = line.start; offset <= line.end; offset++) {
        const caret = nativeTextEditorCaret(layout, offset, offset === line.end ? "upstream" : "downstream");
        const hit = nativeTextEditorOffsetAtPoint(layout, { x: caret.x, y: (caret.top + caret.bottom) / 2 });
        expect(hit.offset).toBe(offset);
      }
    }
    expect(nativeTextEditorOffsetAtPoint(layout, { x: -50, y: -50 }).offset).toBe(0);
    expect(nativeTextEditorOffsetAtPoint(layout, { x: 1000, y: 1000 }).offset).toBe(object.text.length);
  });

  it("moves vertically by rendered line keeping the column, and finds line boundaries (K3)", () => {
    const layout = planNativeTextEditorLayout(box(TEXT, 230));
    const [first, second] = layout.lines;
    const start = first!.start + 4;
    const down = nativeTextEditorVerticalMove(layout, start, "downstream", 1);
    expect(nativeTextEditorCaret(layout, down.offset, down.affinity).lineIndex).toBe(1);
    expect(Math.abs(nativeTextEditorCaret(layout, down.offset).x - nativeTextEditorCaret(layout, start).x)).toBeLessThan(6);
    const up = nativeTextEditorVerticalMove(layout, down.offset, down.affinity, -1, down.goalX);
    expect(up.offset).toBe(start);
    expect(nativeTextEditorVerticalMove(layout, start, "downstream", -1).offset).toBe(0);
    expect(nativeTextEditorLineBoundary(layout, second!.start + 3, "downstream", "start").offset).toBe(second!.start);
    const end = nativeTextEditorLineBoundary(layout, second!.start + 3, "downstream", "end");
    expect(end).toEqual({ offset: second!.end, affinity: "upstream" });
    expect(nativeTextEditorCaret(layout, end.offset, end.affinity).lineIndex).toBe(1);
  });

  it("highlights exactly the selected range on each rendered line (S1)", () => {
    const layout = planNativeTextEditorLayout(box(TEXT, 230));
    const [first, second, third] = layout.lines;
    const rects = nativeTextEditorSelectionRects(layout, first!.start + 4, second!.end);
    expect(rects.map(rect => rect.lineIndex)).toEqual([0, 1]);
    expect(rects[0]!.left).toBe(first!.stops[4]);
    expect(rects[1]!.right).toBe(second!.stops[second!.stops.length - 1]);
    expect(rects.some(rect => rect.lineIndex === third!.index)).toBe(false);
    expect(nativeTextEditorSelectionRects(layout, 5, 5)).toEqual([]);
  });

  it("selects words and paragraphs (S2)", () => {
    expect(nativeTextEditorWordRange("hello brave world", 8)).toEqual({ start: 6, end: 11 });
    expect(nativeTextEditorWordRange("hello brave world", 11)).toEqual({ start: 11, end: 12 });
    expect(nativeTextEditorWordRange("it shouldn't", 6)).toEqual({ start: 3, end: 12 });
    expect(nativeTextEditorParagraphRange("one\ntwo three\nfour", 6)).toEqual({ start: 4, end: 13 });
  });

  it("reports the glyph under a point for word selection, apart from the nearest caret stop (S2)", () => {
    const text = "alpha beta\ngamma";
    const layout = planNativeTextEditorLayout(box(text, 230));
    const [line, last] = [layout.lines[0]!, layout.lines[1]!];
    const y = (line.top + line.bottom) / 2;
    const at = (offset: number, fraction: number) => nativeTextEditorOffsetAtPoint(layout,
      { x: line.stops[offset]! + (line.stops[offset + 1]! - line.stops[offset]!) * fraction, y });
    // Right half of alpha's last letter: the caret goes after it, the word is still alpha.
    expect(at(4, 0.75)).toMatchObject({ offset: 5, glyphOffset: 4 });
    expect(nativeTextEditorWordRange(text, at(4, 0.75).glyphOffset)).toEqual({ start: 0, end: 5 });
    expect(at(4, 0.25)).toMatchObject({ offset: 4, glyphOffset: 4 });
    // Either half of the space between the words is the space.
    expect(at(5, 0.25).glyphOffset).toBe(5);
    expect(at(5, 0.75)).toMatchObject({ offset: 6, glyphOffset: 5 });
    // Past either end of a line, the glyph at that end, never the line break.
    expect(nativeTextEditorOffsetAtPoint(layout, { x: line.stops[10]! + 50, y })).toMatchObject({ offset: 10, glyphOffset: 9 });
    expect(nativeTextEditorOffsetAtPoint(layout, { x: line.stops[0]! - 50, y }).glyphOffset).toBe(0);
    const lastY = (last.top + last.bottom) / 2;
    expect(nativeTextEditorOffsetAtPoint(layout, { x: last.stops.at(-1)! + 50, y: lastY }).glyphOffset).toBe(15);
    // An empty line has no glyph: its start.
    const empty = planNativeTextEditorLayout(box("a\n\nb", 230));
    const emptyLine = empty.lines[1]!;
    expect(nativeTextEditorOffsetAtPoint(empty, { x: 500, y: (emptyLine.top + emptyLine.bottom) / 2 }).glyphOffset).toBe(2);
    // A right-to-left run (descending stops): the glyph between the two stops around x.
    const rtl = planNativeTextEditorLayout(box("שלום", 230), measured =>
      Array.from({ length: measured.end - measured.start + 1 }, (_, index) => 100 - index * 10));
    const rtlLine = rtl.lines[0]!;
    const rtlY = (rtlLine.top + rtlLine.bottom) / 2;
    expect(nativeTextEditorOffsetAtPoint(rtl, { x: 97, y: rtlY })).toMatchObject({ offset: 0, glyphOffset: 0 });
    expect(nativeTextEditorOffsetAtPoint(rtl, { x: 83, y: rtlY })).toMatchObject({ offset: 2, glyphOffset: 1 });
    expect(nativeTextEditorOffsetAtPoint(rtl, { x: 0, y: rtlY }).glyphOffset).toBe(3);
    expect(nativeTextEditorOffsetAtPoint(rtl, { x: 200, y: rtlY }).glyphOffset).toBe(0);
  });

  it("selects whole graphemes: an emoji alone, an astral letter inside its word (S2)", () => {
    // "ab😀cd": the emoji is offsets 2-3 (a surrogate pair) and is not a letter.
    const emoji = "ab😀cd";
    expect(nativeTextEditorWordRange(emoji, 2)).toEqual({ start: 2, end: 4 });
    expect(nativeTextEditorWordRange(emoji, 3)).toEqual({ start: 2, end: 4 });
    expect(nativeTextEditorWordRange(emoji, 1)).toEqual({ start: 0, end: 2 });
    expect(nativeTextEditorWordRange(emoji, 4)).toEqual({ start: 4, end: 6 });
    // "x𝐀y z": MATHEMATICAL BOLD CAPITAL A (U+1D400) is a letter written as a surrogate pair.
    const astral = "x𝐀y z";
    for (const offset of [0, 1, 2, 3]) expect(nativeTextEditorWordRange(astral, offset)).toEqual({ start: 0, end: 4 });
    // A ZWJ emoji sequence and a combining accent stay whole.
    const zwj = "a 👩‍💻 b";
    expect(nativeTextEditorWordRange(zwj, 3)).toEqual({ start: 2, end: 2 + "👩‍💻".length });
    expect(nativeTextEditorWordRange("cafe\u0301 au", 4)).toEqual({ start: 0, end: 5 });
    // No selection ends between the two halves of a surrogate pair.
    for (const text of [emoji, astral, zwj]) {
      for (let offset = 0; offset <= text.length; offset++) {
        const { start, end } = nativeTextEditorWordRange(text, offset);
        for (const edge of [start, end]) expect(/[\uDC00-\uDFFF]/.test(text[edge] ?? "")).toBe(false);
      }
    }
  });

  it("hit-tests and highlights a right-to-left run, whose glyph stops descend (C2, S1)", () => {
    const text = "שלום עולם";
    const object = box(text, 230);
    // Measured SVG stops for an RTL run: the logical start is at the right edge.
    const layout = planNativeTextEditorLayout(object, line =>
      Array.from({ length: line.end - line.start + 1 }, (_, index) => 100 - index * 7));
    const line = layout.lines[0]!;
    expect(line.stops[0]).toBeGreaterThan(line.stops[line.stops.length - 1]!);
    const y = (line.top + line.bottom) / 2;
    for (let offset = 0; offset <= text.length; offset++) {
      expect(nativeTextEditorOffsetAtPoint(layout, { x: line.stops[offset]!, y }).offset).toBe(offset);
      expect(nativeTextEditorOffsetAtPoint(layout, { x: line.stops[offset]! + 2, y }).offset).toBe(offset);
    }
    // Past the right edge is the logical start; past the left edge is the end.
    expect(nativeTextEditorOffsetAtPoint(layout, { x: 500, y }).offset).toBe(0);
    expect(nativeTextEditorOffsetAtPoint(layout, { x: -500, y }).offset).toBe(text.length);
    // Every non-empty range is highlighted with a positive width over exactly its glyphs.
    for (let start = 0; start < text.length; start++) {
      for (let end = start + 1; end <= text.length; end++) {
        const [rect, ...rest] = nativeTextEditorSelectionRects(layout, start, end);
        expect(rest).toEqual([]);
        expect(rect!.left).toBe(line.stops[end]);
        expect(rect!.right).toBe(line.stops[start]);
        expect(rect!.right - rect!.left).toBeGreaterThan(0);
      }
    }
    // A selected line break after an RTL line is marked at the line's end, its left edge.
    const twoLines = planNativeTextEditorLayout(box(`${text}\nab`, 230), measured =>
      measured.index === 0 ? Array.from({ length: measured.end - measured.start + 1 }, (_, index) => 100 - index * 7) : undefined);
    const [breakRect] = nativeTextEditorSelectionRects(twoLines, text.length, text.length + 1);
    expect(breakRect!.right).toBe(twoLines.lines[0]!.stops[text.length]);
    expect(breakRect!.right - breakRect!.left).toBeGreaterThan(0);
    // Mixed directions (non-monotonic stops): still the nearest stop, never an empty highlight.
    const mixed = planNativeTextEditorLayout(box("ab אב cd", 230), () => [0, 6, 30, 24, 18, 30, 36, 42, 48]);
    const mixedLine = mixed.lines[0]!;
    expect(nativeTextEditorOffsetAtPoint(mixed, { x: 23, y: (mixedLine.top + mixedLine.bottom) / 2 }).offset).toBe(3);
    for (let start = 0; start < 8; start++) {
      const [rect] = nativeTextEditorSelectionRects(mixed, start, start + 1);
      expect(rect!.right - rect!.left).toBeGreaterThan(0);
    }
  });

  it("keeps the auto-width height steady per keystroke, counting only drawn lines (H1, H3)", () => {
    const typed = "it should not have delete the unselected hehehe but then again it shouldn't be doing this";
    let previous: number | undefined;
    for (let length = 1; length <= typed.length; length++) {
      const object = box(typed.slice(0, length), 324, "auto");
      const height = nativeTextObjectBoxHeight(object);
      expect(planNativeTextEditorLayout(object).lines).toHaveLength(1);
      if (previous !== undefined) expect(height).toBe(previous);
      previous = height;
    }
    expect(nativeTextObjectBoxHeight(box("a\nb", 30, "auto"))).toBeCloseTo(2 * 14.4 + 4, 6);
  });

  it("never gives an auto-width box less height than its lowest drawn line (H2)", () => {
    const withSpans = (text: string, spans: TextObject["spans"], extra: Partial<TextObject["style"]> = {}) =>
      ({ ...box(text, 30, "auto", extra), spans });
    const cases: TextObject[] = [
      // A small line height: the second baseline is 20 + 10, its descent 4 below that.
      box("a\nb", 30, "auto", { fontSizePx: 20, lineHeight: 0.5 }),
      // A large subscript, and a large run, hang below a 12 px line.
      withSpans("H2O", [{ text: "H", script: "normal", style: {} }, { text: "2", script: "subscript", style: { fontSizePx: 40 } },
        { text: "O", script: "normal", style: {} }]),
      withSpans("aB", [{ text: "a", script: "normal", style: {} }, { text: "B", script: "normal", style: { fontSizePx: 40 } }]),
      // A large subscript on the first of two lines and a large superscript on the second.
      withSpans("x2\ny3", [{ text: "x", script: "normal", style: {} }, { text: "2", script: "subscript", style: { fontSizePx: 48 } },
        { text: "\ny", script: "normal", style: {} }, { text: "3", script: "superscript", style: { fontSizePx: 48 } }], { lineHeight: 0.8 })
    ];
    for (const object of cases) {
      const lines = planNativeTextEditorLayout(object).lines;
      const lowest = Math.max(...lines.map(line => line.bottom));
      expect(nativeTextObjectBoxHeight(object), JSON.stringify(object.text)).toBeGreaterThanOrEqual(lowest);
      // The same rule for a fixed-width box of the same text.
      const fixed = { ...object, width: 400, style: { ...object.style, textBoxSizingMode: "fixed-width" as const } };
      expect(nativeTextObjectBoxHeight(fixed)).toBeGreaterThanOrEqual(Math.max(...planNativeTextEditorLayout(fixed).lines.map(line => line.bottom)));
    }
  });

  it("changes a fixed-width height only with the wrapped line count and never below content (H1, H2)", () => {
    let previousLines = 0, previousHeight = 0;
    for (let length = 1; length <= TEXT.length; length++) {
      const object = box(TEXT.slice(0, length), 160);
      const lines = planNativeTextEditorLayout(object).lines;
      const height = nativeTextObjectBoxHeight(object);
      if (lines.length === previousLines) expect(height).toBe(previousHeight);
      expect(height).toBeGreaterThanOrEqual(lines[lines.length - 1]!.bottom);
      previousLines = lines.length;
      previousHeight = height;
    }
  });

  it("prefers measured glyph stops for x, never for line assignment (C1)", () => {
    const object = box(TEXT, 230);
    const estimated = planNativeTextEditorLayout(object);
    const measured = planNativeTextEditorLayout(object, line => Array.from({ length: line.end - line.start + 1 }, (_, i) => i * 5));
    expect(measured.lines.map(line => [line.start, line.end])).toEqual(estimated.lines.map(line => [line.start, line.end]));
    expect(nativeTextEditorCaret(measured, TEXT.length).x).toBe((measured.lines.at(-1)!.end - measured.lines.at(-1)!.start) * 5);
    // A measurement of the wrong length (stale SVG) is ignored.
    const stale = planNativeTextEditorLayout(object, () => [1, 2]);
    expect(stale.lines[0]!.stops).toEqual(estimated.lines[0]!.stops);
  });
});
