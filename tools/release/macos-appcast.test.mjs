import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { appcastConfiguration, emptyAppcast, NOTES_PREFIX, parseAppcast, targetForFeed, verifyAppcast } from "./macos-appcast.mjs";
import { generateMacosAppcast, mergeAppcast } from "./generate-macos-appcast.mjs";
import { verifyDmg, verifyFeedArtifacts } from "./verify-macos-feed.mjs";
import { feedForTarget, verifyApp } from "./verify-macos-app.mjs";
import { machOSlices } from "./macos-mach-o.mjs";
import { thinMachO } from "./macos-test-fixtures.mjs";
import { requiredLicenseFiles } from "./required-license-files.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const names = { arm64: "ChemDraft_1.1.1_aarch64.dmg", x86_64: "ChemDraft_1.1.1_x86_64.dmg" };

function feed(architecture, { version = "1.1.1", notesDirectory = appcastConfiguration(architecture).notesDirectory } = {}) {
  const item = `<item>
            <title>${version}</title>
            <sparkle:version>${version}</sparkle:version>
            <sparkle:hardwareRequirements>${architecture}</sparkle:hardwareRequirements>
            <sparkle:releaseNotesLink>${NOTES_PREFIX}${notesDirectory}/${names[architecture].replace(".dmg", ".md")}</sparkle:releaseNotesLink>
            <enclosure url="https://github.com/jgassens/ChemDraft/releases/download/v${version}/${names[architecture]}" length="1234" type="application/octet-stream" sparkle:edSignature="test-signature"/>
        </item>`;
  return emptyAppcast(architecture).replace("</channel>", `${item}\n    </channel>`);
}

test("arm64 feed retains every published signed item byte-for-byte and lists only arm64 DMGs", () => {
  const xml = readFileSync(new URL("../../appcast.xml", import.meta.url), "utf8");
  const items = verifyAppcast(xml, "aarch64-apple-darwin");
  // Pin the released items, including signatures, URLs, notes, hardware, minimum OS and formatting.
  const published = {
    "1.1.0": "02de1bc443f291e205b57ec2eff15b498ae5619f171c0dcfe854a7e0c0c286bd",
    "1.0.0": "698f810db308e01e9da2d272bb46ac85b6563ca21d413234b80923c49d990b47",
    "0.3.9": "496f84654de6a1abab02a39b8caa23a5b6ea4e121315e86b01499a6449331116"
  };
  for (const [version, hash] of Object.entries(published)) assert.equal(sha256(items.find((item) => item.version === version)?.raw ?? "missing"), hash);
  const merged = mergeAppcast(xml, feed("arm64"), "arm64", { version: "1.1.1", dmgs: [names.arm64] });
  const updated = verifyAppcast(merged, "arm64");
  assert.equal(updated.length, items.length + 1);
  assert.deepEqual(updated.slice(1), items);
});

test("committed Intel feed is valid empty RSS until the first Intel release", () => {
  const xml = readFileSync(new URL("../../appcast-intel.xml", import.meta.url), "utf8");
  assert.deepEqual(verifyAppcast(xml, "x86_64"), []);
  assert.deepEqual(parseAppcast(xml), []);
  for (const invalid of ["<rss><channel></rss>", "<rss/>", "<!DOCTYPE rss><rss/>"]) assert.throws(() => parseAppcast(invalid));
});

