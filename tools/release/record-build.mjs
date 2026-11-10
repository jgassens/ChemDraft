#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
export const BUILD_TARGETS = {
  "aarch64-apple-darwin": "aarch64.dmg",
  "x86_64-apple-darwin": "x86_64.dmg",
  "x86_64-pc-windows-msvc": "x64-setup.exe"
};

// Hash in bounded chunks: release installers and DMGs can be hundreds of MB.
export function artifactDigest(artifact) {
  const fd = openSync(artifact, "r");
  try {
    if (!statSync(artifact).isFile()) throw new Error(`Not a release file: ${artifact}`);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
      size += count;
    }
    return { sha256: hash.digest("hex"), size };
  } finally { closeSync(fd); }
}

export function gitOutput(rootDir, args) {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}

export function buildSource(rootDir = ROOT) {
  const commit = gitOutput(rootDir, ["rev-parse", "HEAD"]);
  if (!COMMIT_PATTERN.test(commit)) throw new Error("Expected a full 40-character source commit");
  if (gitOutput(rootDir, ["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("Refusing release build record: source tree is dirty");
  }
  const { version } = JSON.parse(readFileSync(join(rootDir, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Invalid app version");
  return { commit, version, clean: true };
}

export function recordBuild({ artifact, target, rootDir = ROOT }) {
  if (!Object.hasOwn(BUILD_TARGETS, target)) throw new Error(`Unsupported release target: ${target}`);
  const source = buildSource(rootDir);
  const expected = `ChemDraft_${source.version}_${BUILD_TARGETS[target]}`;
  if (basename(artifact) !== expected || !statSync(artifact).isFile()) throw new Error(`Expected release artifact ${expected}`);
  const record = { ...source, target, ...artifactDigest(artifact) };
  writeFileSync(`${artifact}.build.json`, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { artifact: { type: "string" }, target: { type: "string" } } });
    if (!values.artifact || !values.target) throw new Error("Usage: node tools/release/record-build.mjs --artifact <file> --target <triple>");
    recordBuild(values);
    console.log(`Recorded ${values.artifact}.build.json`);
  } catch (error) { console.error(`Build record: ${error.message}`); process.exitCode = 1; }
}
