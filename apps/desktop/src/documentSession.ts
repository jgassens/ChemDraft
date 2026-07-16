/**
 * Working-document autosave ("document session").
 *
 * The envelope carries the serialized document plus its file association so a relaunch resumes
 * exactly the last edited state — including unsaved changes — with no explicit save involved.
 * MainWindow writes it (debounced) on every document/file-state change and restores it at startup;
 * `document-session.json` in the app data dir is the Rust-persisted storage.
 *
 * Blankness is an explicit flag captured from the live document's object count at save time —
 * serialized bytes are NOT comparable across launches (fresh documents get new ids/timestamps),
 * so hash equality can never recognize "this is just an empty canvas".
 *
 * Everything here is pure so the envelope contract is unit-testable; the effects live in
 * MainWindow.
 */

export const DOCUMENT_SESSION_VERSION = 1;
export const DOCUMENT_SESSION_SAVE_DEBOUNCE_MS = 800;

export interface DocumentSessionEnvelope {
  version: typeof DOCUMENT_SESSION_VERSION;
  /** Full serialized document (the same payload File > Save writes). */
  contents: string;
  /** Hash of `contents`, kept for debugging and future retention policies. */
  payloadHash: string;
  /** True when the document had no drawable objects on any page at save time. */
  blank: boolean;
  /** Absolute path of the associated file, when the document has ever been saved/opened. */
  path?: string;
  /** Name shown in the restore status line (file basename, or the document's save filename). */
  displayName: string;
  /** True when the session holds edits that were never written to `path`. */
  dirty: boolean;
  /** ISO timestamp of the autosave, for debugging and future retention policies. */
  savedAt: string;
}

export interface DocumentSessionSource {
  contents: string;
  payloadHash: string;
  /** The serializer's suggested filename (used when no file is associated). */
  filename: string;
}

/** No drawable objects on any page. Structural parameter type so this module stays free of the
 *  document schema import. */
export function documentIsBlank(document: {
  pages: ReadonlyArray<{ objects: ReadonlyArray<unknown> }>;
}): boolean {
  return document.pages.every((page) => page.objects.length === 0);
}

export function buildDocumentSessionEnvelope(
  payload: DocumentSessionSource,
  fileState: { path?: string; dirty: boolean },
  displayName: string,
  blank: boolean,
  savedAt: Date = new Date()
): DocumentSessionEnvelope {
  return {
    version: DOCUMENT_SESSION_VERSION,
    contents: payload.contents,
    payloadHash: payload.payloadHash,
    blank,
    ...(fileState.path !== undefined ? { path: fileState.path } : {}),
    displayName,
    dirty: fileState.dirty,
    savedAt: savedAt.toISOString()
  };
}

/** Structural validation of a loaded envelope; anything unexpected restores nothing (the blank
 *  document stands) rather than throwing at startup. */
export function parseDocumentSessionEnvelope(raw: unknown): DocumentSessionEnvelope | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  if (
    candidate.version !== DOCUMENT_SESSION_VERSION ||
    typeof candidate.contents !== "string" ||
    candidate.contents.length === 0 ||
    typeof candidate.payloadHash !== "string" ||
    typeof candidate.blank !== "boolean" ||
    typeof candidate.displayName !== "string" ||
    typeof candidate.dirty !== "boolean" ||
    typeof candidate.savedAt !== "string" ||
    (candidate.path !== undefined && typeof candidate.path !== "string")
  ) {
    return undefined;
  }
  return {
    version: DOCUMENT_SESSION_VERSION,
    contents: candidate.contents,
    payloadHash: candidate.payloadHash,
    blank: candidate.blank,
    ...(candidate.path !== undefined ? { path: candidate.path } : {}),
    displayName: candidate.displayName,
    dirty: candidate.dirty,
    savedAt: candidate.savedAt
  };
}

/** An empty never-saved canvas restores nothing — otherwise every fresh launch would announce
 *  "Restored last session" over the identical blank it starts with anyway. A blank canvas still
 *  restores when it IS a file (reopen it) or carries unsaved edits (e.g. the user erased
 *  everything and that erasure is the unsaved state). */
export function shouldRestoreDocumentSession(envelope: DocumentSessionEnvelope): boolean {
  return envelope.path !== undefined || envelope.dirty || !envelope.blank;
}
