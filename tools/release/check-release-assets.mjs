#!/usr/bin/env node
// Final byte/source gate over ALL assets actually attached to the release.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { expectedReleaseCommit, missingBuildFiles, releaseBuildFiles, verifyBuildAssets } from "./release-assets.mjs";
import { verifyDmgSourceCommit } from "./macos-dmg.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function checkReleaseAssets({ tag, version = tag?.replace(/^v/, ""), commit, assets, rootDir = ROOT, allowIncomplete = false, skipDmgProvenance = false }, {
  run = spawnSync, makeTemp = () => mkdtempSync(join(tmpdir(), "chemdraft-release-assets-")),
  cleanup = (path) => rmSync(path, { recursive: true, force: true }), platform = process.platform, log = console.log
} = {}) {
  releaseBuildFiles(version);
  if (tag !== undefined && tag !== `v${version}`) throw new Error("Release tag must match --version");
  if (!assets && !tag) throw new Error("Downloading release assets requires --tag vX.Y.Z");
  if (platform !== "darwin") {
    log(`DMG embedded commit check skipped on ${platform}: mounting DMGs requires macOS.`);
    if (!skipDmgProvenance) throw new Error("Use --skip-dmg-provenance to acknowledge the skipped check; final publishing verification must run on macOS without this flag");
  }
  const expectedCommit = expectedReleaseCommit({ commit, tag, rootDir }, { run });
  const temporary = !assets;
  const folder = assets ? resolve(assets) : makeTemp();
  try {
    if (temporary) {
      // No patterns: stale/opposite-version builds must be visible to validation.
      const result = run("gh", ["release", "download", tag, "--dir", folder], { cwd: rootDir, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`gh release download ${tag}: ${result.stderr || result.error?.message || "download failed"}`);
    }
    const missing = missingBuildFiles(folder, version);
    const builds = verifyBuildAssets({ assets: folder, version, expectedCommit, allowIncomplete }, {
      checkDmgCommit: platform === "darwin"
        ? (dmg, _target, expected, recordCommit) => verifyDmgSourceCommit(dmg, expected, { run, recordCommit })
        : undefined
    });
    if (missing.length) {
      if (!allowIncomplete) throw new Error(missing.map((name) => `${name}: missing release file`).join("\n"));
      return { complete: false, missing };
    }
    return { complete: true, commit: expectedCommit, builds };
  } finally { if (temporary) cleanup(folder); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { tag: { type: "string" }, version: { type: "string" }, commit: { type: "string" }, assets: { type: "string" }, "allow-incomplete": { type: "boolean", default: false }, "skip-dmg-provenance": { type: "boolean", default: false } } });
    const result = checkReleaseAssets({ ...values, allowIncomplete: values["allow-incomplete"], skipDmgProvenance: values["skip-dmg-provenance"] });
    if (result.complete) console.log(`Release assets PASS: ${result.builds.join(", ")} at ${result.commit}`);
    else console.log(`Release assets INCOMPLETE (not a publishing pass): missing ${result.missing.join(", ")}`);
  } catch (error) { console.error(`Release assets: ${error.message}`); process.exitCode = 1; }
}
