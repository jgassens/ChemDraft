import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildMacosDesktop } from "./desktop-tauri.mjs";

for (const script of ["sign-opsin-runtime.sh", "prepare-sparkle.sh"]) {
  test(`${script} refuses production without an identity before running native tools`, {
    skip: process.platform === "win32" ? "macOS signing scripts require bash; Windows does not run them" : false
  }, () => {
    const result = spawnSync("bash", [fileURLToPath(new URL(`./${script}`, import.meta.url))], {
      encoding: "utf8", env: { ...process.env, APPLE_SIGNING_IDENTITY: "", CHEMDRAFT_RELEASE_BUILD: "1" }
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /APPLE_SIGNING_IDENTITY is required.*CHEMDRAFT_RELEASE_BUILD=1/);
  });
}

test("dev OPSIN builds still skip signing without an identity", {
  skip: process.platform === "win32" ? "macOS signing script requires bash" : false
}, () => {
  const result = spawnSync("bash", [fileURLToPath(new URL("./sign-opsin-runtime.sh", import.meta.url))], {
    encoding: "utf8", env: { ...process.env, APPLE_SIGNING_IDENTITY: "", CHEMDRAFT_RELEASE_BUILD: "0" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /skipping OPSIN runtime signing/);
});

test("desktop wrapper passes the build environment through to signing scripts", () => {
  const source = readFileSync(new URL("./desktop-tauri.mjs", import.meta.url), "utf8");
  assert.match(source, /const env = \{ \.\.\.process\.env \}/);
  assert.match(source, /pnpm prepare:sparkle && pnpm sign:opsin-runtime/);
  assert.match(source, /cwd: APP_DIR,\s+env,/);
});

for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
  test(`stable ${target} DMG packaging enables release mode and requires the signing identity before preparation`, () => {
    for (const bundles of [[], ["--bundles", "app,dmg"], ["--bundles=dmg"], ["-b", "dmg"], ["--bundles", "all"]]) {
      const args = ["build", "--target", target, ...bundles];
      const called = [];
      const env = { CHEMDRAFT_RELEASE_BUILD: "0", APPLE_SIGNING_IDENTITY: "" };
      const options = {
        preflight: (actual) => { assert.deepEqual(actual, args); called.push("preflight"); },
        preparePlist: (actual, config) => {
          assert.deepEqual(actual, args);
          assert.equal(config.stable, true);
          assert.equal(config.target, target);
          called.push("plist");
          return { args: [...args, "--config", "fixture-plist"], cleanup: () => called.push("cleanup") };
        },
        run: (command, actual, config) => {
          assert.equal(command, "bash");
          assert.deepEqual(actual, ["-c", 'pnpm prepare:sparkle && pnpm sign:opsin-runtime && PATH="$HOME/.cargo/bin:$PATH" tauri "$@"', "tauri", ...args, "--config", "fixture-plist"]);
          assert.equal(config.env.CHEMDRAFT_RELEASE_BUILD, "1");
          assert.equal(config.env.APPLE_SIGNING_IDENTITY, "Developer ID Application: ChemDraft");
          assert.equal(config.stdio, "inherit");
          assert.ok(config.cwd.endsWith("desktop"));
          called.push("run");
          return { status: 0 };
        }
      };
      assert.throws(() => buildMacosDesktop(args, { env, stable: true, isPackageBuild: true }, options), /APPLE_SIGNING_IDENTITY is required/);
      assert.deepEqual(called, []);
      env.APPLE_SIGNING_IDENTITY = "Developer ID Application: ChemDraft";
      assert.equal(buildMacosDesktop(args, { env, stable: true, isPackageBuild: true }, options).status, 0);
      assert.deepEqual(called, ["preflight", "plist", "run", "cleanup"]);
    }
  });
}

test("dev, branch, debug and app-only smoke builds keep their existing release environment", () => {
  for (const [args, stable] of [
    [["dev"], true], [["build", "--debug"], true], [["build", "--no-bundle"], true],
    [["build", "--bundles", "app"], true], [["build", "-b", "app"], true], [["build"], false]
  ]) {
    const env = { CHEMDRAFT_RELEASE_BUILD: "0", APPLE_SIGNING_IDENTITY: "" };
    const result = buildMacosDesktop(args, { env, stable, isPackageBuild: false }, {
      preflight: () => {}, preparePlist: () => undefined,
      run: (command, actual, config) => {
        assert.equal(command, "bash");
        assert.deepEqual(actual, ["-c", 'PATH="$HOME/.cargo/bin:$PATH" tauri "$@"', "tauri", ...args]);
        assert.equal(config.env.CHEMDRAFT_RELEASE_BUILD, "0");
        return { status: 0 };
      }
    });
    assert.equal(result.status, 0);
  }
});
