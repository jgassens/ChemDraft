import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isMachO, machOSlices, packedVersion, versionString } from "./macos-mach-o.mjs";
import { fatMachO, thinMachO } from "./macos-test-fixtures.mjs";
import { feedForTarget, inventoryApp, verifyApp, verifyInventory, verifyReleaseTrust } from "./verify-macos-app.mjs";
import { requiredLicenseFiles } from "./required-license-files.mjs";

test("parses modern and legacy minimum commands and all fat table formats", () => {
  for (const command of [0x32, 0x24]) {
    const [slice] = machOSlices(thinMachO("x86_64", packedVersion("11.2.3"), command));
    assert.equal(versionString(slice.minimum), "11.2.3");
  }
  for (const little of [true, false]) for (const wide of [true, false]) {
    assert.deepEqual(machOSlices(fatMachO([thinMachO(), thinMachO("arm64")], { little, wide })).map((slice) => slice.architecture), ["x86_64", "arm64"]);
  }
});

test("rejects malformed, truncated, non-macOS and unknown native headers", () => {
  assert.equal(isMachO(Buffer.from("not native")), false);
  assert.throws(() => machOSlices(thinMachO().subarray(0, 40)), /Truncated/);
  const invalidSize = thinMachO(); invalidSize.writeUInt32LE(4, 36);
  assert.throws(() => machOSlices(invalidSize), /size/);
  const otherPlatform = thinMachO(); otherPlatform.writeUInt32LE(2, 40);
  assert.throws(() => machOSlices(otherPlatform), /not macOS/);
  const cpu = thinMachO(); cpu.writeUInt32LE(7, 4);
  assert.throws(() => machOSlices(cpu), /CPU/);
  const badFat = fatMachO([thinMachO()]); badFat.writeUInt32BE(0xffffffff, 16);
  assert.throws(() => machOSlices(badFat), /bounds/);
  const cpuMismatch = fatMachO([thinMachO()]); cpuMismatch.writeUInt32BE(0x0100000c, 8);
  assert.throws(() => machOSlices(cpuMismatch), /CPU table/);
  for (const version of ["11", "11..0", "11.256", "-1.0", "11.0.0.0"]) assert.throws(() => packedVersion(version), /Invalid/);
});

function validBundle(architecture = "x86_64") {
  const target = architecture === "x86_64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";
  return {
    target,
    plist: { LSMinimumSystemVersion: "11.0", SUFeedURL: feedForTarget(target), CFBundleExecutable: "chemdraft" },
    records: [
      ...["Contents/MacOS/chemdraft", "Contents/MacOS/avogadro3d-sidecar", "Contents/Resources/resources/opsin/jre/bin/java", "Contents/Resources/resources/opsin/jre/lib/server/libjvm.dylib"].map((path) => ({ path, slices: machOSlices(thinMachO(architecture)) })),
      ...requiredLicenseFiles.map(({ target }) => ({ path: `Contents/Resources/${target}` }))
    ]
  };
}

test("both thin app targets pass with their own feed and compatible universal Sparkle", () => {
  for (const architecture of ["x86_64", "arm64"]) {
    const bundle = validBundle(architecture);
    bundle.records.push({ path: "Contents/Frameworks/Sparkle.framework/Sparkle", slices: machOSlices(fatMachO([thinMachO(), thinMachO("arm64")])) });
    assert.equal(verifyInventory(bundle), 5);
  }
});

test("embedded release commit is a full SHA and matches the expected source", () => {
  const bundle = validBundle();
  const commit = "a".repeat(40);
  assert.throws(() => verifyInventory({ ...bundle, commit }), /ChemDraftSourceCommit.*missing/);
  bundle.plist.ChemDraftSourceCommit = "short";
  assert.throws(() => verifyInventory(bundle), /ChemDraftSourceCommit.*invalid/);
  bundle.plist.ChemDraftSourceCommit = commit;
  assert.equal(verifyInventory({ ...bundle, commit }), 4);
  assert.throws(() => verifyInventory({ ...bundle, commit: "b".repeat(40) }), /ChemDraftSourceCommit.*expected/);
});

