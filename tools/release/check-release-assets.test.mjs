import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkReleaseAssets } from "./check-release-assets.mjs";
import { artifactDigest } from "./record-build.mjs";
import { expectedReleaseCommit } from "./release-assets.mjs";
import { allUsersInstaller, arm, commit, fakeReleaseRunner, installer, intel, releaseFixture, version } from "./release-test-fixtures.mjs";

const check = (args, options = {}) => checkReleaseAssets({ tag: `v${version}`, ...args }, { run: fakeReleaseRunner(), platform: "darwin", ...options });

test("folder gate accepts both Windows installer/record pairs and both Mac builds from the tag's commit", (t) => {
  const args = releaseFixture(t);
  assert.deepEqual(check(args), { complete: true, commit, builds: [arm, intel, installer, allUsersInstaller] });
});

for (const name of [arm, intel]) {
  test(`macOS asset gate refuses unsigned ${name} despite matching hashes and source records`, (t) => {
    const args = releaseFixture(t);
    for (const skipDmgProvenance of [false, true]) {
      const calls = [];
      assert.throws(() => check({ ...args, skipDmgProvenance }, {
        run: fakeReleaseRunner({ unsigned: (dmg) => dmg === join(args.assets, name), calls })
      }), /ChemDraftUnsignedBuild: UNSIGNED local build must NEVER be published/);
      assert.equal(calls.at(-1).args[0], "detach");
    }
  });
}

for (const name of [arm, intel, installer, allUsersInstaller, ...[arm, intel, installer, allUsersInstaller].map((name) => `${name}.build.json`)]) {
  test(`asset checker names missing ${name}; incomplete workflow mode is not a pass`, (t) => {
    const args = releaseFixture(t);
    unlinkSync(join(args.assets, name));
    assert.throws(() => check(args), (error) => error.message.includes(name));
    // Incomplete mode cannot fully verify a half-present build.
    assert.throws(() => check({ ...args, allowIncomplete: true }), (error) => error.message.includes(name));
  });
}

for (const extra of ["ChemDraft_1.2.2_aarch64.dmg", "ChemDraft_1.2.3_x64.dmg", "ChemDraft_1.2.3_x64-extra-setup.exe", "unexpected.exe", "other.dmg.build.json", "other.sig", "old.exe.sig", "other.msi", "other.zip", "other.pkg", "other.tar.gz", "OTHER.TAR.GZ"]) {
  test(`extra build ${extra} is refused`, (t) => {
    const args = releaseFixture(t);
    writeFileSync(join(args.assets, extra), "stale build");
    assert.throws(() => check(args), (error) => error.message.includes(`Unexpected release build: ${extra}`));
  });
}

test("all four required Windows updater files pass the strict gate", (t) => {
  const args = releaseFixture(t);
  assert.equal(check(args).complete, true);
});

for (const name of [`${installer}.sig`, `${allUsersInstaller}.sig`, "latest.json", "latest-allusers.json"]) {
  test(`missing updater file ${name} fails strict mode and is reported in incomplete mode`, (t) => {
    const args = releaseFixture(t);
    unlinkSync(join(args.assets, name));
    assert.throws(() => check(args), (error) => error.message.includes(`${name}: missing release file`));
    for (const platform of ["darwin", "win32"]) {
      assert.deepEqual(check({ ...args, allowIncomplete: true, skipDmgProvenance: platform !== "darwin" }, { platform, log: () => {} }), { complete: false, missing: [name] });
    }
  });
}

test("Windows upload job flags accept both installers and updater files before Mac builds arrive", (t) => {
  const args = releaseFixture(t);
  const missing = [arm, intel].flatMap((name) => [name, `${name}.build.json`]);
  for (const name of missing) unlinkSync(join(args.assets, name));
  assert.deepEqual(check({ version, rootDir: args.rootDir, commit, allowIncomplete: true, skipDmgProvenance: true }, {
    platform: "win32", log: () => {}, run: fakeReleaseRunner({ downloadFrom: args.assets })
  }), { complete: false, missing });
});

for (const windowsOnly of [false, true]) {
  test(`per-user-only Windows release fails without --allow-incomplete (Windows only: ${windowsOnly})`, (t) => {
    const args = releaseFixture(t);
    const missing = (windowsOnly ? [arm, intel, allUsersInstaller] : [allUsersInstaller]).flatMap((name) => [name, `${name}.build.json`]);
    for (const name of missing) unlinkSync(join(args.assets, name));
    assert.throws(() => check(args), (error) => error.message.includes(`${allUsersInstaller}: missing release file`));
    assert.deepEqual(check({ ...args, allowIncomplete: true }), { complete: false, missing });
  });
}

