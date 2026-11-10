import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { targetArchitecture } from "../tools/release/macos-mach-o.mjs";

export const DEFAULT_MACOS_TARGET = "aarch64-apple-darwin";
export const INTEL_MACOS_TARGET = "x86_64-apple-darwin";

export function macosBuildTarget(input, hostArch = process.arch) {
  const end = input.indexOf("--");
  const options = end === -1 ? input : input.slice(0, end);
  const targets = options.flatMap((arg, index) => arg === "--target" || arg === "-t" ? [options[index + 1]] : arg.startsWith("--target=") ? [arg.slice(9)] : arg.startsWith("-t") && arg.length > 2 ? [arg.slice(2)] : []);
  if (targets.length > 1) throw new Error("Specify --target only once");
  const target = targets.length ? targets[0] : targetArchitecture(hostArch) === "x86_64" ? INTEL_MACOS_TARGET : DEFAULT_MACOS_TARGET;
  if (![DEFAULT_MACOS_TARGET, INTEL_MACOS_TARGET].includes(target)) throw new Error(`Unsupported macOS target: ${target}`);
  return target;
}

export function macosBuildArgs(input, intelConfig, hostArch = process.arch) {
  const args = [...input];
  if (args[0] !== "build") return args;
  const target = macosBuildTarget(args, hostArch);
  // Prepend the architecture overlay so explicit caller config (e.g. run-app's dev id) still wins.
  if (target === INTEL_MACOS_TARGET) args.splice(1, 0, "--config", intelConfig);
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const target = process.argv[2];
    console.log(macosBuildTarget(target ? ["build", "--target", target] : ["build"]));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
