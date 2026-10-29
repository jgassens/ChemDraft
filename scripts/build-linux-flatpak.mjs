#!/usr/bin/env node
// Local Linux development package. Builds against GNOME 49 instead of the host's WebKitGTK,
// then exports an unsigned Flatpak bundle. This does not install or publish anything.
import {
  chmodSync, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, rmSync, statSync, symlinkSync, writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_PRODUCT_NAME, worktreeIdentity } from "./worktree-identity.mjs";
import { createLinuxBuildGuard, reserveLinuxBuildCpus } from "./linux-build-resources.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TAURI = join(ROOT, "apps", "desktop", "src-tauri");
const ARTIFACTS = join(ROOT, "artifacts");
const APP_ID = "org.chemdraft.desktop.dev";
const RUNTIME = "org.gnome.Platform";
const SDK = "org.gnome.Sdk";
const RUNTIME_VERSION = "49";
const BRANCH = "linux-dev";
let guard;

function fail(message) {
  throw new Error(message);
}

async function run(command, args, options = {}) {
  await guard.run(command, args, { cwd: ROOT, ...options });
}

function optionsFrom(args) {
  const options = { stageOnly: false, help: false };
  const values = new Map([["--binary", "binary"], ["--build-dir", "buildDir"], ["--output-dir", "outputDir"]]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--stage-only") options.stageOnly = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (values.has(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--") || value.includes("\0") || /[\r\n]/.test(value)) fail(`Missing or invalid value for ${arg}.`);
      options[values.get(arg)] = resolve(ROOT, value);
    } else fail(`Unknown option: ${arg}. Use --help.`);
  }
  return options;
}

function assertElf(path, arch) {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`Executable missing: ${path}`);
  const descriptor = openSync(path, "r");
  const header = Buffer.alloc(20);
  try {
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) fail(`Executable is truncated: ${path}`);
  } finally {
    closeSync(descriptor);
  }
  const machine = { x86_64: 62, aarch64: 183 }[arch];
  if (header.subarray(0, 4).toString("hex") !== "7f454c46" || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== machine) {
    fail(`Expected a native ${arch} Linux ELF executable: ${path}`);
  }
}

function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/build-linux-flatpak.mjs [options]

  --stage-only          Package an existing GNOME SDK 49 release build
  --binary PATH         Release executable to package (default: Cargo release output)
  --build-dir PATH      Flatpak build directory, inside artifacts/ (default: artifacts/flatpak-build)
  --output-dir PATH     Bundle and local repository directory (default: artifacts/)
  --help                Show this help