for (const allowIncomplete of [false, true]) {
  for (const [field, value, message] of [
    ["commit", "b".repeat(40), /does not match expected commit/],
    ["target", "aarch64-apple-darwin", /expected target x86_64-pc-windows-msvc/],
    ["version", "1.2.2", /expected version 1\.2\.3/],
    ["clean", false, /source tree must be clean/],
    ["sha256", "0".repeat(64), /SHA-256 mismatch/],
    ["size", 0, /size mismatch/]
  ]) {
    test(`all-users ${field} mismatch fails (allowIncomplete: ${allowIncomplete})`, (t) => {
      const args = releaseFixture(t);
      const recordFile = join(args.assets, `${allUsersInstaller}.build.json`);
      const record = JSON.parse(readFileSync(recordFile, "utf8"));
      writeFileSync(recordFile, JSON.stringify({ ...record, [field]: value }));
      assert.throws(() => check({ ...args, allowIncomplete }), (error) => error.message.includes(allUsersInstaller) && message.test(error.message));
    });
  }

  test(`changed all-users installer bytes fail (allowIncomplete: ${allowIncomplete})`, (t) => {
    const args = releaseFixture(t);
    writeFileSync(join(args.assets, allUsersInstaller), "mutated after signing");
    assert.throws(() => check({ ...args, allowIncomplete }), (error) => error.message.includes(allUsersInstaller) && /SHA-256 mismatch/.test(error.message) && /size mismatch/.test(error.message));
  });
}

test("incomplete mode verifies all supplied builds, records, bytes, DMG commits and extra assets", (t) => {
  const args = releaseFixture(t);
  unlinkSync(join(args.assets, arm));
  unlinkSync(join(args.assets, `${arm}.build.json`));
  const incomplete = { ...args, allowIncomplete: true };
  assert.deepEqual(check(incomplete), { complete: false, missing: [arm, `${arm}.build.json`] });
  const file = join(args.assets, installer);
  const bytes = readFileSync(file);
  const recordPath = `${file}.build.json`;
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  for (const [field, value, message] of [
    ["commit", "b".repeat(40), /does not match expected commit/],
    ["target", "wrong", /expected target/], ["version", "0.0.0", /expected version/],
    ["clean", false, /source tree must be clean/], ["sha256", "0".repeat(64), /SHA-256 mismatch/],
    ["size", 0, /size mismatch/]
  ]) {
    writeFileSync(recordPath, JSON.stringify({ ...record, [field]: value }));
    assert.throws(() => check(incomplete), message);
  }
  writeFileSync(recordPath, JSON.stringify(record));
  writeFileSync(file, "tampered");
  assert.throws(() => check(incomplete), /SHA-256 mismatch/);
  writeFileSync(file, bytes);
  assert.throws(() => check(incomplete, { run: fakeReleaseRunner({ embeddedCommit: "b".repeat(40) }) }), /ChemDraftSourceCommit.*expected/);
  writeFileSync(join(args.assets, "extra.zip"), "unexpected");
  assert.throws(() => check(incomplete), /Unexpected release build: extra.zip/);
});

for (const platform of ["linux", "win32"]) {
  test(`${platform} requires an explicit DMG provenance skip, including incomplete mode`, (t) => {
    const args = releaseFixture(t);
    const messages = [];
    const calls = [];
    const options = { platform, log: (message) => messages.push(message), run: fakeReleaseRunner({ calls }) };
    assert.throws(() => check(args, options), /--skip-dmg-provenance/);
    assert.throws(() => check({ ...args, allowIncomplete: true }, options), /--skip-dmg-provenance/);
    assert.equal(check({ ...args, skipDmgProvenance: true }, options).complete, true);
    assert.match(messages.join("\n"), new RegExp(`DMG embedded commit check skipped on ${platform}`));
    assert.equal(calls.some(({ command }) => command === "/usr/bin/hdiutil"), false);
    writeFileSync(join(args.assets, installer), "bad bytes");
    assert.throws(() => check({ ...args, skipDmgProvenance: true }, options), /SHA-256 mismatch/);
  });
}

