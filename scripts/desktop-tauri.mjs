#!/usr/bin/env node
// Cross-platform entry for the desktop package's `build` and `tauri` scripts.
//
// On macOS this runs exactly the commands the package scripts ran before (Sparkle staging and OPSIN
// runtime signing ahead of the package `build`, with ~/.cargo/bin on PATH). Those steps and that POSIX
// syntax are macOS-only; pnpm runs package scripts through cmd.exe on Windows, which can run neither.
// Elsewhere this adds cargo to PATH if needed and invokes the Tauri CLI directly.
//
// On both platforms it sets CHEMDRAFT_WORKTREE_LABEL for the child: the worktree label (AGENTS.md
// §21.1) for dev and branch builds, and the EMPTY string for a stable package build (on main, or with
// CHEMDRAFT_STABLE_BUILD=1), so a release is titled plain "ChemDraft" and does not fall back to git.
// The explicit local-only CHEMDRAFT_ALLOW_UNSIGNED_STABLE=1 escape labels a stable DMG "UNSIGNED".
//
//   node scripts/desktop-tauri.mjs --package-build [tauri build args…]   (the package `build` script)
//   node scripts/desktop-tauri.mjs <any tauri subcommand…>               (the package `tauri` script)
//
// Only the package `build` script stages Sparkle and signs the OPSIN runtime, as before: a bare
// `pnpm tauri build` never did, so `--package-build` rather than a `build` argument selects it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_PRODUCT_NAME, isStableBuild, prependToPath, worktreeIdentity, worktreeLabelFor } from "./worktree-identity.mjs";
import { macosBuildArgs, macosBuildTarget } from "./macos-build-target.mjs";
import { preflightReleaseOpsinRuntime } from "./check-release-opsin-runtime.mjs";
import { isStableDmgBuild, macosReleasePlist } from "../tools/release/macos-build-plist.mjs";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_DIR = join(ROOT_DIR, "apps", "desktop");
const requireConfig = createRequire(import.meta.url);

// The `name` of the `.chemdraft` association, which the Windows installer uses as its registry ProgID.
export function chemdraftAssociationName(associations) {
  return associations?.find((association) => association.ext?.includes("chemdraft"))?.name;
}

// The association list Tauri reads on Windows: the platform override when it has one, else the base.
function windowsFileAssociations() {
  const read = (file) => requireConfig(join(APP_DIR, "src-tauri", file));
  return read("tauri.windows.conf.json").bundle?.fileAssociations ?? read("tauri.conf.json").bundle?.fileAssociations ?? [];
}

export function buildMacosDesktop(args, { env, stable, isPackageBuild }, {
  run = spawnSync, preflight = preflightReleaseOpsinRuntime, preparePlist = macosReleasePlist, warn = console.warn
} = {}) {
  const allowUnsigned = env.CHEMDRAFT_ALLOW_UNSIGNED_STABLE === "1";
  if (allowUnsigned && env.APPLE_SIGNING_IDENTITY) {
    throw new Error("CHEMDRAFT_ALLOW_UNSIGNED_STABLE=1 and APPLE_SIGNING_IDENTITY cannot be used together. Pick one: unset the flag to sign, or unset the identity for a local UNSIGNED build.");
  }
  const unsigned = isStableDmgBuild(args, stable) && allowUnsigned;
  const warning = "WARNING: This stable macOS build is UNSIGNED.\nCHEMDRAFT_ALLOW_UNSIGNED_STABLE=1 is a local-only escape.\nThis build must NEVER be published.";
  if (isStableDmgBuild(args, stable)) {
    env.CHEMDRAFT_RELEASE_BUILD = unsigned ? "0" : "1";
    if (!unsigned && !env.APPLE_SIGNING_IDENTITY?.trim()) throw new Error("APPLE_SIGNING_IDENTITY is required for stable macOS DMG builds (CHEMDRAFT_RELEASE_BUILD=1); use CHEMDRAFT_ALLOW_UNSIGNED_STABLE=1 only for a local UNSIGNED build that must never be published");
  }
  if (unsigned) {
    warn(warning);
    // Vite's stamp and the native title already consume this label; no app source change needed.
    env.CHEMDRAFT_WORKTREE_LABEL = "UNSIGNED";
  }
  let releasePlist;
  try {
    // Fail before signing or Tauri packaging; dev/debug/non-bundle builds keep OPSIN optional.
    preflight(args);
    releasePlist = preparePlist(args, {
      rootDir: ROOT_DIR,
      target: args[0] === "build" ? macosBuildTarget(args) : undefined,
      stable,
      unsigned
    });
    const prep = isPackageBuild ? "pnpm prepare:sparkle && pnpm sign:opsin-runtime && " : "";
    return run("bash", ["-c", `${prep}PATH="$HOME/.cargo/bin:$PATH" tauri "$@"`, "tauri", ...(releasePlist?.args ?? args)], {
      cwd: APP_DIR,
      env,
      stdio: "inherit"
    });
  } finally {
    try { releasePlist?.cleanup(); }
    finally { if (unsigned) warn(warning); }
  }
}

