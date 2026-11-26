import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkReleaseAssets } from "./check-release-assets.mjs";
import { artifactDigest } from "./record-build.mjs";
import { expectedReleaseCommit } from "./release-assets.mjs";
import { loadUpdaterPublicKey } from "./windows-updater.mjs";
import { processReleaseChecksums, SUMS_FILE, verifyReleaseChecksums, writeReleaseChecksums } from "./release-checksums.mjs";
import { allusersInstaller, appImage, arm, commit, deb, fakeReleaseRunner, installer, intel, offlineInstaller, releaseFixture, updaterPublicKey, updaterSignature, version, windowsFiles, windowsPlatformKey, windowsUpdates } from "./release-test-fixtures.mjs";

const check = (args, options = {}) => checkReleaseAssets({ tag: `v${version}`, ...args }, { run: fakeReleaseRunner(), platform: "darwin", updaterPublicKey, ...options });

const requiredBuilds = [arm, intel, installer, allusersInstaller, offlineInstaller];
const buildNames = [...requiredBuilds, deb, appImage];

test("the three required builds pass without Linux and produce combined checksums", (t) => {
  const args = releaseFixture(t, { withLinux: false });
  const checksumOutput = join(args.rootDir, "SHA256SUMS.txt");
  const expected = { complete: true, commit, builds: requiredBuilds };
  assert.deepEqual(check({ ...args, checksumOutput }), expected);
  assert.deepEqual(check({ ...args, allowIncomplete: true }), expected);
  assert.equal(readFileSync(checksumOutput, "utf8"), readFileSync(join(args.assets, SUMS_FILE), "utf8"));
});

