#!/usr/bin/env node
// Run locally AFTER signing/notarization/stapling has finalized the DMGs.
// Usage: node tools/release/generate-macos-appcast.mjs --target <triple> --version X.Y.Z --staging <directory>
// Output: <staging>/appcast.xml or appcast-intel.xml. Review and publish with that target's notes.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { appcastConfiguration, dmgArchitecture, emptyAppcast, NOTES_PREFIX, parseAppcast, verifyAppcast } from "./macos-appcast.mjs";
import { verifyDmg } from "./verify-macos-feed.mjs";

const ROOT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const xmlText = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

function setSparkleText(item, name, value) {
  const tag = `sparkle:${name}`;
  const replacement = `<${tag}>${xmlText(value)}</${tag}>`;
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}\\s*>`);
  return pattern.test(item) ? item.replace(pattern, replacement) : item.replace(/<\/item\s*>$/, `    ${replacement}\n        </item>`);
}

export function mergeAppcast(previous, generated, target, { version, dmgs }) {
  const config = appcastConfiguration(target);
  const prior = verifyAppcast(previous, target);
  const incoming = parseAppcast(generated);
  const additions = [];
  for (const name of dmgs) {
    if (dmgArchitecture(name) !== config.architecture) throw new Error(`${name}: wrong architecture for ${config.filename}`);
    const item = incoming.find((entry) => basename(new URL(entry.url).pathname) === name);
    if (!item || item.version !== version) throw new Error(`${name}: generator did not produce version ${version}`);
    if (prior.some((entry) => entry.version === version)) throw new Error(`Version ${version} is already published; never replace a signed feed item`);
    const notes = `${NOTES_PREFIX}${config.notesDirectory}/${name.replace(/\.dmg$/, ".md")}`;
    additions.push(setSparkleText(setSparkleText(item.raw, "releaseNotesLink", notes), "hardwareRequirements", config.architecture));
  }
  const anchor = prior.length ? previous.indexOf(prior[0].raw) : previous.indexOf("</channel>");
  const merged = previous.slice(0, anchor) + additions.join("\n        ") + "\n        " + previous.slice(anchor);
  verifyAppcast(merged, target);
  return merged;
}

export function generateMacosAppcast({ target, version, staging, rootDir = ROOT_DIR }, {
  run = spawnSync, checkDmg = verifyDmg
} = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a release version X.Y.Z");
  const config = appcastConfiguration(target);
  staging = resolve(staging);
  const dmgs = readdirSync(staging).filter((name) => name.endsWith(".dmg")).sort();
  if (dmgs.length !== 1) throw new Error("Stage exactly one final DMG per architecture and release version");
  // Validate ALL inputs before invoking Sparkle or writing output. A misleading filename cannot
  // hide an opposite-architecture app or the wrong embedded SUFeedURL.
  for (const name of dmgs) {
    if (dmgArchitecture(name) !== config.architecture) throw new Error(`${name}: wrong architecture for ${config.filename}`);
    checkDmg(join(staging, name), target);
    const notes = join(rootDir, ...config.notesDirectory.split("/"), name.replace(/\.dmg$/, ".md"));
    if (!existsSync(notes)) throw new Error(`Missing release notes: ${notes}`);
  }
  const previousPath = join(rootDir, config.filename);
  const previous = existsSync(previousPath) ? readFileSync(previousPath, "utf8") : emptyAppcast(target);
  verifyAppcast(previous, target);
  const temporary = mkdtempSync(join(staging, ".appcast-"));
  try {
    for (const name of dmgs) {
      const notesName = name.replace(/\.dmg$/, ".md");
      copyFileSync(join(rootDir, ...config.notesDirectory.split("/"), notesName), join(staging, notesName));
    }
    const generatedPath = join(temporary, config.filename);
    const args = [
      "--download-url-prefix", `https://github.com/jgassens/ChemDraft/releases/download/v${version}/`,
      "--link", "https://github.com/jgassens/ChemDraft", "--maximum-deltas", "0", "--maximum-versions", "3",
      "-o", generatedPath, staging
    ];
    const result = run(join(rootDir, "apps", "desktop", "src-tauri", "sparkle-bin", "generate_appcast"), args, { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`generate_appcast failed: ${result.error?.message ?? result.status}`);
    const merged = mergeAppcast(previous, readFileSync(generatedPath, "utf8"), target, { version, dmgs });
    const output = join(staging, config.filename);
    writeFileSync(output, merged);
    return output;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { target: { type: "string" }, version: { type: "string" }, staging: { type: "string" } } });
    if (!values.target || !values.version || !values.staging) throw new Error("Usage: node tools/release/generate-macos-appcast.mjs --target <triple> --version X.Y.Z --staging <directory>");
    console.log(`Generated ${generateMacosAppcast(values)}; review and publish with its release notes after uploading the exact DMG.`);
  } catch (error) { console.error(`macOS appcast generation failed: ${error.message}`); process.exitCode = 1; }
}
