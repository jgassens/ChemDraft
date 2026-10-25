import { detectShortcutPlatform } from "@chemdraft/shortcut-engine";
import { perfProbeRequestedFromWindow } from "./gate";
import { createPerfProbe, type DoneSignal, type PerfRecord, type PerfProbe } from "./probe";

declare global { interface Window { readonly __CHEMDRAFT_PERF_ALLOWED__?: boolean; } }
export let perfProbe: PerfProbe | undefined;
export const PERF_BUILD_STAMP = "10.25.12.40-codex";

/** Forward a numeric completion only; Rust authenticates windows and enforces the launch gate. */
export function sendPerfCompletion(target: string, requestKey: string, signal: DoneSignal, at?: number, frameAt?: number): void {
  if (!perfProbe) return;
  const completionTime = at ?? perfProbe.timestamp();
  void import("@tauri-apps/api/core").then(({ invoke }) => invoke("perf_log_complete", {
    completion: { target, requestKey, signal, at: completionTime, frameAt }
  })).catch(error => console.warn("Perf probe completion failed", error));
}
/** Hidden windows must be shown before requesting their first frame. */
export function perfSurfaceReady(target: string, requestKey: string, signal: DoneSignal): void {
  if (!perfProbe) return;
  const at = perfProbe.timestamp();
  requestAnimationFrame(() => sendPerfCompletion(target, requestKey, signal, at, perfProbe?.timestamp()));
}

export function probePlatform(platform = detectShortcutPlatform()): PerfRecord["platform"] {
  return platform === "macos" ? "macos" : platform === "windows" ? "windows" : "linux";
}
export function windowRole(search: string): PerfRecord["window"] {
  const role = new URLSearchParams(search).get("window");
  return role === "dialog" || role === "preferences" ? "dialog"
    : role === "pluginPanel" || role === "spin3d-debugger" ? "plugin-panel"
    : role === "toolsetPopover" || role === "toolsetTooltip" ? "palette-popover"
    : role === "toolset" || role === "tool-palette" ? "palette" : "main";
}
/** Safari historically used epoch event timestamps; modern WebKit/WebView2 use timeOrigin. */
export function alignEventTime(timeStamp: number, timeOrigin: number, offset: number): number {
  return (timeStamp > 1e12 ? timeStamp - timeOrigin : timeStamp) + offset;
}
export interface NativeClock { now: number; processStart: number; }
export async function calibrateClock(now: () => number, clock: () => Promise<NativeClock>) {
  let best: { offset: number; error: number; processStart: number } | undefined;
  for (let i = 0; i < 3; i++) {
    const before = now();
    const sample = await clock();
    const after = now();
    const error = (after - before) / 2;
    if (!best || error < best.error) best = { offset: sample.now - (before + after) / 2, error, processStart: sample.processStart };
  }
  return best!;
}

/** Called before mounting React. Rust injects the marker only under its existing env/argv gate. */
export async function startPerfProbe(): Promise<void> {
  if (!perfProbeRequestedFromWindow()) return;
  const native = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  const desktop = Boolean(native.__TAURI_INTERNALS__ || native.__TAURI__);
  let offset = performance.timeOrigin;
  let processStart = offset;
  let clockErrorMs = 0;
  let write: (record: PerfRecord) => void;
  if (desktop) {
    const { invoke } = await import("@tauri-apps/api/core");
    const aligned = await calibrateClock(() => performance.now(), () => invoke<NativeClock>("perf_log_clock"));
    offset = aligned.offset; processStart = aligned.processStart; clockErrorMs = aligned.error;
    // Serialize only our writes; never make a command or render await logging.
    let queue = Promise.resolve();
    let queued = 0;
    write = record => {
      if (queued >= 256) { console.warn("Perf probe log queue full; sample dropped"); return; }
      queued++;
      queue = queue.then(() => invoke<void>("perf_log_append", { line: JSON.stringify(record) }))
        .catch(error => console.warn("Perf probe log append failed", error)).finally(() => { queued--; });
    };
  } else {
    // Web preview has no app_data_dir. Keep the same JSONL shape in a bounded browser buffer.
    write = record => {
      try {
        const line = `${JSON.stringify(record)}\n`;
        const previous = localStorage.getItem("chemdraft.perfLog") ?? "";
        localStorage.setItem("chemdraft.perfLog", previous.length + line.length > 1024 * 1024 ? line : previous + line);
      } catch (error) { console.warn("Perf probe browser log failed", error); }
    };
  }
  perfProbe = createPerfProbe(true, () => ({ target: window, now: () => performance.now() + offset,
    eventTime: stamp => alignEventTime(stamp, performance.timeOrigin, offset),
    frame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
    defer: callback => queueMicrotask(callback), timeout: callback => setTimeout(callback, 120_000), clearTimeout,
    write, window: windowRole(location.search), platform: probePlatform(),
    buildStamp: `${PERF_BUILD_STAMP} · ${__BUILD_STAMP__} · ${__WORKTREE_LABEL__}`, processStart, clockErrorMs }));
  if (desktop) window.addEventListener("chemdraft:perf-complete", event => {
    const detail = (event as CustomEvent<{ requestKey: string; signal: DoneSignal; at: number; frameAt?: number; window: string }>).detail;
    if (!detail) return;
    if (detail.window === "main" && windowRole(location.search) === "dialog" && detail.signal === "dialog-open") {
      requestAnimationFrame(() => sendPerfCompletion("main", detail.requestKey, detail.signal, detail.at, perfProbe?.timestamp()));
    } else perfProbe?.remoteCompletion(detail.requestKey, detail.signal, detail.at, detail.frameAt, detail.window);
  });
  // All secondary React roots share this one observer. It measures DOM commits, including async
  // state updates, without touching their event handlers or requiring extra IPC permissions.
  const root = document.getElementById("root");
  if (root) {
    const observer = new MutationObserver(() => perfProbe?.rendered());
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  }
}
