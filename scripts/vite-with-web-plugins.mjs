#!/usr/bin/env node
// Run Vite for the browser build with preloaded web plugins: `dev:web:plugins` and `build:web:plugins`
// in apps/desktop/package.json. Sets CHEMDRAFT_WEB_PLUGINS_DIR to the default staging directory
// (apps/desktop/.web-plugins) unless it is already set, then runs Vite with the given arguments.
// A Node launcher rather than `VAR=… vite` so the scripts also run under cmd.exe on Windows.
// Leading flags, used by `dev:web:game` / `build:web:game`, in any order before Vite's own arguments:
//   --toolbar-profile=<name>   sets CHEMDRAFT_TOOLBAR_PROFILE; vite.config.ts rejects a name no profile has.
//   --startup-command=<id>     sets CHEMDRAFT_WEB_STARTUP_COMMAND, the preloaded plugin's command the page
//                              runs once its plugins have loaded (apps/desktop/src/plugins/webStartupCommand.ts).
//
// Browser build only. The Tauri build never calls this, and the Vite plugin and vite.config.ts refuse to
// run inside a Tauri build with these variables set (scripts/web-plugins/vitePlugin.ts).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_DIR = join(ROOT_DIR, "apps", "desktop");
const DEFAULT_DIR = join(APP_DIR, ".web-plugins");

const LEADING_FLAGS = {
  "--toolbar-profile=": "CHEMDRAFT_TOOLBAR_PROFILE",
  "--startup-command=": "CHEMDRAFT_WEB_STARTUP_COMMAND"
};

/** The environment and Vite arguments for one run: leading launcher flags become variables. */
export function webPluginsLaunch(argv, baseEnv) {
  let args = [...argv];
  const env = { ...baseEnv, CHEMDRAFT_WEB_PLUGINS_DIR: baseEnv.CHEMDRAFT_WEB_PLUGINS_DIR || DEFAULT_DIR };
  for (;;) {
    const flag = Object.keys(LEADING_FLAGS).find(prefix => args[0]?.startsWith(prefix));
    if (!flag) break;
    env[LEADING_FLAGS[flag]] = args[0].slice(flag.length);
    args = args.slice(1);
  }
  return { env, args };
}

function main() {
  const { env, args } = webPluginsLaunch(process.argv.slice(2), process.env);
  const viteBin = join(dirname(createRequire(join(APP_DIR, "package.json")).resolve("vite/package.json")), "bin", "vite.js");
  const result = spawnSync(process.execPath, [viteBin, ...args], { cwd: APP_DIR, env, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) main();