test("folder gate accepts exactly the release builds, including all three Windows installers, from the tag's commit", (t) => {
  const args = releaseFixture(t);
  assert.deepEqual(check(args), { complete: true, commit, builds: buildNames });
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

for (const name of [...buildNames, ...buildNames.map((name) => `${name}.build.json`)]) {
  test(`asset checker names missing ${name}; incomplete workflow mode is not a pass`, (t) => {
    const args = releaseFixture(t);
    unlinkSync(join(args.assets, name));
    const missing = name.endsWith(".build.json") ? "missing build record" : "missing release file";
    for (const allowIncomplete of [false, true]) {
      assert.throws(() => check({ ...args, allowIncomplete }), ({ message }) => message.includes(`${name}: ${missing}`));
    }
  });
}

test("a release missing only the offline installer fails, and an offline .sig is still refused", (t) => {
  const args = releaseFixture(t, { withLinux: false });
  unlinkSync(join(args.assets, offlineInstaller));
  unlinkSync(join(args.assets, `${offlineInstaller}.build.json`));
  writeReleaseChecksums(args.assets);
  assert.deepEqual(check({ ...args, allowIncomplete: true }), { complete: false, missing: [offlineInstaller, `${offlineInstaller}.build.json`] });
  assert.throws(() => check(args), ({ message }) => message.includes(`${offlineInstaller}.build.json: missing build record`));
  const signed = releaseFixture(t, { withLinux: false });
  writeFileSync(join(signed.assets, `${offlineInstaller}.sig`), "offline signature");
  assert.throws(() => check(signed), ({ message }) => message.includes(`Unexpected release build: ${offlineInstaller}.sig`));
});

for (const extra of ["ChemDraft_1.2.2_aarch64.dmg", "ChemDraft_1.2.3_x64.dmg", "unexpected.exe", `${offlineInstaller}.sig`, "ChemDraft_1.2.2_x64-allusers-setup.exe", "other.dmg.build.json", "other.sig", "old.exe.sig", "other.msi", "other.zip", "other.pkg", "other.tar.gz", "OTHER.TAR.GZ"]) {
  test(`extra build ${extra} is refused`, (t) => {
    const args = releaseFixture(t);
    writeFileSync(join(args.assets, extra), "stale build");
    assert.throws(() => check(args), (error) => error.message.includes(`Unexpected release build: ${extra}`));
  });
}

for (const extra of ["other.deb", "OTHER.APPIMAGE", "ChemDraft_1.2.2_amd64.deb", "ChemDraft_1.2.2_amd64.AppImage.build.json",
  "ChemDraft_1.2.2-beta_amd64.deb", "ChemDraft_1.2.3_amd64.deb", "ChemDraft_1.2.3_amd64.AppImage", "ChemDraft_1.2.3_amd64.deb.build.json"]) {
  test(`unexpected Linux file ${extra} is refused with or without the beta packages`, (t) => {
    for (const withLinux of [false, true]) {
      const args = releaseFixture(t, { withLinux });
      writeFileSync(join(args.assets, extra), "stale build");
      assert.throws(() => check(args), (error) => error.message.includes(`Unexpected release build: ${extra}`));
    }
  });
}

for (const name of [deb, appImage]) {
  test(`asset checker requires ${name} and its record when the other Linux package is present`, (t) => {
    const args = releaseFixture(t);
    unlinkSync(join(args.assets, name));
    unlinkSync(join(args.assets, `${name}.build.json`));
    for (const allowIncomplete of [false, true]) {
      assert.throws(() => check({ ...args, allowIncomplete }), ({ message }) =>
        message.includes(`${name}.build.json: missing build record`) && message.includes(`${name}: missing release file`));
    }
  });

  test(`asset checker rejects tampered ${name} bytes`, (t) => {
    const args = releaseFixture(t);
    writeFileSync(join(args.assets, name), "tampered");
    for (const allowIncomplete of [false, true]) {
      assert.throws(() => check({ ...args, allowIncomplete }), (error) =>
        error.message.includes(`SHA-256 mismatch for ${name}`));
    }
  });
}

test("a lone Linux package or build record is rejected even in incomplete mode", (t) => {
  const linuxFiles = [deb, `${deb}.build.json`, appImage, `${appImage}.build.json`];
  for (const attached of linuxFiles) {
    const args = releaseFixture(t);
    for (const file of linuxFiles.filter((name) => name !== attached)) unlinkSync(join(args.assets, file));
    const missing = attached.endsWith(".build.json")
      ? `${attached.slice(0, -".build.json".length)}: missing release file`
      : `${attached}.build.json: missing build record`;
    for (const allowIncomplete of [false, true]) {
      assert.throws(() => check({ ...args, allowIncomplete }), ({ message }) => message.includes(missing));
    }
  }
});

test("combined checksums refresh from the attached assets after a Linux rebuild", (t) => {
  const { assets, rootDir } = releaseFixture(t);
  const checksumOutput = join(rootDir, "SHA256SUMS.txt");
  writeFileSync(join(assets, "SHA256SUMS.txt"), "stale combined checksums");
  writeFileSync(join(assets, "SHA256SUMS-linux.txt"), "separate Linux manifest");
  const refresh = () => {
    check({ assets: undefined, checksumOutput }, { run: fakeReleaseRunner({ downloadFrom: assets }) });
    return readFileSync(checksumOutput, "utf8");
  };
  const before = refresh();
  const artifact = join(assets, appImage);
  writeFileSync(artifact, "rebuilt AppImage");
  const record = JSON.parse(readFileSync(`${artifact}.build.json`, "utf8"));
  writeFileSync(`${artifact}.build.json`, JSON.stringify({ ...record, ...artifactDigest(artifact) }));
  const after = refresh();
  assert.notEqual(before, after);
  copyFileSync(checksumOutput, join(assets, SUMS_FILE));
  assert.equal(verifyReleaseChecksums(assets), true);
  assert.match(after, /  SHA256SUMS-linux\.txt$/m);
});

test("the expected Windows signatures, latest.json and latest-allusers.json verify against their installers", (t) => {
  const args = releaseFixture(t);
  assert.equal(check(args).complete, true);
});

test("Windows updater gate defaults to the checked-in config key and refuses the throwaway test key", (t) => {
  const config = JSON.parse(readFileSync(new URL("../../apps/desktop/src-tauri/tauri.windows.conf.json", import.meta.url), "utf8"));
  assert.equal(loadUpdaterPublicKey(), config.plugins.updater.pubkey);
  assert.throws(() => check(releaseFixture(t), { updaterPublicKey: undefined }), /x64-setup\.exe\.sig: Updater signature key ID mismatch/);
});

test("incomplete mode defers a wholly absent Windows build, but refuses orphaned updater metadata", (t) => {
  const args = releaseFixture(t, { withLinux: false });
  const signatures = windowsUpdates.map(({ installer: name }) => readFileSync(join(args.assets, `${name}.sig`), "utf8"));
  for (const name of windowsFiles) unlinkSync(join(args.assets, name));
  writeReleaseChecksums(args.assets);
  const missing = [installer, allusersInstaller, offlineInstaller].flatMap((name) => [name, `${name}.build.json`]);
  assert.deepEqual(check({ ...args, allowIncomplete: true }), { complete: false, missing });
  windowsUpdates.forEach(({ installer: name, feed }, index) => {
    writeFileSync(join(args.assets, `${name}.sig`), signatures[index]);
    assert.throws(() => check({ ...args, allowIncomplete: true }), new RegExp(`${feed.replace(".", "\\.")}: missing release file`));
    unlinkSync(join(args.assets, `${name}.sig`));
  });
});

for (const { installer: name, feed: feedName } of windowsUpdates) {
  const feedPattern = feedName.replace(".", "\\.");
  const otherInstaller = windowsUpdates.find((update) => update.installer !== name).installer;
  for (const [label, mutate, expected] of [
    ["stale version", (feed) => { feed.version = "1.2.2"; }, new RegExp(`${feedPattern}: version: expected 1\\.2\\.3, found 1\\.2\\.2`)],
    ["wrong URL", (feed) => { feed.platforms[windowsPlatformKey].url = feed.platforms[windowsPlatformKey].url.replace("v1.2.3", "v1.2.2"); }, new RegExp(`${feedPattern}: platforms\\.windows-x86_64-nsis\\.url: expected .*v1\\.2\\.3.*found .*v1\\.2\\.2`)],
    ["the other installer's URL", (feed) => { feed.platforms[windowsPlatformKey].url = feed.platforms[windowsPlatformKey].url.replace(name, otherInstaller); }, new RegExp(`${feedPattern}: platforms\\.windows-x86_64-nsis\\.url: expected`)],
    ["wrong platform key", (feed) => { feed.platforms = { "windows-x86_64": feed.platforms[windowsPlatformKey] }; }, new RegExp(`${feedPattern}: platforms: expected windows-x86_64-nsis, found windows-x86_64`)],
    ["unexpected extra platform", (feed) => { feed.platforms["windows-aarch64-nsis"] = feed.platforms[windowsPlatformKey]; }, new RegExp(`${feedPattern}: platforms: expected windows-x86_64-nsis, found .*windows-aarch64-nsis`)],
    ["signature differs from .sig", (feed) => { feed.platforms[windowsPlatformKey].signature = updaterSignature(Buffer.from("other installer"), name); }, new RegExp(`${feedPattern}: platforms\\.windows-x86_64-nsis\\.signature: expected .*\\.sig.*found`)]
  ]) {
    test(`Windows updater gate rejects ${label} in ${feedName}`, (t) => {
      const args = releaseFixture(t);
      const file = join(args.assets, feedName);
      const feed = JSON.parse(readFileSync(file, "utf8"));
      mutate(feed);
      writeFileSync(file, JSON.stringify(feed));
      assert.throws(() => check(args), expected);
    });
  }

  test(`Windows updater gate rejects a real signature over different ${name} bytes, even when ${feedName} matches it`, (t) => {
    const args = releaseFixture(t);
    const signature = updaterSignature(Buffer.from("different signed installer"), name);
    writeFileSync(join(args.assets, `${name}.sig`), signature);
    const file = join(args.assets, feedName);
    const feed = JSON.parse(readFileSync(file, "utf8"));
    feed.platforms[windowsPlatformKey].signature = signature;
    writeFileSync(file, JSON.stringify(feed));
    assert.throws(() => check(args), (error) => error.message.includes(`${name}.sig: Updater signature verification failed`));
  });

  for (const missing of [`${name}.sig`, feedName]) {
    test(`Windows updater gate requires ${missing}, including incomplete mode`, (t) => {
      const args = releaseFixture(t);
      unlinkSync(join(args.assets, missing));
      for (const allowIncomplete of [false, true]) assert.throws(() => check({ ...args, allowIncomplete }), (error) => error.message.includes(missing));
    });
  }
}

test("incomplete mode verifies all supplied builds, records, bytes, DMG commits and extra assets", (t) => {
  const args = releaseFixture(t);
  unlinkSync(join(args.assets, arm));
  unlinkSync(join(args.assets, `${arm}.build.json`));
  writeReleaseChecksums(args.assets);
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

for (const existingSums of ["absent", "Windows-only", "combined"]) {
  test(`Windows upload with ${existingSums} sums passes with Mac assets attached and retains their entries`, (t) => {
    const args = releaseFixture(t);
    for (const name of ["appcast.xml", "appcast-intel.xml"]) writeFileSync(join(args.assets, name), "synthetic feed");
    const combined = writeReleaseChecksums(args.assets);
    const staged = join(args.rootDir, "windows-staged");
    mkdirSync(staged);
    for (const name of windowsFiles) copyFileSync(join(args.assets, name), join(staged, name));
    // A rerun may replace Windows bytes, so existing Windows entries must also be refreshed.
    writeFileSync(join(staged, "latest.json"), `${readFileSync(join(staged, "latest.json"), "utf8")}\n`);
    const windowsSums = writeReleaseChecksums(staged);
    if (existingSums === "absent") unlinkSync(join(args.assets, SUMS_FILE));
    if (existingSums === "Windows-only") writeFileSync(join(args.assets, SUMS_FILE), windowsSums);

    // Match the workflow: verify only staging, upload its files excluding local sums, refresh by tag.
    assert.equal(processReleaseChecksums({ assets: staged, verify: true }), true);
    const beforeUpload = existsSync(join(args.assets, SUMS_FILE)) ? readFileSync(join(args.assets, SUMS_FILE), "utf8") : undefined;
    for (const name of readdirSync(staged).filter((name) => name !== SUMS_FILE)) copyFileSync(join(staged, name), join(args.assets, name));
    assert.equal(existsSync(join(args.assets, SUMS_FILE)) ? readFileSync(join(args.assets, SUMS_FILE), "utf8") : undefined, beforeUpload);
    const download = join(args.rootDir, "checksum-download");
    const calls = [];
    const downloadRunner = fakeReleaseRunner({ downloadFrom: args.assets, calls });
    processReleaseChecksums({ tag: `v${version}` }, {
      makeTemp: () => { mkdirSync(download); return download; },
      run: (command, commandArgs, options) => {
        if (commandArgs[1] !== "upload") return downloadRunner(command, commandArgs, options);
        assert.equal(command, "gh");
        assert.deepEqual(commandArgs, ["release", "upload", `v${version}`, join(download, SUMS_FILE), "--clobber"]);
        copyFileSync(commandArgs[3], join(args.assets, SUMS_FILE));
        return { status: 0 };
      }
    });
    assert.equal(existsSync(download), false);
    assert.equal(verifyReleaseChecksums(args.assets), true);
    const refreshed = readFileSync(join(args.assets, SUMS_FILE), "utf8");
    for (const line of combined.split("\n").filter((line) => line && !windowsFiles.includes(line.slice(66)))) assert.ok(refreshed.includes(`${line}\n`));
    for (const line of windowsSums.split("\n").filter(Boolean)) assert.ok(refreshed.includes(`${line}\n`));
    assert.equal(check({ tag: `v${version}`, rootDir: args.rootDir, allowIncomplete: true, skipDmgProvenance: true }, {
      platform: "win32", log: () => {}, run: fakeReleaseRunner({ downloadFrom: args.assets })
    }).complete, true);
  });
}

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
  assert.match(upload, /\$assets = @\(Get-ChildItem release-assets -File \| Where-Object Name -ne 'SHA256SUMS\.txt'/);
  const verifyStaging = upload.indexOf("node tools/release/release-checksums.mjs --assets release-assets --verify");
  const refreshSums = upload.indexOf('node tools/release/release-checksums.mjs --tag "$env:RELEASE_TAG"');
  assert.ok(verifyStaging > 0 && verifyStaging < upload.indexOf("gh release upload"));
  assert.ok(refreshSums > upload.indexOf("gh release upload") && refreshSums < upload.indexOf("node tools/release/check-release-assets.mjs"));
  assert.match(upload, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Combined release checksum upload failed\.'/);
  assert.match(upload, /shell: pwsh[\s\S]*if \(\$LASTEXITCODE -ne 0\) \{ throw 'Release asset validation failed\.'/);
});

test("Linux records the smoke-tested packages before staging and checks the destination before upload", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/linux-release.yml", import.meta.url), "utf8");
  const packageBuild = readFileSync(new URL("../../.github/workflows/linux-build.yml", import.meta.url), "utf8");
  const container = readFileSync(new URL("../../.github/workflows/linux-container-smoke.yml", import.meta.url), "utf8");
  const windows = readFileSync(new URL("../../.github/workflows/windows-release.yml", import.meta.url), "utf8");
  const [build, upload] = workflow.split("\n  upload:");
  assert.match(packageBuild, /commit: \$\{\{ steps\.source\.outputs\.commit \}\}/);
  assert.match(packageBuild, /\[ "\$sha" = "\$WORKFLOW_SHA" \]/);
  assert.match(packageBuild, /Repack AppImage/);
  assert.match(build, /Smoke test the repacked AppImage\n\s+uses: \.\/\.github\/workflows\/linux-package-smoke[\s\S]+package: appimage/);
  assert.match(build, /container-smoke:[\s\S]+uses: \.\/\.github\/workflows\/linux-container-smoke/);
  assert.match(upload, /needs: \[build, smoke, container-smoke\]/);
  assert.match(container, /apps\/desktop\/src-tauri\/src\/\*\*/);
  assert.match(container, /apps\/desktop\/src-tauri\/Cargo\.toml[\s\S]+apps\/desktop\/src-tauri\/Cargo\.lock/);
  assert.match(container, /distro: arch[\s\S]+host-mesa\.sh/);
  assert.match(container, /uses: \.\/\.github\/workflows\/linux-package-smoke/);
  for (const variable of ["DEB", "APPIMAGE"]) {
    const record = packageBuild.indexOf(`record-build.mjs --artifact "$${variable}" --target x86_64-unknown-linux-gnu`);
    assert.ok(record > packageBuild.indexOf("Repack AppImage"));
    assert.ok(record < packageBuild.indexOf("mkdir -p release-assets"));
    assert.ok(packageBuild.includes(`"$${variable}.build.json"`));
  }
  const jobs = [...workflow.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)];
  assert.match(packageBuild, /uses: actions\/upload-artifact@[^\n]+\n\s+with:\n\s+name: linux-release-\$\{\{ matrix\.arch \}\}\n\s+path: release-assets\/\*/);
  assert.match(packageBuild, /arch: amd64/);
  const smokeJobs = jobs.filter(([, , body]) => body.includes("uses: ./.github/workflows/linux-package-smoke"));
  assert.ok(smokeJobs.length > 0);
  for (const [, name, body] of smokeJobs) {
    assert.match(body, /needs:\s*(?:build|\[[^\]]*\bbuild\b[^\]]*\])/);
    assert.match(body, /uses: actions\/download-artifact@[^\n]+\n\s+with:\n\s+name: linux-release-amd64\n\s+path: release-assets/);
    assert.match(body, /release-assets\/\$\{\{ needs\.build\.outputs\.appimage \}\}/);
    assert.match(body, /release-assets\/\$\{\{ needs\.build\.outputs\.deb \}\}/);
    assert.ok(upload.match(/needs:\s*\[([^\]]+)\]/)?.[1].split(",").map((need) => need.trim()).includes(name), `upload must need ${name}`);
  }
  assert.match(upload, /BUILD_COMMIT: \$\{\{ needs\.build\.outputs\.commit \}\}/);
  assert.match(upload, /git fetch --no-tags origin[^\n]+\n\s+destination_commit=\$\(git rev-parse --verify "refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}"\)/);
  assert.match(upload, /\[ "\$destination_commit" = "\$BUILD_COMMIT" \].*exit 1; \}\n\s+gh release upload/);
  assert.match(upload, /gh release upload[\s\S]+--write-checksums[\s\S]+gh release upload/);
  const group = "group: draft-release-upload-${{ inputs.upload_to_release }}";
  assert.ok(upload.includes(group));
  assert.ok(windows.split("\n  upload:")[1].includes(group));
});

