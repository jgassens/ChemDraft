/** Serial drain of the native FIFO. Subscribe before waking it. Pausing during React effect
 * replay retains an in-flight result until the next subscription, instead of losing a file. */
export function createNativeOpenQueue<T>(take: () => Promise<T | undefined>) {
  let handler: ((payload: T) => Promise<void>) | undefined;
  let running = false;
  let requested = false;
  const buffered: T[] = [];
  const wake = async (): Promise<void> => {
    requested = true;
    if (running || !handler) return;
    running = true;
    try {
      do {
        requested = false;
        while (handler) {
          requested = false; // this poll also covers wake-ups received during the previous open
          const payload = buffered.shift() ?? await take();
          if (payload === undefined) break;
          if (!handler) { buffered.unshift(payload); break; }
          await handler(payload);
        }
      } while (requested && handler);
    } finally {
      running = false;
    }
  };
  return {
    wake,
    subscribe(next: (payload: T) => Promise<void>) {
      handler = next;
      return () => { if (handler === next) handler = undefined; };
    }
  };
}
