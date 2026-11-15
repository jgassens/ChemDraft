// Shared, platform-neutral checks over the final artifact bytes and source identity.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { artifactDigest, BUILD_TARGETS, COMMIT_PATTERN } from "./record-build.mjs";

export function expectedReleaseCommit({ commit, tag, rootDir }, { run = spawnSync } = {}) {
  if (commit !== undefined && !COMMIT_PATTERN.test(commit)) throw new Error("Expected --commit to be a full 40-character SHA");
  if (!tag && !commit) throw new Error("Expected --commit or a release --tag; an expected commit is mandatory");
  if (!tag) return commit;
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Expected release --tag vX.Y.Z");
  const git = (args) => run("git", args, { cwd: rootDir, encoding: "utf8" });
  // Always refresh, including an existing local tag. A conflicting local tag fails closed.
  const fetched = git(["fetch", "origin", "tag", tag, "--no-tags"]);
  if (fetched.status !== 0) throw new Error(`Expected --commit or a resolvable release tag: cannot fetch ${tag}: ${fetched.stderr || fetched.error?.message || "git fetch failed"}`);
  // FETCH_HEAD is the fetched origin value, rather than a pre-existing local ref.
  const result = git(["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]);
  const taggedCommit = result.stdout?.trim();
  if (result.status !== 0 || !COMMIT_PATTERN.test(taggedCommit ?? "")) throw new Error(`Cannot resolve release tag ${tag} to a full commit`);
  if (commit && commit !== taggedCommit) throw new Error(`--commit ${commit} disagrees with tag ${tag} (${taggedCommit})`);
  return taggedCommit;
}

export function releaseBuildFiles(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Expected --version X.Y.Z");
  return Object.entries(BUILD_TARGETS).map(([target, suffix]) => ({ target, name: `ChemDraft_${version}_${suffix}` }));
}

export function missingBuildFiles(assets, version) {
  return releaseBuildFiles(version).flatMap(({ name }) => [name, `${name}.build.json`]).filter((name) => {
    try { return !statSync(join(assets, name)).isFile(); } catch { return true; }
  });
}

export function verifyBuildAssets({ assets, version, expectedCommit, allowIncomplete = false }, { checkDmgCommit } = {}) {
  if (!COMMIT_PATTERN.test(expectedCommit ?? "")) throw new Error("An expected full source commit is mandatory");
  const builds = releaseBuildFiles(version);
  const allowed = new Set(builds.flatMap(({ name }) => [name, `${name}.build.json`]));
  allowed.add(`ChemDraft_${version}_x64-setup.exe.sig`);
  allowed.add("latest.json");
  const errors = [];
  // Feeds, checksums and notes are allowed; unexpected packages/signatures/records are not.
  const present = new Set(readdirSync(assets));
  for (const name of present) {
    if (/\.(?:dmg|exe|build\.json|sig|msi|zip|pkg|tar\.gz)$/i.test(name) && !allowed.has(name)) errors.push(`Unexpected release build: ${name}`);
  }
  let commonCommit;
  let commonBuild;
  const checked = [];
  for (const { target, name } of builds) {
    const file = join(assets, name);
    const recordName = `${name}.build.json`;
    // Only wholly absent builds may be deferred. Partial pairs cannot be fully verified.
    if (allowIncomplete && !present.has(name) && !present.has(recordName)) continue;
    checked.push(name);
    let record;
    try { record = JSON.parse(readFileSync(`${file}.build.json`, "utf8")); }
    catch (error) { errors.push(`${recordName}: ${error.code === "ENOENT" ? "missing build record" : error.message}`); }
    if (record !== undefined) {
      if (!COMMIT_PATTERN.test(record?.commit ?? "")) errors.push(`${recordName}: expected full 40-character commit`);
      else {
        if (!commonCommit) { commonCommit = record.commit; commonBuild = recordName; }
        if (record.commit !== commonCommit) errors.push(`${recordName}: commit ${record.commit} differs from ${commonBuild} (${commonCommit})`);
        if (record.commit !== expectedCommit) errors.push(`${recordName}: commit ${record.commit} does not match expected commit (${expectedCommit})`);
      }
      if (record?.clean !== true) errors.push(`${recordName}: source tree must be clean (clean: true)`);
      if (record?.version !== version) errors.push(`${recordName}: expected version ${version}, found ${record?.version}`);
      if (record?.target !== target) errors.push(`${recordName}: expected target ${target}, found ${record?.target}`);
    }
    try {
      const digest = artifactDigest(file);
      if (!/^[0-9a-f]{64}$/.test(record?.sha256 ?? "") || digest.sha256 !== record.sha256) errors.push(`${recordName}: SHA-256 mismatch for ${name}`);
      if (!Number.isSafeInteger(record?.size) || digest.size !== record.size) errors.push(`${recordName}: size mismatch for ${name}`);
      if (name.endsWith(".dmg") && checkDmgCommit) checkDmgCommit(file, target, expectedCommit, record?.commit);
    } catch (error) { errors.push(`${name}: ${error.code === "ENOENT" ? "missing release file" : error.message}`); }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return checked;
}
