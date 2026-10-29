#!/usr/bin/env node
// Real Flatpak installation/render checks in disposable distribution containers.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLinuxBuildGuard, reserveLinuxBuildCpus } from "./linux-build-resources.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT = join(ROOT, "artifacts", "container-portability");
const BUNDLE = join(ROOT, "artifacts", "ChemDraft-linux-x86_64.flatpak");
const FIXTURE = join(ROOT, "scripts", "test-resources", "linux-desktop-v2.chemdraft");
const OWNER_KEY = "org.chemdraft.test-suite";
const OWNER = "linux-distributions-v1";
const DEFINITIONS = [
  { key: "ubuntu24", base: "ubuntu:24.04", setup: "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends flatpak dbus-x11 xvfb xauth x11-utils xdotool xclip imagemagick ca-certificates procps fonts-dejavu-core && apt-get clean && rm -rf /var/lib/apt/lists/*" },
  { key: "debian13", base: "debian:13", setup: "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends flatpak dbus-x11 xvfb xauth x11-utils xdotool xclip imagemagick ca-certificates procps fonts-dejavu-core && apt-get clean && rm -rf /var/lib/apt/lists/*" },
  { key: "fedora44", base: "fedora:44", setup: "dnf -y install flatpak dbus-daemon dbus-tools xorg-x11-server-Xvfb xorg-x11-xauth xwininfo xdotool xclip ImageMagick ca-certificates procps-ng dejavu-sans-fonts && dnf clean all" },
  { key: "arch", base: "archlinux:latest", setup: "pacman -Syu --noconfirm --needed flatpak dbus xorg-server-xvfb xorg-xauth xorg-xwininfo xdotool xclip imagemagick ca-certificates procps-ng ttf-dejavu && pacman -Scc --noconfirm" }
];
const options = { keys: DEFINITIONS.map(({ key }) => key), prepare: false, cleanup: false };
for (let index = 2; index < process.argv.length; index++) {
  const value = process.argv[index];
  if (value === "--prepare-images") options.prepare = true;
  else if (value === "--cleanup") options.cleanup = true;
  else if (value === "--distributions") options.keys = (process.argv[++index] ?? "").split(",");
  else if (value === "--help") {
    console.log("Usage: node scripts/test-linux-distributions.mjs [--prepare-images] [--distributions ubuntu24,debian13,fedora44,arch] [--cleanup]\nRequires Linux x86_64, Docker, a self-contained Node 24+ binary, the local Flatpak bundle and system-installed org.gnome.Platform/x86_64/49. --prepare-images prepares missing, labelled test images, then runs the tests. --cleanup removes only this harness's labelled containers/images and performs no tests. Shared upstream base images are retained. Tests use private users/D-Bus/Xvfb, software rendering and read-only GNOME runtime/bundle/Node/fixture mounts. Three CPUs stay free; each container uses at most 1.5 CPUs. The disk guard retains 20 GiB on home/output/Docker volumes and 10 GiB on root.");
    process.exit(0);
  } else throw new Error(`Unknown option: ${value}`);
}
if (process.platform !== "linux" || process.arch !== "x64") throw new Error("These distribution checks require an x86_64 Linux host.");
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Run with a self-contained Node 24+ binary.");
if (!options.keys.length || new Set(options.keys).size !== options.keys.length || options.keys.some((key) => !DEFINITIONS.some((entry) => entry.key === key))) throw new Error("Unknown or repeated distribution.");
if (options.cleanup && options.prepare) throw new Error("Use --cleanup separately from --prepare-images.");

