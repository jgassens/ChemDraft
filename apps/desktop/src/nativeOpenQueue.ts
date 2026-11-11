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
    } finally { draining = false; }
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
  /** Absent when the open finished, including keeping the page after a resize prompt. */
  error?: unknown;
}

function openFailureReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s*\r?\n\s*/g, " ");
}

function openFileName(displayName: string): string {
  return displayName.split(/[\\/]/).at(-1) || displayName;
}

export function formatDocumentOpenFailure(displayName: string, error: unknown): string {
  return `Could not open ${openFileName(displayName)}: ${openFailureReason(error)}`;
}

/** Successful batches leave the last open's existing status untouched. */
export function formatDocumentOpenBatchStatus(results: readonly DocumentOpenResult[]): string | undefined {
  const failures = results.filter(result => "error" in result);
  const first = failures[0];
  if (!first) return undefined;
  const failure = formatDocumentOpenFailure(failures.map(result => openFileName(result.displayName)).join(", "), first.error);
  return results.length === 1 ? failure : `Opened ${results.length - failures.length} of ${results.length} files. ${failure}`;
}
