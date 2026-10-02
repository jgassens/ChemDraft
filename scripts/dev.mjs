#!/usr/bin/env node
// Cross-platform entry for `pnpm dev` (Tauri dev mode with Vite HMR).
//
// macOS keeps using `run-app --dev` unchanged: it also owns LaunchServices cleanup, stale-process
// reaping, and Sparkle staging, none of which exist elsewhere. Every other platform gets the parts of
// run-app that are not macOS-specific — the worktree label, the per-worktree dev identifier (its own
// app_data_dir, so a dev build never shares state with an installed one), a free dev-server port, and
// the local Engine 3D sidecar override — and then launches the Tauri CLI directly. pnpm runs package
// scripts through cmd.exe on Windows, which cannot execute the bash launcher or `${VAR:-default}`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prependToPath, worktreeIdentity } from "./worktree-identity.mjs";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_DIR = join(ROOT_DIR, "apps", "desktop");
const DEV_HOST = "127.0.0.1";
const exe = process.platform === "win32" ? ".exe" : "";

if (process.platform === "darwin") {
  const result = spawnSync("bash", [join(ROOT_DIR, "run-app"), "--dev", ...process.argv.slice(2)], {
    cwd: ROOT_DIR,
    stdio: "inherit"
  });
  process.exit(result.status ?? 1);
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, DEV_HOST, () => server.close(() => resolve(true)));
  });
}

async function selectDevPort(start) {
  for (let candidate = start; candidate <= start + 20; candidate++) {
    if (await portIsFree(candidate)) {
      return candidate;
    }
    console.log(`Port ${candidate} is already in use; trying the next one.`);
  }
  console.error(`No free ChemDraft dev server port in ${start}-${start + 20}.`);
  process.exit(1);
}

function onPath(command) {
  const lookup = process.platform === "win32" ? "where" : "which";
  return spawnSync(lookup, [command], { stdio: "ignore" }).status === 0;
}

const env = { ...process.env };

if (!existsSync(join(ROOT_DIR, "node_modules")) || !existsSync(join(APP_DIR, "node_modules"))) {
  const install = spawnSync("pnpm", ["install"], { cwd: ROOT_DIR, stdio: "inherit", shell: true });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

if (!onPath("cargo")) {
  const cargoBin = join(homedir(), ".cargo", "bin");
  if (existsSync(join(cargoBin, `cargo${exe}`))) {
    prependToPath(env, cargoBin);
  } else {
    console.error("ChemDraft launches through Tauri, but Rust/Cargo is not installed or not on PATH.");
    console.error("Install Rust from https://rustup.rs/, then run `pnpm dev` again.");
    process.exit(1);
  }
}

const identity = worktreeIdentity(ROOT_DIR);
env.CHEMDRAFT_WORKTREE_LABEL = identity.label;
env.CHEMDRAFT_DEV_BUNDLE_ID = identity.devBundleId;
const port = await selectDevPort(Number(env.CHEMDRAFT_DEV_PORT ?? 5173));
env.CHEMDRAFT_DEV_PORT = String(port);

const localSidecar = join(
  ROOT_DIR,
  "native",
  "avogadro3d-sidecar",
  "build",
  process.platform === "win32" ? join("windows-msvc", "Release") : "protocol-scout",
  `avogadro3d-sidecar${exe}`
);
if (!env.CHEMDRAFT_ENGINE3D_SIDECAR && existsSync(localSidecar)) {
  env.CHEMDRAFT_ENGINE3D_SIDECAR = localSidecar;
  console.log(`Using local Engine 3D sidecar: ${localSidecar}`);
}

console.log("");
console.log("============================================================");
console.log(`  ChemDraft  ▸  ${env.CHEMDRAFT_WORKTREE_LABEL}`);
console.log(`  worktree:  ${ROOT_DIR}`);
console.log(`  mode:      dev (Vite HMR) on ${DEV_HOST}:${port}`);
console.log(`  bundle id: ${env.CHEMDRAFT_DEV_BUNDLE_ID}`);
console.log("============================================================");
console.log("");

// The identifier split gives the dev build its own app_data_dir; devUrl follows the chosen port.
// Passed as one argv element, so no shell quoting is involved on any platform.
const devConfig = JSON.stringify({
  identifier: env.CHEMDRAFT_DEV_BUNDLE_ID,
  build: { devUrl: `http://${DEV_HOST}:${port}` }
});
const tauriCli = join(APP_DIR, "node_modules", "@tauri-apps", "cli", "tauri.js");
const child = spawn(process.execPath, [tauriCli, "dev", "--config", devConfig, ...process.argv.slice(2)], {
  cwd: APP_DIR,
  env,
  stdio: "inherit"
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
