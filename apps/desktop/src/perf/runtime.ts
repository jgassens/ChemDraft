import { detectShortcutPlatform } from "@chemdraft/shortcut-engine";
import { perfProbeRequestedFromWindow } from "./gate";
import { createPerfProbe, type DoneSignal, type PerfRecord, type PerfProbe } from "./probe";

declare global { interface Window { readonly __CHEMDRAFT_PERF_ALLOWED__?: boolean; } }
export let perfProbe: PerfProbe | undefined;
function reportPerfFailure(error: unknown): void {
  perfProbe?.guard(() => { throw error; });
}

/** Forward a numeric completion only; Rust authenticates windows and enforces the launch gate. */
export function sendPerfCompletion(target: string, requestKey: string, signal: DoneSignal, at?: number, frameAt?: number): void {
  perfProbe?.guard(() => {
    const completionTime = at ?? perfProbe?.timestamp();
    if (completionTime === undefined) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("perf_log_complete", {
      completion: { target, requestKey, signal, at: completionTime, frameAt }
    })).catch(reportPerfFailure);
  });
}
/** Hidden windows must be shown before requesting their first frame. */
export function perfSurfaceReady(target: string, requestKey: string, signal: DoneSignal): void {
  perfProbe?.guard(() => {
    const at = perfProbe?.timestamp();
    window.requestAnimationFrame(() => perfProbe?.guard(() => sendPerfCompletion(target, requestKey, signal, at, perfProbe?.timestamp())));
  });
}

export function probePlatform(platform = detectShortcutPlatform()): PerfRecord["platform"] {
  return platform === "macos" ? "macos" : platform === "windows" ? "windows" : "linux";
}
export function windowRole(search: string): PerfRecord["window"] {
  const role = new URLSearchParams(search).get("window");
  return role === "preferences" || role === "spin3d-debugger" ? role
    : role === "dialog" ? "dialog"
    : role === "pluginPanel" ? "plugin-panel"
    : role === "toolsetPopover" || role === "toolsetTooltip" ? "palette-popover"
    : role === "toolset" || role === "tool-palette" ? "palette" : "main";
}
/** Safari historically used epoch event timestamps; modern WebKit/WebView2 use timeOrigin. */
export function alignEventTime(timeStamp: number, timeOrigin: number, offset: number): number {
  return (timeStamp > 1e12 ? timeStamp - timeOrigin : timeStamp) + offset;
}
export interface NativeClock { now: number; processStart: number; buildStamp?: string | null; }
export async function calibrateClock(now: () => number, clock: () => Promise<NativeClock>) {
  let best: { offset: number; error: number; processStart: number; buildStamp?: string } | undefined;
  for (let i = 0; i < 3; i++) {
    const before = now();
    const sample = await clock();
    const after = now();
    const error = (after - before) / 2;
    if (!best || error < best.error) best = { offset: sample.now - (before + after) / 2, error, processStart: sample.processStart,
      ...(sample.buildStamp == null ? {} : { buildStamp: sample.buildStamp }) };
  }
  return best!;
}

/** Called before mounting React. Rust injects the marker only under its existing env/argv gate. */
export async function startPerfProbe(sourceStamp?: string): Promise<void> {
  if (!perfProbeRequestedFromWindow()) return;
  const native = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  const desktop = Boolean(native.__TAURI_INTERNALS__ || native.__TAURI__);
  let offset = window.performance.timeOrigin;
  let processStart = offset;
  let clockErrorMs = 0;
  let buildStamp = sourceStamp === undefined ? "" : `${sourceStamp} · ${__BUILD_STAMP__} · ${__WORKTREE_LABEL__}`;
  let write: (record: PerfRecord) => void;
  if (desktop) {
    const { invoke } = await import("@tauri-apps/api/core");
    let registration = buildStamp || undefined;
    const aligned = await calibrateClock(() => window.performance.now(), () => {
      const buildStamp = registration; registration = undefined;
      return invoke<NativeClock>("perf_log_clock", { buildStamp });
    });
    buildStamp = aligned.buildStamp ?? buildStamp;
    offset = aligned.offset; processStart = aligned.processStart; clockErrorMs = aligned.error;
    // Serialize only our writes; never make a command or render await logging.
    let queue = Promise.resolve();
    let queued = 0;
    write = record => {
      if (queued >= 256) { console.warn("Perf probe log queue full; sample dropped"); return; }
      queued++;
      queue = queue.then(() => invoke<void>("perf_log_append", { line: JSON.stringify(record) }))
        .catch(reportPerfFailure).finally(() => { queued--; });
    };
  } else {
    // Web preview has no app_data_dir. Keep the same JSONL shape in a bounded browser buffer.
    write = record => {
      try {
        const line = `${JSON.stringify(record)}\n`;
        const previous = localStorage.getItem("chemdraft.perfLog") ?? "";
        localStorage.setItem("chemdraft.perfLog", previous.length + line.length > 1024 * 1024 ? line : previous + line);
      } catch (error) { reportPerfFailure(error); }
    };
  }
  perfProbe = createPerfProbe(true, () => ({ target: {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => window.addEventListener(type, listener, options),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => window.removeEventListener(type, listener, options)
  }, now: () => window.performance.now() + offset,
    eventTime: stamp => alignEventTime(stamp, window.performance.timeOrigin, offset),
    frame: callback => window.requestAnimationFrame(callback), cancelFrame: id => window.cancelAnimationFrame(id),
    defer: callback => window.queueMicrotask(callback), timeout: (callback, delayMs = 120_000) => window.setTimeout(callback, delayMs),
    clearTimeout: id => window.clearTimeout(id),
    write, window: windowRole(location.search), platform: probePlatform(),
    buildStamp, processStart, clockErrorMs }));
  if (desktop) window.addEventListener("chemdraft:perf-complete", event => perfProbe?.guard(() => {
    const detail = (event as CustomEvent<{ requestKey: string; signal: DoneSignal; at: number; frameAt?: number; window: string }>).detail;
    if (!detail) return;
    if (["popover-shown", "no-op", "failed"].includes(detail.signal) && windowRole(location.search) === "palette") {
      const shown = detail as typeof detail & { flyoutId: string };
      perfProbe?.popoverShown(shown.flyoutId, shown.at, shown.frameAt ?? undefined, shown.window, shown.signal as "popover-shown" | "no-op" | "failed");
    } else if (detail.window === "main" && windowRole(location.search) === "dialog" && detail.signal === "dialog-open") {
      window.requestAnimationFrame(() => sendPerfCompletion("main", detail.requestKey, detail.signal, detail.at, perfProbe?.timestamp()));
    } else perfProbe?.remoteCompletion(detail.requestKey, detail.signal, detail.at, detail.frameAt, detail.window);
  }));
  if (desktop && windowRole(location.search) === "palette") {
    const toolsetId = new URLSearchParams(location.search).get("toolsetId") ?? "core.main";
    const { listenForToolsetPopoverContent } = await import("../window-manager");
    await listenForToolsetPopoverContent(payload => perfProbe?.guard(() => {
      if (payload.toolsetId === toolsetId && payload.kind === "flyout" && payload.flyout.commands.length > 0) perfProbe?.popoverRequested(payload.flyout.flyoutId);
    }));
  }
  // All secondary React roots share this one observer. It measures DOM commits, including async
  // state updates, without touching their event handlers or requiring extra IPC permissions.
  const root = document.getElementById("root");
  if (root) {
    const observer = new MutationObserver(() => perfProbe?.rendered());
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  }
}
