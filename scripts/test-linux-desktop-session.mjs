#!/usr/bin/env node
// Runs inside the disposable desktop-test container; the host launcher supplies only test artifacts.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const session = process.argv[2];
const settings = {
  "kwin-x11": { desktop: "KDE", command: "kwin_x11", args: ["--no-kactivities"], manager: /KWin/i },
  "gnome-x11": { desktop: "GNOME", command: "gnome-shell", args: ["--x11", "--sm-disable"], manager: /GNOME Shell|Mutter/i },
  xfwm4: { desktop: "XFCE", command: "xfwm4", args: ["--compositor=off", "--sm-client-disable"], manager: /Xfwm4/i },
  openbox: { desktop: "OPENBOX", command: "openbox", args: ["--sm-disable"], manager: /Openbox/i },
  "kwin-wayland": { desktop: "KDE", command: "kwin_wayland", args: ["--virtual", "--width", "1600", "--height", "1000", "--xwayland", "--socket", "wayland-chemdraft", "--no-lockscreen", "--no-global-shortcuts", "--no-kactivities"], manager: /KWin/i, wayland: true },
  "gnome-wayland": { desktop: "GNOME", command: "gnome-shell", args: ["--headless", "--wayland", "--virtual-monitor=1600x1000", "--wayland-display=wayland-chemdraft", "--sm-disable"], manager: /GNOME Shell|Mutter/i, wayland: true }
};
assert.ok(Object.hasOwn(settings, session), "Known desktop test session");
const config = settings[session];
const output = `/artifacts/linux-followup/desktops/${session}`;
mkdirSync(output, { recursive: true });
const report = {
  session, desktop: config.desktop, transport: config.wayland ? "XWayland in a Wayland compositor" : "X11",
  startedAt: new Date().toISOString(), softwareRendering: true, applicationBackend: "GTK X11", status: "RUNNING", checks: []
};
const tasks = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app;
let main;
let palette;

