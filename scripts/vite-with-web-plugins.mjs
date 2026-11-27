#!/usr/bin/env node
// Run Vite for the browser build with preloaded web plugins: `dev:web:plugins` and `build:web:plugins`
// in apps/desktop/package.json. Sets CHEMDRAFT_WEB_PLUGINS_DIR to the default staging directory
// (apps/desktop/.web-plugins) unless it is already set, then runs Vite with the given arguments.
// A Node launcher rather than `VAR=… vite` so the scripts also run under cmd.exe on Windows.
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

const env = { ...process.env, CHEMDRAFT_WEB_PLUGINS_DIR: process.env.CHEMDRAFT_WEB_PLUGINS_DIR || DEFAULT_DIR };
const viteBin = join(dirname(createRequire(join(APP_DIR, "package.json")).resolve("vite/package.json")), "bin", "vite.js");
const result = spawnSync(process.execPath, [viteBin, ...process.argv.slice(2)], { cwd: APP_DIR, env, stdio: "inherit" });
process.exit(result.status ?? 1);
