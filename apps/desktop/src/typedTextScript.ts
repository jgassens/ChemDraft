import type { TextSpan } from "@chemdraft/chem-core";

/**
 * Subscript or superscript chosen at a collapsed caret, waiting for the next typed characters.
 *
 * A word processor treats a style toggled with nothing selected as the style of what is typed
 * next. A text box does the same: the toggle records the script here, and the next insertion at
 * that caret takes it. Typing moves the caret along with the text, so the script keeps applying
 * until it is toggled off or the caret goes somewhere else.
 */
export interface PendingTypedScript {
  objectId: string;
  /** Offset in the editor's text (LF line breaks) where the next character will be typed. */
  caret: number;
  script: TextSpan["script"];
}

/**
 * The pending script after a script command at a collapsed caret. `scriptAtCaret` is what a
 * character typed there would get without any toggle; a pending script at the same caret wins.
 * Toggling the script that is already in force turns it back to normal.
 */
export function toggledPendingTypedScript(
  pending: PendingTypedScript | undefined,
  objectId: string,
  caret: number,
  commandScript: TextSpan["script"],
  scriptAtCaret: TextSpan["script"]
): PendingTypedScript {
  const current = pending && pending.objectId === objectId && pending.caret === caret ? pending.script : scriptAtCaret;
  const script = commandScript === "normal" || current !== commandScript ? commandScript : "normal";
  return { objectId, caret, script };
}

/**
 * Where a text change inserted characters at the pending caret, and the pending script that
 * follows the caret afterwards. Undefined when the change was not a plain insertion at that caret
 * (a deletion, a replacement, typing somewhere else), so the pending script should be dropped.
 *
 * `caretAfter` is the editor's caret once the change landed. When given, it decides where the
 * new characters are: a text diff alone cannot tell which of two repeated letters was typed
 * ("HO" to "HOO" may be an O typed at offset 1 or at offset 2), so the insertion counts only if
 * it ends at that caret and starts at the pending one.
 */
export function typedScriptInsertion(
  pending: PendingTypedScript | undefined,
  objectId: string,
  previousText: string,
  nextText: string,
  caretAfter?: number
): { range: { start: number; end: number }; next: PendingTypedScript } | undefined {
  if (!pending || pending.objectId !== objectId) return undefined;
  const inserted = nextText.length - previousText.length;
  const { caret } = pending;
  if (inserted <= 0 || caret < 0 || caret > previousText.length) return undefined;
  if (caretAfter !== undefined && caretAfter - inserted !== caret) return undefined;
  if (nextText.slice(0, caret) !== previousText.slice(0, caret)) return undefined;
  if (nextText.slice(caret + inserted) !== previousText.slice(caret)) return undefined;
  return {
    range: { start: caret, end: caret + inserted },
    next: { ...pending, caret: caret + inserted }
  };
}

/**
 * Whether a selection reported by the editor keeps a pending script alive: only a collapsed caret
 * still at the toggled offset, in the same text box. Any move away drops it for good, so moving
 * back to the old offset afterwards types normal text again.
 */
export function pendingTypedScriptSurvivesSelection(
  pending: PendingTypedScript | undefined,
  objectId: string,
  range: { start: number; end: number }
): boolean {
  return !!pending && pending.objectId === objectId && range.start === range.end && range.start === pending.caret;
}

/**
 * The script the Text style subscript and superscript buttons show for a collapsed caret in the
 * open editor: the script pending at that caret when one survives there, else the script a
 * character typed there would take (`scriptAtCaret`, the same choice `toggledPendingTypedScript`
 * toggles from). So after any caret move (an arrow, Home, End, a click) that drops the pending
 * script, the buttons show what typing will really do, and one click turns the script on with its
 * button lit.
 */
export function effectiveTypedScriptAtCaret(
  pending: PendingTypedScript | undefined,
  objectId: string,
  caret: number,
  scriptAtCaret: TextSpan["script"]
): TextSpan["script"] {
  return pending && pendingTypedScriptSurvivesSelection(pending, objectId, { start: caret, end: caret })
    ? pending.script
    : scriptAtCaret;
}

/** One state of the text in an open editor: its text, its formatting runs, and the pending script. */
export interface TextEditFormattingState {
  text: string;
  spans: TextSpan[];
  pending?: PendingTypedScript;
}

/**
 * The formatting of each text state seen in one editing session, in the order the native editor
 * undo stack holds them. The textarea's own undo and redo restore only the characters; this lets
 * the app put back the exact runs (and the script pending at the caret) that each state had.
 */
export interface TextEditFormattingTimeline {
  objectId: string;
  states: TextEditFormattingState[];
  index: number;
}

/**
 * Record an ordinary edit (typing, deleting, pasting). `before` is the state the edit left, read
 * from the document so formatting applied since the last edit is kept; anything that could have
 * been redone is discarded, as the native stack does.
 */
export function recordTextEditFormatting(
  timeline: TextEditFormattingTimeline | undefined,
  objectId: string,
  before: TextEditFormattingState,
  after: TextEditFormattingState
): TextEditFormattingTimeline {
  if (!timeline || timeline.objectId !== objectId) return { objectId, states: [before, after], index: 1 };
  const states = [...timeline.states.slice(0, timeline.index), before, after];
  return { objectId, states, index: states.length - 1 };
}

/**
 * The state a native undo or redo returned to, found by its text: the nearest earlier state for an
 * undo, the nearest later one for a redo. The browser may merge several typed characters into one
 * undo step, so the step can pass over states. `current` refreshes the state being left, so a redo
 * back to it restores formatting applied after it was recorded. Undefined when no recorded state
 * has that text (the timeline no longer matches the native stack).
 */
export function stepTextEditFormatting(
  timeline: TextEditFormattingTimeline | undefined,
  objectId: string,
  direction: "undo" | "redo",
  current: TextEditFormattingState,
  targetText: string
): { timeline: TextEditFormattingTimeline; state: TextEditFormattingState } | undefined {
  if (!timeline || timeline.objectId !== objectId || timeline.states[timeline.index]?.text !== current.text) return undefined;
  const states = timeline.states.slice();
  states[timeline.index] = current;
  const step = direction === "undo" ? -1 : 1;
  for (let index = timeline.index + step; index >= 0 && index < states.length; index += step) {
    if (states[index]!.text === targetText) return { timeline: { objectId, states, index }, state: states[index]! };
  }
  return undefined;
}

/** The status line for a script toggled at a collapsed caret. */
export function pendingTypedScriptStatus(script: TextSpan["script"]): string {
  return script === "normal" ? "Normal text for typing" : script === "subscript"
    ? "Subscript on for typing" : "Superscript on for typing";
}
