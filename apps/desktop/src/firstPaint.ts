// A window built hidden by `first_paint::hidden_until_first_paint` (src-tauri/src/first_paint.rs)
// is shown when its page calls `ackFirstPaint()`, or by Rust's fallback timer if it never does.
// The acknowledgement shows only the window that sends it, and only the first one counts.

/** The Tauri command (permission `allow-window-first-paint`). index.html's inline loader calls it too. */
export const WINDOW_FIRST_PAINT_COMMAND = "window_first_paint";

/** What `ackFirstPaint` reads from the page; tests pass their own. */
export interface FirstPaintEnvironment {
  requestAnimationFrame?: (callback: () => void) => unknown;
  document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  invoke?: (command: string) => Promise<unknown>;
}

/** Loaded on first use, so importing the command name pulls in no Tauri API. */
const tauriInvoke = (command: string) => import("@tauri-apps/api/core").then(core => core.invoke(command));

function pageEnvironment(): FirstPaintEnvironment {
  return {
    requestAnimationFrame: typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
      ? callback => window.requestAnimationFrame(callback)
      : undefined,
    document: typeof document !== "undefined" ? document : undefined,
    invoke: tauriInvoke
  };
}

/**
 * Tells the host this window's content has painted. Call it once the first screen is in the DOM.
 *
 * While the page is visible, it waits two animation frames: the second runs only after the first
 * frame, which carried the content, has been presented. While the page is hidden it acknowledges at
 * once instead, because a hidden document gets no animation frames (Chromium, and so WebView2,
 * stops producing frames for a hidden page; WebKit does the same), and the window would otherwise
 * wait for the fallback. The content is already in the DOM then, so the first frame produced when
 * the window is shown contains it. A page that turns hidden while waiting acknowledges then.
 * Never throws; a refused or failed invoke is swallowed (the fallback still shows the window).
 */
export function ackFirstPaint(environment: FirstPaintEnvironment = pageEnvironment()): Promise<void> {
  const { requestAnimationFrame, document: page } = environment;
  const send = environment.invoke ?? tauriInvoke;
  return new Promise<void>(resolve => {
    let sent = false;
    const acknowledge = () => {
      if (sent) return;
      sent = true;
      page?.removeEventListener("visibilitychange", onVisibility);
      Promise.resolve()
        .then(() => send(WINDOW_FIRST_PAINT_COMMAND))
        .catch(() => undefined)
        .then(() => resolve());
    };
    const onVisibility = () => {
      if (page?.visibilityState === "hidden") acknowledge();
    };
    if (!requestAnimationFrame || page?.visibilityState === "hidden") {
      acknowledge();
      return;
    }
    page?.addEventListener("visibilitychange", onVisibility);
    requestAnimationFrame(() => requestAnimationFrame(acknowledge));
  });
}
