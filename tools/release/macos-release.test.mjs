import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isMachO, machOSlices, packedVersion, versionString } from "./macos-mach-o.mjs";
import { fatMachO, thinMachO } from "./macos-test-fixtures.mjs";
import { feedForTarget, inventoryApp, verifyInventory } from "./verify-macos-app.mjs";

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
    records: ["Contents/MacOS/chemdraft", "Contents/MacOS/avogadro3d-sidecar", "Contents/Resources/resources/opsin/jre/bin/java", "Contents/Resources/resources/opsin/jre/lib/server/libjvm.dylib"].map((path) => ({ path, slices: machOSlices(thinMachO(architecture)) }))
  };
}

test("both thin app targets pass with their own feed and compatible universal Sparkle", () => {
  for (const architecture of ["x86_64", "arm64"]) {
    const bundle = validBundle(architecture);
    bundle.records.push({ path: "Contents/Frameworks/Sparkle.framework/Sparkle", slices: machOSlices(fatMachO([thinMachO(), thinMachO("arm64")])) });
    assert.equal(verifyInventory(bundle), 5);
  }
});

test("wrong feed, missing runtime, wrong JVM, wrong helpers and high minos fail closed", () => {
  const feed = validBundle(); feed.plist.SUFeedURL = feedForTarget("arm64");
  assert.throws(() => verifyInventory(feed), /SUFeedURL/);
  const missing = validBundle(); missing.records.pop();
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
  bundle.records.pop();
  assert.throws(() => verifyInventory({ ...bundle, allowSidecarPlaceholder: true }), /libjvm/);
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
    for (const record of bundle.records) write(record.path, thinMachO());
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
