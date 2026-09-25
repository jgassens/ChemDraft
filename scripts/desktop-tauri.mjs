#!/usr/bin/env node
// Cross-platform entry for the desktop package's `build` and `tauri` scripts.
//
// On macOS this runs exactly the commands the package scripts ran before (Sparkle staging and OPSIN
// runtime signing ahead of `tauri build`, with ~/.cargo/bin on PATH). Those steps and that POSIX
// syntax are macOS-only; pnpm runs package scripts through cmd.exe on Windows, which can run neither.
// Elsewhere this adds cargo to PATH if needed and invokes the Tauri CLI directly.
//
//   node scripts/desktop-tauri.mjs build [tauri build args…]
//   node scripts/desktop-tauri.mjs <any tauri subcommand…>
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_DIR = join(ROOT_DIR, "apps", "desktop");
const args = process.argv.slice(2);
const isBuild = args[0] === "build";

if (process.platform === "darwin") {
  const prep = isBuild ? "pnpm prepare:sparkle && pnpm sign:opsin-runtime && " : "";
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
  env.PATH = `${cargoBin}${delimiter}${env.PATH ?? ""}`;
}

const tauriCli = join(APP_DIR, "node_modules", "@tauri-apps", "cli", "tauri.js");
const result = spawnSync(process.execPath, [tauriCli, ...args], { cwd: APP_DIR, env, stdio: "inherit" });
process.exit(result.status ?? 1);
