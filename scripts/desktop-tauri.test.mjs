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
      encoding: "utf8", env: { ...process.env, APPLE_SIGNING_IDENTITY: "", CHEMDRAFT_RELEASE_BUILD: "1", CHEMDRAFT_ALLOW_UNSIGNED_STABLE: "0" }
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /APPLE_SIGNING_IDENTITY is required.*CHEMDRAFT_RELEASE_BUILD=1/);
  });

  test(`${script} refuses the unsigned escape with a signing identity before running native tools`, {
    skip: process.platform === "win32" ? "macOS signing scripts require bash" : false
  }, () => {
    const result = spawnSync("bash", [fileURLToPath(new URL(`./${script}`, import.meta.url))], {
      encoding: "utf8", env: { ...process.env, APPLE_SIGNING_IDENTITY: "fixture identity", CHEMDRAFT_RELEASE_BUILD: "1", CHEMDRAFT_ALLOW_UNSIGNED_STABLE: "1" }
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /cannot be used together.*Pick one/);
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
          assert.equal(config.unsigned, false);
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

test("only the exact unsigned escape value 1 bypasses the stable DMG signing requirement", () => {
  for (const value of [undefined, "", "0", "true", "yes", "01", " 1", "1 "]) {
    const env = { CHEMDRAFT_ALLOW_UNSIGNED_STABLE: value };
    assert.throws(() => buildMacosDesktop(["build"], { env, stable: true, isPackageBuild: true }, {
      preflight: () => assert.fail("must fail before preparation"),
      warn: () => assert.fail("must not warn for unsigned mode")
    }), /APPLE_SIGNING_IDENTITY is required/);
    assert.equal(env.CHEMDRAFT_RELEASE_BUILD, "1");
  }
});

test("the unsigned escape and a signing identity fail before warnings, preparation or packaging", () => {
  assert.throws(() => buildMacosDesktop(["build"], {
    env: { CHEMDRAFT_ALLOW_UNSIGNED_STABLE: "1", APPLE_SIGNING_IDENTITY: "fixture identity" },
    stable: true, isPackageBuild: true
  }, {
    preflight: () => assert.fail("must not prepare"), warn: () => assert.fail("must not warn")
  }), /cannot be used together.*Pick one/);
});

for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
  for (const outcome of [0, 1, "throw", "preflight failure"]) {
    test(`unsigned ${target} build warns at both ends, labels, stamps and skips release signing (${outcome})`, () => {
      const args = ["build", "--target", target, "--bundles", "app,dmg"];
      const env = { CHEMDRAFT_ALLOW_UNSIGNED_STABLE: "1", CHEMDRAFT_RELEASE_BUILD: "1", CHEMDRAFT_WORKTREE_LABEL: "" };
      const calls = [];
      const options = {
        warn: (message) => { calls.push("warning"); assert.match(message, /WARNING:.*UNSIGNED.*\n.*local-only.*\n.*NEVER be published/); },
        preflight: () => { calls.push("preflight"); if (outcome === "preflight failure") throw new Error("fixture preflight failure"); },
        preparePlist: (actual, config) => {
          calls.push("plist");
          assert.deepEqual(actual, args);
          assert.equal(config.unsigned, true);
          assert.equal(config.stable, true);
          assert.equal(config.target, target);
          return { args: [...args, "--config", "unsigned-plist"], cleanup: () => calls.push("cleanup") };
        },
        run: (_command, actual, config) => {
          calls.push("run");
          assert.equal(actual.at(-1), "unsigned-plist");
          assert.equal(config.env.CHEMDRAFT_RELEASE_BUILD, "0");
          assert.equal(config.env.CHEMDRAFT_ALLOW_UNSIGNED_STABLE, "1");
          assert.equal(config.env.APPLE_SIGNING_IDENTITY, undefined);
          assert.equal(config.env.CHEMDRAFT_WORKTREE_LABEL, "ChemDraft (unsigned)");
          if (outcome === "throw") throw new Error("fixture runner failure");
          return { status: outcome };
        }
      };
      const build = () => buildMacosDesktop(args, { env, stable: true, isPackageBuild: true }, options);
      if (typeof outcome === "string") assert.throws(build, /fixture/);
      else assert.equal(build().status, outcome);
      assert.deepEqual(calls, outcome === "preflight failure"
        ? ["warning", "preflight", "warning"]
        : ["warning", "preflight", "plist", "run", "cleanup", "warning"]);
    });
  }
}

test("OPSIN skips signing with the explicit unsigned escape even when release mode was inherited", {
  skip: process.platform === "win32" ? "macOS signing script requires bash" : false
}, () => {
  const result = spawnSync("bash", [fileURLToPath(new URL("./sign-opsin-runtime.sh", import.meta.url))], {
    encoding: "utf8", env: { ...process.env, APPLE_SIGNING_IDENTITY: "", CHEMDRAFT_RELEASE_BUILD: "1", CHEMDRAFT_ALLOW_UNSIGNED_STABLE: "1" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /skipping OPSIN runtime signing/);
});

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
