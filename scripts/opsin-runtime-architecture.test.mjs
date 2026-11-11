import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { assertMachOArchitecture } from "../tools/release/macos-mach-o.mjs";
import { fatMachO, thinMachO } from "../tools/release/macos-test-fixtures.mjs";
import { assertRosettaAvailable, jdkInvocation, opsinArchitecturePlan } from "./opsin-runtime-architecture.mjs";
import { acquireIntelMacJdk, INTEL_MAC_JDK } from "./opsin-jdk.mjs";
import { buildOpsinRuntime } from "./build-opsin-runtime.mjs";

test("arm64 default keeps direct JDK execution; Windows and Linux retain native execution", () => {
  for (const [platform, hostArch] of [["darwin", "arm64"], ["win32", "x64"], ["linux", "x64"]]) {
    const plan = opsinArchitecturePlan({ platform, hostArch });
    assert.equal(plan.cross, false);
    assert.deepEqual(jdkInvocation("jdk/bin/jlink", ["--output", "jre"], plan), ["jdk/bin/jlink", ["--output", "jre"]]);
  }
});

test("Intel target selects a pinned JDK unless JAVA_HOME is explicit, and uses Rosetta only on arm64", () => {
  const options = { platform: "darwin", hostArch: "arm64", targetArch: "x86_64" };
  for (const hostArch of ["arm64", "x64"]) for (const targetArch of ["x86_64", "x86_64-apple-darwin"]) {
    assert.equal(opsinArchitecturePlan({ ...options, hostArch, targetArch }).downloadJdk, true);
  }
  const plan = opsinArchitecturePlan({ ...options, javaHome: "/Intel JDK/Contents/Home" });
  assert.equal(plan.downloadJdk, false);
  for (const executable of ["/Intel JDK/bin/jlink", "/runtime/bin/java"]) {
    assert.deepEqual(jdkInvocation(executable, ["argument with spaces"], plan), ["/usr/bin/arch", ["-x86_64", executable, "argument with spaces"]]);
  }
  assert.equal(opsinArchitecturePlan({ platform: "darwin", hostArch: "x64", targetArch: "x86_64" }).rosetta, false);
  assert.throws(() => opsinArchitecturePlan({ platform: "darwin", hostArch: "x64", targetArch: "arm64" }), /JAVA_HOME/);
  assert.throws(() => opsinArchitecturePlan({ platform: "win32", hostArch: "x64", targetArch: "arm64" }), /only on macOS/);
});

test("Rosetta absence names the install command; native builds do not probe it", () => {
  const run = (command, args) => {
    assert.equal(command, "/usr/bin/arch");
    assert.deepEqual(args, ["-x86_64", "/usr/bin/true"]);
    return { status: 1, stderr: "Bad CPU type in executable" };
  };
  assert.throws(() => assertRosettaAvailable({ rosetta: true }, run), /Rosetta 2.*softwareupdate --install-rosetta --agree-to-license/);
  assertRosettaAvailable({ rosetta: false }, () => assert.fail("native execution must not probe Rosetta"));
});

const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("Temurin pin matches Adoptium's published checksum-file digest", () => {
  assert.equal(INTEL_MAC_JDK.version, "25.0.5+8");
  assert.equal(INTEL_MAC_JDK.url, "https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jdk_x64_mac_hotspot_25.0.5_8.tar.gz");
  assert.equal(INTEL_MAC_JDK.checksumUrl, `${INTEL_MAC_JDK.url}.sha256.txt`);
  // GitHub publishes this digest for the .sha256.txt asset itself, independently of the tarball.
  assert.equal(checksum(`${INTEL_MAC_JDK.sha256}  ${INTEL_MAC_JDK.archive}\n`), "238959cdf4bc17f788a3c69bb353012a88a83b794d75a7e14fc89522e8cace36");
});

