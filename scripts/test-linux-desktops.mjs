#!/usr/bin/env node
// Disposable, real WM/compositor tests for the local Linux Flatpak. Does not use the host desktop.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARTIFACTS = join(ROOT, "artifacts");
const OUTPUT = join(ARTIFACTS, "linux-followup", "desktops");
const FIXTURE = join(ROOT, "scripts", "test-resources", "linux-desktop-v2.chemdraft");
const VALID = ["kwin-x11", "gnome-x11", "xfwm4", "openbox", "kwin-wayland", "gnome-wayland"];
const args = process.argv.slice(2);
let sessions = [...VALID];
let image = "chemdraft-desktops:local";
let prepareImage = false;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--sessions") sessions = (args[++index] ?? "").split(",");
  else if (arg === "--image") image = args[++index] ?? "";
  else if (arg === "--prepare-image") prepareImage = true;
  else if (arg === "--help") {
    console.log(`Usage: node scripts/test-linux-desktops.mjs [--prepare-image] [--sessions ${VALID.join(",")}] [--image chemdraft-desktops:local]\nRequires the local bundle and the host's system-installed org.gnome.Platform/x86_64/49 runtime. --prepare-image creates the Debian test image when missing (about 3 GiB), using KWin, GNOME Shell, xfwm4, Openbox, Xvfb, XWayland, xclip, xterm, xdotool, wmctrl, Flatpak and ImageMagick. Uses a separate container/private D-Bus/display for each session. Run with a self-contained Node 24 binary, which is mounted read-only into the container. Reserves three CPUs and at least 20 GiB disk space. No host desktop or authentication files are mounted.`);
    process.exit(0);
  } else throw new Error(`Unknown option: ${arg}`);
}
if (process.platform !== "linux") throw new Error("Desktop integration tests require Linux.");
if (!sessions.length || sessions.some((session) => !VALID.includes(session))) throw new Error("Unknown desktop test session.");
if (!/^[\w./:-]+$/.test(image) || image.startsWith("-")) throw new Error("Invalid Docker image name.");
for (const session of sessions) {
  const name = `chemdraft-wm-${session}`;
  const existing = spawnSync("docker", ["container", "inspect", name], { stdio: "ignore" });
  if (existing.status === 0) throw new Error(`Test container ${name} already exists; finish or clean up that test before starting another.`);
}
const allowed = /^Cpus_allowed_list:\s*(.*)$/m.exec(readFileSync("/proc/self/status", "utf8"))[1].trim().split(",").flatMap((part) => {
  const [first, last = first] = part.split("-").map(Number);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
});
if (allowed.length < 4) throw new Error("At least four available CPUs are needed to reserve three for the OS.");
const cpus = allowed.slice(0, -3).join(",");
const affinity = spawnSync("taskset", ["-apc", cpus, String(process.pid)], { stdio: "ignore" });
if (affinity.status !== 0) throw new Error("Could not enforce the CPU reserve.");
const dockerRoot = spawnSync("docker", ["info", "--format", "{{.DockerRootDir}}"], { encoding: "utf8" }).stdout.trim();
function checkDisk() {
  for (const path of [ARTIFACTS, dockerRoot]) {
    const value = statfsSync(path);
    if (value.bavail * value.bsize < 20 * 1024 ** 3) throw new Error(`Fewer than 20 GiB free at ${path}; tests stopped.`);
  }
}
function watchDisk(name, child, stopped) {
  const timer = setInterval(() => {
    try { checkDisk(); } catch (error) {
      clearInterval(timer);
      stopped(error.message);
      spawnSync("docker", ["stop", "--time", "3", name], { stdio: "ignore" });
      child.kill("SIGTERM");
    }
  }, 10_000);
  return timer;
}
const bundle = join(ARTIFACTS, "ChemDraft-linux-x86_64.flatpak");
if (!existsSync(bundle)) throw new Error("Build the local Linux Flatpak first.");
if (!existsSync(FIXTURE)) throw new Error(`Committed desktop fixture is missing: ${FIXTURE}`);
const bundleHash = createHash("sha256").update(readFileSync(bundle)).digest("hex");
mkdirSync(OUTPUT, { recursive: true });
let inspect = spawnSync("docker", ["image", "inspect", "--format", "{{json .}}", image], { encoding: "utf8" });
if (inspect.status !== 0 && prepareImage) {
  checkDisk();
  const name = "chemdraft-wm-image-prep";
  const packages = ["flatpak", "dbus", "dbus-x11", "xvfb", "xwayland", "xauth", "x11-utils", "x11-xserver-utils", "wmctrl", "xdotool", "imagemagick", "kwin-x11", "kwin-wayland", "plasma-workspace", "gnome-shell", "mutter", "xfwm4", "openbox", "xclip", "xterm", "xdg-desktop-portal", "xdg-desktop-portal-gtk", "xdg-desktop-portal-kde", "xdg-desktop-portal-gnome", "libgl1-mesa-dri", "libgbm1", "mesa-utils", "fonts-dejavu-core"];
  const command = `apt-get update && apt-get install -y --no-install-recommends ${packages.join(" ")} && useradd -m -u 1000 tester && mkdir -p /run/user/1000 && chown 1000:1000 /run/user/1000 && chmod 700 /run/user/1000 && apt-get clean && rm -rf /var/lib/apt/lists/*`;
  const log = createWriteStream(join(OUTPUT, "image-preparation.log"));
  let diskError;
  const status = await new Promise((resolveResult) => {
    const child = spawn("docker", ["run", "--name", name, "--label", "chemdraft.desktop-test=1", `--cpuset-cpus=${cpus}`, "--cpus=2", "--env", "DEBIAN_FRONTEND=noninteractive", "debian:13", "sh", "-c", command], { stdio: ["ignore", "pipe", "pipe"] });
    const monitor = watchDisk(name, child, (message) => { diskError = message; });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    child.on("exit", (code) => { clearInterval(monitor); resolveResult(code); });
    child.on("error", () => { clearInterval(monitor); resolveResult(1); });
  });
  log.end();
  if (diskError) throw new Error(diskError);
  if (status !== 0) throw new Error(`Desktop image preparation failed; see ${join(OUTPUT, "image-preparation.log")}.`);
  checkDisk();
  const committed = spawnSync("docker", ["commit", name, image], { stdio: "inherit" });
  if (committed.status !== 0) throw new Error("Could not commit the prepared desktop image.");
  spawnSync("docker", ["rm", name], { stdio: "ignore" });
  inspect = spawnSync("docker", ["image", "inspect", "--format", "{{json .}}", image], { encoding: "utf8" });
}
if (inspect.status !== 0) throw new Error(`Prepared desktop image is missing: ${image}; use --prepare-image.`);
const imageInfo = JSON.parse(inspect.stdout);
if (imageInfo.Size > 8 * 1024 ** 3) throw new Error("Desktop test image exceeds the 8 GiB budget.");
writeFileSync(join(OUTPUT, "system-bus.conf"), `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd"><busconfig><type>system</type><listen>unix:path=/run/dbus/system_bus_socket</listen><auth>EXTERNAL</auth><policy context="default"><allow user="*"/><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>\n`);
const summary = [];
for (const session of sessions) {
  checkDisk();
  rmSync(join(OUTPUT, session, "result.json"), { force: true });
  const name = `chemdraft-wm-${session}`;
  const log = createWriteStream(join(OUTPUT, `${session}-container.log`));
  const command = ["run", "--rm", "--name", name, "--label", "chemdraft.desktop-test=1", `--cpuset-cpus=${cpus}`, "--cpus=2", "--shm-size=768m",
    "--cap-add", "SYS_ADMIN", "--cap-add", "SYS_NICE", "--security-opt", "seccomp=unconfined", "--security-opt", "systempaths=unconfined",
    "--mount", "type=bind,src=/var/lib/flatpak,dst=/var/lib/flatpak,readonly",
    "--mount", `type=bind,src=${ARTIFACTS},dst=/artifacts`,
    "--mount", `type=bind,src=${process.execPath},dst=/test-tools/node,readonly`,
    "--mount", `type=bind,src=${FIXTURE},dst=/test-tools/desktop-fixture.chemdraft,readonly`,
    "--mount", `type=bind,src=${join(ROOT, "scripts", "test-linux-desktop-session.mjs")},dst=/test-tools/session.mjs,readonly`, image,
    "sh", "-c", "mkdir -p /run/dbus; dbus-uuidgen > /etc/machine-id; dbus-daemon --config-file=/artifacts/linux-followup/desktops/system-bus.conf --fork || exit 1; exec runuser -u tester -- env HOME=/home/tester XDG_RUNTIME_DIR=/run/user/1000 XDG_DATA_DIRS=/usr/local/share:/usr/share dbus-run-session -- /test-tools/node /test-tools/session.mjs \"$1\"", "desktop-test", session];
  const result = await new Promise((resolveResult) => {
    const child = spawn("docker", command, { stdio: ["ignore", "pipe", "pipe"] });
    let diskError;
    const monitor = watchDisk(name, child, (message) => { diskError = message; });
    const timer = setTimeout(() => {
      spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      child.kill("SIGTERM");
    }, 240_000);
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    child.on("error", (error) => { clearTimeout(timer); clearInterval(monitor); resolveResult({ code: 1, error: diskError ?? error.message }); });
    child.on("exit", (code) => { clearTimeout(timer); clearInterval(monitor); resolveResult({ code, ...(diskError ? { error: diskError } : {}) }); });
  });
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  log.end();
  const path = join(OUTPUT, session, "result.json");
  const record = { session, image, imageId: imageInfo.Id, imageBytes: imageInfo.Size, ...result,
    ...(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { status: "FAIL", error: "Container/session did not produce a result." }) };
  if (result.code !== 0) record.status = "FAIL";
  if (record.bundleSha256 !== bundleHash) {
    record.status = "FAIL";
    record.error = "The tested package differs from the package present when this run started.";
  }
  summary.push(record);
  writeFileSync(join(OUTPUT, "results.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`${session}: ${record.status} (${record.checks?.length ?? 0} checks)`);
}
process.exitCode = summary.some((result) => result.status !== "PASS") ? 1 : 0;