function docker(args, allowMissing = false) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowMissing) throw new Error(`docker ${args.join(" ")}: ${result.stderr.trim()}`);
  return result;
}
function inspect(kind, name) {
  const result = docker([kind, "inspect", "--format", "{{json .}}", name], true);
  return result.status === 0 ? JSON.parse(result.stdout) : undefined;
}
function owned(info) { return info?.Config?.Labels?.[OWNER_KEY] === OWNER; }
function removeContainer(name) {
  const info = inspect("container", name);
  if (!info) return;
  if (!owned(info)) throw new Error(`Refusing to remove an unrelated container: ${name}`);
  docker(["rm", "--force", name]);
}
const imageName = (key) => `chemdraft-distributions-${key}:local`;
const prepareName = (key) => `chemdraft-distributions-prepare-${key}`;
const testName = (key) => `chemdraft-distributions-test-${key}`;
if (options.cleanup) {
  for (const key of options.keys) {
    for (const name of [prepareName(key), testName(key)]) removeContainer(name);
    const image = imageName(key);
    const info = inspect("image", image);
    if (!info) continue;
    if (!owned(info)) throw new Error(`Refusing to remove an unrelated image: ${image}`);
    docker(["image", "rm", image]);
    console.log(`Removed owned test image ${image}`);
  }
  process.exit(0);
}

for (const path of [BUNDLE, FIXTURE]) if (!existsSync(path)) throw new Error(`Required test input is missing: ${path}`);
docker(["version", "--format", "{{.Server.Version}}"]);
const runtime = spawnSync("flatpak", ["info", "--system", "--show-location", "runtime/org.gnome.Platform/x86_64/49"], { encoding: "utf8", timeout: 30_000 });
if (runtime.error || runtime.status !== 0 || !runtime.stdout.trim().startsWith("/var/lib/flatpak/")) throw new Error("Install org.gnome.Platform/x86_64/49 system-wide before testing.");
const cpus = reserveLinuxBuildCpus();
mkdirSync(OUTPUT, { recursive: true, mode: 0o777 });
// The private UID 1000 test user writes only this output tree, never a host home directory.
const dockerRoot = docker(["info", "--format", "{{.DockerRootDir}}"]).stdout.trim();
const guard = createLinuxBuildGuard([OUTPUT, dockerRoot]);
const packageSha256 = createHash("sha256").update(readFileSync(BUNDLE)).digest("hex");
const summary = [];
const resourceProof = { startedAt: new Date().toISOString(), cpuList: cpus, containerCpus: 1.5, reserveCpus: 3, homeDockerOutputReserveGiB: 20, rootReserveGiB: 10, packageSha256, packageBytes: statSync(BUNDLE).size, images: [] };
writeFileSync(join(OUTPUT, "resource-proof.json"), JSON.stringify(resourceProof, null, 2) + "\n");
writeFileSync(join(OUTPUT, "system-bus.conf"), `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd"><busconfig><type>system</type><listen>unix:path=/run/dbus/system_bus_socket</listen><auth>EXTERNAL</auth><policy context="default"><allow user="*"/><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>\n`);

async function guardedDocker(args, name, log, timeout) {
  const descriptor = openSync(log, "w");
  // Docker's daemon owns the container, outside the CLI process group. Stop that explicitly
  // when the shared guard aborts or a test times out, including an interrupted image commit.
  try { await guard.run("docker", args, { stdio: ["ignore", descriptor, descriptor], timeout }); }
  finally { closeSync(descriptor); removeContainer(name); }
}
async function prepare(definition) {
  const image = imageName(definition.key);
  let info = inspect("image", image);
  if (info && !owned(info)) throw new Error(`Unrelated image already uses ${image}.`);
  if (!info) {
    if (!options.prepare) throw new Error(`Prepared image is missing: ${image}; use --prepare-images.`);
    const name = prepareName(definition.key);
    if (inspect("container", name)) throw new Error(`Preparation container already exists: ${name}; use --cleanup first.`);
    const command = `${definition.setup} && useradd --non-unique --create-home --uid 1000 tester && mkdir -p /run/user/1000 && chown tester:tester /run/user/1000 && chmod 700 /run/user/1000 && cat /etc/os-release && flatpak --version && command -v Xvfb xwininfo xdotool xclip import dbus-run-session`;
    const log = openSync(join(OUTPUT, `${definition.key}-prep.log`), "w");
    try {
      await guard.run("docker", ["run", "--name", name, "--label", `${OWNER_KEY}=${OWNER}`, "--label", `org.chemdraft.distribution=${definition.key}`, `--cpuset-cpus=${cpus}`, "--cpus=1.5", definition.base, "sh", "-c", command], { stdio: ["ignore", log, log], timeout: 900_000 });
      await guard.run("docker", ["commit", "--change", `LABEL ${OWNER_KEY}=${OWNER}`, name, image], { stdio: ["ignore", log, log], timeout: 120_000 });
    } finally { closeSync(log); removeContainer(name); }
    info = inspect("image", image);
  }
  if (!owned(info)) throw new Error(`Prepared image has no ownership label: ${image}`);
  resourceProof.images.push({ key: definition.key, image, imageId: info.Id, imageBytes: info.Size });
  if (resourceProof.images.reduce((total, item) => total + item.imageBytes, 0) > 8 * 1024 ** 3) throw new Error("Prepared distribution images exceed the 8 GiB budget; use --cleanup.");
  writeFileSync(join(OUTPUT, "resource-proof.json"), JSON.stringify(resourceProof, null, 2) + "\n");
  return info;
}

