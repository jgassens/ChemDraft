// Where Tauri's `app_data_dir()` lives on each platform, minus the bundle identifier.
//
// Node-side tools (the Vite dev middleware that serves staged plugins, `running-build.mjs`) must
// read the same directories the running app writes. Tauri resolves app_data_dir via the `dirs`
// crate's data_dir: `~/Library/Application Support` on macOS, the roaming `%APPDATA%` on Windows,
// and `$XDG_DATA_HOME` (default `~/.local/share`) on Linux. Keep this in step with that.
import { homedir } from "node:os";
import { join } from "node:path";

/** The bundle identifier a stable (non-dev) build uses; mirrors `tauri.conf.json`. */
export const STABLE_BUNDLE_ID = "org.chemdraft.desktop";

export function appDataRoot(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support");
  }
  if (platform === "win32") {
    return env.APPDATA || join(home, "AppData", "Roaming");
  }
  return env.XDG_DATA_HOME || join(home, ".local", "share");
}