test("the final publishing checklist requires Mac verification of both DMGs without bypass flags", () => {
  const guide = readFileSync(new URL("../../docs/releasing/three-builds.md", import.meta.url), "utf8");
  const final = guide.split("## Last step before un-drafting")[1];
  assert.match(final, /\*\*on a Mac\*\*/);
  const commands = final.match(/^   node .+$/gm);
  assert.equal(commands.length, 4);
  assert.ok(commands[0].includes("release-checksums.mjs --tag vX.Y.Z"));
  for (const [index, target, suffix] of [[0, "aarch64-apple-darwin", "aarch64"], [1, "x86_64-apple-darwin", "x86_64"]]) {
    assert.ok(commands[index + 1].includes(`verify-macos-app.mjs --target ${target} --release --dmg`));
    assert.ok(commands[index + 1].includes(`ChemDraft_X.Y.Z_${suffix}.dmg --commit <full-sha>`));
  }
  assert.ok(commands[3].includes("check-release-assets.mjs --tag vX.Y.Z --commit <full-sha>"));
  assert.doesNotMatch(commands.join("\n"), /--skip-dmg-provenance|--allow-incomplete/);
  assert.match(final, /needs macOS, `hdiutil` and `plutil`/);
  const mac = readFileSync(new URL("../../docs/releasing/macos-updates.md", import.meta.url), "utf8");
  assert.match(mac, /staple and validate \*\*the DMG only\*\*/);
  assert.match(mac, /sets\n`CHEMDRAFT_RELEASE_BUILD=1` automatically/);
  assert.doesNotMatch(mac, /both staples|validate` on \*\*both\*\* app and DMG|staple and validate the app and DMG/);
});
