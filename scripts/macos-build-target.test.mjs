import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { macosBuildArgs, macosBuildTarget } from "./macos-build-target.mjs";

test("macOS build preserves native defaults and routes explicit targets correctly", () => {
  const defaultArgs = ["build", "--bundles", "app"];
  assert.deepEqual(macosBuildArgs(defaultArgs, "intel.json", "arm64"), defaultArgs);
  assert.deepEqual(macosBuildArgs(defaultArgs, "intel.json", "x64"), ["build", "--config", "intel.json", "--bundles", "app"]);
  assert.deepEqual(defaultArgs, ["build", "--bundles", "app"]);
  for (const host of ["arm64", "x64"]) {
    assert.equal(macosBuildTarget(defaultArgs, host), host === "x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin");
    assert.deepEqual(macosBuildArgs(["dev"], "intel.json", host), ["dev"]);
    assert.deepEqual(macosBuildArgs(["build", "--", "--target=bad"], "intel.json", host), host === "x64"
      ? ["build", "--config", "intel.json", "--", "--target=bad"] : ["build", "--", "--target=bad"]);
  }
  const arm64Args = ["build", "--target", "aarch64-apple-darwin", "--bundles", "app"];
  assert.deepEqual(macosBuildArgs(arm64Args, "intel.json"), arm64Args);
  for (const flag of [["--target", "x86_64-apple-darwin"], ["--target=x86_64-apple-darwin"], ["-t", "x86_64-apple-darwin"]]) {
    const input = ["build", ...flag, "--config", '{"identifier":"org.chemdraft.desktop.dev"}'];
    assert.deepEqual(macosBuildArgs(input, "intel.json"), ["build", "--config", "intel.json", ...input.slice(1)]);
  }
  assert.deepEqual(macosBuildArgs(["build", "-t", "aarch64-apple-darwin"], "intel.json"), ["build", "-t", "aarch64-apple-darwin"]);
  assert.deepEqual(macosBuildArgs(["build", "--target=x86_64-apple-darwin", "--", "--release"], "intel.json"), ["build", "--config", "intel.json", "--target=x86_64-apple-darwin", "--", "--release"]);
  assert.deepEqual(macosBuildArgs(["dev"], "intel.json"), ["dev"]);
  assert.throws(() => macosBuildArgs(["build", "--target"], "intel.json"), /Unsupported/);
  assert.throws(() => macosBuildArgs(["build", "--target=universal-apple-darwin"], "intel.json"), /Unsupported/);
  assert.throws(() => macosBuildArgs(["build", "--target=x86_64-apple-darwin", "--target=bad"], "intel.json"), /only once/);
  assert.throws(() => macosBuildArgs(["build", "-t", "x86_64-apple-darwin", "--target=aarch64-apple-darwin"], "intel.json"), /only once/);
  assert.throws(() => macosBuildArgs(["build", "--target=x86_64-apple-darwin", "-t", "aarch64-apple-darwin"], "intel.json"), /only once/);
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
  for (const args of [["--target", "bad-target"], ["-t", "bad-target"], ["--dev", "--target", "x86_64-apple-darwin"], ["--dev", "-t", "x86_64-apple-darwin"], ["-t"], ["--target"], ["--target="], ["--target", "x86_64-apple-darwin", "--target", ""], ["--target", "x86_64-apple-darwin", "--target=aarch64-apple-darwin"]]) {
    const result = spawnSync("bash", [launcher, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /target/);
  }
});

test("run-app native and explicit targets preserve output paths, stage Intel OPSIN, preflight, then package with the correct plist", { skip: process.platform === "win32" }, () => {
  const source = readFileSync(new URL("../run-app", import.meta.url), "utf8");
  // Execute the real argument parser and runtime preparation block with a mocked Node process.
  // Skip launcher locks, installs, cargo, signing, builds and every other filesystem operation.
  const parser = source.slice(source.indexOf("RUN_MODE="), source.indexOf("\n# Which worktree/branch"));
  const preparation = source.slice(source.indexOf('if [ "$MACOS_BUILD_TARGET" = "x86_64-apple-darwin" ]; then\n  node'), source.indexOf("\n# The identifier must be overridden"));
  assert.ok(preparation.includes("build-opsin-runtime.mjs"));
  const packaging = source.slice(source.indexOf("tauri_build_args=(build)"), source.indexOf('\nset_bundle_display_name "$TAURI_OUTPUT_BUNDLE"')).replace("node_modules/.bin/tauri", "tauri");
  for (const native of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) for (const args of [["-t", "x86_64-apple-darwin"], ["--target", "x86_64-apple-darwin"], ["--target=x86_64-apple-darwin"], ["--target", "aarch64-apple-darwin"], []]) {
    const script = `set -eu\nROOT_DIR=/fixture\nAPP_DIR=/fixture/apps/desktop\nRUN_APP_BUNDLE_ID=org.chemdraft.desktop.dev
node() { if [[ "$1" = */macos-build-target.mjs ]]; then printf '%s\\n' "\${2:-${native}}"; else printf '%s\\n' "$@"; fi; }
tauri() { printf '%s\\n' "$@"; }
${parser}
printf '%s\\n' "$RELEASE_TARGET_DIR"
${preparation}
${packaging}`;
    const result = spawnSync("bash", ["-c", script, "run-app", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const target = args.length ? args.at(-1).replace("--target=", "") : native;
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines[0], `/fixture/apps/desktop/src-tauri/target${args.length ? `/${target}` : ""}/release`);
    const expected = [];
    if (target === "x86_64-apple-darwin") expected.push("/fixture/scripts/build-opsin-runtime.mjs", "--target", target);
    expected.push("/fixture/scripts/check-release-opsin-runtime.mjs", "--target", target, "build");
    if (args.length) expected.push("--target", target);
    if (target === "x86_64-apple-darwin") expected.push("--config", "/fixture/apps/desktop/src-tauri/tauri.intel.conf.json");
    expected.push("--bundles", "app", "--config", '{"identifier":"org.chemdraft.desktop.dev"}');
    assert.deepEqual(lines.slice(1), expected);
  }
  assert.ok(source.indexOf('if [ "$RUN_MODE" = "--dev" ]; then\n  select_dev_port') < source.indexOf('node "$ROOT_DIR/scripts/check-release-opsin-runtime.mjs"'));
});
