#!/usr/bin/env node
/**
 * Refresh the About window's open-source holder data.
 *
 *   node scripts/generate-about-holders.mjs            # rewrite apps/desktop/src/about/holderData.json
 *   node scripts/generate-about-holders.mjs --check    # exit 1 when the committed file is out of date
 *   node scripts/generate-about-holders.mjs --registry # read ~/.cargo/registry/src instead of running cargo
 *   node scripts/generate-about-holders.mjs --keep-committed # a package with no installed copy keeps its committed holders
 *
 * Every entry also carries `platforms`: "all", or the list of macos / windows / linux builds that
 * ship the package. npm packages are bundled into the web app, so they are "all". A Rust crate is
 * walked from Cargo.lock through the target-specific dependency sections of each crate's Cargo.toml
 * (apps/desktop/src/about/cratePlatforms.ts), so a crate reachable only through
 * cfg(target_os = "linux") or cfg(windows) is tagged for that platform alone. The About window hides
 * components the running platform does not ship; NOTICE and the dependency inventory list them all.
 *
 * The build never reads node_modules or the cargo registry. It reads only the JSON this script writes,
 * so Windows and macOS show identical holders. Run this after a dependency changes (pnpm-lock.yaml or
 * Cargo.lock), from a checkout with a real `pnpm install` and, for the Rust crates, `cargo` on PATH
 * (it fetches the locked crates if they are not unpacked yet). It refuses to write when any locked
 * package's directory cannot be found, so a half-installed checkout cannot downgrade entries to
 * "see license". Add --allow-missing only to record that gap on purpose.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const outputPath = fileURLToPath(new URL("../apps/desktop/src/about/holderData.json", import.meta.url));
const manifestPath = fileURLToPath(new URL("../apps/desktop/src-tauri/Cargo.toml", import.meta.url));
const args = new Set(process.argv.slice(2));

const aboutUrl = new URL("../apps/desktop/src/about/", import.meta.url);
const { buildAboutProvenance } = await tsImport("./buildProvenance.ts", pathToFileURL(fileURLToPath(aboutUrl) + "/").href);
const { holderKey } = await tsImport("./holders.ts", pathToFileURL(fileURLToPath(aboutUrl) + "/").href);
const { cargoCrateManifest, installedHolders, setCargoDirectories } = await tsImport("./holdersFromDisk.ts", pathToFileURL(fileURLToPath(aboutUrl) + "/").href);
const { platformTag, readCargoLock, reachByPlatform } = await tsImport("./cratePlatforms.ts", pathToFileURL(fileURLToPath(aboutUrl) + "/").href);

function cargoMetadata() {
  const run = extra => JSON.parse(execFileSync("cargo",
    ["metadata", "--format-version", "1", "--locked", "--manifest-path", manifestPath, ...extra],
    { cwd: repoRoot, maxBuffer: 512 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
  try {
    return run(["--offline"]);
  } catch {
    execFileSync("cargo", ["fetch", "--locked", "--manifest-path", manifestPath], { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] });
    return run([]);
  }
}

// Every crate in Cargo.lock, for every target platform, so the Windows-only crates are covered from a Mac.
// With --registry the crates are found in the unpacked cargo registry instead of through `cargo metadata`.
if (!args.has("--registry")) {
  const directories = new Map();
  for (const pkg of cargoMetadata().packages) {
    if (pkg.source) directories.set(pkg.name + "-" + pkg.version, dirname(pkg.manifest_path));
  }
  setCargoDirectories(directories);
}

// Which platforms ship each locked crate (see cratePlatforms.ts). The root crate's own Cargo.toml is
// the app's manifest; every other crate's comes from its unpacked directory.
const lock = readCargoLock(readFileSync(new URL("../apps/desktop/src-tauri/Cargo.lock", import.meta.url), "utf8"));
const rootId = [...lock.values()].find(pkg => pkg.name === "chemdraft")?.id;
if (!rootId) throw new Error("Cargo.lock has no chemdraft package");
const reach = reachByPlatform(lock, rootId, pkg =>
  pkg.id === rootId ? readFileSync(manifestPath, "utf8") : cargoCrateManifest(pkg.name, pkg.version));

const committed = (() => {
  try { return JSON.parse(readFileSync(outputPath, "utf8")).entries ?? {}; } catch { return {}; }
})();
const entries = {};
const missing = [];
const unreachable = [];
for (const library of buildAboutProvenance().libraries) {
  for (const version of library.versions) {
    const key = holderKey(library.kind, library.name, version);
    if (key in entries) continue;
    let { holders, from, found } = installedHolders(library.kind, library.name, version);
    // The platform tag does not depend on an installed copy, so a host missing a package can still refresh
    // the tags and keep that package's committed holders instead of downgrading them.
    if (!found && args.has("--keep-committed") && committed[key]?.holders?.length) {
      ({ holders, from } = committed[key]);
      found = true;
    }
    if (!found) missing.push(key);
    const platforms = library.kind === "cargo" ? platformTag(reach.platforms.get(library.name + "@" + version)) : "all";
    if (Array.isArray(platforms) && platforms.length === 0) unreachable.push(key);
    entries[key] = { ...(holders.length ? { holders, from } : { holders: ["see license"], from: "none" }), platforms };
  }
}

if (missing.length && !args.has("--allow-missing")) {
  console.error("No installed copy of " + missing.length + " locked package(s); run `pnpm install` and retry:\n  " + missing.sort().join("\n  "));
  process.exit(1);
}

if (unreachable.length) {
  console.error("Cargo.lock reaches no shipped platform to " + unreachable.length + " listed crate(s); fix the platform walk:\n  " + unreachable.sort().join("\n  "));
  process.exit(1);
}
if (reach.unfiltered.length) {
  console.error(reach.unfiltered.length + " Cargo.lock edge(s) had no readable Cargo.toml declaration and were kept on every platform:\n  " + reach.unfiltered.join("\n  "));
}

const sorted = Object.fromEntries(Object.keys(entries).sort().map(key => [key, entries[key]]));
const text = JSON.stringify({
  note: "Generated by scripts/generate-about-holders.mjs (node scripts/generate-about-holders.mjs). Do not edit by hand. One entry per exact locked package version; platforms says which builds ship it.",
  entries: sorted
}, null, 2) + "\n";

if (args.has("--check")) {
  if (readFileSync(outputPath, "utf8") !== text) {
    console.error("apps/desktop/src/about/holderData.json is out of date; run `node scripts/generate-about-holders.mjs`.");
    process.exit(1);
  }
  console.error("holderData.json is up to date (" + Object.keys(sorted).length + " entries).");
} else {
  writeFileSync(outputPath, text);
  console.error("Wrote " + Object.keys(sorted).length + " entries to apps/desktop/src/about/holderData.json" +
    (missing.length ? " (" + missing.length + " without an installed copy)" : "") + ".");
}
