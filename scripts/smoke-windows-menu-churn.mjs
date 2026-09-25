#!/usr/bin/env node
// Windows-only crash smoke for the menu-subclass use-after-free (see `install_app_menu` in
// apps/desktop/src-tauri/src/lib.rs). It launches the INSTALLED app with a WebView2 DevTools port,
// races whole-menu rebuilds (set_keybinding_scheme) against palette/Preferences/3D-debugger window
// creation, show and hide, closes each run through the close button's WM_CLOSE path, and fails if
// Windows logged a ChemDraft crash. Before the fix this crashed on every cycle; after it, none.
//
//   node scripts/smoke-windows-menu-churn.mjs [--cycles 4] [--rounds 25] [--exe <path>]
//
// The default --exe is the build this worktree installs: `ChemDraft (dev)` on a branch, `ChemDraft`
// on main (see scripts/desktop-tauri.mjs, which gives branch builds their own product name).

import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_PRODUCT_NAME, worktreeIdentity } from "./worktree-identity.mjs";

if (process.platform !== "win32") {
  console.log("smoke-windows-menu-churn: Windows only, skipping.");
  process.exit(0);
}

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const positiveInteger = (name, fallback) => {
  const value = Number(option(name, fallback));
  if (!Number.isInteger(value) || value < 1) {
    console.error(`smoke-windows-menu-churn: --${name} must be a positive integer (got ${option(name, fallback)}).`);
    process.exit(2);
  }
  return value;
};
const cycles = positiveInteger("cycles", 4);
const rounds = positiveInteger("rounds", 25);
const productName = worktreeIdentity(ROOT_DIR).branch === "main" ? "ChemDraft" : DEV_PRODUCT_NAME;
const exe = path.resolve(option("exe", path.join(process.env.LOCALAPPDATA ?? "", productName, "chemdraft.exe")));
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

const psString = (value) => `'${value.replaceAll("'", "''")}'`;

// Stop only instances of the exe under test — never the stable app or another worktree's build the
// user has open. "No such process" is the expected, happy outcome, and PowerShell reports it as a
// failure. Run from inside a packaged (MSIX) app such as a terminal or agent host, %LOCALAPPDATA%
// writes are virtualized, and a process reports `…\Packages\<app>\LocalCache\Local\…` for the same
// file; that prefix is folded back before comparing.
function stopInstancesOfExe() {
  powershell(
    `$target = ${psString(exe)}; Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and (([IO.Path]::GetFullPath($_.Path) -replace '^.*\\\\Packages\\\\[^\\\\]+\\\\LocalCache\\\\Local\\\\', ($env:LOCALAPPDATA + '\\')) -ieq $target) } | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0`
  );
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
  // Rejects on a protocol error or a thrown/rejected expression: a smoke that resolves `undefined`
  // for "the page threw" would count a broken run as a clean one.
  const evaluate = (expression, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("IPC round timed out (app hung or crashed)"));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) {
        reject(new Error(`DevTools error: ${message.error.message}`));
      } else if (message.result?.exceptionDetails) {
        const details = message.result.exceptionDetails;
        reject(new Error(`page threw: ${details.exception?.description ?? details.text}`));
      } else {
        resolve(message.result?.result?.value);
      }
    });
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { evaluate, close: () => ws.close() };
}