function trustRunner(calls, { failure, signature = "Authority=Developer ID Application: ChemDraft (ABCDEFGHIJ)\nTeamIdentifier=ABCDEFGHIJ" } = {}) {
  return (command, args) => {
    calls.push({ command, args });
    if (failure?.(command, args)) return { status: 1, stderr: "rejected by fake native gate" };
    return { status: 0, stderr: command === "/usr/bin/codesign" && args[0] === "--display" ? signature : "" };
  };
}

test("production gate requires Developer ID, correct team, a DMG staple and both Gatekeeper assessments", () => {
  const calls = [];
  verifyReleaseTrust("ChemDraft.app", "ChemDraft.dmg", { teamId: "ABCDEFGHIJ", run: trustRunner(calls) });
  assert.deepEqual(calls, [
    { command: "/usr/bin/codesign", args: ["--verify", "--deep", "--strict", "ChemDraft.app"] },
    { command: "/usr/bin/codesign", args: ["--display", "--verbose=4", "ChemDraft.app"] },
    { command: "/usr/sbin/spctl", args: ["--assess", "--type", "execute", "ChemDraft.app"] },
    { command: "/usr/bin/xcrun", args: ["stapler", "validate", "ChemDraft.dmg"] },
    { command: "/usr/sbin/spctl", args: ["--assess", "--type", "open", "--context", "context:primary-signature", "ChemDraft.dmg"] }
  ]);
});

test("production rejects missing signatures, DMG staples, Gatekeeper failures and wrong team", () => {
  for (let failed = 0; failed < 5; failed++) {
    const calls = [];
    const run = trustRunner(calls, { failure: () => calls.length === failed + 1 });
    assert.throws(() => verifyReleaseTrust("ChemDraft.app", "ChemDraft.dmg", { teamId: "ABCDEFGHIJ", run }), /rejected by fake native gate/);
  }
  for (const signature of ["Signature=adhoc", "Authority=Apple Development: ChemDraft\nTeamIdentifier=ABCDEFGHIJ", "Authority=Developer ID Application: ChemDraft\nTeamIdentifier=WRONGTEAM1"]) {
    assert.throws(() => verifyReleaseTrust("ChemDraft.app", "ChemDraft.dmg", { teamId: "ABCDEFGHIJ", run: trustRunner([], { signature }) }), /Developer ID Application signature|team ID/);
  }
  assert.throws(() => verifyReleaseTrust("ChemDraft.app", "ChemDraft.dmg", { teamId: "" }), /--team-id or APPLE_TEAM_ID/);
  assert.throws(() => verifyReleaseTrust("ChemDraft.app", undefined, { teamId: "ABCDEFGHIJ" }), /--dmg/);
});

