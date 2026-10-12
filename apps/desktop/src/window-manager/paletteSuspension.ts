import { suspendToolsetWindows } from "./index";

/** One document-owned lease pool for native dialogs, utility windows and HTML modals. */
export function createPaletteSuspensionCoordinator(suspend: (active: boolean) => Promise<void>) {
  let nativeDialogs = 0;
  let htmlModal = false;
  let applied = false;
  let pending = Promise.resolve();
  const update = () => {
    pending = pending.catch(() => undefined).then(async () => {
      const active = nativeDialogs > 0 || htmlModal;
      if (active !== applied) {
        // Native hiding may fail after hiding some windows; finally must still restore them.
        if (active) applied = true;
        await suspend(active);
        applied = active;
      }
    });
    return pending;
  };
  return {
    setHtmlModal(active: boolean) {
      htmlModal = active;
      void update().catch(() => undefined);
    },
    settled: () => pending,
    async run<T>(open: () => Promise<T>): Promise<T> {
      nativeDialogs += 1;
      try {
        await update();
        return await open();
      } finally {
        // Let a native result's HTML replacement reach the modal observer first.
        await Promise.resolve();
        nativeDialogs -= 1;
        await update();
      }
    }
  };
}

export const paletteSuspension = createPaletteSuspensionCoordinator(suspendToolsetWindows);
export const withToolsetWindowsSuspended = <T>(open: () => Promise<T>) => paletteSuspension.run(open);
