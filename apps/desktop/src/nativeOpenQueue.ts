/**
 * Native events are queue-change notifications, never a second source of payloads. Subscribe before
 * the initial destructive drain and serialize all later drains, including notifications received
 * during an in-flight drain. `consume` reserves a slot in the existing document-open queue without
 * waiting for that document's prompts; this coordinator only orders native queue reads.
 */
export function listenAndDrainNativeOpenQueue<T>(options: {
  listen: (changed: () => void) => Promise<() => void>;
  drain: () => Promise<readonly T[]>;
  consume: (payload: T) => void;
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
          for (const payload of payloads) {
            try { options.consume(payload); } catch (error) { options.onError(error); }
          }
        } catch (error) { options.onError(error); }
      }
    } finally { draining = false; }
  };
  const changed = () => {
    requested = true;
    void drainRequested();
  };

  void options.listen(changed).then(stop => {
    if (disposed) { stop(); return; }
    unlisten = stop;
    ready = true;
    changed();
  }).catch(options.onError);

  return () => { disposed = true; unlisten?.(); };
}
