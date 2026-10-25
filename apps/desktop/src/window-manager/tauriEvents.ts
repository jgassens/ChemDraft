import type { Event, EventCallback, UnlistenFn } from "@tauri-apps/api/event";

/** Stops a listener. Safe to call any number of times, and at any moment. */
export type SafeUnlisten = () => void;

/** Attaches a native listener for `handler` and resolves with Tauri's own unlisten for it. */
export type TauriAttach<T> = (handler: EventCallback<T>) => Promise<UnlistenFn>;

/** How often, and how far apart, a failed unlisten is retried before giving up. */
export const UNLISTEN_ATTEMPTS = 6;
export const UNLISTEN_RETRY_MS = 25;

export interface SafeTauriListener {
  /** Stop listening: mutes the handler at once, then removes the native listener. */
  stop: SafeUnlisten;
  /** Resolves with `stop` once the native listener is attached; rejects if attaching failed. */
  attached: Promise<SafeUnlisten>;
}

/**
 * Listen to a Tauri event so that stopping can never fail.
 *
 * Tauri 2.11's unlisten reads `listeners[event][eventId].handlerId` with no guard. `listen()`
 * resolves on the IPC reply, but the script that creates that entry in the page is evaluated
 * separately and can land after it. An unlisten made in that gap (a component that subscribed and
 * cleaned up at once, a popover that closed as it opened) throws "Cannot read properties of
 * undefined (reading 'handlerId')" inside an async function: an unhandled rejection, which the
 * crash reporter shows as "ChemDraft ran into an error". Its native listener is never removed.
 *
 * The returned `stop`:
 * - mutes `handler` at once, so nothing it does can run after stop, whatever Tauri is doing;
 * - runs Tauri's unlisten exactly once, after `listen()` has resolved (stop before that is kept and
 *   applied when it does);
 * - if that unlisten fails because the entry is not there yet, retries it a few times, so the native
 *   listener is still removed rather than leaked; and never leaves a rejection unhandled.
 *
 * TODO(tauri-events): drop the retry once the tauri release we use includes the unlisten guard (upstream
 * dev has it; not confirmed for 2.12.0). The mute and the once-only unlisten stay.
 */
export function safeTauriListen<T>(eventName: string, attach: TauriAttach<T>, handler: EventCallback<T>): SafeTauriListener {
  let stopped = false;
  let unlisten: UnlistenFn | undefined;

  const release = (nativeUnlisten: UnlistenFn, attempt: number) => {
    const retry = (error: unknown) => {
      if (attempt + 1 < UNLISTEN_ATTEMPTS) {
        setTimeout(() => release(nativeUnlisten, attempt + 1), UNLISTEN_RETRY_MS * (attempt + 1));
      } else {
        // The handler is muted, so a native listener left behind delivers to nothing.
        console.warn(`Could not stop listening to ${eventName}`, error);
      }
    };
    try {
      const result: unknown = nativeUnlisten();
      if (result instanceof Promise) {
        result.catch(retry);
      }
    } catch (error) {
      retry(error);
    }
  };

  const stop: SafeUnlisten = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (unlisten) {
      release(unlisten, 0);
      unlisten = undefined;
    }
  };

  const attached = attach((event: Event<T>) => {
    if (!stopped) {
      handler(event);
    }
  }).then((nativeUnlisten) => {
    if (stopped) {
      release(nativeUnlisten, 0);
    } else {
      unlisten = nativeUnlisten;
    }
    return stop;
  });

  return { stop, attached };
}

/** `listen` from `@tauri-apps/api/event` (events to any target), with a stop that cannot fail. */
export async function listenTauriEvent<T>(eventName: string, handler: EventCallback<T>): Promise<SafeUnlisten> {
  const { listen } = await import("@tauri-apps/api/event");
  return safeTauriListen<T>(eventName, (wrapped) => listen<T>(eventName, wrapped), handler).attached;
}

/** The current webview window's own `listen` (events targeted at this window), with a stop that cannot fail. */
export async function listenCurrentWindowEvent<T>(eventName: string, handler: EventCallback<T>): Promise<SafeUnlisten> {
  // A desktop UI marker (__TAURI__) alone supplies no window metadata or native IPC.
  // Use the same host check as isTauriHost without loading the plugin filesystem adapter here.
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => undefined;
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const currentWindow = getCurrentWebviewWindow();
  return safeTauriListen<T>(eventName, (wrapped) => currentWindow.listen<T>(eventName, wrapped), handler).attached;
}
