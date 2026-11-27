import type { TextObject } from "@chemdraft/chem-core";
import {
  nativeTextEditorCaret, nativeTextEditorLineBoundary, nativeTextEditorOffsetAtPoint, nativeTextEditorParagraphRange,
  nativeTextEditorSelectionRects, nativeTextEditorVerticalMove, nativeTextEditorWordRange, planNativeTextEditorLayout,
  textObjectWithNormalizedLineBreaks, type NativeTextCaretAffinity, type NativeTextEditorLayout, type NativeTextEditorStopMeasure
} from "@chemdraft/layout-engine";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";

/**
 * The text box editor's view of the shared layout model (docs/plans/textbox-behavior.md).
 * The textarea holds text and selection and receives keys, IME and paste; everything the
 * user sees or points at (caret, highlight, hit-testing, vertical moves) reads the layout
 * engine's model of the lines the page SVG draws. The textarea's own browser layout is never
 * shown and never hit-tested, so it cannot disagree with the glyphs.
 */

export type TextEditorSession = {
  affinity: NativeTextCaretAffinity;
  goalX?: number;
  drag?: { pointerId: number; anchor: number };
  lastPress?: { time: number; x: number; y: number; count: number };
  pendingSelection?: { start: number; end: number; text: string };
};

export function createTextEditorSession(): TextEditorSession {
  return { affinity: "downstream" };
}

/** Rendered glyph x per caret stop, read from the page SVG the user sees. Only when that SVG
 * shows exactly this text (no collapsed whitespace, not stale); otherwise the layout engine's
 * advances. Never decides which line a character is on. */
export function svgTextEditorStopMeasure(textElement: SVGTextContentElement | null | undefined,
  object: TextObject): NativeTextEditorStopMeasure | undefined {
  if (!textElement || typeof textElement.getStartPositionOfChar !== "function" ||
      typeof textElement.getNumberOfChars !== "function") return undefined;
  const flat = object.text.replace(/[\r\n]/g, "");
  try {
    if (textElement.textContent !== flat || textElement.getNumberOfChars() !== flat.length) return undefined;
  } catch { return undefined; }
  const breaksBefore: number[] = [0];
  for (let index = 0; index < object.text.length; index++) {
    const character = object.text[index];
    breaksBefore.push(breaksBefore[index]! + (character === "\r" || character === "\n" ? 1 : 0));
  }
  const svgIndex = (offset: number) => offset - breaksBefore[offset]!;
  return line => {
    if (line.end <= line.start) return undefined;
    try {
      const stops: number[] = [];
      for (let offset = line.start; offset < line.end; offset++) {
        stops.push(textElement.getStartPositionOfChar(svgIndex(offset)).x - object.x);
      }
      stops.push(textElement.getEndPositionOfChar(svgIndex(line.end - 1)).x - object.x);
      return stops;
    } catch {
      return undefined;
    }
  };
}

/** The editor reads the object with LF line breaks, as its textarea holds them, so an object
 * from an older file that still stores CR has the same offsets as the textarea. */
export function textEditorLayout(object: TextObject, textElement?: SVGTextContentElement | null): NativeTextEditorLayout {
  const model = textObjectWithNormalizedLineBreaks(object);
  return planNativeTextEditorLayout(model, svgTextEditorStopMeasure(textElement, model));
}

/** Where the textarea's selection focus is (the end a Shift move extends). */
export function textEditorSelection(editor: HTMLTextAreaElement) {
  const backward = editor.selectionDirection === "backward";
  return {
    start: editor.selectionStart,
    end: editor.selectionEnd,
    anchor: backward ? editor.selectionEnd : editor.selectionStart,
    focus: backward ? editor.selectionStart : editor.selectionEnd
  };
}

export function setTextEditorSelection(editor: HTMLTextAreaElement, anchor: number, focus: number) {
  editor.setSelectionRange(Math.min(anchor, focus), Math.max(anchor, focus),
    anchor > focus ? "backward" : anchor < focus ? "forward" : "none");
}

/** Paint the caret and selection rectangles from the model. `originX` is the chrome-local x of
 * object.x (the editor frame can grow around the alignment anchor). */
export function paintTextEditorChrome(options: {
  editor: HTMLTextAreaElement;
  caret: HTMLElement;
  selectionLayer: HTMLElement;
  layout: NativeTextEditorLayout;
  session: TextEditorSession;
  scale: number;
  originX: number;
}) {
  const { editor, caret, selectionLayer, layout, session, scale, originX } = options;
  const { start, end } = textEditorSelection(editor);
  const focused = editor.ownerDocument.activeElement === editor;
  if (start === end && focused) {
    const position = nativeTextEditorCaret(layout, start, session.affinity);
    caret.hidden = false;
    caret.style.left = `${originX + position.x * scale}px`;
    caret.style.top = `${position.top * scale}px`;
    caret.style.height = `${(position.bottom - position.top) * scale}px`;
    caret.dataset.caretOffset = String(start);
    caret.dataset.caretLine = String(position.lineIndex);
  } else {
    caret.hidden = true;
  }
  const rects = nativeTextEditorSelectionRects(layout, start, end);
  const existing = [...selectionLayer.children] as HTMLElement[];
  rects.forEach((rect, index) => {
    const element = existing[index] ?? selectionLayer.appendChild(selectionLayer.ownerDocument.createElement("div"));
    element.className = "text-editor-selection-rect";
    element.dataset.line = String(rect.lineIndex);
    element.style.left = `${originX + rect.left * scale}px`;
    element.style.top = `${rect.top * scale}px`;
    element.style.width = `${Math.max(0, rect.right - rect.left) * scale}px`;
    element.style.height = `${(rect.bottom - rect.top) * scale}px`;
  });
  for (const element of existing.slice(rects.length)) element.remove();
}