function run(command, args = [], options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 10_000, env: process.env, ...options });
}
function checked(command, args = [], options = {}) {
  const result = run(command, args, options);
  assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return result.stdout.trim();
}
function start(command, args, log) {
  const descriptor = openSync(join(output, log), "w");
  const child = spawn(command, args, { env: process.env, detached: true, stdio: ["ignore", descriptor, descriptor] });
  tasks.push(child);
  return child;
}
async function until(test, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try { const value = test(); if (value) return value; } catch (caught) { error = caught; }
    await pause(200);
  }
  throw new Error(`Timed out: ${label}${error ? ` (${error.message})` : ""}`);
}
function pass(message) { report.checks.push(message); console.log(`PASS ${message}`); }
function clients() {
  return checked("wmctrl", ["-l"]).split("\n").filter(Boolean).map((line) => {
    const parts = /^(0x[0-9a-f]+)\s+\S+\s+\S+\s+(.*)$/i.exec(line);
    return parts && { id: parts[1], title: parts[2] };
  }).filter(Boolean);
}
function property(window, name) { return checked("xprop", ["-id", window, name]); }
function geometry(window) {
  const value = checked("xwininfo", ["-id", window]);
  // xdotool's position double-counts Mutter's external frame/shadow offsets; the X server's
  // absolute client coordinates are the correct target for mouse events on every manager.
  return {
    WINDOW: Number(window),
    X: Number(/Absolute upper-left X:\s*(-?\d+)/.exec(value)?.[1]),
    Y: Number(/Absolute upper-left Y:\s*(-?\d+)/.exec(value)?.[1]),
    WIDTH: Number(/Width:\s*(\d+)/.exec(value)?.[1]),
    HEIGHT: Number(/Height:\s*(\d+)/.exec(value)?.[1])
  };
}
function viewable(window) { return /Map State: IsViewable/.test(checked("xwininfo", ["-id", window])); }
function minimized(window) {
  // Compositors may leave an XWayland client's X window mapped while hiding its actor.
  // EWMH section 5.7: https://specifications.freedesktop.org/wm/latest/ar01s05.html
  return /_NET_WM_STATE_HIDDEN/.test(property(window, "_NET_WM_STATE"));
}
async function focus(window) {
  checked("wmctrl", ["-i", "-a", window]);
  await until(() => viewable(window) && !minimized(window), "focus target is restored and mapped");
  const bounds = geometry(window);
  // A real click supplies the user timestamp that focus-stealing prevention requires. The
  // right side of the tab/terminal background is empty, so this does not invoke an app command.
  checked("xdotool", ["mousemove", String(bounds.X + bounds.WIDTH - 40), String(bounds.Y + 40), "click", "1"]);
}
function active(window) {
  const value = checked("xprop", ["-root", "_NET_ACTIVE_WINDOW"]);
  const match = /0x[0-9a-f]+/i.exec(value);
  return Boolean(match && BigInt(match[0]) === BigInt(window));
}
async function dismissOverview() {
  if (config.desktop !== "GNOME") return;
  // GNOME starts a fresh user session in Activities. Use its public property rather than
  // testing application focus while the shell's overview still owns the keyboard.
  // https://github.com/GNOME/gnome-shell/blob/48.7/data/dbus-interfaces/org.gnome.Shell.xml
  await until(() => {
    const set = run("gdbus", ["call", "--session", "--dest", "org.gnome.Shell", "--object-path", "/org/gnome/Shell", "--method", "org.freedesktop.DBus.Properties.Set", "org.gnome.Shell", "OverviewActive", "<false>"], { timeout: 1500 });
    if (set.status !== 0) return false;
    const get = run("gdbus", ["call", "--session", "--dest", "org.gnome.Shell", "--object-path", "/org/gnome/Shell", "--method", "org.freedesktop.DBus.Properties.Get", "org.gnome.Shell", "OverviewActive"], { timeout: 1500 });
    return get.status === 0 && /false/.test(get.stdout);
  }, "GNOME Activities overview closes", 20_000);
}
function chemicalGraph(molecule) {
  const index = new Map(molecule.atoms.map((atom, position) => [atom.id, position]));
  return {
    structureFormat: molecule.structureFormat,
    structure: molecule.structure,
    atoms: molecule.atoms.map(({ id, x, y, ...identity }) => identity),
    bonds: molecule.bonds.map(({ id, fromAtomId, toAtomId, ...properties }) => ({
      ...properties, from: index.get(fromAtomId), to: index.get(toAtomId)
    }))
  };
}
async function copyMolecules(label, expected) {
  // A separate producer establishes a fresh selection, so a stale earlier copy cannot pass.
  const marker = run("xclip", ["-selection", "clipboard"], { input: `chemdraft-${label}-${Date.now()}`, timeout: 2000 });
  assert.ok(marker.status === 0 || marker.error?.code === "ETIMEDOUT", "Clipboard sentinel producer started");
  await focus(main.id);
  await until(() => active(main.id), `${label}: document focus`);
  checked("xdotool", ["key", "--clearmodifiers", "ctrl+a"]);
  checked("xdotool", ["key", "--clearmodifiers", "ctrl+c"]);
  const payload = await until(() => {
    const copied = run("xclip", ["-selection", "clipboard", "-o", "-t", "application/x-chemdraft-selection+json"], { timeout: 1500 });
    if (copied.status !== 0) return false;
    const result = JSON.parse(copied.stdout);
    return result.kind === "chemdraft-selection" ? result : false;
  }, `${label}: native chemical clipboard`, 15_000);
  const molecules = payload.objects.filter((object) => object.type === "molecule");
  const atoms = molecules.map((object) => object.atoms.length).sort((a, b) => a - b);
  assert.deepEqual(atoms, expected, `${label}: copied atom counts`);
  for (const molecule of molecules) {
    assert.equal(molecule.structure, molecule.atoms.length === 2 ? "CC" : "C1=CC=CC=C1", `${label}: fixture chemical identity`);
    if (report.clipboard) {
      const original = report.clipboard.objects.find((object) => object.type === "molecule" && object.atoms.length === molecule.atoms.length);
      assert.deepEqual(chemicalGraph(molecule), chemicalGraph(original), `${label}: atom identity, charge, bond orders and stereochemistry`);
    }
  }
  writeFileSync(join(output, `${label}-clipboard.json`), JSON.stringify(payload, null, 2));
  return payload;
}

