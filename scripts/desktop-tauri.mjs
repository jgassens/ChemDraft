#!/usr/bin/env node
// Cross-platform entry for the desktop package's `build` and `tauri` scripts.
//
// On macOS this runs exactly the commands the package scripts ran before (Sparkle staging and OPSIN
// runtime signing ahead of the package `build`, with ~/.cargo/bin on PATH). Those steps and that POSIX
// syntax are macOS-only; pnpm runs package scripts through cmd.exe on Windows, which can run neither.
// Elsewhere this adds cargo to PATH if needed, labels the build with its worktree, and invokes the
// Tauri CLI directly.
//
//   node scripts/desktop-tauri.mjs --package-build [tauri build args…]   (the package `build` script)
//   node scripts/desktop-tauri.mjs <any tauri subcommand…>               (the package `tauri` script)
//
// Only the package `build` script stages Sparkle and signs the OPSIN runtime, as before: a bare
// `pnpm tauri build` never did, so `--package-build` rather than a `build` argument selects it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_PRODUCT_NAME, prependToPath, worktreeIdentity } from "./worktree-identity.mjs";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_DIR = join(ROOT_DIR, "apps", "desktop");
const PACKAGE_BUILD_FLAG = "--package-build";
const isPackageBuild = process.argv[2] === PACKAGE_BUILD_FLAG;
const args = isPackageBuild ? ["build", ...process.argv.slice(3)] : process.argv.slice(2);

if (process.platform === "darwin") {
  const prep = isPackageBuild ? "pnpm prepare:sparkle && pnpm sign:opsin-runtime && " : "";
  const result = spawnSync("bash", ["-c", `${prep}PATH="$HOME/.cargo/bin:$PATH" tauri "$@"`, "tauri", ...args], {
    cwd: APP_DIR,
    stdio: "inherit"
  });
  process.exit(result.status ?? 1);
}

const env = { ...process.env };
const exe = process.platform === "win32" ? ".exe" : "";
const cargoBin = join(homedir(), ".cargo", "bin");
if (existsSync(join(cargoBin, `cargo${exe}`))) {
  prependToPath(env, cargoBin);
}

const identity = worktreeIdentity(ROOT_DIR);
env.CHEMDRAFT_WORKTREE_LABEL ??= identity.label;

// A release build from any branch but main is a different application (AGENTS.md §21.2): its own
// identifier — hence its own app_data_dir and single-instance lock — and its own product name, which
// gives the installer its own install directory and uninstall entry. Without this, installing a branch
// build replaced the stable install and a running stable app swallowed the branch build's launch.
// CHEMDRAFT_STABLE_BUILD=1 opts out, for release automation building a tagged commit.
if (args[0] === "build" && identity.branch !== "main" && env.CHEMDRAFT_STABLE_BUILD !== "1") {
  const devConfig = JSON.stringify({
    identifier: identity.devBundleId,
    productName: DEV_PRODUCT_NAME,
    bundle: { fileAssociations: devFileAssociations() }
  });
  args.splice(1, 0, "--config", devConfig);
  console.log(`Branch build (${identity.label}): ${DEV_PRODUCT_NAME}, ${identity.devBundleId}`);
}

// The installer names each association's registry ProgID after its `name`, so a branch build that
// kept "ChemDraft Document" rewrote the stable install's `.chemdraft` handler — and uninstalling the
// branch build deleted it. Same associations, suffixed names. (--config replaces arrays, so this is
// the platform's full list: the Windows override when there is one, else the base config.)
function devFileAssociations() {
  const tauriDir = join(APP_DIR, "src-tauri");
  const platformFile = { win32: "tauri.windows.conf.json", linux: "tauri.linux.conf.json" }[process.platform];
  const read = (file) => (existsSync(join(tauriDir, file)) ? JSON.parse(readFileSync(join(tauriDir, file), "utf8")) : {});
  const associations =
    (platformFile && read(platformFile).bundle?.fileAssociations) ?? read("tauri.conf.json").bundle?.fileAssociations ?? [];
  return associations.map((association) => ({ ...association, name: `${association.name} (dev)` }));
}

const tauriCli = join(APP_DIR, "node_modules", "@tauri-apps", "cli", "tauri.js");
const result = spawnSync(process.execPath, [tauriCli, ...args], { cwd: APP_DIR, env, stdio: "inherit" });
process.exit(result.status ?? 1);
