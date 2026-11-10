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
  const ref = `refs/tags/${tag}`;
  let result = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (result.status !== 0) {
    const fetched = git(["fetch", "--no-tags", "origin", `${ref}:${ref}`]);
    if (fetched.status !== 0) throw new Error(`Expected --commit or a resolvable release tag: cannot fetch ${tag}: ${fetched.stderr || fetched.error?.message || "git fetch failed"}`);
    result = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  }
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

export function verifyBuildAssets({ assets, version, expectedCommit }, { checkDmgCommit } = {}) {
  if (!COMMIT_PATTERN.test(expectedCommit ?? "")) throw new Error("An expected full source commit is mandatory");
  const builds = releaseBuildFiles(version);
  const allowed = new Set(builds.flatMap(({ name }) => [name, `${name}.build.json`]));
  const errors = [];
  // Feeds, signatures, checksums and notes are allowed; extra builds/records are not.
  for (const name of readdirSync(assets)) {
    if (/\.(?:dmg|exe|build\.json)$/i.test(name) && !allowed.has(name)) errors.push(`Unexpected release build: ${name}`);
  }
  let commonCommit;
  let commonBuild;
  for (const { target, name } of builds) {
    const file = join(assets, name);
    const recordName = `${name}.build.json`;
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
      if (name.endsWith(".dmg") && checkDmgCommit) checkDmgCommit(file, target, expectedCommit);
    } catch (error) { errors.push(`${name}: ${error.code === "ENOENT" ? "missing release file" : error.message}`); }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return builds.map(({ name }) => name);
}
