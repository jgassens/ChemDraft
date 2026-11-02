export const DEFAULT_MACOS_TARGET = "aarch64-apple-darwin";
export const INTEL_MACOS_TARGET = "x86_64-apple-darwin";

export function macosBuildArgs(input, intelConfig) {
  const args = [...input];
  if (args[0] !== "build") return args;
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  const targets = options.flatMap((arg, index) => arg === "--target" || arg === "-t" ? [options[index + 1]] : arg.startsWith("--target=") ? [arg.slice(9)] : arg.startsWith("-t") && arg.length > 2 ? [arg.slice(2)] : []);
  if (targets.length > 1) throw new Error("Specify --target only once");
  if (!targets.length) return args;
  const target = targets[0];
  if (![DEFAULT_MACOS_TARGET, INTEL_MACOS_TARGET].includes(target)) throw new Error(`Unsupported macOS target: ${target}`);
  // Prepend the architecture overlay so explicit caller config (e.g. run-app's dev id) still wins.
  if (target === INTEL_MACOS_TARGET) args.splice(1, 0, "--config", intelConfig);
  return args;
}
