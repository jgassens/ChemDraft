import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isMacosReleasePackaging, preflightReleaseOpsinRuntime } from "./check-release-opsin-runtime.mjs";
import { fatMachO, thinMachO } from "../tools/release/macos-test-fixtures.mjs";

test("both host-native and cross-target release bundles require a matching staged Java launcher and JVM", () => {
  for (const hostArch of ["arm64", "x64"]) for (const target of [undefined, "aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const architecture = target ? target.startsWith("x86_64") ? "x86_64" : "arm64" : hostArch === "x64" ? "x86_64" : "arm64";
    const args = ["build", "--bundles", "app,dmg", ...(target ? ["--target", target] : [])];
    const reads = [];
    const options = { platform: "darwin", hostArch, rootDir: "fixture", read: (path) => { reads.push(path); return thinMachO(architecture); } };
    preflightReleaseOpsinRuntime(args, options);
    const runtime = join("fixture", "apps", "desktop", "src-tauri", "resources", "opsin", "jre");
    assert.deepEqual(reads, [join(runtime, "bin", "java"), join(runtime, "lib", "server", "libjvm.dylib")]);
    for (const missing of reads) {
      assert.throws(() => preflightReleaseOpsinRuntime(args, { ...options, read: (path) => {
        if (path === missing) throw new Error(`ENOENT ${path}`);
        return thinMachO(architecture);
      } }), /Cannot package.*staged OPSIN JRE.*ENOENT.*build-opsin-runtime/);
      for (const wrong of [thinMachO(architecture === "arm64" ? "x86_64" : "arm64"), fatMachO([thinMachO(), thinMachO("arm64")]), Buffer.from("placeholder")]) {
        assert.throws(() => preflightReleaseOpsinRuntime(args, { ...options, read: (path) => path === missing ? wrong : thinMachO(architecture) }), /Cannot package.*staged OPSIN JRE/);
      }
    }
  }
});

test("optional-runtime builds stay optional and preflight never reads their staging tree", () => {
  for (const platform of ["darwin", "win32", "linux"]) for (const args of [["dev"], ["build", "--debug"], ["build", "--no-bundle"], ["build", "--bundles", "nsis"], ["build", "--bundles=none"]]) {
    preflightReleaseOpsinRuntime(args, { platform, read: () => assert.fail("optional runtime must not be inspected") });
  }
  for (const platform of ["win32", "linux"]) {
    preflightReleaseOpsinRuntime(["build"], { platform, read: () => assert.fail("non-macOS behavior must not change") });
  }
  for (const args of [["build"], ["build", "-b", "app"], ["build", "--bundles=dmg"], ["build", "--bundles", "all"], ["build", "--", "--debug"]]) {
    assert.equal(isMacosReleasePackaging(args, "darwin"), true);
  }
});

test("desktop wrapper preflights before macOS signing and packaging", () => {
  const source = readFileSync(new URL("./desktop-tauri.mjs", import.meta.url), "utf8");
  assert.ok(source.indexOf("preflightReleaseOpsinRuntime(args);") < source.indexOf('const prep = isPackageBuild'));
});