// Preloaded web plugins (CHEMDRAFT_WEB_PLUGINS_DIR) belong to the browser build alone. A Tauri dev or
// package build with it set would copy staged third-party packages into the desktop bundle, so refuse
// before anything runs. The Vite plugin refuses too (TAURI_ENV_*), for `tauri` invoked any other way.
export function assertNoWebPluginsDir(env) {
  if (env.CHEMDRAFT_WEB_PLUGINS_DIR !== undefined && env.CHEMDRAFT_WEB_PLUGINS_DIR.trim() !== "") {
    throw new Error(
      "CHEMDRAFT_WEB_PLUGINS_DIR is set, but preloaded web plugins are for the browser build only " +
        "(pnpm --filter @chemdraft/desktop build:web:plugins). Unset it to build or run the desktop app."
    );
  }
}

// A toolbar profile (CHEMDRAFT_TOOLBAR_PROFILE) is for the browser game build alone. Inherited by a
// desktop dev or package build, it would ship the game's toolbars in the desktop app, so refuse before
// anything builds, signs or packages, on every platform. vite.config.ts refuses it too (TAURI_ENV_*),
// for `tauri` invoked any other way. Unset or empty is the standard toolbars and stays allowed.
export function assertNoToolbarProfile(env) {
  if (env.CHEMDRAFT_TOOLBAR_PROFILE !== undefined && env.CHEMDRAFT_TOOLBAR_PROFILE.trim() !== "") {
    throw new Error(
      `CHEMDRAFT_TOOLBAR_PROFILE=${env.CHEMDRAFT_TOOLBAR_PROFILE} is set, but toolbar profiles are for the browser build only ` +
        "(pnpm --filter @chemdraft/desktop build:web:game). Unset it to build or run the desktop app."
    );
  }
}

// A startup command (CHEMDRAFT_WEB_STARTUP_COMMAND) is for the browser game build alone. Inherited by a
// desktop dev or package build, it would make the desktop app run a command on launch, so refuse before
// anything builds, signs or packages, on every platform. vite.config.ts refuses it too (TAURI_ENV_*).
// Unset or empty is no startup command and stays allowed.
export function assertNoWebStartupCommand(env) {
  if (env.CHEMDRAFT_WEB_STARTUP_COMMAND !== undefined && env.CHEMDRAFT_WEB_STARTUP_COMMAND.trim() !== "") {
    throw new Error(
      `CHEMDRAFT_WEB_STARTUP_COMMAND=${env.CHEMDRAFT_WEB_STARTUP_COMMAND} is set, but a startup command is for the browser build only ` +
        "(pnpm --filter @chemdraft/desktop build:web:game). Unset it to build or run the desktop app."
    );
  }
}

