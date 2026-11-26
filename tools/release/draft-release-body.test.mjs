import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { draftReleaseBody, windowsInstallerLines } from "./draft-release-body.mjs";
import { BUILD_TARGETS } from "./record-build.mjs";
import { releaseBuildFiles } from "./release-assets.mjs";
import { allusersInstaller, appImage, arm, commit, deb, fakeReleaseRunner, installer, intel, offlineInstaller, releaseFixture, updaterPublicKey, version, windowsInstallers, windowsUpdates } from "./release-test-fixtures.mjs";

const feed = (name) => `<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>${version}</sparkle:version><enclosure url="https://example.com/${name}"/></item></channel></rss>`;

function fixture(t, options) {
  const args = releaseFixture(t, options);
  mkdirSync(join(args.rootDir, "release-notes", "macos"), { recursive: true });
  mkdirSync(join(args.rootDir, "release-notes", "macos-intel"), { recursive: true });
  writeFileSync(join(args.assets, "appcast.xml"), feed(arm));
  writeFileSync(join(args.assets, "appcast-intel.xml"), feed(intel));
  writeFileSync(join(args.rootDir, "release-notes", "macos", arm.replace(".dmg", ".md")), "Apple notes");
  writeFileSync(join(args.rootDir, "release-notes", "macos-intel", intel.replace(".dmg", ".md")), "Intel notes");
  writeFileSync(join(args.rootDir, "release-notes", `windows-${version}.md`), "Windows notes");
  return { ...args, noGaps: true };
}

const draft = (args, options = {}) => draftReleaseBody(args, { run: fakeReleaseRunner(), updaterPublicKey, ...options });

