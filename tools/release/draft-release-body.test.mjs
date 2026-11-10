import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { draftReleaseBody } from "./draft-release-body.mjs";

const version = "1.2.3";
const arm = `ChemDraft_${version}_aarch64.dmg`;
const intel = `ChemDraft_${version}_x86_64.dmg`;
const installer = `ChemDraft_${version}_x64-setup.exe`;
const feed = (name) => `<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>${version}</sparkle:version><enclosure url="https://example.com/${name}"/></item></channel></rss>`;

function fixture(t) {
  const rootDir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".release-body-test-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const assets = join(rootDir, "assets");
  mkdirSync(assets);
  mkdirSync(join(rootDir, "release-notes", "macos"), { recursive: true });
  mkdirSync(join(rootDir, "release-notes", "macos-intel"), { recursive: true });
  for (const name of [arm, intel, installer, `${installer}.sig`, "latest.json"]) writeFileSync(join(assets, name), "fixture");
  writeFileSync(join(assets, "appcast.xml"), feed(arm));
  writeFileSync(join(assets, "appcast-intel.xml"), feed(intel));
  writeFileSync(join(rootDir, "release-notes", "macos", arm.replace(".dmg", ".md")), "Apple notes");
  writeFileSync(join(rootDir, "release-notes", "macos-intel", intel.replace(".dmg", ".md")), "Intel notes");
  writeFileSync(join(rootDir, "release-notes", `windows-${version}.md`), "Windows notes");
  return { rootDir, assets, version };
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

for (const name of [arm, intel, installer, `${installer}.sig`, "latest.json", "appcast.xml", "appcast-intel.xml"]) {
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