const invoke = (command, payload = {}) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(payload)})`;
// Resolves to the rejection messages, so a command that starts failing fails the smoke instead of
// being swallowed by allSettled.
const settleAll = (calls) =>
  `Promise.allSettled([${calls.join(",")}]).then((r) => r.filter((x) => x.status === "rejected").map((x) => String(x.reason)))`;

async function round(cdp, label, calls) {
  const rejected = await cdp.evaluate(settleAll(calls));
  if (!Array.isArray(rejected)) {
    throw new Error(`${label}: no result from the page`);
  }
  if (rejected.length > 0) {
    throw new Error(`${label}: ${rejected.length} command(s) rejected: ${rejected.join("; ")}`);
  }
}

// The document target is listed before its first navigation commits: for a few hundred ms it is
// still about:blank with no Tauri bridge. Wait for the bridge; never having one is a failure.
async function waitForTauriBridge(cdp) {
  for (let waited = 0; waited < 30000; waited += 250) {
    if ((await cdp.evaluate("typeof window.__TAURI_INTERNALS__?.invoke")) === "function") {
      return;
    }
    await sleep(250);
  }
  throw new Error("the DevTools page never exposed a Tauri bridge (__TAURI_INTERNALS__.invoke)");
}

async function stress(cdp) {
  await waitForTauriBridge(cdp);
  await sleep(4000); // let startup palette restore and the first menu pushes finish
  const states = (await cdp.evaluate(invoke("list_toolset_window_states"))) ?? [];
  const open = new Set(states.filter((state) => state.open).map((state) => state.toolsetId));
  const toolsets = churnToolsets.filter((id) => !open.has(id));
  if (toolsets.length === 0) {
    throw new Error("every churn toolset is already open; nothing to create");
  }
  for (let index = 0; index < rounds; index++) {
    const scheme = index % 2 === 0 ? "chemdraw" : "chemdraft";
    const other = scheme === "chemdraw" ? "chemdraft" : "chemdraw";
    const toolset = toolsets[index % toolsets.length];
    // Fired together so rebuild closures interleave with window creation on the main thread.
    await round(cdp, `round ${index + 1} open`, [
      invoke("set_keybinding_scheme", { scheme }),
      invoke("open_toolset_window", { toolsetId: toolset }),
      invoke("set_keybinding_scheme", { scheme: other }),
      invoke("toggle_preferences_window"),
      invoke("set_keybinding_scheme", { scheme }),
      invoke("toggle_spin3d_debugger_window"),
      invoke("show_toolset_tooltip_window")
    ]);
    await sleep(120);
    await round(cdp, `round ${index + 1} close`, [
      invoke("close_toolset_window", { toolsetId: toolset }),
      invoke("hide_toolset_tooltip_window"),
      invoke("set_keybinding_scheme", { scheme: "chemdraft" }),
      invoke("toggle_preferences_window"),
      invoke("toggle_spin3d_debugger_window")
    ]);
    await sleep(60);
  }
}

// Post WM_CLOSE to the child's document window: the close-button path (CloseRequested -> session
// flush -> exit). Found by owning process, class, and title — Process.MainWindowHandle can name a
// palette, whose close is not a quit, and the document title carries the worktree label (§21.1).
function closeDocumentWindow(pid) {
  return powershell(`
Add-Type -Namespace W -Name U -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetClassName(System.IntPtr h, System.Text.StringBuilder s, int n);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);
'@
$state = @{ found = [IntPtr]::Zero }
[void][W.U]::EnumWindows({ param($h, $l)
  $owner = 0; [void][W.U]::GetWindowThreadProcessId($h, [ref]$owner)
  if ($owner -ne ${pid}) { return $true }
  $class = New-Object System.Text.StringBuilder 64; [void][W.U]::GetClassName($h, $class, 64)
  $title = New-Object System.Text.StringBuilder 256; [void][W.U]::GetWindowText($h, $title, 256)
  if ($class.ToString() -eq 'Tauri Window' -and $title.ToString() -match '^ChemDraft( \\u2014 .*)?$') { $state.found = $h; return $false }
  return $true
}, [IntPtr]::Zero)
if ($state.found -eq [IntPtr]::Zero) { 'no document window' } else { [void][W.U]::PostMessage($state.found, 0x10, [IntPtr]::Zero, [IntPtr]::Zero); 'posted' }`);
}

const hex = (code) => `0x${(code >>> 0).toString(16)}`;

const startedAt = new Date();
let failures = 0;
stopInstancesOfExe();
await sleep(1500);

for (let cycle = 1; cycle <= cycles; cycle++) {
  const child = spawn(exe, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
  });
  // The real exit status, from the child's own exit event. "The process is gone" is not a status: a
  // crash is gone too, and treating gone as 0 is exactly how a crashing run would read as clean.
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  let exit;
  void exited.then((result) => {
    exit = result;
  });
  try {
    const cdp = await connect((await mainPage()).webSocketDebuggerUrl);
    try {
      await stress(cdp);
    } finally {
      cdp.close();
    }
    const closeResult = closeDocumentWindow(child.pid);
    for (let waited = 0; exit === undefined && waited < 15000; waited += 250) {
      await sleep(250);
    }
    if (exit === undefined) {
      failures++;
      console.log(`cycle ${cycle}: WM_CLOSE ${closeResult}; still running after 15 s`);
    } else if (exit.code !== 0) {
      failures++;
      console.log(`cycle ${cycle}: WM_CLOSE ${closeResult}; exit ${exit.code === null ? `signal ${exit.signal}` : hex(exit.code)}`);
    } else {
      console.log(`cycle ${cycle}: ${rounds} rounds, clean exit`);
    }
  } catch (error) {
    failures++;
    console.log(`cycle ${cycle}: ${error.message}`);
  }
  stopInstancesOfExe();
  await Promise.race([exited, sleep(3000)]);
  await sleep(1500);
}

const crashes = powershell(
  `@(Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'; StartTime=[datetime]'${startedAt.toISOString()}'} -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'chemdraft' }).Count`
);
console.log(`crash events: ${crashes}`);
process.exit(failures === 0 && crashes === "0" ? 0 : 1);
