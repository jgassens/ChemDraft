import { detectShortcutPlatform, type ShortcutPlatform } from "@chemdraft/shortcut-engine";

const reloadPreventedEvents = new WeakSet<KeyboardEvent>();

/** The browser default was canceled by this guard, so normal app shortcut routing may continue. */
export function wasBrowserReloadPrevented(event: KeyboardEvent): boolean {
  return reloadPreventedEvents.has(event);
}

/** WebView2 reloads discard the document and undo history. WKWebView has no reload chord. */
export function isBrowserReloadChord(
  event: { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean },
  platform: ShortcutPlatform = detectShortcutPlatform()
): boolean {
  if (platform === "macos" || event.altKey || event.metaKey) return false;
  if (event.key === "F5" || event.key === "BrowserRefresh") return true;
  return Boolean(event.ctrlKey) && event.key.toLowerCase() === "r";
}

/** Cancel reload before controls swallow keydown, while preserving normal app shortcut routing. */
export function installBrowserReloadGuard(
  platform: ShortcutPlatform = detectShortcutPlatform(),
  target: Window = window
): () => void {
  const guard = (event: KeyboardEvent) => {
    if (!isBrowserReloadChord(event, platform)) return;
    if (!event.defaultPrevented) reloadPreventedEvents.add(event);
    event.preventDefault();
  };
  target.addEventListener("keydown", guard, true);
  return () => target.removeEventListener("keydown", guard, true);
}
