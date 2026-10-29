#!/usr/bin/env node
// Native WebKit/GTK integration checks for a previously staged Linux development build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { basename, resolve } from 'node:path';
import { createLinuxBuildGuard, reserveLinuxBuildCpus } from './linux-build-resources.mjs';

const root = resolve(import.meta.dirname, '..');
const options = {
  tauriDriver: process.env.CHEMDRAFT_SMOKE_TAURI_DRIVER || 'tauri-driver',
  buildDir: 'artifacts/flatpak-build', app: process.env.CHEMDRAFT_SMOKE_APP || '/app/bin/chemdraft',
  outputDir: 'artifacts', port: process.env.CHEMDRAFT_SMOKE_DRIVER_PORT || '4448',
  display: process.env.CHEMDRAFT_SMOKE_DISPLAY || ':99',
};
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/smoke-linux-native.mjs [options]

  --tauri-driver PATH  tauri-driver 2.1.0 executable (default: resolve tauri-driver on PATH)
  --build-dir PATH     Initialized/staged GNOME SDK 49 directory (default: artifacts/flatpak-build)
  --app PATH           Application visible inside the SDK (default: /app/bin/chemdraft)
  --output-dir PATH    Evidence directory (default: artifacts)
  --display :N         Private unused Xvfb display (default: :99)
  --port N             Private unused WebDriver port; N+1 must also be free (default: 4448)
  --help               Show this help

Requires Node 24+, Flatpak, Xvfb, GNOME SDK 49 and a staged current development build.
Runs eight native WebKit/GTK checks under C.UTF-8 using the tracked legacy fixture.
Reserves three CPUs. Existing X displays/ports are refused; cleanup signals only own process groups.
CHEMDRAFT_SMOKE_REQUIRE_PACKAGED=0 permits a deliberately incomplete development staging tree.`);
  process.exit(0);
}
const optionKeys = { '--tauri-driver': 'tauriDriver', '--build-dir': 'buildDir', '--app': 'app', '--output-dir': 'outputDir', '--display': 'display', '--port': 'port' };
for (let index = 0; index < args.length; index++) {
  const key = optionKeys[args[index]];
  const value = args[++index];
  if (!key || !value || value.startsWith('--') || /[\r\n\0]/.test(value)) throw new Error('Invalid argument; use --help.');
  options[key] = value;
}
if (process.platform !== 'linux') throw new Error('The native Linux smoke must run on Linux.');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error(`Node 24 or newer is required; running ${process.execPath} (${process.version}).`);
if (!/^:[0-9]+$/.test(options.display)) throw new Error('--display must be a private display number such as :99.');
if (!/^[0-9]+$/.test(options.port) || Number(options.port) < 1024 || Number(options.port) > 65534) throw new Error('--port must be an integer from 1024 through 65534.');
const buildDir = resolve(root, options.buildDir);
const outputDir = resolve(root, options.outputDir);
const artifact = name => resolve(outputDir, name);
const app = options.app;
const requirePackaged = process.env.CHEMDRAFT_SMOKE_REQUIRE_PACKAGED !== '0';
const port = Number(options.port);
const display = options.display;
const fixture = resolve(root, 'scripts/test-resources/linux-desktop-v2.chemdraft');
const base = `http://127.0.0.1:${port}`;
const profile = artifact(`native-smoke-profile/run-${Date.now()}`);
const report = { app, buildDir, fixture, display, port, profile, nodeVersion: process.version, nodeExecutable: process.execPath, checks: [], status: 'RUNNING' };
const processes = [];
const logs = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const interruption = new AbortController();
let session;

async function assertUnusedDisplay() {
  for (const path of [`/tmp/.X11-unix/X${display.slice(1)}`, `/tmp/.X${display.slice(1)}-lock`]) {
    try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Display ${display} is already reserved (${path}); choose --display with an unused number. Nothing was stopped.`);
  }
}
async function assertUnusedPort(value) {
  const probe = createServer();
  await new Promise((resolveProbe, reject) => {
    probe.once('error', error => reject(new Error(`Port ${value} is unavailable (${error.code}); choose another --port. Nothing was stopped.`)));
    probe.listen({ host: '127.0.0.1', port: value, exclusive: true }, () => probe.close(resolveProbe));
  });
}
async function executablePath(value) {
  const candidates = value.includes('/') ? [resolve(root, value)] : (process.env.PATH || '').split(':').filter(Boolean).map(directory => resolve(directory, value));
  for (const path of candidates) { try { await access(path, constants.X_OK); return path; } catch {} }
  throw new Error(`tauri-driver executable unavailable: ${value}; provide --tauri-driver PATH.`);
}
await access(resolve(buildDir, 'metadata'));
await access(fixture);
const tauriDriver = await executablePath(options.tauriDriver);
report.tauriDriver = tauriDriver;
await assertUnusedDisplay();
await assertUnusedPort(port);
await assertUnusedPort(port + 1);
report.cpuAffinity = reserveLinuxBuildCpus();
const diskGuard = createLinuxBuildGuard([buildDir, outputDir]);
const interrupt = signal => interruption.abort(new Error(`Native smoke interrupted by ${signal}.`));
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);
const diskMonitor = setInterval(() => {
  try { diskGuard.check(); } catch (error) { interruption.abort(error); }
}, 10000);

function assertRunning(child, name) {
  if (child.startError || child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} exited before readiness: ${child.startError?.message || child.signalCode || child.exitCode}`);
}

