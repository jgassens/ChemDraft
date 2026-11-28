/**
 * Keys that belong to an open typed-rotation entry (Rotate Molecule…, or a double-click on the
 * rotate handle) even when focus is not in its field yet: a native context menu or a handle press
 * can leave focus on the canvas or on the handle, and digits typed there would run canvas
 * shortcuts instead of entering the angle (RC5 report: "type 45, Enter: nothing happened").
 */
export type RotationEntryKeyAction =
  | { kind: "insert"; text: string }
  | { kind: "delete"; backward: boolean }
  | { kind: "keep" }
  | { kind: "cancel" };

export interface RotationEntryKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

/** What a key does to the open entry, or undefined for a key the entry leaves alone (a chord,
 * a letter, an arrow). Digits, a minus or plus sign and a decimal point are entered. */
export function rotationEntryKeyAction(event: RotationEntryKeyEvent): RotationEntryKeyAction | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return undefined;
  if (/^[0-9]$/.test(event.key) || event.key === "-" || event.key === "+" || event.key === ".") {
    return { kind: "insert", text: event.key };
  }
  switch (event.key) {
    case "Backspace": return { kind: "delete", backward: true };
    case "Delete": return { kind: "delete", backward: false };
    case "Enter": return { kind: "keep" };
    case "Escape": return { kind: "cancel" };
    default: return undefined;
  }
}

/** The field's text and caret after an insert or delete at its selection. */
export function editRotationEntryField(
  value: string, selectionStart: number, selectionEnd: number, action: Extract<RotationEntryKeyAction, { kind: "insert" | "delete" }>
): { value: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd, value.length));
  const end = Math.max(start, Math.min(Math.max(selectionStart, selectionEnd), value.length));
  if (action.kind === "insert") {
    return { value: value.slice(0, start) + action.text + value.slice(end), caret: start + action.text.length };
  }
  if (start !== end) return { value: value.slice(0, start) + value.slice(end), caret: start };
  return action.backward
    ? { value: value.slice(0, Math.max(0, start - 1)) + value.slice(start), caret: Math.max(0, start - 1) }
    : { value: value.slice(0, start) + value.slice(start + 1), caret: start };
}
