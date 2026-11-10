import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkReleaseAssets } from "./check-release-assets.mjs";
import { expectedReleaseCommit } from "./release-assets.mjs";
import { arm, commit, fakeReleaseRunner, installer, intel, releaseFixture, version } from "./release-test-fixtures.mjs";

const check = (args, options = {}) => checkReleaseAssets({ tag: `v${version}`, ...args }, { run: fakeReleaseRunner(), ...options });

test("folder gate accepts exactly three builds from the tag's commit", (t) => {
  const args = releaseFixture(t);
  assert.deepEqual(check(args), { complete: true, commit, builds: [arm, intel, installer] });
});

for (const name of [arm, intel, installer, ...[arm, intel, installer].map((name) => `${name}.build.json`)]) {
  test(`asset checker names missing ${name}; incomplete workflow mode is not a pass`, (t) => {
    const args = releaseFixture(t);
    unlinkSync(join(args.assets, name));
    assert.throws(() => check(args), (error) => error.message.includes(name));
    assert.deepEqual(check({ ...args, allowIncomplete: true }), { complete: false, missing: [name] });
  });
}

for (const extra of ["ChemDraft_1.2.2_aarch64.dmg", "ChemDraft_1.2.3_x64.dmg", "unexpected.exe", "other.dmg.build.json"]) {
  test(`extra build ${extra} is refused`, (t) => {
    const args = releaseFixture(t);
    writeFileSync(join(args.assets, extra), "stale build");
    assert.throws(() => check(args), (error) => error.message.includes(`Unexpected release build: ${extra}`));
  });
}

test("hashes, sizes, source commits and tag identity fail closed", (t) => {
  const args = releaseFixture(t);
  const file = join(args.assets, installer);
  const recordFile = `${file}.build.json`;
  const record = JSON.parse(readFileSync(recordFile, "utf8"));
  writeFileSync(file, "mutated after signing");
  assert.throws(() => check(args), /SHA-256 mismatch/);
  writeFileSync(recordFile, JSON.stringify({ ...record, sha256: undefined, size: "123", commit: "b".repeat(40) }));
  assert.throws(() => check(args), /differs from/);
  assert.throws(() => check(args), /size mismatch/);
  assert.throws(() => check(args), /does not match expected commit/);
  assert.throws(() => check({ ...args, commit: "b".repeat(40) }), /--commit.*disagrees with tag/);
});

test("expected commit is mandatory, including folder and incomplete modes", (t) => {
  const args = releaseFixture(t);
  assert.throws(() => check({ ...args, tag: undefined }), /expected commit is mandatory/);
  assert.throws(() => check({ ...args, allowIncomplete: true }, { run: () => ({ status: 1, stderr: "tag missing" }) }), /cannot fetch/);
  assert.equal(check({ ...args, tag: undefined, commit }).commit, commit);
});

test("GitHub download checks all assets, cleans temp output, and never installs dependencies", (t) => {
  const args = releaseFixture(t);
  const folder = join(args.rootDir, "downloaded");
  const calls = [];
  const options = {
    makeTemp: () => { mkdirSync(folder); return folder; },
    run: fakeReleaseRunner({ downloadFrom: args.assets, calls })
  };
  assert.equal(check({ version, rootDir: args.rootDir }, options).complete, true);
  assert.equal(existsSync(folder), false);
  assert.deepEqual(calls.find(({ command }) => command === "gh").args, ["release", "download", `v${version}`, "--dir", folder]);
  writeFileSync(join(args.assets, "extra.exe"), "extra");
  assert.throws(() => check({ version, rootDir: args.rootDir }, options), /Unexpected release build/);
  assert.equal(existsSync(folder), false);
  assert.throws(() => check({ version, rootDir: args.rootDir }, {
    ...options, run: (command, ...rest) => command === "gh" ? { status: 1, stderr: "download failed" } : options.run(command, ...rest)
  }), /download failed/);
  assert.equal(existsSync(folder), false);
});

test("tag resolution peels annotated tags, fetches absent local tags, and rejects bad fetches", () => {
  const calls = [];
  const resolve = (commitOverride) => expectedReleaseCommit({ tag: `v${version}`, commit: commitOverride, rootDir: "fixture" }, {
    run: (command, args) => {
      assert.equal(command, "git");
      calls.push(args);
      if (calls.length === 1) return { status: 1 };
      return { status: 0, stdout: `${commit}\n` };
    }
  });
  assert.equal(resolve(), commit);
  assert.deepEqual(calls, [
    ["rev-parse", "--verify", "--quiet", `refs/tags/v${version}^{commit}`],
    ["fetch", "--no-tags", "origin", `refs/tags/v${version}:refs/tags/v${version}`],
    ["rev-parse", "--verify", "--quiet", `refs/tags/v${version}^{commit}`]
  ]);
  assert.throws(() => resolve("b".repeat(40)), /disagrees/);
  assert.throws(() => expectedReleaseCommit({ tag: `v${version}` }, { run: () => ({ status: 1, stderr: "no remote tag" }) }), /cannot fetch/);
  assert.throws(() => expectedReleaseCommit({ tag: `v${version}` }, { run: () => ({ status: 0, stdout: "not-a-commit" }) }), /Cannot resolve/);
  assert.throws(() => expectedReleaseCommit({}), /expected commit is mandatory/);
});

test("required CI jobs run the Node suites and release upload checks destination identity", () => {
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  for (const job of [ci.split("  web:\n")[1].split("  rust:\n")[0], ci.split("  windows:\n")[1].split("  build-stamp:\n")[0]]) {
    assert.ok(job.includes("pnpm vitest run"));
    assert.ok(job.includes('node --test "scripts/*.test.mjs" "tools/release/*.test.mjs"'));
  }
  const workflow = readFileSync(new URL("../../.github/workflows/windows-release.yml", import.meta.url), "utf8");
  const upload = workflow.slice(workflow.indexOf("\n  upload:"));
  assert.ok(upload.indexOf("Destination release tag does not match the built commit") < upload.indexOf("gh release upload"));
  assert.match(upload, /git fetch --no-tags origin/);
  assert.match(workflow, /needs: \[build, upload\]/);
  assert.match(workflow, /check-release-assets\.mjs --tag.*--commit.*--allow-incomplete/);
});
