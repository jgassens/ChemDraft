import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { draftReleaseBody } from "./draft-release-body.mjs";
import { BUILD_TARGETS } from "./record-build.mjs";
import { arm, commit, fakeReleaseRunner, installer, intel, releaseFixture, updaterPublicKey, version } from "./release-test-fixtures.mjs";

const feed = (name) => `<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>${version}</sparkle:version><enclosure url="https://example.com/${name}"/></item></channel></rss>`;

function fixture(t) {
  const args = releaseFixture(t);
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

test("complete release produces ordered sections with explicit gaps or explicit no-gaps", (t) => {
  const args = fixture(t);
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

test("neither gap choice is refused, including by the CLI", (t) => {
  const args = fixture(t);
  assert.throws(() => draft({ ...args, noGaps: false }), /--gap.*--no-gaps/);
  assert.throws(() => draft({ ...args, gaps: ["windows:reason"] }), /not both/);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./draft-release-body.mjs", import.meta.url)), "--version", version, "--assets", args.assets, "--commit", commit], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--gap.*--no-gaps/);
});

for (const name of [arm, intel, installer, `${installer}.sig`, "latest.json", "appcast.xml", "appcast-intel.xml", ...[arm, intel, installer].map((name) => `${name}.build.json`)]) {
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

for (const [name, garbage] of [[`${installer}.sig`, "not a signature"], ["latest.json", "not JSON"]]) {
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
  assert.throws(() => draft({ ...fixture(t), noGaps: false, gaps: ["linux:feature"] }), /Invalid gap/);
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

for (const [target, suffix] of Object.entries(BUILD_TARGETS)) {
  test(`differing ${target} commit and bytes are refused`, (t) => {
    const args = fixture(t);
    const file = join(args.assets, `ChemDraft_${version}_${suffix}`);
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
