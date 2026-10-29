#!/usr/bin/env node
// Build the reviewed terminal used only for visible Linux CLI sign-in. No host execution escape.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLinuxBuildGuard, reserveLinuxBuildCpus } from "./linux-build-resources.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = join(root, "native", "linux-terminal");
const sourceUrl = "https://dl.suckless.org/st/st-0.9.3.tar.gz";
const sourceSha256 = "9ed9feabcded713d4ded38c8cebf36a3b08f0042ef7934a0e2b2409da56e649b";
let guard;

async function run(command, args) {
  await guard.run(command, args, { cwd: root });
}

async function main() {
  if (process.platform !== "linux") throw new Error("The sign-in terminal must be built on Linux.");
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node scripts/build-linux-terminal.mjs [--sdk-build-dir artifacts/flatpak-build]\nBuilds native/linux-terminal/build/chemdraft-terminal using GNOME SDK 49. Reserves three CPUs, 20 GiB on home/build volumes and 10 GiB on root; monitors active build steps.");
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== "--sdk-build-dir" || !args[1])) throw new Error("Invalid arguments; use --help.");
  const sdkBuild = resolve(root, args[1] ?? "artifacts/flatpak-build");
  if (!existsSync(join(sdkBuild, "metadata"))) throw new Error("Initialize a GNOME SDK 49 Flatpak build directory first.");
  reserveLinuxBuildCpus();
  const deps = join(directory, "_deps");
  const build = join(directory, "build");
  guard = createLinuxBuildGuard([root, sdkBuild, deps, build]);
  mkdirSync(deps, { recursive: true });
  mkdirSync(build, { recursive: true });
  const archive = join(deps, "st-0.9.3.tar.gz");
  if (!existsSync(archive)) {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Terminal source download failed: HTTP ${response.status}.`);
    if (!response.body) throw new Error("Terminal source download has no body.");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 512 * 1024) throw new Error("Terminal source exceeds its size limit.");
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== sourceSha256) throw new Error("Terminal source checksum mismatch.");
    writeFileSync(archive, bytes);
  }
  if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== sourceSha256) throw new Error("Terminal source checksum mismatch.");
  // This exact upstream archive was reviewed: only regular files/directories under st-0.9.3.
  // Never accept an unpinned tarball or renderer-provided URL/path here.
  await run("tar", ["-xzf", archive, "-C", deps]);
  const source = join(deps, "st-0.9.3");
  const license = readFileSync(join(source, "LICENSE"));
  if (!license.equals(readFileSync(join(directory, "LICENSE")))) throw new Error("Terminal source licence differs from the reviewed licence.");
  const configuration = readFileSync(join(source, "config.def.h"), "utf8")
    .replace('char *termname = "st-256color";', 'char *termname = "xterm-256color";')
    .replace('"Liberation Mono:pixelsize=12:antialias=true:autohint=true"', '"monospace:size=12:antialias=true:autohint=true"');
  writeFileSync(join(source, "config.h"), configuration);
  await run("flatpak", ["build", "--filesystem=home", `--filesystem=${root}`, sdkBuild, "make", "-C", source, "-j3", "CC=cc", "CFLAGS=-O2", "LDFLAGS=-Wl,-z,relro,-z,now"]);
  const output = join(build, "chemdraft-terminal");
  copyFileSync(join(source, "st"), output);
  chmodSync(output, 0o755);
  console.log(`Built ${output}\nSource SHA-256: ${sourceSha256}`);
}

main().catch(error => { console.error(`Linux sign-in terminal build failed: ${error.message}`); process.exitCode = 1; });