try {
  process.env.XDG_RUNTIME_DIR = "/run/user/1000";
  process.env.XDG_CURRENT_DESKTOP = config.desktop;
  process.env.XDG_SESSION_DESKTOP = config.desktop;
  process.env.XDG_SESSION_TYPE = config.wayland ? "wayland" : "x11";
  process.env.LANG = "C.UTF-8";
  process.env.LC_ALL = "C.UTF-8";
  process.env.LIBGL_ALWAYS_SOFTWARE = "1";
  process.env.GDK_BACKEND = "x11";
  process.env.QT_QPA_PLATFORM = "xcb";
  process.env.KWIN_COMPOSE = "N";
  process.env.GNOME_SHELL_SESSION_MODE = "user";
  process.env.NO_AT_BRIDGE = "1";
  process.env.DISPLAY = ":99";
  report.osRelease = readFileSync("/etc/os-release", "utf8");
  report.flatpakVersion = checked("flatpak", ["--version"]);
  const bundle = "/artifacts/ChemDraft-linux-x86_64.flatpak";
  report.bundleSha256 = createHash("sha256").update(readFileSync(bundle)).digest("hex");
  copyFileSync("/test-tools/desktop-fixture.chemdraft", "/home/tester/desktop-fixture.chemdraft");

  start("Xvfb", [":99", "-screen", "0", "1600x1000x24", "-ac", "-nolisten", "tcp"], "xvfb.log");
  await until(() => existsSync("/tmp/.X11-unix/X99"), "isolated Xvfb");
  checked("xdpyinfo");
  checked("dbus-update-activation-environment", ["DISPLAY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XDG_RUNTIME_DIR"]);
  const wm = start(config.command, config.args, "window-manager.log");
  if (config.wayland) {
    await until(() => {
      assert.ok(wm.exitCode === null, "Wayland compositor remains running");
      const socket = readdirSync("/tmp/.X11-unix").filter((name) => /^X\d+$/.test(name) && name !== "X99")
        .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)))[0];
      if (!socket) return false;
      process.env.DISPLAY = `:${socket.slice(1)}`;
      // Mutter reserves a private authenticated XWayland server. Its cookie belongs only to
      // this disposable session and must accompany clients, just as a normal GNOME login does.
      if (config.desktop === "GNOME") {
        const authority = readdirSync(process.env.XDG_RUNTIME_DIR).find((name) => name.startsWith(".mutter-Xwaylandauth."));
        if (authority) process.env.XAUTHORITY = join(process.env.XDG_RUNTIME_DIR, authority);
      }
      return run("xdpyinfo", [], { timeout: 1000 }).status === 0;
    }, "compositor-owned XWayland display", 45_000);
    process.env.WAYLAND_DISPLAY = "wayland-chemdraft";
  }
  checked("dbus-update-activation-environment", ["DISPLAY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XDG_RUNTIME_DIR", ...(config.wayland ? ["WAYLAND_DISPLAY"] : [])]);
  report.display = process.env.DISPLAY;
  report.wmCheck = await until(() => {
    assert.ok(wm.exitCode === null, "Window manager remains running");
    const value = checked("xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"]);
    const id = /0x[0-9a-f]+/i.exec(value)?.[0];
    if (!id) return false;
    const name = property(id, "_NET_WM_NAME");
    return config.manager.test(name) && { id, name };
  }, "actual expected window manager", 45_000);
  report.wmCommand = [config.command, ...config.args];
  report.wmVersion = run(config.command, ["--version"], { env: { ...process.env, QT_QPA_PLATFORM: "offscreen" } }).stdout.trim();
  pass(`Actual ${config.desktop} window manager owns the private ${report.display} display`);
  if (config.desktop === "GNOME") {
    // Owning the X display precedes Shell's asynchronous startup animation. Hiding Activities
    // during that animation leaves its input grab/window group in an intermediate state.
    await until(() => readFileSync(join(output, "window-manager.log"), "utf8").includes("GNOME Shell started at"), "GNOME Shell startup completes");
  }
  await dismissOverview();
  await pause(1000);
  if (config.desktop === "GNOME") {
    const terminal = start("xterm", ["-title", "Desktop preflight", "-geometry", "35x5+400+400"], "preflight-terminal.log");
    const terminalWindow = await until(() => clients().find(({ title }) => title === "Desktop preflight"), "independent terminal preflight");
    await focus(terminalWindow.id);
    report.preflightTerminalFocus = await until(() => active(terminalWindow.id), "independent terminal receives focus");
    terminal.kill("SIGTERM");
  }

  const install = run("flatpak", ["install", "--user", "--noninteractive", "--assumeyes", "--no-deps", "--no-related", bundle], { timeout: 120_000 });
  writeFileSync(join(output, "install.log"), `${install.stdout}\n${install.stderr}`);
  assert.equal(install.status, 0, `Flatpak installation: ${install.stderr}`);

  app = start("flatpak", ["run", "--env=LIBGL_ALWAYS_SOFTWARE=1", "--env=WEBKIT_DISABLE_COMPOSITING_MODE=1", "org.chemdraft.desktop.dev", "/home/tester/desktop-fixture.chemdraft"], "app.log");
  await until(() => {
    assert.equal(app.exitCode, null, "Application remains running");
    const windows = clients();
    main = windows.find(({ title }) => /ChemDraft/.test(title) && !/Toolbar|Tooltip|Popover/.test(title));
    palette = windows.find(({ title }) => title === "ChemDraft Main Toolbar");
    return main && palette && windows.some(({ title }) => title === "ChemDraft Art Toolbar") && viewable(main.id);
  }, "document and both native palettes", 60_000);
  await pause(6000);
  pass("Editor and both native tool palettes are visible");

  await focus(main.id);
  await dismissOverview();
  await until(() => active(main.id), "document is active before window operations");

  checked("wmctrl", ["-i", "-r", main.id, "-b", "remove,maximized_vert,maximized_horz"]);
  report.initialGeometry = geometry(main.id);
  checked("wmctrl", ["-i", "-r", main.id, "-e", "0,120,40,1200,800"]);
  report.movedGeometry = await until(() => {
    const value = geometry(main.id);
    report.lastGeometry = value;
    return value.WIDTH === 1200 && value.HEIGHT === 800 && value.X >= 0 && value.Y >= 0 &&
      (Math.abs(value.X - report.initialGeometry.X) > 10 || Math.abs(value.Y - report.initialGeometry.Y) > 10) && value;
  }, "move and resize document");
  pass("Document window moves and resizes under the real window manager");
  report.clipboard = await copyMolecules("initial", [2, 6]);
  checked("xdotool", ["key", "--clearmodifiers", "ctrl+v"]);
  await pause(5000);
  await copyMolecules("pasted", [2, 2, 6, 6]);
  checked("xdotool", ["key", "--clearmodifiers", "ctrl+z"]);
  await pause(500);
  await copyMolecules("undone", [2, 6]);
  pass("Real Ctrl+A/C/V and Undo preserve the two molecules through native clipboard transfer");

  const other = start("xterm", ["-title", "ChemDraft desktop test focus target", "-geometry", "35x5+1100+820"], "focus-target.log");
  const otherWindow = await until(() => clients().find(({ title }) => title === "ChemDraft desktop test focus target"), "separate focus target");
  await focus(otherWindow.id);
  await until(() => active(otherWindow.id), "other application focus");
  const at = geometry(palette.id);
  checked("xdotool", ["mousemove", String(at.X + 29), String(at.Y + 38), "click", "1"]);
  await until(() => active(main.id), "palette click returns keyboard focus to document");
  other.kill("SIGTERM");
  pass("A native palette command returns focus from another application to the document");

  checked("xdotool", ["windowminimize", main.id]);
  report.minimizeSamples = [];
  await until(() => {
    const sample = { visible: viewable(main.id), state: property(main.id, "_NET_WM_STATE"), icccm: property(main.id, "WM_STATE"), active: checked("xprop", ["-root", "_NET_ACTIVE_WINDOW"]) };
    if (JSON.stringify(report.minimizeSamples.at(-1)) !== JSON.stringify(sample)) report.minimizeSamples.push(sample);
    return /_NET_WM_STATE_HIDDEN/.test(sample.state);
  }, "document minimizes");
  report.paletteVisibilityWhileMinimized = await until(() => {
    const palettes = clients().filter(({ title }) => /ChemDraft (Main|Art) Toolbar/.test(title))
      .map(({ id, title }) => ({ title, viewable: viewable(id), hidden: minimized(id) }));
    return palettes.length === 2 && palettes.every((window) => !window.viewable || window.hidden) && palettes;
  }, "both native palettes hide with the minimized document", 10_000);
  checked("wmctrl", ["-i", "-a", main.id]);
  await until(() => viewable(main.id) && !minimized(main.id), "document restores");
  report.restoredPalettes = await until(() => {
    const palettes = clients().filter(({ title }) => /ChemDraft (Main|Art) Toolbar/.test(title))
      .map(({ id, title }) => ({ id, title, viewable: viewable(id), hidden: minimized(id), geometry: geometry(id) }));
    return palettes.length === 2 && palettes.every((window) => window.viewable && !window.hidden) && palettes;
  }, "both native palettes restore with the document", 10_000);
  // Restoring the owner maps its palettes asynchronously. Click only once that transition is
  // complete, so a later utility-window map cannot invalidate the user's activation timestamp.
  await focus(main.id);
  await until(() => active(main.id), "restored document receives keyboard focus");
  await copyMolecules("restored", [2, 6]);
  pass("Document minimizes, restores and remains editable with its chemical graph unchanged");

  palette = clients().find(({ title }) => title === "ChemDraft Main Toolbar");
  checked("import", ["-window", main.id, join(output, "editor.png")], { timeout: 30_000 });
  checked("import", ["-window", palette.id, join(output, "main-palette.png")], { timeout: 30_000 });
  if (!config.wayland) checked("import", ["-window", "root", join(output, "desktop.png")], { timeout: 30_000 });
  report.screenshotColors = Number(checked("identify", ["-format", "%k", join(output, "editor.png")]));
  assert.ok(report.screenshotColors > 200, "Editor screenshot contains rendered UI");
  report.finalWindows = clients();
  writeFileSync(join(output, "windows.txt"), checked("xwininfo", ["-root", "-tree"]));
  assert.equal(app.exitCode, null, "Application is alive after all desktop operations");
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error.stack ?? error);
  try { report.failureRootProperties = checked("xprop", ["-root", "_NET_CURRENT_DESKTOP", "_NET_ACTIVE_WINDOW", "_NET_SHOWING_DESKTOP"]); } catch {}
  if (main) {
    try { report.failureMainProperties = property(main.id, "_NET_WM_STATE") + "\n" + property(main.id, "WM_STATE"); } catch {}
    try { checked("import", ["-window", main.id, join(output, "failure-editor.png")], { timeout: 10_000 }); } catch {}
  }
  try { writeFileSync(join(output, "failure-windows.txt"), checked("xwininfo", ["-root", "-tree"])); } catch {}
  try { checked("import", ["-window", "root", join(output, "failure.png")], { timeout: 10_000 }); } catch {}
} finally {
  if (app) run("flatpak", ["kill", "org.chemdraft.desktop.dev"], { timeout: 10_000 });
  for (const child of tasks.reverse()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
  report.completedAt = new Date().toISOString();
  writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
process.exitCode = report.status === "PASS" ? 0 : 1;
