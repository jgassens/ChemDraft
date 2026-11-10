import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { draftReleaseBody } from "./draft-release-body.mjs";
import { BUILD_TARGETS } from "./record-build.mjs";

const version = "1.2.3";
const arm = `ChemDraft_${version}_aarch64.dmg`;
const intel = `ChemDraft_${version}_x86_64.dmg`;
const installer = `ChemDraft_${version}_x64-setup.exe`;
const commit = "a".repeat(40);
const feed = (name) => `<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>${version}</sparkle:version><enclosure url="https://example.com/${name}"/></item></channel></rss>`;

function fixture(t) {
  const rootDir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".release-body-test-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const assets = join(rootDir, "assets");
  git(rootDir, ["init", "--quiet"]);
  mkdirSync(assets);
  mkdirSync(join(rootDir, "release-notes", "macos"), { recursive: true });
  mkdirSync(join(rootDir, "release-notes", "macos-intel"), { recursive: true });
  for (const name of [arm, intel, installer, `${installer}.sig`, "latest.json"]) writeFileSync(join(assets, name), "fixture");
  writeFileSync(join(assets, "appcast.xml"), feed(arm));
  writeFileSync(join(assets, "appcast-intel.xml"), feed(intel));
  writeFileSync(join(rootDir, "release-notes", "macos", arm.replace(".dmg", ".md")), "Apple notes");
  writeFileSync(join(rootDir, "release-notes", "macos-intel", intel.replace(".dmg", ".md")), "Intel notes");
  writeFileSync(join(rootDir, "release-notes", `windows-${version}.md`), "Windows notes");
  for (const [target, suffix] of Object.entries(BUILD_TARGETS)) {
    writeFileSync(join(assets, `ChemDraft_${version}_${suffix}.build.json`), JSON.stringify({ commit, version, target, clean: true }));
  }
  return { rootDir, assets, version };
}

function git(rootDir, args) {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("complete release produces ordered sections with their notes and gaps", (t) => {
  const args = fixture(t);
  const body = draftReleaseBody({ ...args, gaps: ["macos-intel:Feature A: reason", "windows:Feature B: reason", "macos-intel:Feature C: reason"] });
  const sections = body.split(/^## /m);
  assert.equal(sections.length, 4);
  assert.match(sections[1], /^macOS \(Apple silicon\)\n\nApple notes/);
  assert.doesNotMatch(sections[1], /Not in this build/);
  assert.match(sections[2], /^macOS \(Intel\)\n\nIntel notes/);
  assert.match(sections[2], /Not in this build: Feature A: reason/);
  assert.match(sections[2], /Not in this build: Feature C: reason/);
  assert.match(sections[3], /^Windows\n\nWindows notes/);
  assert.match(sections[3], /Not in this build: Feature B: reason/);
  assert.match(draftReleaseBody(args), /Platform differences: None\./);
});

for (const name of [arm, intel, installer, `${installer}.sig`, "latest.json", "appcast.xml", "appcast-intel.xml", ...[arm, intel, installer].map((name) => `${name}.build.json`)]) {
  test(`missing ${name} is named`, (t) => {
    const args = fixture(t);
    unlinkSync(join(args.assets, name));
    assert.throws(() => draftReleaseBody(args), (error) => error.message.includes(name));
  });
}

test("feed pointing to the wrong architecture fails", (t) => {
  const args = fixture(t);
  writeFileSync(join(args.assets, "appcast-intel.xml"), feed(arm));
  assert.throws(() => draftReleaseBody(args), /appcast-intel\.xml:.*x86_64/);
});

test("missing version and notes are named", (t) => {
  const args = fixture(t);
  writeFileSync(join(args.assets, "appcast.xml"), feed(arm).replace(version, "1.2.2"));
  unlinkSync(join(args.rootDir, "release-notes", `windows-${version}.md`));
  assert.throws(() => draftReleaseBody(args), (error) =>
    error.message.includes("appcast.xml") && error.message.includes(`windows-${version}.md`));
});

test("invalid gap is rejected", (t) => {
  assert.throws(() => draftReleaseBody({ ...fixture(t), gaps: ["linux:feature"] }), /Invalid gap/);
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
    writeFileSync(join(args.assets, `${installer}.build.json`), JSON.stringify({ commit, version, target: "x86_64-pc-windows-msvc", clean: true, [field]: value }));
    assert.throws(() => draftReleaseBody(args), (error) => error.message.includes(installer) && message.test(error.message));
  });
}

test("explicit commit accepts matching records and rejects mismatches with build names", (t) => {
  const args = fixture(t);
  assert.match(draftReleaseBody({ ...args, commit }), /Platform differences: None/);
  assert.throws(() => draftReleaseBody({ ...args, commit: "c".repeat(40) }), (error) =>
    [arm, intel, installer].every((name) => error.message.includes(`${name}.build.json`)) && /does not match --commit/.test(error.message));
});

for (const [target, suffix] of Object.entries(BUILD_TARGETS)) {
  test(`differing ${target} commit is named`, (t) => {
    const args = fixture(t);
    const name = `ChemDraft_${version}_${suffix}.build.json`;
    writeFileSync(join(args.assets, name), JSON.stringify({ commit: "b".repeat(40), version, target, clean: true }));
    assert.throws(() => draftReleaseBody(args), (error) => error.message.includes(name) && /differs from/.test(error.message));
  });
}

test("release tag is peeled to its commit and mismatches are named", (t) => {
  const args = fixture(t);
  git(args.rootDir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"]);
  git(args.rootDir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "tag.gpgsign=false", "tag", "-a", `v${version}`, "-m", "fixture"]);
  assert.throws(() => draftReleaseBody(args), (error) => error.message.includes(installer) && /does not match tag v1\.2\.3/.test(error.message));
  const taggedCommit = git(args.rootDir, ["rev-parse", "HEAD"]);
  for (const [target, suffix] of Object.entries(BUILD_TARGETS)) {
    writeFileSync(join(args.assets, `ChemDraft_${version}_${suffix}.build.json`), JSON.stringify({ commit: taggedCommit, version, target, clean: true }));
  }
  assert.match(draftReleaseBody(args), /Platform differences: None/);
});

test("CLI exits 1 for a commit mismatch", (t) => {
  const args = fixture(t);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./draft-release-body.mjs", import.meta.url)), "--version", version, "--assets", args.assets, "--commit", "b".repeat(40)], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match --commit/);
  assert.ok(result.stderr.includes(installer));
});
