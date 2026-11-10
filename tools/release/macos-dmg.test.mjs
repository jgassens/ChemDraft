import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withDmgApps } from "./macos-dmg.mjs";

test("read-only DMG mounts check every shipped app and detach even when a check fails", () => {
  for (const fail of [false, true]) {
    const events = [];
    const options = {
      makeTemp: () => "virtual-mount", entries: () => ["ChemDraft.app", "Extra.app", "Applications"],
      cleanup: (mount) => { assert.equal(mount, "virtual-mount"); events.push("cleanup"); },
      run: (command, args, config) => {
        assert.equal(command, "/usr/bin/hdiutil");
        assert.equal(config.encoding, "utf8");
        assert.deepEqual(args, args[0] === "attach"
          ? ["attach", "-readonly", "-nobrowse", "-mountpoint", "virtual-mount", "final.dmg"]
          : ["detach", "virtual-mount"]);
        events.push(args[0]);
        return { status: 0 };
      }
    };
    const check = () => withDmgApps("final.dmg", (app) => {
      events.push(app);
      if (fail) throw new Error("bad shipped app");
    }, options);
    if (fail) assert.throws(check, /bad shipped app/);
    else assert.doesNotThrow(check);
    assert.deepEqual(events, ["attach", join("virtual-mount", "ChemDraft.app"),
      ...(!fail ? [join("virtual-mount", "Extra.app")] : []), "detach", "cleanup"]);
  }
});

test("empty and unmountable DMGs fail closed; failed detach never recursively deletes the mount", () => {
  for (const fail of ["attach", "detach", "no-app"]) {
    const events = [];
    const check = () => withDmgApps("final.dmg", () => assert.fail("no app may pass"), {
      makeTemp: () => "virtual-mount", entries: () => [], cleanup: () => events.push("cleanup"),
      run: (command, args) => {
        assert.equal(command, "/usr/bin/hdiutil");
        events.push(args[0]);
        return { status: args[0] === fail ? 1 : 0, stderr: "native failure" };
      }
    });
    assert.throws(check, fail === "no-app" ? /no app bundle/ : new RegExp(`Cannot ${fail === "attach" ? "mount" : "detach"}`));
    assert.deepEqual(events, fail === "attach" ? ["attach", "cleanup"] : fail === "detach" ? ["attach", "detach"] : ["attach", "detach", "cleanup"]);
  }
});

test("release CLI refuses an omitted DMG before reading any build-folder app", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./verify-macos-app.mjs", import.meta.url)),
    "missing-build.app", "--target", "aarch64-apple-darwin", "--release"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --dmg <final.dmg> to check the shipped app/);
});
