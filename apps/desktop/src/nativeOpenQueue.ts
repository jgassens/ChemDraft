import { DocumentOpenError } from "./documentText";
import { dropErrorReason } from "./imageDrop/dropReason";

/**
 * Native events are queue-change notifications, never a second source of payloads. Subscribe before
 * the initial destructive drain and serialize all later drains, including notifications received
 * during an in-flight drain. `consumeBatch` reserves slots in the existing document-open queue
 * without waiting for prompts; each destructive drain is one batch for status reporting.
 */
export function listenAndDrainNativeOpenQueue<T>(options: {
  subscribe: (changed: () => void) => Promise<() => void>;
  drain: () => Promise<readonly T[]>;
  consumeBatch: (payloads: readonly T[]) => void;
  onDrainActivity?: (busy: boolean) => void;
  onError: (error: unknown) => void;
}): () => void {
  let disposed = false;
  let ready = false;
  let requested = false;
  let draining = false;
  let unlisten: (() => void) | undefined;

  const drainRequested = async () => {
    if (!ready || draining || disposed) return;
    draining = true;
    options.onDrainActivity?.(true);
    try {
      while (requested && !disposed) {
        requested = false;
        try {
          const payloads = await options.drain();
          // A completed destructive read owns its payloads, even if cleanup occurred while it was
          // pending (including a StrictMode replay). Dropping that batch here would lose files.
          if (payloads.length) options.consumeBatch(payloads);
        } catch (error) { options.onError(error); }
      }
    } finally {
      draining = false;
      if (!disposed) options.onDrainActivity?.(false);
    }
  };
  const changed = () => {
    requested = true;
    void drainRequested();
  };

  void options.subscribe(changed).then(stop => {
    if (disposed) { stop(); return; }
    unlisten = stop;
    ready = true;
    changed();
  }).catch(options.onError);

  return () => { disposed = true; unlisten?.(); };
}

export interface DocumentOpenResult {
  displayName: string;
  /**
   * Absent when the open finished, including keeping the page after a resize prompt. A refusal
   * ChemDraft wrote ("Finish or cancel the current edit and try again.") is a `DocumentOpenError`;
   * a bare string is not trusted, since Tauri's file system rejects with one ("Access is denied.").
   */
  error?: unknown;
  /** A finished open's own status line ("Opened …", or that the file was already open). */
  status?: string;
}

function openFailureReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s*\r?\n\s*/g, " ");
}

/** What a dropped document's failure says when its error's text is not ChemDraft's own. */
export const DROPPED_DOCUMENT_UNREADABLE_REASON = "the file could not be read.";

/**
 * A dropped document's failure reason: ChemDraft's own wording (a `DocumentOpenError`) as written;
 * anything else, such as the file system's "Access is denied. (os error 5)", in plain words, the
 * error itself logged.
 */
function droppedOpenFailureReason(displayName: string, error: unknown): string {
  if (error instanceof DocumentOpenError) return openFailureReason(error);
  return dropErrorReason(error, `Could not open the dropped document ${openFileName(displayName)}`) ?? DROPPED_DOCUMENT_UNREADABLE_REASON;
}

function openFileName(displayName: string): string {
  return displayName.split(/[\\/]/).at(-1) || displayName;
}

/** File > Open and the shell's opens keep the error's own text; a drop (`fromDrop`) shows only ChemDraft's wording. */
export function formatDocumentOpenFailure(displayName: string, error: unknown, fromDrop = false): string {
  const reason = fromDrop ? droppedOpenFailureReason(displayName, error) : openFailureReason(error);
  return `Could not open ${openFileName(displayName)}: ${reason}`;
}

/** Successful batches leave the last open's existing status untouched. */
export function formatDocumentOpenBatchStatus(results: readonly DocumentOpenResult[], fromDrop = false): string | undefined {
  const failures = results.filter(result => "error" in result);
  const first = failures[0];
  if (!first) return undefined;
  const failure = formatDocumentOpenFailure(failures.map(result => openFileName(result.displayName)).join(", "), first.error, fromDrop);
  return results.length === 1 ? failure : `Opened ${results.length - failures.length} of ${results.length} files. ${failure}`;
}

/**
 * What a drop's outcome says of its documents: every one that opened, by its own status line, then,
 * when any failed, the count of those opened and each failure with its own reason (ChemDraft's
 * wording only, as `formatDocumentOpenFailure` gives it for a drop). Undefined for no documents.
 */
export function formatDocumentOpenDropOutcome(results: readonly DocumentOpenResult[]): string | undefined {
  const opened = results.flatMap(result => "error" in result ? [] : [result.status ?? `Opened ${openFileName(result.displayName)}`]);
  const failures = results.flatMap(result => "error" in result ? [formatDocumentOpenFailure(result.displayName, result.error, true)] : []);
  if (failures.length && results.length > 1) failures[0] = `Opened ${opened.length} of ${results.length} files. ${failures[0]}`;
  const parts = [...opened, ...failures];
  return parts.length ? parts.join("; ") : undefined;
}