// All cache reads/writes, HTTP responses and extraction are in memory. No test downloads Java.
function downloadHarness({ cached, downloaded = Buffer.from("fixture JDK archive"), httpStatus = 200, extractStatus = 0 } = {}) {
  const cacheDir = join("virtual cache", "ChemDraft", "opsin-jdk");
  const pin = { ...INTEL_MAC_JDK, sha256: checksum(Buffer.from("fixture JDK archive")) };
  const archivePath = join(cacheDir, pin.archive);
  const temp = join(cacheDir, ".extract-test");
  const files = new Map(cached === undefined ? [] : [[archivePath, cached]]);
  const events = [];
  const options = {
    cacheDir, pin, log: () => {},
    fs: {
      mkdir: async () => {}, mkdtemp: async () => temp,
      readFile: async (path) => {
        if (files.has(path)) return files.get(path);
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      writeFile: async (path, bytes) => { events.push("write"); files.set(path, bytes); },
      rename: async (from, to) => { events.push("cache"); files.set(to, files.get(from)); files.delete(from); },
      rm: async (path) => { assert.equal(path, temp); events.push("cleanup"); }
    },
    fetchImpl: async (url) => {
      events.push("download");
      assert.equal(url, pin.url);
      return { ok: httpStatus === 200, status: httpStatus, arrayBuffer: async () => downloaded };
    },
    run: (command, args) => {
      events.push("extract");
      assert.equal(command, "/usr/bin/tar");
      assert.deepEqual(args, ["-xzf", archivePath, "-C", temp]);
      assert.equal(checksum(files.get(archivePath)), pin.sha256, "extract only verified bytes");
      return { status: extractStatus, stderr: "fixture extraction error" };
    }
  };
  return { options, events, files, archivePath, temp };
}

test("verified download is cached before extraction and a verified cache hit needs no network", async () => {
  const fresh = downloadHarness();
  const jdk = await acquireIntelMacJdk(fresh.options);
  assert.equal(jdk.javaHome, join(fresh.temp, "jdk-25.0.5+8", "Contents", "Home"));
  assert.deepEqual(fresh.events, ["download", "write", "cache", "extract"]);
  await jdk.cleanup();
  assert.equal(fresh.events.at(-1), "cleanup");
  const cached = downloadHarness({ cached: fresh.files.get(fresh.archivePath) });
  await (await acquireIntelMacJdk(cached.options)).cleanup();
  assert.deepEqual(cached.events, ["extract", "cleanup"]);
});

test("downloaded and cached checksum mismatches fail before extraction or cache publication", async () => {
  for (const source of ["downloaded", "cached"]) {
    const harness = downloadHarness({ [source]: Buffer.from("tampered JDK") });
    await assert.rejects(acquireIntelMacJdk(harness.options), /SHA-256 mismatch.*refusing extraction/);
    assert.deepEqual(harness.events, source === "downloaded" ? ["download", "cleanup"] : ["cleanup"]);
  }
});

test("HTTP and extraction failures clean up without returning a JDK", async () => {
  for (const [options, message] of [[{ httpStatus: 404 }, /HTTP 404/], [{ extractStatus: 1 }, /extraction failed/]]) {
    const harness = downloadHarness(options);
    await assert.rejects(acquireIntelMacJdk(harness.options), message);
    assert.equal(harness.events.at(-1), "cleanup");
  }
});

function buildHarness({ stagedArch = "x86_64", jdkArch = "x86_64", wrongFile, rosettaStatus = 0 } = {}) {
  const rootDir = join("virtual", "repo");
  const javaHome = join("virtual", "Intel JDK", "Contents", "Home");
  const dest = join(rootDir, "apps", "desktop", "src-tauri", "resources", "opsin", "jre");
  const events = [];
  const calls = [];
  const dependencies = {
    log: () => {},
    acquireJdk: async () => {
      events.push("acquire");
      return { javaHome, cleanup: async () => { events.push("cleanup"); } };
    },
    fs: {
      existsSync: () => true, realpathSync: (path) => path,
      readFileSync: (path) => {
        if (path.startsWith(dest)) {
          assert.ok(events.includes("jlink"));
          events.push("check staged");
          return thinMachO(!wrongFile || path.endsWith(wrongFile) ? stagedArch : "x86_64");
        }
        events.push("check JDK");
        return thinMachO(jdkArch);
      },
      rmSync: () => { events.push("remove staged"); },
      chmodSync: () => {}, readdirSync: () => [],
      statSync: () => ({ mode: 0o444, size: 64, isDirectory: () => false })
    },
    run: (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes("/usr/bin/true")) { events.push("Rosetta"); return { status: rosettaStatus }; }
      if (command === "which" || command === "where") return { status: 0, stdout: join(javaHome, "bin", "jlink") };
      if (args.includes("--output")) { events.push("jlink"); return { status: 0 }; }
      if (args.includes("-jar")) { events.push("smoke"); return { status: 0, stdout: "C1=CC=CC=C1\n" }; }
      assert.fail(`unexpected process: ${command}`);
    }
  };
  return { options: { platform: "darwin", hostArch: "arm64", targetArch: "x86_64-apple-darwin", rootDir, env: {} }, dependencies, events, calls, javaHome };
}

