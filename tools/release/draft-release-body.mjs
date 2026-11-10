#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { dmgArchitecture, parseAppcast } from "./macos-appcast.mjs";
import { expectedReleaseCommit, verifyBuildAssets } from "./release-assets.mjs";
import { verifyDmgCommit } from "./verify-macos-feed.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function draftReleaseBody({ version, commit, tag = `v${version}`, assets = process.cwd(), rootDir = ROOT, gaps = [], noGaps = false }, {
  run = spawnSync, checkDmgCommit = (dmg, target, expected) => verifyDmgCommit(dmg, target, expected, { run })
} = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Expected --version X.Y.Z");
  if (!gaps.length && !noGaps) throw new Error("Supply at least one --gap or explicitly pass --no-gaps");
  if (gaps.length && noGaps) throw new Error("Use --gap or --no-gaps, not both");
  if (tag !== `v${version}`) throw new Error("Release tag must match --version");
  const expectedCommit = expectedReleaseCommit({ commit, tag, rootDir }, { run });
  const platforms = [
    { key: "macos", heading: "macOS (Apple silicon)", dmg: `ChemDraft_${version}_aarch64.dmg`, feed: "appcast.xml", arch: "arm64", notes: join("release-notes", "macos", `ChemDraft_${version}_aarch64.md`) },
    { key: "macos-intel", heading: "macOS (Intel)", dmg: `ChemDraft_${version}_x86_64.dmg`, feed: "appcast-intel.xml", arch: "x86_64", notes: join("release-notes", "macos-intel", `ChemDraft_${version}_x86_64.md`) },
    { key: "windows", heading: "Windows", notes: join("release-notes", `windows-${version}.md`) }
  ];
  const errors = [];
  const gapMap = new Map(platforms.map(({ key }) => [key, []]));
  for (const gap of gaps) {
    const match = /^(macos|macos-intel|windows):([^\r\n]+)$/.exec(gap);
    if (!match || !match[2].trim()) throw new Error(`Invalid gap ${JSON.stringify(gap)}; expected macos, macos-intel, or windows followed by :text`);
    gapMap.get(match[1]).push(match[2].trim());
  }
  const installer = `ChemDraft_${version}_x64-setup.exe`;
  const allUsersInstaller = `ChemDraft_${version}_x64-allusers-setup.exe`;
  try { verifyBuildAssets({ assets, version, expectedCommit }, { checkDmgCommit }); }
  catch (error) { errors.push(error.message); }
  for (const name of [platforms[0].dmg, platforms[1].dmg, installer, `${installer}.sig`, "latest.json", allUsersInstaller, `${allUsersInstaller}.sig`, "latest-allusers.json"]) {
    try { if (!statSync(join(assets, name)).isFile()) throw new Error(); }
    catch { errors.push(`Missing release file: ${name}`); }
  }
  for (const platform of platforms.slice(0, 2)) {
    try {
      const items = parseAppcast(readFileSync(join(assets, platform.feed), "utf8"));
      const matches = items.filter((item) => item.version === version);
      if (matches.length !== 1) throw new Error(`expected exactly one item for ${version}`);
      const item = matches[0];
      if (dmgArchitecture(item.url) !== platform.arch || basename(decodeURIComponent(new URL(item.url).pathname)) !== platform.dmg) {
        throw new Error(`expected ${platform.dmg}, found ${item.url}`);
      }
    } catch (error) { errors.push(`${platform.feed}: ${error.message}`); }
  }
  for (const platform of platforms) {
    try {
      platform.content = readFileSync(join(rootDir, platform.notes), "utf8").trim();
      if (!platform.content) throw new Error("empty file");
    } catch (error) { errors.push(`Release notes ${platform.notes}: ${error.message}`); }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  const sections = platforms.map((platform) => {
    const lines = gapMap.get(platform.key).map((gap) => `Not in this build: ${gap}`);
    if (platform.key === "windows") lines.unshift("Two Windows installers are available: per-user and all-users for managed machines.");
    return [`## ${platform.heading}`, platform.content, ...lines].join("\n\n");
  });
  return `${sections.join("\n\n")}\n\nPlatform differences: ${gaps.length ? "See the feature gaps and reasons above." : "None."}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { version: { type: "string" }, commit: { type: "string" }, tag: { type: "string" }, assets: { type: "string" }, out: { type: "string" }, gap: { type: "string", multiple: true }, "no-gaps": { type: "boolean", default: false } } });
    const body = draftReleaseBody({ ...values, gaps: values.gap, noGaps: values["no-gaps"] });
    if (values.out) writeFileSync(values.out, body);
    else process.stdout.write(body);
  } catch (error) { console.error(`Release body: ${error.message}`); process.exitCode = 1; }
}