/** A primary press over the text: caret, word (double), paragraph (triple) or Shift extension.
 * Click counting is local because a prevented pointerdown suppresses the counted mousedown.
 * Shift always extends: a Shift-click right after a click is never counted as a double-click. */
export function pressTextEditor(editor: HTMLTextAreaElement, session: TextEditorSession, layout: NativeTextEditorLayout,
  point: { x: number; y: number }, press: { pointerId: number; time: number; clientX: number; clientY: number; shiftKey: boolean }) {
  const hit = nativeTextEditorOffsetAtPoint(layout, point);
  const last = session.lastPress;
  const count = !press.shiftKey && last && press.time - last.time < 500 &&
    Math.hypot(press.clientX - last.x, press.clientY - last.y) < 5 ? last.count + 1 : 1;
  session.lastPress = { time: press.time, x: press.clientX, y: press.clientY, count };
  session.goalX = undefined;
  if (count === 2 || count >= 3) {
    const range = count === 2 ? nativeTextEditorWordRange(editor.value, hit.offset) : nativeTextEditorParagraphRange(editor.value, hit.offset);
    setTextEditorSelection(editor, range.start, range.end);
    session.affinity = "downstream";
    session.drag = undefined;
    return;
  }
  const anchor = press.shiftKey ? textEditorSelection(editor).anchor : hit.offset;
  setTextEditorSelection(editor, anchor, hit.offset);
  session.affinity = hit.affinity;
  session.drag = { pointerId: press.pointerId, anchor };
}

export function dragTextEditor(editor: HTMLTextAreaElement, session: TextEditorSession, layout: NativeTextEditorLayout,
  point: { x: number; y: number }) {
  if (!session.drag) return;
  const hit = nativeTextEditorOffsetAtPoint(layout, point);
  setTextEditorSelection(editor, session.drag.anchor, hit.offset);
  session.affinity = hit.affinity;
}

/** ArrowUp/ArrowDown and rendered-line start/end (Home/End on Windows, Cmd+Left/Right on
 * macOS), with Shift extending. Returns false for keys the textarea handles itself. */
export function moveTextEditorCaretForKey(editor: HTMLTextAreaElement, session: TextEditorSession,
  layout: NativeTextEditorLayout, key: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
  platform: ShortcutPlatform): boolean {
  const vertical = (key.key === "ArrowUp" || key.key === "ArrowDown") && !key.altKey && !key.ctrlKey && !key.metaKey;
  const edge = platform === "macos"
    ? key.metaKey && !key.ctrlKey && !key.altKey && (key.key === "ArrowLeft" || key.key === "ArrowRight")
      ? (key.key === "ArrowLeft" ? "start" : "end") : undefined
    : !key.metaKey && !key.ctrlKey && !key.altKey && (key.key === "Home" || key.key === "End")
      ? (key.key === "Home" ? "start" : "end") : undefined;
  if (!vertical && !edge) return false;
  const selection = textEditorSelection(editor);
  const down = key.key === "ArrowDown";
  // Without Shift a selection collapses toward the move before moving, as platform text views do.
  const from = key.shiftKey ? selection.focus : vertical ? (down ? selection.end : selection.start) : selection.focus;
  const affinity = selection.start === selection.end ? session.affinity : "downstream";
  let next: { offset: number; affinity: NativeTextCaretAffinity };
  if (vertical) {
    const moved = nativeTextEditorVerticalMove(layout, from, affinity, down ? 1 : -1, session.goalX);
    session.goalX = moved.goalX;
    next = moved;
  } else {
    session.goalX = undefined;
    next = nativeTextEditorLineBoundary(layout, from, affinity, edge!);
  }
  setTextEditorSelection(editor, key.shiftKey ? selection.anchor : next.offset, next.offset);
  session.affinity = next.affinity;
  return true;
}

/** macOS Cmd+Backspace / Cmd+Delete delete to the start / end of the line. Select that span of
 * the rendered line and let the native delete remove exactly the selection (native undo keeps
 * it). Returns false where the native key already agrees (a selection, or a hard line break). */
export function selectTextEditorLineDeletion(editor: HTMLTextAreaElement, session: TextEditorSession,
  layout: NativeTextEditorLayout, key: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
  platform: ShortcutPlatform): boolean {
  if (platform !== "macos" || !key.metaKey || key.altKey || key.ctrlKey || key.shiftKey) return false;
  if (key.key !== "Backspace" && key.key !== "Delete") return false;
  const { start, end } = textEditorSelection(editor);
  if (start !== end) return false;
  const edge = key.key === "Backspace" ? "start" : "end";
  let boundary = nativeTextEditorLineBoundary(layout, start, session.affinity, edge);
  // At a soft wrap the caret also ends (or starts) the neighbouring rendered line.
  if (boundary.offset === start) boundary = nativeTextEditorLineBoundary(layout, start, edge === "start" ? "upstream" : "downstream", edge);
  if (boundary.offset === start) return false;
  setTextEditorSelection(editor, Math.min(start, boundary.offset), Math.max(start, boundary.offset));
  return true;
}
