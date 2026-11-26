import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { artifactDigest, buildFileName, recordBuild } from "./record-build.mjs";
import { macosReleasePlist } from "./macos-build-plist.mjs";
import { allusersInstaller, appImage, arm, deb, fakeReleaseRunner, installer, intel, offlineInstaller } from "./release-test-fixtures.mjs";

const recordRunner = (options) => {
  const native = fakeReleaseRunner(options);
  return (command, args, config) => command === "git" ? spawnSync(command, args, config) : native(command, args, config);
};

function fixture(t) {
  const rootDir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".build-record-test-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const tauriDir = join(rootDir, "apps", "desktop", "src-tauri");
  mkdirSync(tauriDir, { recursive: true });
  writeFileSync(join(tauriDir, "tauri.conf.json"), JSON.stringify({ version: "1.2.3" }));
  for (const file of ["Info.plist", "Info.intel.plist"]) {
    writeFileSync(join(tauriDir, file), readFileSync(new URL(`../../apps/desktop/src-tauri/${file}`, import.meta.url)));
  }
  writeFileSync(join(rootDir, ".gitignore"), "/assets/\n");
  mkdirSync(join(rootDir, "assets"));
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return { rootDir, tauriDir, commit: git("rev-parse", "HEAD") };
}

test("every release artifact records the checked-out full commit, version, target and cleanliness", (t) => {
  const { rootDir, commit } = fixture(t);
  for (const [target, name] of [
    ["aarch64-apple-darwin", arm], ["x86_64-apple-darwin", intel],
    ["x86_64-pc-windows-msvc", installer], ["x86_64-pc-windows-msvc", allusersInstaller], ["x86_64-pc-windows-msvc", offlineInstaller],
    ["x86_64-unknown-linux-gnu", deb], ["x86_64-unknown-linux-gnu", appImage]
  ]) {
    const artifact = join(rootDir, "assets", name);
    writeFileSync(artifact, "fixture");
    const calls = [];
    recordBuild({ artifact, target, rootDir }, { run: recordRunner({ embeddedCommit: commit, calls }) });
    assert.equal(calls.filter(({ args }) => args[0] === "attach").length, artifact.endsWith(".dmg") ? 1 : 0);
    assert.deepEqual(JSON.parse(readFileSync(`${artifact}.build.json`, "utf8")), { commit, version: "1.2.3", target, clean: true, ...artifactDigest(artifact) });
  }
});

test("only Linux file names carry the beta suffix; macOS and Windows names are unchanged", () => {
  assert.equal(deb, "ChemDraft_1.2.3-beta_amd64.deb");
  assert.equal(appImage, "ChemDraft_1.2.3-beta_amd64.AppImage");
  assert.equal(buildFileName("1.2.3", "x86_64-unknown-linux-gnu", "amd64.deb"), deb);
  assert.equal(buildFileName("1.2.3", "aarch64-apple-darwin", "aarch64.dmg"), "ChemDraft_1.2.3_aarch64.dmg");
  assert.equal(buildFileName("1.2.3", "x86_64-pc-windows-msvc", "x64-setup.exe"), "ChemDraft_1.2.3_x64-setup.exe");
});

test("Linux records require an exact package name for the checked-out version", (t) => {
  const { rootDir } = fixture(t);
  // The Linux build is the beta of 1.2.3: the pre-beta name ChemDraft_1.2.3_amd64.* is no longer accepted.
  for (const name of [
    "ChemDraft_1.2.2-beta_amd64.deb", "ChemDraft_1.2.3-beta_arm64.deb", "ChemDraft_1.2.3-beta_amd64.appimage",
    "ChemDraft_1.2.3_amd64.deb", "ChemDraft_1.2.3_amd64.AppImage", "ChemDraft_1.2.3_beta_amd64.deb", "ChemDraft_1.2.3~beta_amd64.deb"
  ]) {
    const artifact = join(rootDir, "assets", name);
    writeFileSync(artifact, "fixture");
    assert.throws(() => recordBuild({ artifact, target: "x86_64-unknown-linux-gnu", rootDir }),
      { message: `Expected release artifact ${deb} or ${appImage}` });
    assert.equal(existsSync(`${artifact}.build.json`), false);
  }
});

for (const [target, name] of [["aarch64-apple-darwin", arm], ["x86_64-apple-darwin", intel]]) {
  test(`recording ${target} refuses an unsigned-stamped app even with the correct source commit`, (t) => {
    const { rootDir, commit } = fixture(t);
    const artifact = join(rootDir, "assets", name);
    writeFileSync(artifact, "synthetic unsigned DMG");
    const calls = [];
    assert.throws(() => recordBuild({ artifact, target, rootDir }, {
      run: recordRunner({ embeddedCommit: commit, unsigned: true, calls })
    }), /ChemDraftUnsignedBuild: UNSIGNED local build must NEVER be published/);
    assert.equal(existsSync(`${artifact}.build.json`), false);
    assert.deepEqual(calls.filter(({ command }) => command === "/usr/bin/hdiutil").map(({ args }) => args[0]), ["attach", "detach"]);
  });

  test(`recording ${target} checks the DMG's embedded commit before writing a record`, (t) => {
    const { rootDir, commit } = fixture(t);
    const artifact = join(rootDir, "assets", name);
    writeFileSync(artifact, "synthetic DMG");
    for (const embeddedCommit of [undefined, "short", "b".repeat(40)]) {
      const calls = [];
      assert.throws(() => recordBuild({ artifact, target, rootDir }, {
        run: recordRunner({ embeddedCommit: embeddedCommit ?? null, calls })
      }), /ChemDraftSourceCommit: (missing|expected)/);
      assert.equal(existsSync(`${artifact}.build.json`), false);
      assert.deepEqual(calls.filter(({ command }) => command === "/usr/bin/hdiutil").map(({ args }) => args[0]), ["attach", "detach"]);
    }
    assert.equal(recordBuild({ artifact, target, rootDir }, { run: recordRunner({ embeddedCommit: commit }) }).commit, commit);
  });
}

