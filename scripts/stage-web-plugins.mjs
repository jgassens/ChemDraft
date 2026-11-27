#!/usr/bin/env node
// Stage released plugin packages for the browser build. See scripts/web-plugins/stage.ts and
// docs/plugin-architecture/AUTHORING.md ("Running a plugin in the web build").
//
//   node scripts/stage-web-plugins.mjs <plugin.zip> [...more zips] [--out <dir>]
//
// The gates are the app's own TypeScript (inspectPluginPackage), so this registers tsx and imports them
// rather than reimplementing them. Relative paths resolve against the directory the command was typed
// in: under `pnpm --filter … stage:web-plugins` that is INIT_CWD, not the package directory.
import { register } from "tsx/esm/api";

register();
const { main } = await import("./web-plugins/stage.ts");
process.exitCode = await main(process.argv.slice(2), { cwd: process.env.INIT_CWD || process.cwd() });
