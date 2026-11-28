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

/** The status line for a script toggled at a collapsed caret. */
export function pendingTypedScriptStatus(script: TextSpan["script"]): string {
  return script === "normal" ? "Normal text for typing" : script === "subscript"
    ? "Subscript on for typing" : "Superscript on for typing";
}