test("three-build release produces ordered sections with explicit gaps or explicit no-gaps", (t) => {
  const args = fixture(t, { withLinux: false });
  const body = draft({ ...args, noGaps: false, gaps: ["macos-intel:Feature A: reason", "windows:Feature B: reason", "macos-intel:Feature C: reason"] });
  const sections = body.split(/^## /m);
  assert.equal(sections.length, 4);
  assert.match(sections[1], /^macOS \(Apple silicon\)\n\nApple notes/);
  assert.doesNotMatch(sections[1], /Not in this build/);
  assert.match(sections[2], /^macOS \(Intel\)\n\nIntel notes/);
  assert.match(sections[2], /Not in this build: Feature A: reason/);
  assert.match(sections[2], /Not in this build: Feature C: reason/);
  assert.match(sections[3], /^Windows\n\nWindows notes/);
  assert.match(sections[3], /Not in this build: Feature B: reason/);
  assert.match(draft(args), /Platform differences: None\./);
});

test("Windows section lists all three installers, the offline one labelled for IT-managed machines", (t) => {
  const args = fixture(t, { withLinux: false });
  const windows = draft({ ...args, noGaps: false, gaps: ["windows:Feature B: reason"] }).split(/^## /m)[3];
  const list = windowsInstallers.map(({ name, label }) => `- \`${name}\`: ${label}`).join("\n");
  assert.ok(windows.startsWith(`Windows\n\nWindows notes\n\nInstallers:\n\n${list}\n\nNot in this build: Feature B: reason`), windows);
  assert.ok(windows.includes(`- \`${offlineInstaller}\`: offline, for IT-managed machines\n`));
  assert.equal(windows.match(/^- `ChemDraft_.*\.exe`: /gm).length, 3);
});

test("an installer built without a release-page label fails the Windows section", () => {
  const suffixes = BUILD_TARGETS["x86_64-pc-windows-msvc"];
  const original = [...suffixes];
  try {
    suffixes.push("x64-unlabelled-setup.exe");
    assert.throws(() => windowsInstallerLines(version), /No release-page label for Windows installer x64-unlabelled-setup\.exe/);
  } finally {
    suffixes.splice(0, suffixes.length, ...original);
  }
  assert.deepEqual(suffixes, original);
  assert.equal(windowsInstallerLines(version).length, 3);
});

test("five-build release includes a Linux beta section and accepts Linux gaps", (t) => {
  const args = fixture(t);
  assert.match(draft(args), /^## Linux\n\nThe Linux build is ChemDraft [^\n]+β, a beta\.\n\nFiles:\n- ChemDraft_[^\n]+-beta_amd64\.deb\n- ChemDraft_[^\n]+-beta_amd64\.AppImage/m);
  assert.match(draft({ ...args, noGaps: false, gaps: ["linux:Feature A: reason"] }),
    /^## Linux\n\nThe Linux build is ChemDraft [^\n]+β, a beta\.\n\nFiles:\n- ChemDraft_[^\n]+-beta_amd64\.deb\n- ChemDraft_[^\n]+-beta_amd64\.AppImage\n\nNot in this build: Feature A: reason\n\nPlatform differences: See/m);
});

test("requesting a Linux section without packages fails", (t) => {
  const args = fixture(t, { withLinux: false });
  assert.doesNotMatch(draft(args), /^## Linux$/m);
  assert.throws(() => draft({ ...args, includeLinux: true }), /--include-linux requires both verified Linux packages/);
});

test("requesting a Linux section succeeds with the complete verified set", (t) => {
  assert.match(draft({ ...fixture(t), includeLinux: true }), /^## Linux\n\nThe Linux build is ChemDraft [^\n]+β, a beta\.\n\nFiles:\n- ChemDraft_[^\n]+-beta_amd64\.deb\n- ChemDraft_[^\n]+-beta_amd64\.AppImage/m);
});

test("requesting a Linux section still requires a complete set when packages are present", (t) => {
  const args = fixture(t);
  unlinkSync(join(args.assets, appImage));
  unlinkSync(join(args.assets, `${appImage}.build.json`));
  assert.throws(() => draft({ ...args, includeLinux: true }), /amd64\.AppImage: missing release file/);
});

test("neither gap choice is refused, including by the CLI", (t) => {
  const args = fixture(t);
  assert.throws(() => draft({ ...args, noGaps: false }), /--gap.*--no-gaps/);
  assert.throws(() => draft({ ...args, gaps: ["windows:reason"] }), /not both/);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./draft-release-body.mjs", import.meta.url)), "--version", version, "--assets", args.assets, "--commit", commit], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--gap.*--no-gaps/);
});

const buildNames = [arm, intel, installer, allusersInstaller, offlineInstaller, deb, appImage];
const windowsUpdateNames = windowsUpdates.flatMap(({ installer: name, feed }) => [`${name}.sig`, feed]);
for (const name of [...buildNames, ...windowsUpdateNames, "appcast.xml", "appcast-intel.xml", ...buildNames.map((name) => `${name}.build.json`)]) {
  test(`missing ${name} is named`, (t) => {
    const args = fixture(t);
    unlinkSync(join(args.assets, name));
    assert.throws(() => draft(args), (error) => error.message.includes(name));
  });
}

test("feed pointing to the wrong architecture fails", (t) => {
  const args = fixture(t);
  writeFileSync(join(args.assets, "appcast-intel.xml"), feed(arm));
  assert.throws(() => draft(args), /appcast-intel\.xml:.*x86_64/);
});

for (const [name, garbage] of windowsUpdates.flatMap(({ installer: file, feed }) => [[`${file}.sig`, "not a signature"], [feed, "not JSON"]])) {
  for (const state of ["absent", "garbage"]) {
    test(`release body refuses ${state} Windows updater ${name} with valid build/record pairs`, (t) => {
      const args = fixture(t);
      assert.match(draft(args), /Platform differences: None\./);
      if (state === "absent") unlinkSync(join(args.assets, name));
      else writeFileSync(join(args.assets, name), garbage);
      assert.throws(() => draft(args), (error) => error.message.includes(name));
    });
  }
}

test("missing version and notes are named", (t) => {
  const args = fixture(t);
  writeFileSync(join(args.assets, "appcast.xml"), feed(arm).replace(version, "1.2.2"));
  unlinkSync(join(args.rootDir, "release-notes", `windows-${version}.md`));
  assert.throws(() => draft(args), (error) => error.message.includes("appcast.xml") && error.message.includes(`windows-${version}.md`));
});

test("invalid gap is rejected", (t) => {
  const args = { ...fixture(t, { withLinux: false }), noGaps: false };
  assert.throws(() => draft({ ...args, gaps: ["linux:feature"] }), /Invalid gap/);
  assert.throws(() => draft({ ...fixture(t), noGaps: false, includeLinux: true, gaps: ["other:feature"] }), /Invalid gap/);
});

for (const [field, value, message] of [
  ["commit", "b".repeat(40), /commit .* differs/],
  ["commit", "abc123", /40-character commit/],
  ["clean", false, /must be clean/],
  ["clean", "true", /must be clean/],
  ["target", "aarch64-apple-darwin", /expected target x86_64-pc-windows-msvc/],
  ["version", "1.2.2", /expected version 1\.2\.3/]
]) {
  test(`Windows record with ${field}=${value} fails naming the build`, (t) => {
    const args = fixture(t);
    const file = join(args.assets, `${installer}.build.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), [field]: value }));
    assert.throws(() => draft(args), (error) => error.message.includes(installer) && message.test(error.message));
  });
}

for (const { name } of releaseBuildFiles(version)) {
  test(`differing ${name} commit and bytes are refused`, (t) => {
    const args = fixture(t);
    const file = join(args.assets, name);
    writeFileSync(file, "tampered bytes");
    assert.throws(() => draft(args), /SHA-256 mismatch/);
    const recordFile = `${file}.build.json`;
    writeFileSync(recordFile, JSON.stringify({ ...JSON.parse(readFileSync(recordFile, "utf8")), commit: "b".repeat(40) }));
    assert.throws(() => draft(args), /differs from/);
  });
}

test("release DMGs require their embedded source commit and detach after rejection", (t) => {
  const args = fixture(t);
  for (const embeddedCommit of [null, "", "b".repeat(40)]) {
    const calls = [];
    assert.throws(() => draft(args, { run: fakeReleaseRunner({ embeddedCommit, calls }) }), /ChemDraftSourceCommit: (missing|expected)/);
    assert.equal(calls.filter(({ args }) => args[0] === "attach").length, 2);
    assert.equal(calls.filter(({ args }) => args[0] === "detach").length, 2);
  }
});

for (const name of [arm, intel]) {
  test(`release body refuses an unsigned ${name} even with a matching source commit`, (t) => {
    const args = fixture(t);
    assert.throws(() => draft(args, { run: fakeReleaseRunner({ unsigned: (dmg) => dmg === join(args.assets, name) }) }),
      /ChemDraftUnsignedBuild: UNSIGNED local build must NEVER be published/);
  });
}

test("missing expected source, unresolvable tag and tag/commit disagreement fail", (t) => {
  const args = fixture(t);
  assert.throws(() => draft(args, { run: () => ({ status: 1, stderr: "no tag" }) }), /Expected --commit/);
  assert.throws(() => draft({ ...args, commit: "b".repeat(40) }), /--commit.*disagrees with tag v1\.2\.3/);
  assert.match(draft({ ...args, commit }), /Platform differences: None/);
  assert.throws(() => draft(args, { run: fakeReleaseRunner({ taggedCommit: "c".repeat(40) }) }), /does not match expected commit/);
});
