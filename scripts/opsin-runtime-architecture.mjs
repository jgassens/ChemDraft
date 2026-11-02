import { targetArchitecture } from "../tools/release/macos-mach-o.mjs";

export function opsinArchitecturePlan({ platform, hostArch, targetArch, javaHome }) {
  if (platform !== "darwin") {
    if (targetArch && targetArch !== hostArch) throw new Error("Cross-architecture OPSIN runtimes are supported only on macOS");
    return { cross: false, rosetta: false };
  }
  const host = targetArchitecture(hostArch);
  const target = targetArchitecture(targetArch ?? hostArch);
  const cross = target !== host;
  if (cross && !javaHome) throw new Error(`JAVA_HOME must point to a ${target} JDK when targeting a different architecture`);
  return { target, cross, rosetta: host === "arm64" && target === "x86_64" };
}

export function jdkInvocation(executable, args, plan) {
  return plan.rosetta ? ["/usr/bin/arch", ["-x86_64", executable, ...args]] : [executable, args];
}
