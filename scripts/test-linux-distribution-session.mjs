#!/usr/bin/env node
// Runs only inside a private distribution-test container; all host inputs are read-only.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUTPUT = "/test-results";
const APP = "org.chemdraft.desktop.dev";
const BUNDLE = "/test-tools/ChemDraft.flatpak";
const report = { key: process.argv[2], startedAt: new Date().toISOString(), displayBackend: "X11/Xvfb without a window manager", softwareRendering: true, status: "RUNNING", checks: [] };
const tasks = [];
let app;
let main;
const pause = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
function run(command, args = [], options = {}) { return spawnSync(command, args, { encoding: "utf8", timeout: 10_000, env: process.env, ...options }); }
function checked(command, args = [], options = {}) {
  const result = run(command, args, options);
  assert.equal(result.status, 0, `${command}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return result.stdout.trim();
}
function start(command, args, log) {
  const descriptor = openSync(join(OUTPUT, log), "w");
  const child = spawn(command, args, { env: process.env, detached: true, stdio: ["ignore", descriptor, descriptor] });
  closeSync(descriptor);
  tasks.push(child);
  return child;
}
async function until(probe, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = probe(); if (result) return result; } catch (error) { last = error.message; }
    await pause(250);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last})` : ""}`);
}
function windows() {
  return [...checked("xwininfo", ["-root", "-tree"]).matchAll(/(0x[0-9a-f]+) "([^"]*ChemDraft[^"]*)"/gi)].map((match) => ({ id: match[1], title: match[2] }));
}
function viewable(window) { return /Map State: IsViewable/.test(checked("xwininfo", ["-id", window.id])); }
function pass(message) { report.checks.push(message); console.log(`PASS ${message}`); }

try {
  mkdirSync(OUTPUT, { recursive: true });
  process.env.DISPLAY = ":99";
  process.env.LANG = "C.UTF-8";
  process.env.LC_ALL = "C.UTF-8";
  process.env.GDK_BACKEND = "x11";
  process.env.LIBGL_ALWAYS_SOFTWARE = "1";
  process.env.NO_AT_BRIDGE = "1";
  report.osRelease = readFileSync("/etc/os-release", "utf8");
  report.flatpakVersion = checked("flatpak", ["--version"]);
  report.cpuList = /^Cpus_allowed_list:\s*(.+)$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1].trim();
  if (existsSync("/sys/fs/cgroup/cpu.max")) report.cpuMax = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim();
  report.packageBytes = statSync(BUNDLE).size;
  report.packageSha256 = createHash("sha256").update(readFileSync(BUNDLE)).digest("hex");
  const install = run("flatpak", ["install", "--user", "--noninteractive", "--assumeyes", "--no-deps", "--no-related", BUNDLE], { timeout: 120_000 });
  writeFileSync(join(OUTPUT, "install.log"), `${install.stdout}\n${install.stderr}`);
  assert.equal(install.status, 0, `Flatpak install: ${install.error?.message ?? install.stderr}`);
  report.flatpakInfo = checked("flatpak", ["info", "--user", APP]);
  pass("The exact local bundle installs into the private test user's Flatpak data");
  copyFileSync("/test-tools/desktop-fixture.chemdraft", "/home/tester/desktop-fixture.chemdraft");
  start("Xvfb", [":99", "-screen", "0", "1600x1000x24", "-ac", "-nolisten", "tcp"], "xvfb.log");
  await until(() => existsSync("/tmp/.X11-unix/X99"), "private Xvfb display");
  app = start("flatpak", ["run", "--env=LIBGL_ALWAYS_SOFTWARE=1", "--env=WEBKIT_DISABLE_COMPOSITING_MODE=1", APP, "/home/tester/desktop-fixture.chemdraft"], "app.log");
  let paletteWindows;
  await until(() => {
    assert.equal(app.exitCode, null, "Application remains alive");
    const clients = windows();
    main = clients.find(({ title }) => !/Toolbar|Tooltip|Popover/.test(title));
    paletteWindows = clients.filter(({ title }) => /^ChemDraft (Main|Art) Toolbar$/.test(title));
    return main && viewable(main) && paletteWindows.length === 2 && paletteWindows.every(viewable);
  }, "rendered document and two native tool palettes", 90_000);
  // Xvfb has no window manager. Position the actual clients through X11, as the old
  // distribution harness did with XMoveWindow, before collecting their screenshots.
  checked("xdotool", ["windowmove", main.id, "24", "24"]);
  checked("xdotool", ["windowsize", main.id, "1300", "900"]);
  checked("xdotool", ["windowmove", paletteWindows.find(({ title }) => title.includes("Main")).id, "30", "100"]);
  checked("xdotool", ["windowmove", paletteWindows.find(({ title }) => title.includes("Art")).id, "30", "520"]);
  await pause(30_000);
  assert.equal(app.exitCode, null, "Application stays alive after startup");
  report.mainWindow = main;
  report.paletteWindows = windows().filter(({ title }) => /^ChemDraft (Main|Art) Toolbar$/.test(title));
  assert.equal(report.paletteWindows.length, 2);
  assert.ok(report.paletteWindows.every(viewable));
  pass("Document and both native palettes remain visible after 30 seconds");
  checked("xdotool", ["windowfocus", "--sync", main.id]);
  checked("xdotool", ["key", "--clearmodifiers", "ctrl+a", "ctrl+c"]);
  const copied = await until(() => {
    const result = run("xclip", ["-selection", "clipboard", "-o", "-t", "application/x-chemdraft-selection+json"], { timeout: 1500 });
    if (result.status !== 0) return false;
    const payload = JSON.parse(result.stdout);
    const molecules = payload.objects.filter((object) => object.type === "molecule");
    assert.deepEqual(molecules.map(({ atoms }) => atoms.length).sort((a, b) => a - b), [2, 6]);
    assert.deepEqual(molecules.map(({ structure }) => structure).sort(), ["C1=CC=CC=C1", "CC"]);
    return payload;
  }, "loaded fixture's actual chemical clipboard", 15_000);
  writeFileSync(join(OUTPUT, "fixture-clipboard.json"), JSON.stringify(copied, null, 2) + "\n");
  pass("The committed legacy fixture opened and copied both expected molecules");
  checked("import", ["-window", "root", join(OUTPUT, "desktop.png")], { timeout: 30_000 });
  checked("import", ["-window", main.id, join(OUTPUT, "editor.png")], { timeout: 30_000 });
  report.screenshotColors = Number(checked("identify", ["-format", "%k", join(OUTPUT, "editor.png")]));
  assert.ok(report.screenshotColors > 200, "Editor screenshot contains rendered UI");
  writeFileSync(join(OUTPUT, "windows.txt"), checked("xwininfo", ["-root", "-tree"]));
  pass("Screenshots capture the rendered editor and native palettes");
  report.aliveAfterStartup = app.exitCode === null;
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error.stack ?? error);
  try { writeFileSync(join(OUTPUT, "failure-windows.txt"), checked("xwininfo", ["-root", "-tree"])); } catch {}
  try { checked("import", ["-window", "root", join(OUTPUT, "failure.png")], { timeout: 10_000 }); } catch {}
} finally {
  if (app) run("flatpak", ["kill", APP], { timeout: 10_000 });
  for (const child of tasks.reverse()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
  report.completedAt = new Date().toISOString();
  writeFileSync(join(OUTPUT, "result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
process.exitCode = report.status === "PASS" ? 0 : 1;