for (const key of options.keys) {
  const definition = DEFINITIONS.find((entry) => entry.key === key);
  guard.check();
  const info = await prepare(definition);
  const name = testName(key);
  if (inspect("container", name)) throw new Error(`Test container already exists: ${name}; use --cleanup first.`);
  const output = join(OUTPUT, key);
  mkdirSync(output, { recursive: true, mode: 0o777 });
  chmodSync(output, 0o777);
  for (const file of ["result.json", "desktop.png", "editor.png"]) rmSync(join(output, file), { force: true });
  let failure;
  try {
    await guardedDocker(["run", "--name", name, "--label", `${OWNER_KEY}=${OWNER}`, `--cpuset-cpus=${cpus}`, "--cpus=1.5", "--network=none", "--shm-size=512m",
      "--cap-add", "SYS_ADMIN", "--security-opt", "seccomp=unconfined", "--security-opt", "systempaths=unconfined",
      "--mount", "type=bind,src=/var/lib/flatpak,dst=/var/lib/flatpak,readonly",
      "--mount", `type=bind,src=${BUNDLE},dst=/test-tools/ChemDraft.flatpak,readonly`,
      "--mount", `type=bind,src=${FIXTURE},dst=/test-tools/desktop-fixture.chemdraft,readonly`,
      "--mount", `type=bind,src=${process.execPath},dst=/test-tools/node,readonly`,
      "--mount", `type=bind,src=${join(ROOT, "scripts", "test-linux-distribution-session.mjs")},dst=/test-tools/session.mjs,readonly`,
      "--mount", `type=bind,src=${join(OUTPUT, "system-bus.conf")},dst=/test-tools/system-bus.conf,readonly`,
      "--mount", `type=bind,src=${output},dst=/test-results`, imageName(key), "sh", "-c",
      "mkdir -p /run/dbus; dbus-uuidgen > /etc/machine-id; dbus-daemon --config-file=/test-tools/system-bus.conf --fork || exit 1; exec runuser -u tester -- env HOME=/home/tester XDG_RUNTIME_DIR=/run/user/1000 XDG_DATA_DIRS=/usr/local/share:/usr/share dbus-run-session -- /test-tools/node /test-tools/session.mjs \"$1\"", "distribution-test", key], name, join(OUTPUT, `${key}-run.log`), 240_000);
  } catch (error) { failure = error.message; }
  const path = join(output, "result.json");
  const result = { key, image: imageName(key), imageId: info.Id, imageBytes: info.Size, ...(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { status: "FAIL", stage: "container-runtime" }) };
  if (failure) { result.status = "FAIL"; result.error = failure; }
  if ((result.packageSha256 && result.packageSha256 !== packageSha256) || (result.status === "PASS" && !result.packageSha256)) { result.status = "FAIL"; result.error = "Tested package does not match the bundle present at test start."; }
  summary.push(result);
  writeFileSync(join(OUTPUT, "results.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`${key}: ${result.status}`);
  guard.check();
}
resourceProof.completedAt = new Date().toISOString();
writeFileSync(join(OUTPUT, "resource-proof.json"), JSON.stringify(resourceProof, null, 2) + "\n");
process.exitCode = summary.some((result) => result.status !== "PASS") ? 1 : 0;