test("release app verification requires embedded commit and cannot exempt sidecars; unsigned smoke still works", () => {
  const bundle = validBundle();
  const calls = [];
  const trust = trustRunner(calls);
  const mounted = join("virtual-mount", "ChemDraft.app");
  const run = (command, args, options) => {
    assert.equal(options.encoding, "utf8");
    if (command === "/usr/bin/plutil") {
      assert.deepEqual(args, ["-convert", "json", "-o", "-", join(mounted, "Contents", "Info.plist")]);
      return { status: 0, stdout: JSON.stringify(bundle.plist) };
    }
    if (command === "/usr/bin/hdiutil") {
      calls.push({ command, args });
      assert.deepEqual(args, args[0] === "attach"
        ? ["attach", "-readonly", "-nobrowse", "-mountpoint", "virtual-mount", "ChemDraft.dmg"]
        : ["detach", "virtual-mount"]);
      return { status: 0 };
    }
    return trust(command, args);
  };
  const options = {
    run, release: true, dmg: "ChemDraft.dmg", teamId: "ABCDEFGHIJ", commit: "a".repeat(40),
    makeTemp: () => "virtual-mount", entries: () => ["ChemDraft.app", "Applications"], cleanup: () => {},
    inventory: (app) => { assert.equal(app, mounted); return bundle.records; }
  };
  assert.throws(() => verifyApp("build-folder.app", bundle.target, options), /ChemDraftSourceCommit.*missing/);
  assert.equal(calls.at(-1).args[0], "detach");
  assert.throws(() => verifyApp("build-folder.app", bundle.target, { ...options, dmg: undefined }), /requires --dmg/);
  assert.throws(() => verifyApp("build-folder.app", bundle.target, { ...options, allowSidecarPlaceholder: true }), /cannot allow/);
  assert.equal(verifyApp(mounted, bundle.target, { run, inventory: () => bundle.records }), 4);
  bundle.plist.ChemDraftSourceCommit = options.commit;
  calls.length = 0;
  assert.equal(verifyApp("build-folder.app", bundle.target, options), 4);
  assert.deepEqual(calls.map(({ args }) => args[0]), ["attach", "--verify", "--display", "--assess", "stapler", "--assess", "detach"]);
  for (const { command, args } of calls) {
    if (command === "/usr/bin/codesign" || (command === "/usr/sbin/spctl" && args.includes("execute"))) assert.equal(args.at(-1), mounted);
    if (command === "/usr/bin/xcrun") assert.deepEqual(args, ["stapler", "validate", "ChemDraft.dmg"]);
  }
  assert.equal(verifyApp(undefined, bundle.target, options), 4);
  assert.throws(() => verifyApp("build-folder.app", bundle.target, {
    ...options, run: (command, args, config) => command === "/usr/bin/codesign"
      ? { status: 1, stderr: "invalid shipped signature" } : run(command, args, config)
  }), /invalid shipped signature/);
  assert.equal(calls.at(-1).args[0], "detach");
  // A valid local build cannot hide a wrong payload architecture or commit.
  bundle.records[0].slices = machOSlices(thinMachO("arm64"));
  assert.throws(() => verifyApp("build-folder.app", bundle.target, options), /missing x86_64 slice/);
  assert.equal(calls.at(-1).args[0], "detach");
  bundle.plist.ChemDraftSourceCommit = "b".repeat(40);
  assert.throws(() => verifyApp("build-folder.app", bundle.target, options), /ChemDraftSourceCommit.*expected/);
});

test("wrong feed, missing runtime, wrong JVM, wrong helpers and high minos fail closed", () => {
  const feed = validBundle(); feed.plist.SUFeedURL = feedForTarget("arm64");
  assert.throws(() => verifyInventory(feed), /SUFeedURL/);
  const missing = validBundle(); missing.records.splice(3, 1);
  assert.throws(() => verifyInventory(missing), /libjvm.*missing/);
  const wrongJvm = validBundle(); wrongJvm.records[3].slices = machOSlices(thinMachO("arm64"));
  assert.throws(() => verifyInventory(wrongJvm), /libjvm.*missing x86_64/);
  const helper = validBundle(); helper.records.push({ path: "Contents/Resources/extra.dylib", slices: machOSlices(thinMachO("arm64")) });
  assert.throws(() => verifyInventory(helper), /extra.dylib.*missing x86_64/);
  const high = validBundle(); high.records.push({ path: "Contents/Frameworks/Sparkle", slices: machOSlices(fatMachO([thinMachO(), thinMachO("arm64", packedVersion("12.0"))])) });
  assert.throws(() => verifyInventory(high), /requires macOS 12.0.0/);
  const noMin = validBundle(); noMin.records[0].slices[0].minimum = undefined;
  assert.throws(() => verifyInventory(noMin), /no minimum/);
});