function start(command, args, logName) {
  const log = createWriteStream(artifact(logName));
  log.once('error', error => interruption.abort(error));
  logs.push(log);
  const child = spawn(command, args, {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.once('error', error => { child.startError = error; });
  child.stdout.pipe(log); child.stderr.pipe(log);
  processes.push(child);
  return child;
}
async function request(method, path, data) {
  const response = await fetch(`${base}${path}`, {
    method, headers: data === undefined ? undefined : { 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.any([AbortSignal.timeout(60000), interruption.signal]),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(result)}`);
  return result.value;
}
const execute = (script, args = []) => request('POST', `/session/${session}/execute/sync`, { script, args });
async function executeAsync(script, args = []) {
  const result = await request('POST', `/session/${session}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      Promise.resolve().then(async () => { ${script} }).then(value => done({ ok: true, value }), error => done({ ok: false, error: String(error?.stack || error) }));`,
    args,
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const invoke = (command, args = {}) => executeAsync('return await window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]);', [command, args]);
async function waitFor(predicate, description, milliseconds = 30000) {
  const until = Date.now() + milliseconds;
  let latest;
  while (Date.now() < until) {
    interruption.signal.throwIfAborted();
    try { const value = await predicate(); if (value) return value; } catch (error) { latest = error; }
    await delay(200);
  }
  throw new Error(`Timed out: ${description}${latest ? ` (${latest})` : ''}`);
}
async function screenshot(name = 'linux-native-smoke.png') {
  const png = await request('GET', `/session/${session}/screenshot`);
  await writeFile(artifact(name), Buffer.from(png, 'base64'));
}
function check(message) { report.checks.push(message); console.log(`PASS ${message}`); }

try {
  await mkdir(profile, { recursive: true });
  const xvfb = start('/usr/bin/Xvfb', [display, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp', '-ac'], 'linux-native-smoke.xvfb.log');
  await waitFor(async () => { assertRunning(xvfb, 'Own Xvfb'); await access(`/tmp/.X11-unix/X${display.slice(1)}`); return true; }, 'own Xvfb display');
  const driver = start('flatpak', [
    'build', '--filesystem=host', '--socket=x11', '--share=ipc', '--share=network',
    `--filesystem=${resolve(root, 'scripts/test-resources')}:ro`,
    `--env=DISPLAY=${display}`, '--env=GDK_BACKEND=x11', '--env=LIBGL_ALWAYS_SOFTWARE=1',
    '--env=WEBKIT_DISABLE_COMPOSITING_MODE=1', '--env=TAURI_WEBVIEW_AUTOMATION=true',
    '--env=LC_ALL=C.UTF-8', '--env=GTK_MODULES=', '--env=FONTCONFIG_FILE=/etc/fonts/fonts.conf', '--env=FONTCONFIG_PATH=/etc/fonts',
    `--env=XDG_DATA_HOME=${profile}/data`,
    `--env=XDG_CONFIG_HOME=${profile}/config`,
    `--env=XDG_CACHE_HOME=${profile}/cache`,
    buildDir, tauriDriver,
    '--port', String(port), '--native-port', String(port + 1), '--native-driver', '/usr/bin/WebKitWebDriver',
  ], 'linux-native-smoke.driver.log');
  await waitFor(async () => { assertRunning(driver, 'Own tauri-driver'); const status = await request('GET', '/status'); assertRunning(driver, 'Own tauri-driver'); return status; }, 'own tauri-driver');
  const opened = await request('POST', '/session', { capabilities: { alwaysMatch: {
    'tauri:options': { application: app, args: ['--chemdraft-agent-bridge', fixture] },
  } } });
  session = opened.sessionId;
  assert.ok(session, 'WebDriver session created');
  await request('POST', `/session/${session}/timeouts`, { script: 60000, pageLoad: 60000, implicit: 0 });
  await waitFor(async () => {
    for (const handle of await request('GET', `/session/${session}/window/handles`)) {
      await request('POST', `/session/${session}/window`, { handle });
      if (await execute('return Boolean(window.__CHEMDRAFT_AGENT__);')) return true;
    }
    return false;
  }, 'explicitly enabled document agent bridge', 45000);
  const snapshot = await waitFor(async () => {
    const state = await execute('return window.__CHEMDRAFT_AGENT__.snapshot();');
    return state.file?.path?.endsWith(basename(fixture)) && state.objects?.length === 2 ? state : false;
  }, 'CLI document fixture loaded', 45000);
  report.title = await execute('return document.title;');
  report.build = snapshot.build;
  report.runtime = snapshot.runtime;
  report.file = snapshot.file;
  report.molecules = snapshot.objects.map(({ id, type, atomCount, bondCount }) => ({ id, type, atomCount, bondCount }));
  const expectedStamp = (await readFile(resolve(root, 'apps/desktop/src/MainWindow.tsx'), 'utf8')).match(/const CURRENT_BUILD_STAMP = "([^"]+)"/)[1];
  assert.ok(snapshot.build.includes(expectedStamp), `build stamp ${expectedStamp}`);
  assert.ok(snapshot.build.includes('chemdraft [linux-port]'), 'worktree build label');
  assert.equal(snapshot.runtime.desktop, true);
  assert.deepEqual(snapshot.objects.map(object => object.atomCount), [6, 2]);
  assert.deepEqual(snapshot.objects.map(object => object.bondCount), [6, 1]);
  check('Native WebKit editor renders the current build and loads the two-molecule CLI document');
  await screenshot();

  const unicode = 'Grüße aus Linux — αβ CCO';
  const textItems = [
    { type: 'application/x-chemdraft-selection+json', text: '{"kind":"smoke","atoms":[]}' },
    { type: 'chemical/x-cdxml', text: '<CDXML><page id="1"/></CDXML>' },
    { type: 'chemical/x-mdl-molfile', text: 'ChemDraft smoke\n  Linux\n\n  0  0  0  0  0  0            999 V2000\nM  END\n' },
    { type: 'text/plain', text: unicode },
  ];
  await invoke('write_clipboard_text_items', { items: textItems });
  const clipboard = await invoke('read_clipboard_payload');
  for (const item of textItems) assert.ok(clipboard.textItems.some(actual => actual.type === item.type && actual.text === item.text), `clipboard preserves ${item.type}`);
  report.clipboard = { types: clipboard.types, textTypes: clipboard.textItems.map(item => item.type), unicode };
  check('Native GTK clipboard round-trips Unicode, ChemDraft selection JSON, CDXML and MOL MIME formats');

  // Exercise WebKit's real keyboard editing path in a disposable text field, keeping the drawing
  // untouched. These actions complement the Rust menu routing tests and native MIME round-trip.
  try {
  await delay(1500);
  await invoke('focus_main_document_window');
  await invoke('write_clipboard_text_items', { items: [{ type: 'text/plain', text: 'copy sentinel' }] });
  await execute(`const field = document.createElement('input');
    field.id = 'linux-native-smoke-field'; field.value = arguments[0];
    field.style.cssText = 'position:fixed;top:80px;left:24px;width:400px;z-index:2147483647';
    document.body.append(field); field.focus(); field.select();`, [unicode]);
  const controlKey = String.fromCodePoint(0xE009);
  const chord = async key => request('POST', `/session/${session}/actions`, { actions: [{
    type: 'key', id: 'native-smoke-keyboard', actions: [
      { type: 'keyDown', value: controlKey }, { type: 'keyDown', value: key },
      { type: 'keyUp', value: key }, { type: 'keyUp', value: controlKey },
    ],
  }] });
  const fieldElement = await request('POST', `/session/${session}/element`, { using: 'css selector', value: '#linux-native-smoke-field' });
  const fieldId = fieldElement['element-6066-11e4-a52e-4f735466cecf'];
  await request('POST', `/session/${session}/element/${fieldId}/click`, {});
  await chord('a');
  report.keyboardBefore = await execute('const field = document.getElementById("linux-native-smoke-field"); return { hasFocus: document.hasFocus(), active: document.activeElement?.id, value: field.value, start: field.selectionStart, end: field.selectionEnd };');
  await chord('c');
  await waitFor(async () => {
    report.keyboardClipboard = await invoke('read_clipboard_payload');
    return report.keyboardClipboard.textItems.some(item => item.type === 'text/plain' && item.text === unicode);
  }, 'native text field Ctrl+C');
  const pasted = 'Einfügen β — CCO';
  await invoke('write_clipboard_text_items', { items: [{ type: 'text/plain', text: pasted }] });
  await chord('v');
  await waitFor(() => execute('return document.getElementById("linux-native-smoke-field").value === arguments[0];', [pasted]), 'native text field Ctrl+V');
  await chord('a');
  await chord('x');
  await waitFor(() => execute('return document.getElementById("linux-native-smoke-field").value === "";'), 'native text field Ctrl+X');
  await waitFor(async () => (await invoke('read_clipboard_payload')).textItems.some(item => item.type === 'text/plain' && item.text === pasted), 'cut text reached GTK clipboard');
  await execute('document.getElementById("linux-native-smoke-field").remove();');
  check('Real WebKit Ctrl+C, Ctrl+V and Ctrl+X edit a focused Unicode text field and transfer the GTK clipboard');
  } catch (error) {
    report.failures ??= [];
    report.failures.push({ check: 'Native Unicode text field clipboard keyboard editing', error: error.stack || String(error) });
    console.log(`FAIL Native Unicode keyboard editing: ${error}`);
    await execute('document.getElementById("linux-native-smoke-field")?.remove();').catch(() => {});
  }

  const png = await readFile(resolve(root, 'apps/desktop/src-tauri/icons/32x32.png'));
  await invoke('write_clipboard_image', { pngBytes: Array.from(png) });
  const imageClipboard = await invoke('read_clipboard_payload');
  assert.ok(imageClipboard.types.includes('image/png'));
  assert.equal(imageClipboard.textItems.length, 0);
  report.pngClipboard = { types: imageClipboard.types, bytes: png.length };
  check('Native PNG clipboard is advertised as image/png and never decoded as text');

  report.opsin = await invoke('opsin_status');
  if (requirePackaged) assert.equal(report.opsin.available, true, report.opsin.reason);
  if (report.opsin.available) {
    report.ethanol = await invoke('opsin_name_to_structure', { name: 'ethanol' });
    assert.ok(['CCO', 'C(C)O'].includes(report.ethanol.smiles), 'OPSIN returns an ethanol SMILES');
    check('Bundled OPSIN Java runtime converts ethanol to an equivalent ethanol SMILES through native IPC');
  }
  report.sidecar = await invoke('engine3d_sidecar_status');
  if (requirePackaged) {
    assert.equal(report.sidecar.available, true);
    assert.equal(report.sidecar.source, 'bundled');
    check('Packaged native Linux 3D sidecar resolves beside the executable');
  }
  report.ocsrEngine = await invoke('ocsr_engine_status');
  report.namingEngine = await invoke('naming_engine_status');
  assert.equal(report.ocsrEngine.state, 'notInstalled');
  assert.equal(report.ocsrEngine.requiredDiskBytes, 8_000_000_000);
  assert.equal(report.namingEngine.state, 'notInstalled');
  assert.equal(report.namingEngine.requiredDiskBytes, 1_000_000_000);
  await access(resolve(buildDir, 'files/bin/chemdraft-terminal'));
  check('Linux engine installers report supported/not installed with 8 GB OCSR and 1 GB naming space requirements; bundled login terminal is staged');

  report.bridgeGate = await invoke('agent_bridge_status');
  assert.equal(report.bridgeGate.enabled, true);
  await delay(2500);
  const finalState = await execute('return window.__CHEMDRAFT_AGENT__.snapshot();');
  assert.deepEqual(finalState.objects.map(object => object.atomCount), [6, 2]);
  await screenshot();
  check('Editor remains responsive after background palette/tooltip prewarm and native operations');
  report.status = report.failures?.length ? 'FAIL' : 'PASS';
  if (report.status === 'FAIL') process.exitCode = 1;
} catch (error) {
  report.status = 'FAIL'; report.error = error.stack || String(error);
  if (session) await screenshot('linux-native-smoke-failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  try {
    await writeFile(artifact('linux-native-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (session) await request('DELETE', `/session/${session}`).catch(() => {});
    // Never look up or signal a PID by a display/port name: these are only our detached children.
    const ownGroups = processes.reverse().filter(child => Number.isInteger(child.pid) && child.pid > 0);
    for (const child of ownGroups) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
    }
    await delay(500);
    for (const child of ownGroups) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
    }
    for (const log of logs) log.end();
    clearInterval(diskMonitor);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}
