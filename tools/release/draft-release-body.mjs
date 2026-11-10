#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { dmgArchitecture, parseAppcast } from "./macos-appcast.mjs";
import { BUILD_TARGETS, COMMIT_PATTERN } from "./record-build.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function draftReleaseBody({ version, commit, assets = process.cwd(), rootDir = ROOT, gaps = [] }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Expected --version X.Y.Z");
  if (commit !== undefined && !COMMIT_PATTERN.test(commit)) throw new Error("Expected --commit to be a full 40-character SHA");
  const tag = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/v${version}^{commit}`], { cwd: rootDir, encoding: "utf8" });
  const expectedCommit = commit ?? (tag.status === 0 ? tag.stdout.trim() : undefined);
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
  let commonCommit;
  let commonBuild;
  for (const [target, suffix] of Object.entries(BUILD_TARGETS)) {
    const name = `ChemDraft_${version}_${suffix}.build.json`;
    let record;
    try { record = JSON.parse(readFileSync(join(assets, name), "utf8")); }
    catch (error) { errors.push(`${name}: ${error.code === "ENOENT" ? "missing build record" : error.message}`); continue; }
    if (!record || !COMMIT_PATTERN.test(record.commit ?? "")) errors.push(`${name}: expected full 40-character commit`);
    else {
      if (commonCommit === undefined) { commonCommit = record.commit; commonBuild = name; }
      if (record.commit !== commonCommit) errors.push(`${name}: commit ${record.commit} differs from ${commonBuild} (${commonCommit})`);
      if (expectedCommit && record.commit !== expectedCommit) errors.push(`${name}: commit ${record.commit} does not match ${commit ? "--commit" : `tag v${version}`} (${expectedCommit})`);
    }
    if (record?.clean !== true) errors.push(`${name}: source tree must be clean (clean: true)`);
    if (record?.version !== version) errors.push(`${name}: expected version ${version}, found ${record?.version}`);
    if (record?.target !== target) errors.push(`${name}: expected target ${target}, found ${record?.target}`);
  }
  for (const name of [platforms[0].dmg, platforms[1].dmg, installer, `${installer}.sig`, "latest.json"]) {
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
    return [`## ${platform.heading}`, platform.content, ...lines].join("\n\n");
  });
  return `${sections.join("\n\n")}\n\nPlatform differences: ${gaps.length ? "See the feature gaps and reasons above." : "None."}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { version: { type: "string" }, commit: { type: "string" }, assets: { type: "string" }, out: { type: "string" }, gap: { type: "string", multiple: true } } });
    const body = draftReleaseBody({ ...values, gaps: values.gap });
    if (values.out) writeFileSync(values.out, body);
    else process.stdout.write(body);
  } catch (error) { console.error(`Release body: ${error.message}`); process.exitCode = 1; }
}