Requires Flatpak, org.gnome.Sdk//49, org.gnome.Platform//49, Node 24,
pnpm 10.12.1 and the pinned Rust toolchain. Install dependencies with pnpm first.
Reserves three available CPUs for the operating system; Cargo uses at most three jobs.
Keeps 20 GiB free on home/build volumes and 10 GiB on root, monitored during builds.
Output: ChemDraft-linux-<arch>.flatpak, app ID ${APP_ID}, branch ${BRANCH}.
This command never installs, uploads, signs or publishes the package.`);
    return;
  }
  if (process.platform !== "linux") fail("Flatpak packaging must run on Linux.");
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  if (!arch) fail(`Unsupported Linux architecture: ${process.arch}`);
  // Restrict this process too, so staging, compression and every child preserve the CPU reserve.
  reserveLinuxBuildCpus();
  const buildDir = options.buildDir ?? join(ARTIFACTS, "flatpak-build");
  const outputDir = options.outputDir ?? ARTIFACTS;
  const relativeBuild = relative(ARTIFACTS, buildDir);
  if (!relativeBuild || relativeBuild === ".." || relativeBuild.startsWith(`..${sep}`) || isAbsolute(relativeBuild)) {
    fail("--build-dir must be a subdirectory of this checkout's artifacts/ directory.");
  }
  for (const path of [ARTIFACTS, buildDir, join(buildDir, "files"), outputDir]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail(`Output paths must not be symbolic links: ${path}`);
  }

  const targetDir = process.env.CARGO_TARGET_DIR ? resolve(TAURI, process.env.CARGO_TARGET_DIR) : join(TAURI, "target");
  guard = createLinuxBuildGuard([ROOT, ARTIFACTS, buildDir, outputDir, targetDir]);
  const target = process.env.CARGO_BUILD_TARGET;
  if (target && !/^[A-Za-z0-9_-]+$/.test(target)) fail("CARGO_BUILD_TARGET must be a Rust target triple.");
  const binary = options.binary ?? join(targetDir, ...(target ? [target] : []), "release", "chemdraft");
  const metadataPath = join(buildDir, "metadata");
  const metadata = `[Application]\nname=${APP_ID}\nruntime=${RUNTIME}/${arch}/${RUNTIME_VERSION}\nsdk=${SDK}/${arch}/${RUNTIME_VERSION}\n`;
  if (existsSync(metadataPath)) {
    const existing = readFileSync(metadataPath, "utf8");
    for (const required of metadata.trim().split("\n")) {
      if (!existing.split(/\r?\n/).includes(required)) fail(`Existing Flatpak build directory has different metadata: ${buildDir}`);
    }
  } else {
    mkdirSync(dirname(buildDir), { recursive: true });
    await run("flatpak", ["build-init", `--arch=${arch}`, buildDir, APP_ID, SDK, RUNTIME, RUNTIME_VERSION]);
  }

  const identity = worktreeIdentity(ROOT);
  const terminal = join(ROOT, "native", "linux-terminal", "build", "chemdraft-terminal");
  if (!options.stageOnly) {
    await run(process.execPath, [join(ROOT, "scripts", "build-linux-terminal.mjs"), "--sdk-build-dir", buildDir]);
    const cli = join(ROOT, "apps", "desktop", "node_modules", "@tauri-apps", "cli", "tauri.js");
    if (!existsSync(cli)) fail("JavaScript dependencies missing. Run pnpm install --frozen-lockfile first.");
    const callerPath = process.env.PATH ?? "";
    const buildPath = [...new Set([dirname(process.execPath), join(homedir(), ".cargo", "bin"), ...callerPath.split(delimiter), "/usr/bin", "/bin"].filter(Boolean))].join(delimiter);
    const requestedJobs = process.env.CARGO_BUILD_JOBS ?? "3";
    if (!/^[1-9][0-9]*$/.test(requestedJobs)) fail("CARGO_BUILD_JOBS must be a positive integer.");
    const jobs = String(Math.min(3, Number(requestedJobs)));
    await run("flatpak", [
      "build", "--share=network", "--filesystem=home", `--filesystem=${ROOT}`,
      `--env=PATH=${buildPath}`, `--env=CHEMDRAFT_WORKTREE_LABEL=${identity.label}`,
      `--env=CARGO_BUILD_JOBS=${jobs}`,
      `--build-dir=${join(ROOT, "apps", "desktop")}`, buildDir,
      "node", cli, "build", "--no-bundle", "--config",
      JSON.stringify({ identifier: APP_ID, productName: DEV_PRODUCT_NAME })
    ]);
  }

  assertElf(binary, arch);
  assertElf(terminal, arch);
  guard.check();
  const files = join(buildDir, "files");
  // This directory belongs to the validated local app build. Recreate the staged files so a
  // removed optional sidecar or runtime cannot survive from an earlier package.
  rmSync(files, { recursive: true, force: true });
  mkdirSync(files, { recursive: true });
  copy(binary, join(files, "bin", "chemdraft"));
  chmodSync(join(files, "bin", "chemdraft"), 0o755);
  copy(terminal, join(files, "bin", "chemdraft-terminal"));
  chmodSync(join(files, "bin", "chemdraft-terminal"), 0o755);
  cpSync(join(TAURI, "resources"), join(files, "lib", "chemdraft", "resources"), { recursive: true });
  // Tauri resolves Linux resources using productName, while our canonical resource path is lowercase.
  symlinkSync("chemdraft", join(files, "lib", DEV_PRODUCT_NAME));
  symlinkSync("chemdraft", join(files, "lib", "ChemDraft"));

  const sidecar = join(ROOT, "native", "avogadro3d-sidecar", "build", "protocol-scout", "avogadro3d-sidecar");
  if (existsSync(sidecar)) {
    assertElf(sidecar, arch);
    copy(sidecar, join(files, "bin", "avogadro3d-sidecar"));
    chmodSync(join(files, "bin", "avogadro3d-sidecar"), 0o755);
  } else {
    console.warn("Optional native 3D sidecar absent; interactive UFF mechanics will report unavailable. See native/avogadro3d-sidecar/README.md.");
  }
  if (!existsSync(join(TAURI, "resources", "opsin", "jre", "bin", "java"))) {
    console.warn("OPSIN Java runtime absent; name-to-structure will report unavailable. Run node scripts/build-opsin-runtime.mjs with JDK 21+ before packaging to include it.");
  }

  const licenses = join(files, "share", "licenses", "chemdraft");
  for (const file of ["LICENSE", "NOTICE"]) copy(join(ROOT, file), join(licenses, file));
  for (const file of ["download-network-licenses.txt", "dependency-inventory.md"]) {
    copy(join(ROOT, "docs", "architecture", file), join(licenses, file));
  }
  cpSync(join(ROOT, "native", "avogadro3d-sidecar", "licenses"), join(licenses, "avogadro3d-sidecar"), { recursive: true });
  copy(join(ROOT, "native", "linux-terminal", "LICENSE"), join(licenses, "linux-terminal", "LICENSE"));
  copy(join(TAURI, "icons", "128x128@2x.png"), join(files, "share", "icons", "hicolor", "256x256", "apps", `${APP_ID}.png`));
  const desktop = `[Desktop Entry]\nType=Application\nName=${DEV_PRODUCT_NAME}\nComment=Chemical structure drawing\nExec=chemdraft %F\nIcon=${APP_ID}\nTerminal=false\nCategories=Education;Science;Chemistry;\nStartupNotify=true\n`;
  const desktopPath = join(files, "share", "applications", `${APP_ID}.desktop`);
  mkdirSync(dirname(desktopPath), { recursive: true });
  writeFileSync(desktopPath, desktop);

  // Reset only this app's generated metadata, so rerunning after build-finish is repeatable.
  writeFileSync(metadataPath, metadata);
  rmSync(join(buildDir, "export"), { recursive: true, force: true });
  guard.check();
  await run("flatpak", [
    "build-finish", "--command=chemdraft", "--share=network", "--share=ipc",
    "--socket=x11", "--device=dri", "--filesystem=home", "--env=GDK_BACKEND=x11", buildDir
  ]);
  mkdirSync(outputDir, { recursive: true });
  const repository = join(outputDir, "flatpak-repo");
  const bundle = join(outputDir, `ChemDraft-linux-${arch}.flatpak`);
  await run("flatpak", ["build-export", `--arch=${arch}`, repository, buildDir, BRANCH]);
  if (existsSync(bundle)) {
    if (!lstatSync(bundle).isFile()) fail(`Bundle output is not a regular file: ${bundle}`);
    rmSync(bundle);
  }
  await run("flatpak", ["build-bundle", `--arch=${arch}`, "--runtime-repo=https://flathub.org/repo/flathub.flatpakrepo", repository, bundle, APP_ID, BRANCH]);
  console.log(`Created ${bundle}\nLocal repository: ${repository}\nApp: ${APP_ID}/${arch}/${BRANCH}\nInstall: flatpak install --user ${bundle}\nRun: flatpak run ${APP_ID}`);
}

main().catch((error) => {
  console.error(`Linux Flatpak build failed: ${error.message}`);
  process.exitCode = 1;
});
