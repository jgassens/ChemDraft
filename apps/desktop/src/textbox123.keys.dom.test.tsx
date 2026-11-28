// @vitest-environment jsdom
// Spec: docs/plans/textbox-behavior.md (lines K1-K3, R1, U1, I1, P1, and line breaks). Real events
// only; the agent bridge is read for the committed document and never used to drive the editor.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeTextEditorCaret, nativeTextEditorLineBoundary, nativeTextEditorVerticalMove } from "@chemdraft/layout-engine";
import { OWNER_TEXT, TEXTBOX_TEST_TIMEOUT, textboxHarness } from "./textbox123.testHelpers";

/** Two rendered lines, a hard break, then more lines: a range from the first rendered line to
 * the third crosses a soft wrap and the hard break. */
const BROKEN_TEXT = `${OWNER_TEXT.slice(0, 60)}\n${OWNER_TEXT.slice(60)}\nsecond paragraph here`;

describe.each(["macos", "windows"] as const)("text box keys 1.2.3 (%s)", platform => {
  const h = textboxHarness(platform);
  beforeEach(h.setup);
  afterEach(h.teardown);
  const command = platform === "macos" ? { metaKey: true } : { ctrlKey: true };

  const expectCaretAtSelection = () => {
    const drawn = h.caretBox();
    const expected = h.expectedCaretBox();
    expect(drawn).toBeDefined();
    expect([drawn!.offset, drawn!.line]).toEqual([expected.offset, expected.line]);
    expect(drawn!.left).toBeCloseTo(expected.left, 3);
  };

  it("K1: Backspace and Delete remove one character across a soft wrap and a hard break, or exactly the selection", async () => {
    const text = `${OWNER_TEXT}\nnext`;
    const editor = await h.mount(text, { width: 230 });
    const second = h.layout().lines[1]!;
    await h.click(editor, h.clientAt(second.start));
    expect(editor.selectionStart).toBe(second.start);
    await h.deleteKey("Backspace");
    expect(h.object().text).toBe(text.slice(0, second.start - 1) + text.slice(second.start));
    expectCaretAtSelection();
    const breakAt = h.object().text.indexOf("\n");
    await h.click(editor, h.clientAt(breakAt, "upstream"), { timeGap: 1000 });
    expect(editor.selectionStart).toBe(breakAt);
    await h.deleteKey("Delete");
    expect(h.object().text.endsWith("jhehehehe'next")).toBe(true);
    expectCaretAtSelection();
    const before = h.object().text;
    await h.pointer(editor, "pointerdown", h.clientAt(5), { timeGap: 1000 });
    await h.pointer(editor, "pointermove", h.clientAt(12));
    await h.pointer(editor, "pointerup", h.clientAt(12));
    await h.deleteKey("Backspace");
    expect(h.object().text).toBe(before.slice(0, 5) + before.slice(12));
    expectCaretAtSelection();
  }, TEXTBOX_TEST_TIMEOUT);

  // Windows has no delete-to-line-start key: Ctrl+Backspace deletes a word, which does not depend
  // on line layout, so the native textarea handles it unchanged.
  it.skipIf(platform !== "macos")("K1: Cmd+Backspace and Cmd+Delete (macOS) delete to the rendered line's start and end", async () => {
    const editor = await h.mount(OWNER_TEXT, { width: 230 });
    const second = h.layout().lines[1]!;
    const caretAt = second.start + 5;
    await h.click(editor, h.clientAt(caretAt));
    await h.deleteKey("Backspace", { metaKey: true });
    expect(h.object().text).toBe(OWNER_TEXT.slice(0, second.start) + OWNER_TEXT.slice(caretAt));
    expectCaretAtSelection();
    const afterBackspace = h.object().text;
    const caret = editor.selectionStart;
    const lineEnd = nativeTextEditorLineBoundary(h.layout(), caret, "downstream", "end").offset;
    expect(lineEnd).toBeGreaterThan(caret);
    await h.deleteKey("Delete", { metaKey: true });
    expect(h.object().text).toBe(afterBackspace.slice(0, caret) + afterBackspace.slice(lineEnd));
    expectCaretAtSelection();
  }, TEXTBOX_TEST_TIMEOUT);

  it.each([{}, { shiftKey: true }])("K2: Enter %o inserts a hard break at the caret and keeps editing", async keyInit => {
    const editor = await h.mount("alpha beta", { width: 230 });
    await h.click(editor, h.clientAt(6));
    await h.type("\n", "insertLineBreak", keyInit);
    expect(h.object().text).toBe("alpha \nbeta");
    expect(h.editor()).toBe(editor);
    expect(document.activeElement).toBe(editor);
    const drawn = h.caretBox()!;
    expect([drawn.offset, drawn.line]).toEqual([7, 1]);
    expect(drawn.left).toBeCloseTo(nativeTextEditorCaret(h.layout(), 7).x * h.scale(), 3);
  }, TEXTBOX_TEST_TIMEOUT);

  it("K3: arrows move by rendered line keeping the column; line start/end use the rendered line", async () => {
    const editor = await h.mount(OWNER_TEXT, { width: 230 });
    const [first, second] = h.layout().lines;
    const start = first!.start + 6;
    await h.click(editor, h.clientAt(start));
    const down = nativeTextEditorVerticalMove(h.layout(), start, "downstream", 1);
    expect(await h.press("ArrowDown")).toBe(true);
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([down.offset, down.offset]);
    expect(h.caretBox()!.line).toBe(1);
    expect(await h.press("ArrowUp")).toBe(true);
    expect(editor.selectionStart).toBe(start);
    expect(await h.press("ArrowDown", { shiftKey: true })).toBe(true);
    expect([editor.selectionStart, editor.selectionEnd, editor.selectionDirection]).toEqual([start, down.offset, "forward"]);
    const lineKeys = platform === "macos"
      ? { start: ["ArrowLeft", { metaKey: true }], end: ["ArrowRight", { metaKey: true }] } as const
      : { start: ["Home", {}], end: ["End", {}] } as const;
    await h.click(editor, h.clientAt(second!.start + 4), { timeGap: 1000 });
    expect(await h.press(lineKeys.end[0], lineKeys.end[1])).toBe(true);
    const end = nativeTextEditorLineBoundary(h.layout(), second!.start + 4, "downstream", "end");
    expect(editor.selectionStart).toBe(end.offset);
    expect(h.caretBox()!.line).toBe(1);
    expect(await h.press(lineKeys.start[0], { ...lineKeys.start[1], shiftKey: true })).toBe(true);
    expect([editor.selectionStart, editor.selectionEnd, editor.selectionDirection]).toEqual([second!.start, end.offset, "backward"]);
  }, TEXTBOX_TEST_TIMEOUT);

  it("R1: resizing narrower and wider rewraps and keeps the caret and selection", async () => {
    const editor = await h.mount(OWNER_TEXT, { width: 260 });
    await h.pointer(editor, "pointerdown", h.clientAt(30));
    await h.pointer(editor, "pointermove", h.clientAt(70));
    await h.pointer(editor, "pointerup", h.clientAt(70));
    const linesBefore = h.layout().lines.length;
    const page = h.container.querySelector(".page")!;
    const handle = h.container.querySelector('[data-text-resize-edge="right"]')!;
    for (const width of [160, 300]) {
      const current = h.object();
      const y = (current.y + 10) * h.scale();
      await h.pointer(handle, "pointerdown", { x: (current.x + current.width) * h.scale(), y }, { timeGap: 1000 });
      await h.pointer(page, "pointermove", { x: (current.x + width) * h.scale(), y });
      await h.pointer(page, "pointerup", { x: (current.x + width) * h.scale(), y });
      expect(h.object().width).toBe(width);
      expect(h.editor()).toBe(editor);
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([30, 70]);
      const rects = h.selectionRects();
      const model = h.layout();
      expect(rects.length).toBe(model.lines.filter(line => line.start < 70 && line.end > 30).length);
      if (width === 160) expect(model.lines.length).toBeGreaterThan(linesBefore);
    }
    await h.click(editor, h.clientAt(40), { timeGap: 1000 });
    expectCaretAtSelection();
  }, TEXTBOX_TEST_TIMEOUT);

  it("U1: one finished edit is one undo entry; native undo inside the edit moves the drawn caret with it", async () => {
    const editor = await h.mount("Alpha", { width: 230 });
    await h.type("123");
    // A native textarea undo restores value and selection, then fires input (historyUndo).
    await act(async () => {
      h.setValue(editor, "Alpha12");
      editor.setSelectionRange(7, 7);
      editor.dispatchEvent(new InputEvent("input", { inputType: "historyUndo", bubbles: true }));
    });
    expect(h.object().text).toBe("Alpha12");
    expectCaretAtSelection();
    await h.press("Escape");
    expect(h.editor()).toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true, cancelable: true, ...command })));
    expect(h.object().text).toBe("Alpha");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: platform === "windows" ? "y" : "z", bubbles: true, cancelable: true, ...command, shiftKey: platform === "macos"
    })));
    expect(h.object().text).toBe("Alpha12");
  }, TEXTBOX_TEST_TIMEOUT);

  it("I1: IME composition keeps the height and draws the caret at the composition", async () => {
    const editor = await h.mount("it should not have", { width: 230 });
    const height = h.object().height;
    const lines = h.layout().lines.length;
    await act(async () => {
      editor.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
    });
    for (const composing of ["k", "ka", "かな"]) {
      await act(async () => {
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", keyCode: 229, isComposing: true, bubbles: true, cancelable: true } as KeyboardEventInit));
        editor.dispatchEvent(new CompositionEvent("compositionupdate", { data: composing, bubbles: true }));
        const base = "it should not have ";
        h.setValue(editor, base + composing);
        editor.setSelectionRange(base.length + composing.length, base.length + composing.length);
        editor.dispatchEvent(new InputEvent("input", { inputType: "insertCompositionText", data: composing, isComposing: true, bubbles: true }));
      });
      expect(h.layout().lines.length).toBe(lines);
      expect(h.object().height).toBe(height);
      expectCaretAtSelection();
    }
    await act(async () => {
      editor.dispatchEvent(new CompositionEvent("compositionend", { data: "かな", bubbles: true }));
    });
    expect(h.object().text).toBe("it should not have かな");
    expectCaretAtSelection();
  }, TEXTBOX_TEST_TIMEOUT);

  it.each(["plain", "rich"] as const)("P1: %s paste replaces only the selection", async kind => {
    const editor = await h.mount(OWNER_TEXT, { width: 230 });
    await h.pointer(editor, "pointerdown", h.clientAt(7));
    await h.pointer(editor, "pointermove", h.clientAt(15));
    await h.pointer(editor, "pointerup", h.clientAt(15));
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([7, 15]);
    const data: Record<string, string> = kind === "plain" ? { "text/plain": "PASTED" }
      : { "text/plain": "PASTED", "text/html": "<b>PASTED</b>" };
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true, cancelable: true, ...command }));
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: { getData: (type: string) => data[type] ?? "", types: Object.keys(data) } });
      editor.dispatchEvent(paste);
    });
    await h.settle(50);
    expect(h.object().text).toBe(`${OWNER_TEXT.slice(0, 7)}PASTED${OWNER_TEXT.slice(15)}`);
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([13, 13]);
    expectCaretAtSelection();
  }, TEXTBOX_TEST_TIMEOUT);

  // The same text stored with LF and with CRLF (an older file, or a Windows paste in an earlier
  // build). The textarea holds LF either way, so every expectation is in LF offsets.
  describe.each([
    { breaks: "LF", stored: BROKEN_TEXT },
    { breaks: "CRLF", stored: BROKEN_TEXT.replace(/\n/g, "\r\n") }
  ])("over a partial multi-line selection ($breaks)", ({ stored }) => {
    const text = BROKEN_TEXT;
    /** Open the box and drag from the middle of the first rendered line to the middle of the
     * second paragraph's first line: across a soft wrap and the hard break. */
    const select = async () => {
      const editor = await h.mount(stored, { width: 230, stored: true });
      const lines = h.layout().lines;
      const second = lines.findIndex(line => line.paragraphIndex === 1);
      expect(second).toBeGreaterThanOrEqual(2);
      const from = lines[0]!.start + 5, to = lines[second]!.start + 4;
      expect(text.slice(from, to)).toContain("\n");
      await h.drag(from, to);
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([from, to]);
      expect(h.selectionRects().map(rect => Number(rect.dataset.line))).toEqual(lines.slice(0, second + 1).map(line => line.index));
      return { editor, from, to };
    };

    it.each(["Backspace", "Delete"] as const)("K1: %s removes exactly the selection", async key => {
      const { editor, from, to } = await select();
      await h.deleteKey(key);
      expect(h.object().text).toBe(text.slice(0, from) + text.slice(to));
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([from, from]);
      expectCaretAtSelection();
    }, TEXTBOX_TEST_TIMEOUT);

    it.each(["plain", "rich"] as const)("P1: a %s Windows paste (CRLF) replaces exactly the selection", async kind => {
      const { editor, from, to } = await select();
      const plain = "P1\r\nP2";
      await h.paste(kind === "plain" ? { "text/plain": plain } : { "text/plain": plain, "text/html": "<p>P1</p><p>P2</p>" }, command);
      expect(h.object().text).toBe(`${text.slice(0, from)}P1\nP2${text.slice(to)}`);
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([from + 5, from + 5]);
      expectCaretAtSelection();
    }, TEXTBOX_TEST_TIMEOUT);

    it("I1: IME composition replaces exactly the selection and draws the caret at the composition", async () => {
      const { editor, from, to } = await select();
      await h.compose(["k", "ka", "かな"], composing => {
        expect(h.object().text).toBe(`${text.slice(0, from)}${composing}${text.slice(to)}`);
        expect(editor.selectionStart).toBe(from + composing.length);
        expectCaretAtSelection();
      });
      expect(h.object().text).toBe(`${text.slice(0, from)}かな${text.slice(to)}`);
      expectCaretAtSelection();
    }, TEXTBOX_TEST_TIMEOUT);
  });
});