test("macOS checks each mounted DMG against the expected and recorded commits, including fresh records for swapped bytes", (t) => {
  const args = releaseFixture(t);
  const calls = [];
  assert.equal(check({ ...args, skipDmgProvenance: true }, { run: fakeReleaseRunner({ calls }) }).complete, true);
  assert.deepEqual(calls.filter(({ args }) => args[0] === "attach").map(({ args }) => args.at(-1)), [join(args.assets, arm), join(args.assets, intel)]);
  for (const name of [arm, intel]) {
    const file = join(args.assets, name);
    const recordPath = `${file}.build.json`;
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    writeFileSync(file, "swapped DMG with a fresh digest");
    writeFileSync(recordPath, JSON.stringify({ ...record, ...artifactDigest(file) }));
    for (const embeddedCommit of [null, "short", "b".repeat(40)]) {
      const rejected = [];
      assert.throws(() => check(args, { run: fakeReleaseRunner({
        calls: rejected, embeddedCommit: (dmg) => dmg === file ? embeddedCommit : commit
      }) }), /ChemDraftSourceCommit: (missing|expected)/);
      assert.equal(rejected.filter(({ args }) => args[0] === "detach").length, 2);
    }
    // Even a payload matching the tag must also match its adjacent record.
    writeFileSync(recordPath, JSON.stringify({ ...record, ...artifactDigest(file), commit: "c".repeat(40) }));
    assert.throws(() => check(args), /ChemDraftSourceCommit: expected c{40}, found a{40}/);
    writeFileSync(recordPath, JSON.stringify({ ...record, ...artifactDigest(file) }));
  }
});

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

test("tag resolution always fetches origin, peels FETCH_HEAD, and never trusts an existing local tag", () => {
  const calls = [];
  const resolve = (commitOverride) => expectedReleaseCommit({ tag: `v${version}`, commit: commitOverride, rootDir: "fixture" }, {
    run: (command, args) => {
      assert.equal(command, "git");
      calls.push(args);
      if (args[0] === "fetch") return { status: 0 };
      if (args.at(-1) !== "FETCH_HEAD^{commit}") return { status: 0, stdout: `${"b".repeat(40)}\n` };
      return { status: 0, stdout: `${commit}\n` };
    }
  });
  assert.equal(resolve(), commit);
  assert.deepEqual(calls, [
    ["fetch", "origin", "tag", `v${version}`, "--no-tags"],
    ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]
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
  assert.doesNotMatch(workflow, /^  release-assets:/m);
  assert.ok(upload.indexOf("gh release upload") < upload.indexOf("node tools/release/check-release-assets.mjs"));
  assert.match(upload, /contents: write/);
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  assert.match(workflow.split("\n  upload:")[0], /permissions:\n\s+contents: read/);
  assert.match(upload, /check-release-assets\.mjs --tag "\$env:RELEASE_TAG" --commit "\$env:BUILD_COMMIT" --allow-incomplete --skip-dmg-provenance/);
  assert.match(upload, /shell: pwsh[\s\S]*if \(\$LASTEXITCODE -ne 0\) \{ throw 'Release asset validation failed\.'/);
});

test("the final publishing checklist requires Mac verification of both DMGs without bypass flags", () => {
  const guide = readFileSync(new URL("../../docs/releasing/three-builds.md", import.meta.url), "utf8");
  const final = guide.split("## Last step before un-drafting")[1];
  assert.match(final, /\*\*on a Mac\*\*/);
  const commands = final.match(/^   node .+$/gm);
  assert.equal(commands.length, 3);
  for (const [index, target, suffix] of [[0, "aarch64-apple-darwin", "aarch64"], [1, "x86_64-apple-darwin", "x86_64"]]) {
    assert.ok(commands[index].includes(`verify-macos-app.mjs --target ${target} --release --dmg`));
    assert.ok(commands[index].includes(`ChemDraft_X.Y.Z_${suffix}.dmg --commit <full-sha>`));
  }
  assert.ok(commands[2].includes("check-release-assets.mjs --tag vX.Y.Z --commit <full-sha>"));
  assert.doesNotMatch(commands.join("\n"), /--skip-dmg-provenance|--allow-incomplete/);
  assert.match(final, /needs macOS, `hdiutil` and `plutil`/);
  const mac = readFileSync(new URL("../../docs/releasing/macos-updates.md", import.meta.url), "utf8");
  assert.match(mac, /staple and validate \*\*the DMG only\*\*/);
  assert.match(mac, /sets\n`CHEMDRAFT_RELEASE_BUILD=1` automatically/);
  assert.doesNotMatch(mac, /both staples|validate` on \*\*both\*\* app and DMG|staple and validate the app and DMG/);
});