test("sidecar placeholder exemption is explicit and cannot exempt missing Java", () => {
  const bundle = validBundle(); bundle.records[1] = { path: bundle.records[1].path, placeholder: true };
  assert.throws(() => verifyInventory(bundle), /sidecar.*placeholder/);
  assert.equal(verifyInventory({ ...bundle, allowSidecarPlaceholder: true }), 3);
  bundle.records.splice(3, 1);
  assert.throws(() => verifyInventory({ ...bundle, allowSidecarPlaceholder: true }), /libjvm/);
});

test("Intel release gate checks the bundled Java launcher and every loose JRE library", () => {
  for (const path of [
    "Contents/Resources/resources/opsin/jre/bin/java",
    "Contents/Resources/resources/opsin/jre/lib/server/libjvm.dylib",
    "Contents/Resources/resources/opsin/jre/lib/libjava.dylib"
  ]) {
    for (const native of [thinMachO("arm64"), fatMachO([thinMachO(), thinMachO("arm64")])]) {
      const bundle = validBundle();
      bundle.records = bundle.records.filter((record) => record.path !== path);
      bundle.records.push({ path, slices: machOSlices(native) });
      assert.throws(() => verifyInventory(bundle), /opsin\/jre\/.*(missing x86_64|expected a thin x86_64)/);
    }
  }
});

test("bundle traversal finds extensionless helpers and handles framework aliases without loops", { skip: process.platform === "win32" }, () => {
  const temp = mkdtempSync(join(tmpdir(), "chemdraft-macos-check-"));
  try {
    const app = join(temp, "ChemDraft.app");
    const bundle = validBundle();
    const write = (path, buffer) => {
      const file = join(app, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, buffer);
    };
    for (const record of bundle.records) write(record.path, record.slices ? thinMachO() : "fixture licence");
    write("Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate", fatMachO([thinMachO(), thinMachO("arm64")]));
    const framework = join(app, "Contents/Frameworks/Sparkle.framework");
    symlinkSync("B", join(framework, "Versions/Current"));
    symlinkSync("Versions/Current/Autoupdate", join(framework, "Autoupdate"));
    symlinkSync(".", join(framework, "Versions/B/loop"));
    assert.doesNotThrow(() => verifyInventory({ ...bundle, records: inventoryApp(app) }));
    write("Contents/Resources/hidden-helper", thinMachO("arm64"));
    assert.throws(() => verifyInventory({ ...bundle, records: inventoryApp(app) }), /hidden-helper.*missing x86_64/);
    symlinkSync(temp, join(app, "Contents/outside"));
    assert.throws(() => inventoryApp(app), /symlink escapes/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("both macOS final app gates require every licence in Contents/Resources/licenses", () => {
  const temp = mkdtempSync(join(tmpdir(), "chemdraft-macos-licenses-"));
  try {
    for (const architecture of ["x86_64", "arm64"]) {
      const app = join(temp, architecture, "ChemDraft.app");
      const bundle = validBundle(architecture);
      for (const record of bundle.records) {
        const file = join(app, record.path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, record.slices ? thinMachO(architecture) : "fixture licence");
      }
      const check = () => verifyApp(app, bundle.target, {
        run: () => ({ status: 0, stdout: JSON.stringify(bundle.plist) })
      });
      assert.equal(check(), 4);
      for (const { target } of requiredLicenseFiles) {
        const file = join(app, "Contents", "Resources", target);
        rmSync(file);
        // A licence elsewhere in the app does not satisfy the stable path contract.
        const misplaced = join(app, "Contents", "Resources", "resources", target);
        mkdirSync(dirname(misplaced), { recursive: true });
        writeFileSync(misplaced, "misplaced fixture licence");
        assert.throws(check, (error) => error.message.includes(`Contents/Resources/${target}: required bundled licence file is missing`));
        mkdirSync(file);
        assert.throws(check, /required bundled licence file is missing/);
        rmSync(file, { recursive: true });
        writeFileSync(file, "fixture licence");
      }
      assert.equal(check(), 4);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
