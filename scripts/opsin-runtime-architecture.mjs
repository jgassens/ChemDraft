import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertMachOArchitecture, targetArchitecture } from "../tools/release/macos-mach-o.mjs";

export function opsinArchitecturePlan({ platform, hostArch, targetArch, javaHome }) {
  if (platform !== "darwin") {
    if (targetArch && targetArch !== hostArch) throw new Error("Cross-architecture OPSIN runtimes are supported only on macOS");
    return { cross: false, rosetta: false };
  }
  const host = targetArchitecture(hostArch);
  const target = targetArchitecture(targetArch ?? hostArch);
  const cross = target !== host;
  const downloadJdk = target === "x86_64" && !javaHome;
  if (cross && !javaHome && !downloadJdk) throw new Error(`JAVA_HOME must point to a ${target} JDK when targeting a different architecture`);
  return { target, cross, downloadJdk, rosetta: host === "arm64" && target === "x86_64" };
}

export function jdkInvocation(executable, args, plan) {
  return plan.rosetta ? ["/usr/bin/arch", ["-x86_64", executable, ...args]] : [executable, args];
}

export function assertRosettaAvailable(plan, run = spawnSync) {
  if (!plan.rosetta) return;
  const probe = run("/usr/bin/arch", ["-x86_64", "/usr/bin/true"], { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error("Intel OPSIN builds require Rosetta 2 on Apple silicon. Install it with /usr/sbin/softwareupdate --install-rosetta --agree-to-license, then retry.");
  }
}

export function checkOpsinRuntimeArchitecture(root, target, read = readFileSync) {
  for (const relative of [join("bin", "java"), join("lib", "server", "libjvm.dylib")]) {
    const path = join(root, relative);
    assertMachOArchitecture(read(path), target, path);
  }
}
