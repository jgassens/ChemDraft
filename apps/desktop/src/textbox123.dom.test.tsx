// @vitest-environment jsdom
// Spec: docs/plans/textbox-behavior.md (lines H1-H3, C1-C2, S1-S2, W1, and line breaks). Real
// events only; the agent bridge is read for the committed document and never used to drive the editor.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeTextEditorCaret, nativeTextEditorOffsetAtPoint, nativeTextObjectBoxHeight } from "@chemdraft/layout-engine";
import {
  OWNER_TEXT, TEXTBOX_TEST_TIMEOUT, TEXTBOX_TYPING_TEST_TIMEOUT, textareaText, textboxHarness
} from "./textbox123.testHelpers";

describe.each(["macos", "windows"] as const)("text box 1.2.3 (%s)", platform => {
  const h = textboxHarness(platform);
  beforeEach(h.setup);
  afterEach(h.teardown);

  describe.each(["fixed-width", "auto"] as const)("%s (W1)", mode => {
    it("S1: a drag over lines 1-2 selects exactly that range and typing replaces only it", async () => {
      const text = mode === "auto" ? `${OWNER_TEXT.slice(0, 48)}\n${OWNER_TEXT.slice(48, 100)}\n${OWNER_TEXT.slice(100)}` : OWNER_TEXT;
      const editor = await h.mount(text, { width: 230, mode });
      const lines = h.layout().lines;
      expect(lines.length).toBeGreaterThanOrEqual(3);
      // The owner's gesture: press inside line 3, drag up to line 1 and release there.
      const from = lines[2]!.start + 4, to = lines[0]!.start + 6;
      await h.pointer(editor, "pointerdown", h.clientAt(from));
      await h.pointer(editor, "pointermove", h.clientAt(lines[1]!.start + 5));
      await h.pointer(editor, "pointermove", h.clientAt(to));
      await h.pointer(editor, "pointerup", h.clientAt(to));
      expect([editor.selectionStart, editor.selectionEnd, editor.selectionDirection]).toEqual([to, from, "backward"]);
      // What is highlighted is what is selected: rects on lines 0-2 only, ending at `from`.
      const rects = h.selectionRects();
      expect(rects.map(rect => Number(rect.dataset.line))).toEqual([0, 1, 2]);
      const lastRect = rects[2]!;
      expect(parseFloat(lastRect.style.left) + parseFloat(lastRect.style.width))
        .toBeCloseTo(nativeTextEditorCaret(h.layout(), from).x * h.scale(), 3);
      await h.type("X");
      expect(h.object().text).toBe(`${text.slice(0, to)}X${text.slice(from)}`);
      expect(h.object().text.endsWith("jhehehehe'")).toBe(true);
    }, TEXTBOX_TEST_TIMEOUT);

    it("C1: the caret is drawn where the next character goes while typing at the end of wrapped text", async () => {
      await h.mount("", { width: 230, mode });
      const typed = "it should not have delete the unselected hehehe but then again it shouldn't be doing this odd stuff with the cursor,";
      for (const character of typed) {
        await h.type(character);
        const drawn = h.caretBox();
        const expected = h.expectedCaretBox();
        expect(drawn, `caret after ${JSON.stringify(h.object().text)}`).toBeDefined();
        expect(drawn!.line).toBe(expected.line);
        expect(drawn!.left).toBeCloseTo(expected.left, 3);
        expect(drawn!.top).toBeCloseTo(expected.top, 3);
        // The next character goes on the last rendered line.
        expect(drawn!.line).toBe(h.layout().lines.length - 1);
      }
    }, TEXTBOX_TYPING_TEST_TIMEOUT);

    it("C2: clicking a glyph boundary puts the caret there on that rendered line", async () => {
      const editor = await h.mount(mode === "auto" ? "first line here\nsecond line there" : OWNER_TEXT, { width: 230, mode });
      const lines = h.layout().lines;
      for (const offset of [lines[1]!.start + 3, lines[0]!.start + 1, lines[lines.length - 1]!.end - 2]) {
        await h.click(editor, h.clientAt(offset), { timeGap: 1000 });
        expect([editor.selectionStart, editor.selectionEnd]).toEqual([offset, offset]);
        const drawn = h.caretBox()!;
        expect(drawn.offset).toBe(offset);
        expect(drawn.left).toBeCloseTo(h.expectedCaretBox().left, 3);
      }
    }, TEXTBOX_TEST_TIMEOUT);

    it("S2: double-click selects a word, triple-click the paragraph, shift-click extends", async () => {
      const text = mode === "auto" ? "alpha beta gamma\ndelta epsilon" : `${OWNER_TEXT}\nsecond paragraph`;
      const editor = await h.mount(text, { width: 230, mode });
      const word = text.indexOf(mode === "auto" ? "beta" : "party");
      const wordLength = mode === "auto" ? 4 : 5;
      const point = h.clientAt(word + 2);
      await h.click(editor, point, { timeGap: 1000 });
      await h.click(editor, point, { detail: 2, timeGap: 80 });
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([word, word + wordLength]);
      await h.click(editor, point, { detail: 3, timeGap: 80 });
      const paragraphEnd = text.indexOf("\n");
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([0, paragraphEnd]);
      // Shift-click right after a click (within the double-click time and distance) extends
      // from the click; it is not counted as a double-click.
      await h.click(editor, h.clientAt(2), { timeGap: 1000 });
      const dx = 3 / h.scale();
      const nearCaret = nativeTextEditorCaret(h.layout(), 2);
      const near = nativeTextEditorOffsetAtPoint(h.layout(), { x: nearCaret.x + dx, y: (nearCaret.top + nearCaret.bottom) / 2 }).offset;
      await h.click(editor, h.clientAt(2, "downstream", dx), { shiftKey: true });
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, near]);
      await h.click(editor, h.clientAt(paragraphEnd + 3), { shiftKey: true });
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, paragraphEnd + 3]);
      expect(h.caretBox()).toBeUndefined();
    }, TEXTBOX_TEST_TIMEOUT);

    it("CRLF: text stored with CRLF opens, hit-tests, highlights and types at the textarea's offsets", async () => {
      // An older file (or a Windows paste in an earlier build) stored "a\r\nb"; the textarea holds "a\nb".
      const editor = await h.mount("a\r\nb", { width: 230, mode, stored: true });
      expect(editor.value).toBe("a\nb");
      // Opened at the end: the caret is drawn after "b", on the second line.
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 3]);
      const opened = h.caretBox()!;
      expect([opened.offset, opened.line]).toEqual([3, 1]);
      expect(opened.left).toBeCloseTo(h.expectedCaretBox().left, 3);
      expect(opened.left).toBeGreaterThan(nativeTextEditorCaret(h.layout(), 2).x * h.scale());
      // Drag over "b": exactly "b" is selected and highlighted, and typing replaces only it.
      await h.drag(2, 3);
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 3]);
      const [rect, ...more] = h.selectionRects();
      expect(more).toEqual([]);
      expect(Number(rect!.dataset.line)).toBe(1);
      expect(parseFloat(rect!.style.width)).toBeCloseTo(
        (nativeTextEditorCaret(h.layout(), 3).x - nativeTextEditorCaret(h.layout(), 2).x) * h.scale(), 3);
      await h.type("X");
      expect(h.object().text).toBe("a\nX");
      const drawn = h.caretBox()!;
      expect([drawn.offset, drawn.line]).toEqual([3, 1]);
      expect(drawn.left).toBeCloseTo(h.expectedCaretBox().left, 3);
    }, TEXTBOX_TEST_TIMEOUT);

    it("CRLF: a drag over wrapped lines after CRLF breaks selects that range and typing replaces only it", async () => {
      const stored = mode === "auto"
        ? `${OWNER_TEXT.slice(0, 40)}\r\n${OWNER_TEXT.slice(40, 80)}\r\n${OWNER_TEXT.slice(80)}`
        : `first line\r\n${OWNER_TEXT}\r\nlast line`;
      const text = textareaText(stored);
      const editor = await h.mount(stored, { width: 230, mode, stored: true });
      const lines = h.layout().lines;
      expect(lines.length).toBeGreaterThanOrEqual(3);
      // Press on the third rendered line, drag up into the first: the range crosses a CRLF break.
      const from = lines[2]!.start + 4, to = lines[0]!.start + 3;
      await h.pointer(editor, "pointerdown", h.clientAt(from), { timeGap: 1000 });
      await h.pointer(editor, "pointermove", h.clientAt(to));
      await h.pointer(editor, "pointerup", h.clientAt(to));
      expect([editor.selectionStart, editor.selectionEnd, editor.selectionDirection]).toEqual([to, from, "backward"]);
      const rects = h.selectionRects();
      expect(rects.map(element => Number(element.dataset.line))).toEqual([0, 1, 2]);
      expect(parseFloat(rects[2]!.style.left) + parseFloat(rects[2]!.style.width))
        .toBeCloseTo(nativeTextEditorCaret(h.layout(), from).x * h.scale(), 3);
      await h.type("X");
      expect(h.object().text).toBe(`${text.slice(0, to)}X${text.slice(from)}`);
      const drawn = h.caretBox()!;
      expect(drawn.offset).toBe(to + 1);
      expect(drawn.left).toBeCloseTo(h.expectedCaretBox().left, 3);
    }, TEXTBOX_TEST_TIMEOUT);

    it("H2: lines typed into a box on the page bottom grow it past the bottom, never below its lowest drawn line", async () => {
      // Insertion clamps the box onto the bottom edge of the page.
      await h.mount("", { width: 160, mode, y: 1e6 });
      const placed = h.object();
      let previous: { lines: number; height: number; frame: number } | undefined;
      for (const character of "x\nmore\nend") {
        await h.type(character);
        const lines = h.layout().lines;
        const current = { lines: lines.length, height: h.object().height, frame: parseFloat(h.chrome().style.height) };
        expect(current.height, JSON.stringify(h.object().text)).toBeGreaterThanOrEqual(lines[lines.length - 1]!.bottom);
        expect(h.object().y).toBe(placed.y);
        if (previous?.lines === current.lines) {
          expect(current.height).toBe(previous.height);
          expect(current.frame).toBe(previous.frame);
        }
        previous = current;
      }
      expect(h.object().text).toBe("x\nmore\nend");
      expect(h.object().y + h.object().height).toBeGreaterThan(placed.y + placed.height);
    }, TEXTBOX_TYPING_TEST_TIMEOUT);
  });

  it("C2: a press hit-tests through the same measured page viewport the caret is drawn with", async () => {
    // The page SVG sits 7 x 3 px inside the page box (its border and letterboxing). The editor
    // chrome is placed by the SVG's screen matrix, so a press must be inverted through that matrix,
    // not through the page box.
    const svgOffset = { x: 7, y: 3 };
    const original = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getScreenCTM");
    Object.defineProperty(SVGElement.prototype, "getScreenCTM", {
      configurable: true,
      value(this: SVGElement) {
        return this.classList.contains("page-svg-visual-layer")
          ? { a: 1, b: 0, c: 0, d: 1, e: svgOffset.x, f: svgOffset.y } as DOMMatrix : null;
      }
    });
    try {
      const editor = await h.mount(OWNER_TEXT, { width: 230 });
      expect(h.scale()).toBe(1);
      const lines = h.layout().lines;
      for (const target of [lines[1]!.start + 3, lines[0]!.start + 9]) {
        const at = h.clientAt(target);
        const press = { x: at.x + svgOffset.x, y: at.y + svgOffset.y };
        await h.click(editor, press, { timeGap: 1000 });
        expect([editor.selectionStart, editor.selectionEnd]).toEqual([target, target]);
        const drawn = h.caretBox()!;
        expect(drawn.offset).toBe(target);
        // Drawn where pressed: the chrome's left plus the caret's left is the press x.
        expect(parseFloat(h.chrome().style.left) + drawn.left).toBeCloseTo(press.x, 3);
      }
    } finally {
      if (original) Object.defineProperty(SVGElement.prototype, "getScreenCTM", original);
      else Reflect.deleteProperty(SVGElement.prototype, "getScreenCTM");
    }
  }, TEXTBOX_TEST_TIMEOUT);

  it("H1/H3: an auto-width box keeps one line's height while typing one line, even capped at the page edge", async () => {
    await h.mount("", { width: 36, mode: "auto", x: 360 });
    const oneLine = nativeTextObjectBoxHeight({ ...h.object(), text: "x", spans: [] });
    let frameHeight: number | undefined;
    for (const character of "it should not have delete the unselected hehehe but then again it shouldn't be doing this odd stuff") {
      await h.type(character);
      expect(h.layout().lines).toHaveLength(1);
      expect(h.object().height, `height after ${JSON.stringify(h.object().text)}`).toBeCloseTo(oneLine, 6);
      const frame = parseFloat(h.chrome().style.height);
      if (frameHeight !== undefined) expect(frame).toBe(frameHeight);
      frameHeight = frame;
    }
  }, TEXTBOX_TYPING_TEST_TIMEOUT);

  it("H1/H2: a fixed-width box changes height only when its wrapped line count changes, never below content", async () => {
    await h.mount("", { width: 160 });
    let previous = { lines: h.layout().lines.length, height: h.object().height, frame: parseFloat(h.chrome().style.height) };
    for (const character of `${OWNER_TEXT} and then more`) {
      await h.type(character);
      const lines = h.layout().lines;
      const current = { lines: lines.length, height: h.object().height, frame: parseFloat(h.chrome().style.height) };
      if (current.lines === previous.lines) {
        expect(current.height).toBe(previous.height);
        expect(current.frame).toBe(previous.frame);
      }
      expect(current.height).toBeGreaterThanOrEqual(lines[lines.length - 1]!.bottom);
      previous = current;
    }
  }, TEXTBOX_TYPING_TEST_TIMEOUT);
});
