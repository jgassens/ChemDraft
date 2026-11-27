#!/usr/bin/env node
// Run Vite for the browser build with preloaded web plugins: `dev:web:plugins` and `build:web:plugins`
// in apps/desktop/package.json. Sets CHEMDRAFT_WEB_PLUGINS_DIR to the default staging directory
// (apps/desktop/.web-plugins) unless it is already set, then runs Vite with the given arguments.
// A Node launcher rather than `VAR=… vite` so the scripts also run under cmd.exe on Windows.
// `--toolbar-profile=<name>` (first argument, used by `dev:web:game` / `build:web:game`) sets
// CHEMDRAFT_TOOLBAR_PROFILE for this run; vite.config.ts rejects a name no profile has.
//
// Browser build only. The Tauri build never calls this, and the Vite plugin refuses to run inside a
// Tauri build with the variable set (scripts/web-plugins/vitePlugin.ts).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_DIR = join(ROOT_DIR, "apps", "desktop");
const DEFAULT_DIR = join(APP_DIR, ".web-plugins");

const PROFILE_FLAG = "--toolbar-profile=";

let args = process.argv.slice(2);
const env = { ...process.env, CHEMDRAFT_WEB_PLUGINS_DIR: process.env.CHEMDRAFT_WEB_PLUGINS_DIR || DEFAULT_DIR };
if (args[0]?.startsWith(PROFILE_FLAG)) {
  env.CHEMDRAFT_TOOLBAR_PROFILE = args[0].slice(PROFILE_FLAG.length);
  args = args.slice(1);
}
const viteBin = join(dirname(createRequire(join(APP_DIR, "package.json")).resolve("vite/package.json")), "bin", "vite.js");
const result = spawnSync(process.execPath, [viteBin, ...args], { cwd: APP_DIR, env, stdio: "inherit" });
process.exit(result.status ?? 1);
