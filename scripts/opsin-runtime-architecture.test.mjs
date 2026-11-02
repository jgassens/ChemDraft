import assert from "node:assert/strict";
import { test } from "node:test";
import { assertMachOArchitecture } from "../tools/release/macos-mach-o.mjs";
import { fatMachO, thinMachO } from "../tools/release/macos-test-fixtures.mjs";
import { jdkInvocation, opsinArchitecturePlan } from "./opsin-runtime-architecture.mjs";

test("arm64 default keeps direct JDK execution; Windows and Linux retain native execution", () => {
  for (const [platform, hostArch] of [["darwin", "arm64"], ["win32", "x64"], ["linux", "x64"]]) {
    const plan = opsinArchitecturePlan({ platform, hostArch });
    assert.equal(plan.cross, false);
    assert.deepEqual(jdkInvocation("jdk/bin/jlink", ["--output", "jre"], plan), ["jdk/bin/jlink", ["--output", "jre"]]);
  }
});

test("cross-target macOS requires JAVA_HOME and uses Rosetta for both JDK and runtime", () => {
  const options = { platform: "darwin", hostArch: "arm64", targetArch: "x86_64" };
  assert.throws(() => opsinArchitecturePlan(options), /JAVA_HOME/);
  const plan = opsinArchitecturePlan({ ...options, javaHome: "/Intel JDK/Contents/Home" });
  for (const executable of ["/Intel JDK/bin/jlink", "/runtime/bin/java"]) {
    assert.deepEqual(jdkInvocation(executable, ["argument with spaces"], plan), ["/usr/bin/arch", ["-x86_64", executable, "argument with spaces"]]);
  }
  assert.equal(opsinArchitecturePlan({ platform: "darwin", hostArch: "x64", targetArch: "x86_64" }).rosetta, false);
  assert.throws(() => opsinArchitecturePlan({ platform: "win32", hostArch: "x64", targetArch: "arm64" }), /only on macOS/);
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