for (const dirty of ["tracked", "untracked", "staged"]) {
  test(`recording refuses a ${dirty} dirty tree`, (t) => {
    const { rootDir, tauriDir } = fixture(t);
    const file = dirty === "tracked" ? join(tauriDir, "Info.plist") : join(rootDir, "new-file");
    writeFileSync(file, "dirty");
    if (dirty === "staged") assert.equal(spawnSync("git", ["add", file], { cwd: rootDir }).status, 0);
    assert.throws(() => recordBuild({ rootDir, artifact: "unused", target: "aarch64-apple-darwin" }), /tree is dirty/);
  });
}

test("macOS stable DMG builds merge their source commit and preserve each target's Sparkle settings", (t) => {
  const { rootDir, tauriDir, commit } = fixture(t);
  for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const args = ["build", "--target", target, "--bundles", "app,dmg", "--", "extra"];
    const prepared = macosReleasePlist(args, { rootDir, target, stable: true });
    try {
      const config = JSON.parse(prepared.args[prepared.args.indexOf("--config") + 1]);
      const plist = readFileSync(config.bundle.macOS.infoPlist, "utf8");
      const base = readFileSync(join(tauriDir, target.startsWith("x86_64") ? "Info.intel.plist" : "Info.plist"), "utf8");
      assert.equal(plist.replace(`  <key>ChemDraftSourceCommit</key>\n  <string>${commit}</string>\n`, ""), base);
      assert.ok(prepared.args.indexOf("--config") < prepared.args.indexOf("--"));
      assert.equal(args.includes("--config"), false);
    } finally { prepared.cleanup(); }
  }
});

test("non-release macOS builds need no source record or generated plist", () => {
  for (const [args, stable] of [
    [["dev"], true], [["build", "--bundles", "app"], true], [["build", "--bundles=nsis"], true],
    [["build", "--debug"], true], [["build", "--no-bundle"], true], [["build"], false]
  ]) assert.equal(macosReleasePlist(args, { stable }), undefined);
});

test("unsigned stable DMGs merge a boolean unsigned stamp alongside the commit for both targets", (t) => {
  const { rootDir, tauriDir, commit } = fixture(t);
  for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const prepared = macosReleasePlist(["build", "--target", target], { rootDir, target, stable: true, unsigned: true });
    const config = JSON.parse(prepared.args[prepared.args.indexOf("--config") + 1]);
    const file = config.bundle.macOS.infoPlist;
    try {
      const plist = readFileSync(file, "utf8");
      const stamp = `  <key>ChemDraftSourceCommit</key>\n  <string>${commit}</string>\n  <key>ChemDraftUnsignedBuild</key>\n  <true/>\n`;
      assert.ok(plist.includes(stamp));
      const base = readFileSync(join(tauriDir, target.startsWith("x86_64") ? "Info.intel.plist" : "Info.plist"), "utf8");
      assert.equal(plist.replace(stamp, ""), base);
    } finally { prepared.cleanup(); }
    assert.equal(existsSync(file), false);
  }
});

test("Windows records before staging and carries the record through installer uploads", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/windows-release.yml", import.meta.url), "utf8");
  // Every installer variant is recorded outside the checkout before the untracked release-assets folder exists.
  const recording = workflow.indexOf("node tools/release/record-build.mjs --artifact $staged --target x86_64-pc-windows-msvc");
  assert.ok(recording > workflow.indexOf("ref: ${{ inputs.ref }}"));
  assert.ok(recording > workflow.indexOf("foreach ($variant in $variants)"));
  assert.ok(recording < workflow.indexOf("New-Item -ItemType Directory -Path release-assets"));
  assert.match(workflow, /\$staging = Join-Path \$env:RUNNER_TEMP 'windows-installers'/);
  assert.ok(workflow.includes('Copy-Item -LiteralPath "$staged.build.json" -Destination release-assets'));
  assert.match(workflow, /name: windows-nsis-unsigned\n\s+path: \|\n\s+release-assets\/\*\.exe\n\s+release-assets\/\*\.exe\.build\.json/);
  assert.match(workflow, /name: windows-release\n\s+path: release-assets\/\*/);
  assert.match(workflow, /Get-ChildItem release-assets -File[\s\S]+gh release upload \$env:RELEASE_TAG @assets/);
  const finalRecord = workflow.indexOf("name: Bind build records to final signed installer bytes");
  assert.match(workflow.slice(finalRecord), /^name: Bind build records[^\n]*\n\s+env:\n\s+INSTALLERS: \$\{\{ steps\.bundle\.outputs\.installers \}\}\n\s+run: \|\n\s+foreach \(\$artifact in/);
  assert.ok(finalRecord > workflow.indexOf("name: Verify Authenticode and replace unsigned installer"));
  assert.ok(finalRecord < workflow.indexOf("node tools/release/release-checksums.mjs --assets release-assets"));
  assert.match(workflow, /\$record\.sha256 = \(Get-FileHash -LiteralPath \$installer -Algorithm SHA256\)/);
  assert.match(workflow, /\$record\.size = \(Get-Item -LiteralPath \$installer\)\.Length/);
});
