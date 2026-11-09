#!/usr/bin/env node
// Read-only preflight: never builds a runtime or downloads a JDK.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { macosBuildTarget } from "./macos-build-target.mjs";
import { checkOpsinRuntimeArchitecture } from "./opsin-runtime-architecture.mjs";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export function isMacosReleasePackaging(args, platform = process.platform) {
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  if (platform !== "darwin" || options[0] !== "build" || options.includes("--debug") || options.includes("--no-bundle")) return false;
  const index = options.findIndex((arg) => arg === "--bundles" || arg === "-b" || arg.startsWith("--bundles="));
  if (index === -1) return true;
  const bundles = options[index].startsWith("--bundles=") ? options[index].slice(10) : options[index + 1];
  return bundles?.split(",").some((bundle) => ["app", "dmg", "all"].includes(bundle)) ?? true;
}

export function preflightReleaseOpsinRuntime(args, {
  platform = process.platform, hostArch = process.arch, rootDir = ROOT_DIR, read = readFileSync
} = {}) {
  if (!isMacosReleasePackaging(args, platform)) return;
  const target = macosBuildTarget(args, hostArch);
  const runtime = join(rootDir, "apps", "desktop", "src-tauri", "resources", "opsin", "jre");
  try {
    checkOpsinRuntimeArchitecture(runtime, target, read);
  } catch (error) {
    throw new Error(`Cannot package ${target}: staged OPSIN JRE is missing or incompatible (${error.message}). Run node scripts/build-opsin-runtime.mjs --target ${target} before packaging.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { preflightReleaseOpsinRuntime(["build", ...process.argv.slice(2)]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
