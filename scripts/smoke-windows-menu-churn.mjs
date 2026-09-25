#!/usr/bin/env node
// Windows-only crash smoke for the menu-subclass use-after-free (see `install_app_menu` in
// apps/desktop/src-tauri/src/lib.rs). It launches the INSTALLED app with a WebView2 DevTools port,
// races whole-menu rebuilds (set_keybinding_scheme) against palette/Preferences/3D-debugger window
// creation, show and hide, closes each run through the close button's WM_CLOSE path, and fails if
// Windows logged a ChemDraft crash. Before the fix this crashed on every cycle; after it, none.
//
//   node scripts/smoke-windows-menu-churn.mjs [--cycles 4] [--rounds 25] [--exe <path>]

import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

if (process.platform !== "win32") {
  console.log("smoke-windows-menu-churn: Windows only, skipping.");
  process.exit(0);
}

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const cycles = Number(option("cycles", 4));
const rounds = Number(option("rounds", 25));
const exe = option("exe", path.join(process.env.LOCALAPPDATA ?? "", "ChemDraft", "chemdraft.exe"));
const port = 9222;
const churnToolsets = ["core.annotations", "core.arrows", "core.layout", "core.orbitals", "core.structure", "core.style", "core.text"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync(exe)) {
  console.error(`smoke-windows-menu-churn: no ChemDraft at ${exe} (pass --exe).`);
  process.exit(2);
}

function powershell(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
}

// Cleanup: "no such process" is the expected, happy outcome, and PowerShell reports it as a failure.
function stopProcesses(filter) {
  powershell(`Get-Process ${filter} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0`);
}

async function mainPage() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((p) => p.type === "page" && !p.url.includes("window=") && p.url.includes("localhost"));
      if (page) return page;
    } catch {
      // DevTools endpoint not up yet.
    }
    await sleep(500);
  }
  throw new Error("main page never appeared on the DevTools port");
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const evaluate = (expression, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("IPC round timed out (app hung or crashed)"));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message.result?.result?.value);
    });
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { evaluate, close: () => ws.close() };
}

const invoke = (command, payload = {}) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(payload)})`;
const settleAll = (calls) => `Promise.allSettled([${calls.join(",")}]).then((r) => r.filter((x) => x.status === "rejected").length)`;

async function stress(cdp) {
  await sleep(4000); // let startup palette restore and the first menu pushes finish
  const states = (await cdp.evaluate(invoke("list_toolset_window_states"))) ?? [];
  const open = new Set(states.filter((state) => state.open).map((state) => state.toolsetId));
  const toolsets = churnToolsets.filter((id) => !open.has(id));
  for (let round = 0; round < rounds; round++) {
    const scheme = round % 2 === 0 ? "chemdraw" : "chemdraft";
    const other = scheme === "chemdraw" ? "chemdraft" : "chemdraw";
    const toolset = toolsets[round % toolsets.length];
    // Fired together so rebuild closures interleave with window creation on the main thread.
    await cdp.evaluate(settleAll([
      invoke("set_keybinding_scheme", { scheme }),
      invoke("open_toolset_window", { toolsetId: toolset }),
      invoke("set_keybinding_scheme", { scheme: other }),
      invoke("toggle_preferences_window"),
      invoke("set_keybinding_scheme", { scheme }),
      invoke("toggle_spin3d_debugger_window"),
      invoke("show_toolset_tooltip_window")
    ]));
    await sleep(120);
    await cdp.evaluate(settleAll([
      invoke("close_toolset_window", { toolsetId: toolset }),
      invoke("hide_toolset_tooltip_window"),
      invoke("set_keybinding_scheme", { scheme: "chemdraft" }),
      invoke("toggle_preferences_window"),
      invoke("toggle_spin3d_debugger_window")
    ]));
    await sleep(60);
  }
}

const startedAt = new Date();
let failures = 0;
stopProcesses("chemdraft");
await sleep(1500);

for (let cycle = 1; cycle <= cycles; cycle++) {
  const child = spawn(exe, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
  });
  let exitCode;
  child.on("exit", (code) => {
    exitCode = code;
  });
  try {
    const cdp = await connect((await mainPage()).webSocketDebuggerUrl);
    await stress(cdp);
    cdp.close();
    // Close-button path: WM_CLOSE on the document window -> CloseRequested -> app.exit(0). Found by
    // class + exact title: Process.MainWindowHandle can name a palette, whose close is not a quit.
    const closeResult = powershell(`Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; $h = [W.U]::FindWindow('Tauri Window', 'ChemDraft'); if ($h -eq [IntPtr]::Zero) { 'no document window' } else { [void][W.U]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero); 'posted' }`);
    for (let waited = 0; exitCode === undefined && waited < 15000; waited += 250) {
      await sleep(250);
      if (powershell(`if (Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`) === "gone") {
        exitCode ??= 0;
      }
    }
    if (exitCode !== 0) {
      failures++;
      console.log(`cycle ${cycle}: WM_CLOSE ${closeResult}; exit code ${exitCode === undefined ? "none (still running)" : `0x${(exitCode >>> 0).toString(16)}`}`);
    } else {
      console.log(`cycle ${cycle}: ${rounds} rounds, clean exit`);
    }
  } catch (error) {
    failures++;
    console.log(`cycle ${cycle}: ${error.message}`);
  }
  stopProcesses(`-Id ${child.pid}`);
  await sleep(1500);
}

const crashes = powershell(
  `@(Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'; StartTime=[datetime]'${startedAt.toISOString()}'} -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'chemdraft' }).Count`
);
console.log(`crash events: ${crashes}`);
process.exit(failures === 0 && crashes === "0" ? 0 : 1);
