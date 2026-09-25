import { DOM_COMMAND_EVENT } from "./window-manager";

/**
 * Edit ▸ Undo / Redo routing.
 *
 * The native Edit menu carries routed `edit.undo` / `edit.redo` items (⌘Z / ⇧⌘Z) instead of AppKit's
 * predefined ones: the predefined items send `undo:` to the first responder, which is the webview's
 * own text undo manager, so they were greyed out or did nothing after a drawing change.
 *
 * Routing them to the document instead creates the opposite hazard: a focused text field (atom
 * label, text editor, any input) now gets its ⌘Z as a routed menu command. The canvas keydown path
 * ignores editable targets and does not `preventDefault`, so WebKit passes the key equivalent on to
 * the menu — which is exactly one delivery, here. This module sends that delivery back to the field
 * as native text undo, and leaves document history alone.
 *
 * On the canvas, the keydown path `preventDefault`s ⌘Z, which is WebKit's signal to skip the menu key
 * equivalent — the same arrangement that keeps ⌘S from saving twice. One press, one undo.
 *
 * Rust delivers the two commands to whichever window is key, as AppKit's predefined items did. A
 * secondary window (palette, popover, preferences, plugin panel) answers with its own field's text
 * undo, or forwards to the main window's document history when no field is focused
 * (`installSecondaryWindowEditHistory`).
 */
export type EditHistoryDirection = "undo" | "redo";

/** `"text"`: the focused field undoes; `"document"`: document history can move; `"nothing"`: it cannot. */
export type EditHistoryRoute = "text" | "document" | "nothing";

export function editHistoryDirection(commandId: string): EditHistoryDirection | undefined {
  if (commandId === "edit.undo") {
    return "undo";
  }
  if (commandId === "edit.redo") {
    return "redo";
  }
  return undefined;
}

/** Input types that hold typed text, and so have a text undo stack for ⌘Z to act on. */
const TEXT_ENTRY_INPUT_TYPES = new Set(["", "text", "search", "number", "email", "url", "tel", "password"]);

/**
 * True when `element` is a text-entry surface whose own undo stack should answer ⌘Z: a textarea, a
 * contenteditable region, or a text-like input. A focused checkbox, slider, color well, or select
 * has no text to undo, so ⌘Z there belongs to the document.
 */
export function isTextEditingElement(element: Element | null | undefined): boolean {
  if (!element) {
    return false;
  }
  const tagName = element.tagName.toLowerCase();
  if (tagName === "textarea") {
    return true;
  }
  if (tagName === "input") {
    // `getAttribute`, not `.type`: an unknown type reads back as "text" from the property.
    const type = (element.getAttribute("type") ?? "").trim().toLowerCase();
    return TEXT_ENTRY_INPUT_TYPES.has(type);
  }
  const editableHost = element.closest("[contenteditable]");
  return editableHost !== null && editableHost.getAttribute("contenteditable")?.toLowerCase() !== "false";
}

export function resolveEditHistoryRoute(
  direction: EditHistoryDirection,
  state: { activeElement: Element | null | undefined; canUndo: boolean; canRedo: boolean },
  options?: {
    /**
     * A secondary window already decided no text field was focused there, and forwarded the command
     * to the document window for exactly that reason. The document window's own `activeElement` can
     * still be a text input (a hidden field never blurred, since the document window is not key), so
     * that check must not run a second time here — it would undo the field's text instead of the
     * drawing. See `installSecondaryWindowEditHistory`.
     */
    forceDocument?: boolean;
  }
): EditHistoryRoute {
  if (!options?.forceDocument && isTextEditingElement(state.activeElement)) {
    return "text";
  }
  const canMove = direction === "undo" ? state.canUndo : state.canRedo;
  return canMove ? "document" : "nothing";
}

/** Suffix marking a commandId as forwarded from a secondary window with no text field focused there. */
const FORCE_DOCUMENT_HISTORY_SUFFIX = ":forceDocumentHistory";

/** Wraps `commandId` so the document window skips its own text-field check when it arrives. */
export function forceDocumentHistoryCommandId(commandId: string): string {
  return `${commandId}${FORCE_DOCUMENT_HISTORY_SUFFIX}`;
}

/** True when `commandId` was wrapped by `forceDocumentHistoryCommandId`. */
export function isForcedDocumentHistoryCommandId(commandId: string): boolean {
  return commandId.endsWith(FORCE_DOCUMENT_HISTORY_SUFFIX);
}

/** Undoes `forceDocumentHistoryCommandId`, returning `commandId` unchanged if it was not wrapped. */
export function stripForcedDocumentHistorySuffix(commandId: string): string {
  return isForcedDocumentHistoryCommandId(commandId)
    ? commandId.slice(0, -FORCE_DOCUMENT_HISTORY_SUFFIX.length)
    : commandId;
}

/**
 * Native text undo/redo in the focused field. `execCommand` is deprecated in the DOM typings but is
 * still how a script reaches WebKit's editing undo stack; there is no replacement API.
 */
export function performTextFieldHistory(direction: EditHistoryDirection, doc: Document): boolean {
  if (typeof doc.execCommand !== "function") {
    return false;
  }
  return doc.execCommand(direction);
}

/**
 * Edit ▸ Undo / Redo in a secondary window. Rust sends the routed menu command to the key window, so
 * a palette's color hex box or the customize gallery's search gets its own text undo — the drawing
 * is not touched. With no text field focused there, ⌘Z still means the drawing, so the command is
 * forwarded to the main window. Returns the uninstaller.
 */
export function installSecondaryWindowEditHistory(options: {
  target?: Window;
  forwardToMain(commandId: string): void | Promise<void>;
}): () => void {
  const target = options.target ?? window;
  const listener = (event: Event) => {
    const commandId = (event as CustomEvent<{ commandId?: unknown } | undefined>).detail?.commandId;
    if (typeof commandId !== "string") {
      return;
    }
    const direction = editHistoryDirection(commandId);
    if (!direction) {
      return;
    }
    const doc = target.document;
    if (isTextEditingElement(doc.activeElement)) {
      performTextFieldHistory(direction, doc);
      return;
    }
    const forwardedCommandId = forceDocumentHistoryCommandId(commandId);
    void Promise.resolve(options.forwardToMain(forwardedCommandId)).catch((error: unknown) => {
      console.error(`Could not forward ${forwardedCommandId} to the document window.`, error);
    });
  };
  target.addEventListener(DOM_COMMAND_EVENT, listener);
  return () => target.removeEventListener(DOM_COMMAND_EVENT, listener);
}