function main() {
  try {
    assertNoWebPluginsDir(process.env);
    assertNoToolbarProfile(process.env);
    assertNoWebStartupCommand(process.env);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const PACKAGE_BUILD_FLAG = "--package-build";
  const isPackageBuild = process.argv[2] === PACKAGE_BUILD_FLAG;
  const inputArgs = isPackageBuild ? ["build", ...process.argv.slice(3)] : process.argv.slice(2);
  const args = process.platform === "darwin"
    ? macosBuildArgs(inputArgs, join(APP_DIR, "src-tauri", "tauri.intel.conf.json"), process.arch)
    : inputArgs;

  const env = { ...process.env };
  const identity = worktreeIdentity(ROOT_DIR);
  env.CHEMDRAFT_WORKTREE_LABEL = worktreeLabelFor({ command: args[0], identity, env });

  if (process.platform === "darwin") {
    const result = buildMacosDesktop(args, { env, isPackageBuild, stable: isStableBuild({ command: args[0], branch: identity.branch, env }) });
    process.exit(result.status ?? 1);
  }

  const exe = process.platform === "win32" ? ".exe" : "";
  const cargoBin = join(homedir(), ".cargo", "bin");
  if (existsSync(join(cargoBin, `cargo${exe}`))) {
    prependToPath(env, cargoBin);
  }

  // A release build from any branch but main is a different application (AGENTS.md §15.2): the shared
  // dev identifier, app_data_dir and single-instance lock, separate from stable, and a product name which
  // gives the installer its own install directory and uninstall entry. Without this, installing a branch
  // build replaced the stable install and a running stable app swallowed the branch build's launch.
  // CHEMDRAFT_STABLE_BUILD=1 opts out, for release automation building a tagged commit.
  const isBranchBuild = args[0] === "build" && !isStableBuild({ command: args[0], branch: identity.branch, env });
  const devAssociations = isBranchBuild ? devFileAssociations() : undefined;
  if (isBranchBuild) {
    const devConfig = JSON.stringify({
      identifier: identity.devBundleId,
      productName: DEV_PRODUCT_NAME,
      bundle: { fileAssociations: devAssociations }
    });
    args.splice(1, 0, "--config", devConfig);
    console.log(`Branch build (${identity.label}): ${DEV_PRODUCT_NAME}, ${identity.devBundleId}`);
  }

  // The installer hook (apps/desktop/src-tauri/windows/installer-hooks.nsh) needs this build's `.chemdraft`
  // ProgID before APP_ASSOCIATE writes it, and on uninstall when no install recorded it. makensis reads it
  // from the environment at compile time, and the hook fails the build without it. It is the association
  // name Tauri gets: the dev names above for a branch build, else the Windows config's.
  if (process.platform === "win32") {
    const progId = chemdraftAssociationName(devAssociations ?? windowsFileAssociations());
    if (progId) env.CHEMDRAFT_ASSOCIATION_PROGID = progId;
    else delete env.CHEMDRAFT_ASSOCIATION_PROGID;
  }

  // A stable Windows build also signs its installer for the in-app updater (`<installer>.sig`, the
  // input to `pnpm release:windows-manifest`). Only when the updater key is on this machine: without it
  // the build still succeeds, just without update signatures, so a developer on main is never blocked.
  // Branch builds never sign — they must not be publishable as an update to the released app.
  // CI defers updater signing until AFTER Authenticode, which changes the installer bytes. The
  // explicit opt-out also overrides createUpdaterArtifacts in a checked-in config; VM defaults stay.
  if (args[0] === "build" && !isBranchBuild && process.platform === "win32") {
    const keyPath = env.CHEMDRAFT_UPDATER_KEY_PATH ?? join(homedir(), ".tauri", "chemdraft-updater.key");
    if (env.CHEMDRAFT_SKIP_UPDATER_SIGNING === "1") {
      args.splice(1, 0, "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
      console.log("Stable build: updater signing explicitly deferred (CHEMDRAFT_SKIP_UPDATER_SIGNING=1).");
    } else if (env.TAURI_SIGNING_PRIVATE_KEY || existsSync(keyPath)) {
      // Trimmed (which also strips a BOM, whitespace to trim()): a key restored from a password manager
      // through an editor or PowerShell gains a trailing newline, and the CLI then fails to decode it.
      env.TAURI_SIGNING_PRIVATE_KEY ??= readFileSync(keyPath, "utf8").trim();
      env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
      args.splice(1, 0, "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: true } }));
      console.log("Stable build: signing the installer for the in-app updater.");
    } else {
      console.log(`Stable build without the updater key (${keyPath}): the installer cannot be published as an update.`);
    }
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
}

// Importing the build helper must not launch Tauri. Accept the CLI's bare filename too.
if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) main();
