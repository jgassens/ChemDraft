import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "../keyboardShortcuts";

/** Native Windows serves this request with the installed-plugin CSP, never the page's CSP. */
export const PLUGIN_WORKER_BOOTSTRAP_QUERY = "__chemdraft_worker_bootstrap";

export function pluginWorkerBootstrapUrl(
  entry: URL,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): URL {
  if (platform !== "windows" || entry.origin !== "http://tauri.localhost") return entry;
  const bootstrap = new URL(entry.href);
  bootstrap.searchParams.set(PLUGIN_WORKER_BOOTSTRAP_QUERY, "windows");
  return bootstrap;
}
