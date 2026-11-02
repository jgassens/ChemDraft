import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { macosBuildArgs } from "./macos-build-target.mjs";

test("macOS build preserves native defaults and routes explicit targets correctly", () => {
  const defaultArgs = ["build", "--bundles", "app"];
  assert.deepEqual(macosBuildArgs(defaultArgs, "intel.json"), defaultArgs);
  const arm64Args = ["build", "--target", "aarch64-apple-darwin", "--bundles", "app"];
  assert.deepEqual(macosBuildArgs(arm64Args, "intel.json"), arm64Args);
  for (const flag of [["--target", "x86_64-apple-darwin"], ["--target=x86_64-apple-darwin"]]) {
    const input = ["build", ...flag, "--config", '{"identifier":"org.chemdraft.desktop.dev"}'];
    assert.deepEqual(macosBuildArgs(input, "intel.json"), ["build", "--config", "intel.json", ...input.slice(1)]);
  }
  assert.deepEqual(macosBuildArgs(["build", "--target=x86_64-apple-darwin", "--", "--release"], "intel.json"), ["build", "--config", "intel.json", "--target=x86_64-apple-darwin", "--", "--release"]);
  assert.deepEqual(macosBuildArgs(["dev"], "intel.json"), ["dev"]);
  assert.throws(() => macosBuildArgs(["build", "--target"], "intel.json"), /Unsupported/);
  assert.throws(() => macosBuildArgs(["build", "--target=universal-apple-darwin"], "intel.json"), /Unsupported/);
  assert.throws(() => macosBuildArgs(["build", "--target=x86_64-apple-darwin", "--target=bad"], "intel.json"), /only once/);
});

test("Intel plist preserves the base Sparkle settings and only changes the feed", () => {
  const base = readFileSync(new URL("../apps/desktop/src-tauri/Info.plist", import.meta.url), "utf8");
  const intel = readFileSync(new URL("../apps/desktop/src-tauri/Info.intel.plist", import.meta.url), "utf8");
  assert.equal(intel.replace("appcast-intel.xml", "appcast.xml"), base);
  const overlay = JSON.parse(readFileSync(new URL("../apps/desktop/src-tauri/tauri.intel.conf.json", import.meta.url), "utf8"));
  assert.equal(overlay.bundle.macOS.infoPlist, "./Info.intel.plist");
});

test("run-app rejects invalid targets and cross-target dev before any build or installation", { skip: process.platform === "win32" }, () => {
  const launcher = fileURLToPath(new URL("../run-app", import.meta.url));
  for (const args of [["--target", "bad-target"], ["--dev", "--target", "x86_64-apple-darwin"], ["--target"]]) {
    const result = spawnSync("bash", [launcher, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /target/);
  }
});
