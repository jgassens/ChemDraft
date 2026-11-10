import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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

test("desktop wrapper passes the explicit release environment through to signing scripts", () => {
  const source = readFileSync(new URL("./desktop-tauri.mjs", import.meta.url), "utf8");
  assert.match(source, /const env = \{ \.\.\.process\.env \}/);
  assert.match(source, /pnpm prepare:sparkle && pnpm sign:opsin-runtime/);
  assert.match(source, /cwd: APP_DIR,\s+env,/);
});