test("Intel build acquires the JDK, links, checks output, and smokes under Rosetta", async () => {
  const harness = buildHarness();
  await buildOpsinRuntime(harness.options, harness.dependencies);
  assert.deepEqual(harness.events, ["Rosetta", "acquire", "check JDK", "check JDK", "remove staged", "jlink", "check staged", "check staged", "smoke", "cleanup"]);
  for (const call of harness.calls) {
    assert.equal(call.command, "/usr/bin/arch");
    assert.equal(call.args[0], "-x86_64");
  }
});

test("Intel native, explicit JAVA_HOME, arm64 and Windows builds retain the correct JDK path", async () => {
  for (const scenario of [
    { hostArch: "x64" },
    { override: true },
    { platform: "darwin", targetArch: "arm64", override: true },
    { platform: "win32", hostArch: "x64", targetArch: undefined, override: true },
    { platform: "linux", hostArch: "x64", targetArch: undefined, override: true }
  ]) {
    const harness = buildHarness({ jdkArch: scenario.targetArch === "arm64" ? "arm64" : "x86_64", stagedArch: scenario.targetArch === "arm64" ? "arm64" : "x86_64" });
    const { override, ...options } = scenario;
    await buildOpsinRuntime({ ...harness.options, ...options, ...(override ? { env: { JAVA_HOME: harness.javaHome } } : {}) }, harness.dependencies);
    assert.equal(harness.events.includes("acquire"), !override);
    assert.ok(harness.events.includes("smoke"));
    if (scenario.platform && scenario.targetArch !== "x86_64") assert.equal(harness.events.includes("Rosetta"), false);
  }
});

test("wrong JDK fails before replacing the previous runtime; missing Rosetta fails before download", async () => {
  const wrongJdk = buildHarness({ jdkArch: "arm64" });
  await assert.rejects(buildOpsinRuntime({ ...wrongJdk.options, env: { JAVA_HOME: wrongJdk.javaHome } }, wrongJdk.dependencies), /expected x86_64 only/);
  assert.equal(wrongJdk.events.includes("acquire"), false);
  assert.equal(wrongJdk.events.includes("remove staged"), false);
  const missingRosetta = buildHarness({ rosettaStatus: 1 });
  await assert.rejects(buildOpsinRuntime(missingRosetta.options, missingRosetta.dependencies), /Rosetta 2.*softwareupdate/);
  assert.deepEqual(missingRosetta.events, ["Rosetta"]);
});

test("OPSIN_TARGET_ARCH selects Intel while an explicit target takes precedence", async () => {
  const intel = buildHarness();
  await buildOpsinRuntime({ ...intel.options, targetArch: undefined, env: { OPSIN_TARGET_ARCH: "x86_64" } }, intel.dependencies);
  assert.ok(intel.events.includes("acquire"));
  const arm = buildHarness({ jdkArch: "arm64", stagedArch: "arm64" });
  await buildOpsinRuntime({ ...arm.options, targetArch: "arm64", env: { OPSIN_TARGET_ARCH: "x86_64", JAVA_HOME: arm.javaHome } }, arm.dependencies);
  assert.equal(arm.events.includes("acquire"), false);
  assert.equal(arm.events.includes("Rosetta"), false);
});

test("a wrong-architecture JRE produced by jlink fails before smoke or success", async () => {
  for (const wrongFile of [join("bin", "java"), join("lib", "server", "libjvm.dylib")]) {
    const harness = buildHarness({ stagedArch: "arm64", wrongFile });
    await assert.rejects(buildOpsinRuntime(harness.options, harness.dependencies), /expected x86_64 only/);
    assert.ok(harness.events.includes("jlink"));
    assert.equal(harness.events.includes("smoke"), false);
    assert.equal(harness.events.at(-1), "cleanup");
  }
});

test("each staged JVM and launcher must match; wrong architecture, fat JRE and placeholders fail", () => {
  for (const name of ["lib/server/libjvm.dylib", "bin/java"]) {
    assert.doesNotThrow(() => assertMachOArchitecture(thinMachO(), "x86_64", name));
    assert.throws(() => assertMachOArchitecture(thinMachO("arm64"), "x86_64", name), /expected x86_64 only/);
    assert.throws(() => assertMachOArchitecture(thinMachO(), "arm64", name), /expected arm64 only/);
    assert.throws(() => assertMachOArchitecture(fatMachO([thinMachO(), thinMachO("arm64")]), "x86_64", name), /expected x86_64 only/);
    assert.throws(() => assertMachOArchitecture(Buffer.from("#!/bin/sh"), "x86_64", name), /Expected Mach-O/);
  }
});