test("feed names, all enclosures, hardware and notes are architecture-specific", () => {
  for (const architecture of ["arm64", "x86_64"]) {
    const other = architecture === "arm64" ? "x86_64" : "arm64";
    assert.equal(targetForFeed(appcastConfiguration(architecture).filename), architecture === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin");
    assert.equal(verifyAppcast(feed(architecture), architecture).length, 1);
    assert.throws(() => verifyAppcast(feed(other), architecture), /feed requires/);
    assert.throws(() => verifyAppcast(feed(architecture, { notesDirectory: appcastConfiguration(other).notesDirectory }), architecture), /release notes must come from/);
    assert.throws(() => verifyAppcast(feed(architecture).replace(`>${architecture}</sparkle:hardwareRequirements>`, `>${other}</sparkle:hardwareRequirements>`), architecture), /wrong hardware/);
    assert.throws(() => verifyAppcast(feed(architecture).replace(/_aarch64\.dmg|_x86_64\.dmg/, "_universal.dmg"), architecture), /architecture suffix/);
  }
  assert.throws(() => targetForFeed("other.xml"), /Unknown/);
});

test("merging generated entries uses each architecture's own notes and preserves signed enclosure attributes", () => {
  for (const architecture of ["arm64", "x86_64"]) {
    const generated = feed(architecture, { notesDirectory: "incorrect-source" });
    const merged = mergeAppcast(emptyAppcast(architecture), generated, architecture, { version: "1.1.1", dmgs: [names[architecture]] });
    const [item] = verifyAppcast(merged, architecture);
    assert.equal(item.notes, `${NOTES_PREFIX}${appcastConfiguration(architecture).notesDirectory}/${names[architecture].replace(".dmg", ".md")}`);
    const enclosure = (xml) => xml.match(/<enclosure\b[^>]*\/>/)[0];
    assert.equal(enclosure(merged), enclosure(generated));
    assert.throws(() => mergeAppcast(merged, generated, architecture, { version: "1.1.1", dmgs: [names[architecture]] }), /already published/);
    assert.throws(() => mergeAppcast(emptyAppcast(architecture), generated, architecture, { version: "1.1.2", dmgs: [names[architecture]] }), /did not produce version/);
  }
});

test("local generation stages notes from the correct repository folder and rejects mixed inputs before Sparkle", () => {
  const root = mkdtempSync(join(tmpdir(), "chemdraft-appcast-"));
  try {
    const write = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
    for (const architecture of ["arm64", "x86_64"]) {
      const config = appcastConfiguration(architecture);
      const staging = join(root, architecture);
      const noteName = names[architecture].replace(".dmg", ".md");
      write(join(staging, names[architecture]), "fixture DMG: never mounted by tests");
      write(join(root, ...config.notesDirectory.split("/"), noteName), `${architecture} release notes`);
      const events = [];
      const options = {
        checkDmg: (path, target) => { assert.equal(basename(path), names[architecture]); assert.equal(target, architecture); events.push("verify"); },
        run: (command, args) => {
          events.push("generate");
          assert.equal(basename(command), "generate_appcast");
          assert.ok(args.includes("--maximum-deltas"));
          assert.equal(args.at(-1), staging);
          assert.equal(readFileSync(join(staging, noteName), "utf8"), `${architecture} release notes`);
          writeFileSync(args[args.indexOf("-o") + 1], feed(architecture));
          return { status: 0 };
        }
      };
      const output = generateMacosAppcast({ target: architecture, version: "1.1.1", staging, rootDir: root }, options);
      assert.equal(basename(output), config.filename);
      assert.equal(verifyAppcast(readFileSync(output, "utf8"), architecture).length, 1);
      assert.deepEqual(events, ["verify", "generate"]);
      write(join(staging, names[architecture === "arm64" ? "x86_64" : "arm64"]), "wrong DMG");
      assert.throws(() => generateMacosAppcast({ target: architecture, version: "1.1.1", staging, rootDir: root }, {
        run: () => assert.fail("mixed staging must not invoke generator"), checkDmg: () => assert.fail("mixed staging must not inspect artifacts")
      }), /exactly one/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function appChecker(architecture, feedTarget = architecture) {
  const plist = { CFBundleExecutable: "chemdraft", LSMinimumSystemVersion: "11.0", SUFeedURL: feedForTarget(feedTarget) };
  const paths = ["Contents/MacOS/chemdraft", "Contents/MacOS/avogadro3d-sidecar", "Contents/Resources/resources/opsin/jre/bin/java", "Contents/Resources/resources/opsin/jre/lib/server/libjvm.dylib"];
  return (app, target) => verifyApp(app, target, {
    run: () => ({ status: 0, stdout: JSON.stringify(plist) }),
    inventory: () => [
      ...paths.map((path) => ({ path, slices: machOSlices(thinMachO(architecture)) })),
      ...requiredLicenseFiles.map(({ target }) => ({ path: `Contents/Resources/${target}` }))
    ]
  });
}

test("feed verifier rejects app contents of the wrong architecture and architecture-mismatched SUFeedURL", () => {
  for (const architecture of ["arm64", "x86_64"]) {
    const other = architecture === "arm64" ? "x86_64" : "arm64";
    const parameters = { xml: feed(architecture), target: architecture, apps: ["ChemDraft.app"] };
    assert.equal(verifyFeedArtifacts(parameters, { checkApp: appChecker(architecture) }), 1);
    assert.throws(() => verifyFeedArtifacts(parameters, { checkApp: appChecker(other, architecture) }), /missing .* slice/);
    assert.throws(() => verifyFeedArtifacts(parameters, { checkApp: appChecker(architecture, other) }), /SUFeedURL/);
  }
});

test("DMG verifier mounts read-only, checks actual app contents against feed, and detaches on failure", () => {
  for (const architecture of ["arm64", "x86_64"]) for (const bad of ["none", "architecture", "feed"]) {
    const other = architecture === "arm64" ? "x86_64" : "arm64";
    const events = [];
    const options = {
      makeTemp: () => "virtual-mount", entries: () => ["ChemDraft.app", "Applications"],
      cleanup: () => events.push("cleanup"),
      run: (command, args) => {
        assert.equal(command, "/usr/bin/hdiutil");
        events.push(args[0]);
        if (args[0] === "attach") assert.deepEqual(args, ["attach", "-readonly", "-nobrowse", "-mountpoint", "virtual-mount", names[architecture]]);
        return { status: 0 };
      },
      checkApp: appChecker(bad === "architecture" ? other : architecture, bad === "feed" ? other : architecture)
    };
    const check = () => verifyFeedArtifacts({ xml: feed(architecture), target: architecture, dmgs: [names[architecture]] }, {
      checkDmg: (dmg, target) => verifyDmg(dmg, target, options)
    });
    if (bad === "none") assert.doesNotThrow(check);
    else assert.throws(check, bad === "feed" ? /SUFeedURL/ : /missing .* slice/);
    assert.deepEqual(events, ["attach", "detach", "cleanup"]);
    assert.throws(() => verifyDmg(names[other], architecture, { makeTemp: () => assert.fail("wrong filename must not mount") }), /filename does not match/);
    assert.throws(() => verifyFeedArtifacts({ xml: feed(architecture), target: architecture, dmgs: [names[other]] }), /not listed/);
  }
});

test("Intel workflow covers bundle inputs and requires the real sidecar plus all smokes", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/macos-intel-smoke.yml", import.meta.url), "utf8");
  for (const path of ["apps/desktop/**", "packages/**", "native/**", "scripts/**", "tools/release/**", "run-app"]) assert.ok(workflow.includes(`- ${path}\n`));
  assert.match(workflow, /assertMachOArchitecture\(readFileSync\(process.env.CHEMDRAFT_ENGINE3D_SIDECAR\), "x86_64"\)/);
  assert.doesNotMatch(workflow, /allow-sidecar-placeholder|outputs\.real|continue-on-error/);
  for (const smoke of ["real-structure", "hold-steady", "anneal-energy"]) assert.ok(workflow.includes(`pnpm smoke:engine3d-${smoke}`));
});
