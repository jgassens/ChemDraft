import { detectShortcutPlatform } from "@chemdraft/shortcut-engine";
import { perfProbeRequestedFromWindow } from "./gate";
import { createPerfProbe, type DoneSignal, type PerfRecord, type PerfProbe } from "./probe";
import { invoke } from "@tauri-apps/api/core";

declare global { interface Window { readonly __CHEMDRAFT_PERF_ALLOWED__?: boolean; } }
export let perfProbe: PerfProbe | undefined;
export interface NativeOpen { target: string; inputId: string; t0: number; commandId?: string; shownAt?: number; cold?: boolean; }
let openSequence = 0;
let failed = false;
let canvasReadyAt: number | undefined;
let clockOffset: number | undefined;
const startedListeners = new Set<() => void>();
export function onPerfStarted(listener: () => void): () => void {
  startedListeners.add(listener);
  if (perfProbe) perfHook(listener);
  return () => { startedListeners.delete(listener); };
}
export function perfCanvasReady(): void {
  canvasReadyAt = window.performance.now();
  perfHook(() => perfProbe?.readyCanvas(canvasReadyAt! + (clockOffset ?? window.performance.timeOrigin)));
}

/** No app action awaits diagnostics. A broken hook (including a substituted hook) is session fatal. */
export function perfHook<T>(hook: () => T): T | undefined {
  if (failed) return;
  try {
    const result = hook();
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(reportPerfFailure);
      return;
    }
    return result;
  } catch (error) { reportPerfFailure(error); }
}

/** Queue a task after rAF's rendering turn, retaining browser method receivers. */
export function afterPaint(callback: () => void): void {
  if (typeof window.MessageChannel === "function") {
    const channel = new window.MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close(); channel.port2.close(); callback();
    };
    channel.port2.postMessage(null);
  } else window.setTimeout(callback, 0);
}

/** Register before native creation so even a cold webview can claim its originating input. */
export function nativeWindowOpening(target: string, commandId?: string): NativeOpen | undefined {
  return perfHook(() => {
    if (!perfProbe) return;
    const timestamp = perfHook(() => perfProbe?.timestamp());
    const origin = perfHook(() => perfProbe?.nativeWindowStarted(`open-${Math.floor(timestamp ?? 0)}-${++openSequence}`, commandId, target));
    if (!origin) return;
    const request = { ...origin, target };
    void invoke("perf_log_clock", { nativeOpen: request }).catch(reportPerfFailure);
    return request;
  });
}
export function nativeWindowShown(request: NativeOpen | undefined, resolvedAt?: number): void {
  perfHook(() => {
    if (!request || !perfProbe) return;
    request.shownAt = resolvedAt ?? perfHook(() => perfProbe?.timestamp());
    if (request.shownAt === undefined) return;
    perfHook(() => perfProbe?.nativeWindowShown(request.inputId, request.shownAt!));
    void invoke("perf_log_clock", { nativeOpen: request }).catch(reportPerfFailure);
  });
}
/** Called after the original toggle resolves. Only diagnostics query state; actions never await it. */
export function perfToggleResolved(label: string, open: NativeOpen | undefined, input: Parameters<PerfProbe["complete"]>[0] | undefined): void {
  perfHook(() => {
    if (!perfProbe) return;
    const resolvedAt = perfHook(() => perfProbe?.timestamp());
    return invoke<"visible" | "hidden" | "minimized" | "absent">("perf_log_window_state", { label }).then(state => {
      perfHook(() => {
        if (state === "visible") nativeWindowShown(open, resolvedAt);
        else if (input) return perfProbe?.complete(input, "command-finished");
      });
    });
  });
}
export function reportPerfFailure(error: unknown): void {
  if (failed) return;
  failed = true;
  try {
    const stopped: unknown = perfProbe?.stop();
    if (stopped && typeof (stopped as PromiseLike<unknown>).then === "function") void Promise.resolve(stopped).catch(() => undefined);
  } catch { /* Never let teardown affect the application. */ }
  try { console.warn("Perf probe disabled for this session", error); } catch { /* Diagnostics only. */ }
  try {
    if ((window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }).__TAURI_INTERNALS__
      || (window as Window & { __TAURI__?: unknown }).__TAURI__) {
      if (perfProbeRequestedFromWindow()) void invoke("perf_log_clock", { disable: true }).catch(() => undefined);
    }
  } catch { /* Reporting must also fail open, including with the switch off. */ }
}

/** Forward a numeric completion only; Rust authenticates windows and enforces the launch gate. */
export function sendPerfCompletion(target: string, requestKey: string, signal: DoneSignal, at?: number, frameAt?: number, rafAt?: number, shownAt?: number): void {
  perfHook(() => perfProbe?.guard(() => {
    const completionTime = at ?? perfHook(() => perfProbe?.timestamp());
    if (completionTime === undefined) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("perf_log_complete", {
      completion: { target, requestKey, signal, at: completionTime, frameAt, rafAt, shownAt }
    })).catch(reportPerfFailure);
  }));
}
/** Hidden windows must be shown before requesting their first frame. */
export function perfSurfaceReady(target: string, requestKey: string, signal: DoneSignal): void {
  perfHook(() => perfProbe?.guard(() => {
    const at = perfHook(() => perfProbe?.timestamp());
    window.requestAnimationFrame(() => perfHook(() => perfProbe?.guard(() => {
      const rafAt = perfHook(() => perfProbe?.timestamp());
      afterPaint(() => perfHook(() => perfProbe?.guard(() => {
        const paintedAt = perfHook(() => perfProbe?.timestamp());
        sendPerfCompletion(target, requestKey, signal, paintedAt, paintedAt, rafAt, at);
      })));
    })));
  }));
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
    : role === "toolset" || role === "tool-palette"
      ? toolsetRole(new URLSearchParams(search).get("toolsetId")) : "main";
}
function toolsetRole(id: string | null): PerfRecord["window"] {
  if (id === "core.drawnStructureSettings") return "settings";
  return id === "core.art" || id === "core.text" || (id && /(?:Inspector|Properties)$/.test(id)) ? "inspector" : "toolset";
}
/** Safari historically used epoch event timestamps; modern WebKit/WebView2 use timeOrigin. */
export function alignEventTime(timeStamp: number, timeOrigin: number, offset: number): number {
  return (timeStamp > 1e12 ? timeStamp - timeOrigin : timeStamp) + offset;
}
export interface NativeClock { now: number; processStart: number; createdAt?: number; buildStamp?: string | null; nativeOpen?: NativeOpen | null; }
export async function calibrateClock(now: () => number, clock: () => Promise<NativeClock>) {
  let best: { offset: number; error: number; processStart: number; createdAt?: number; buildStamp?: string; nativeOpen?: NativeOpen } | undefined;
  for (let i = 0; i < 3; i++) {
    const before = now();
    const sample = await clock();
    const after = now();
    const error = (after - before) / 2;
    if (!best || error < best.error) best = { offset: sample.now - (before + after) / 2, error, processStart: sample.processStart,
      ...(sample.buildStamp == null ? {} : { buildStamp: sample.buildStamp }),
      ...(best?.nativeOpen === undefined ? {} : { nativeOpen: best.nativeOpen }) };
    // Timing uses the minimum RTT; correlation uses the latest native state, including show.
    if (sample.nativeOpen) best.nativeOpen = sample.nativeOpen;
    if (sample.createdAt !== undefined) best.createdAt = sample.createdAt;
  }
  return best!;
}

/** Starts alongside React mount. Rust injects the marker only under its existing env/argv gate. */
export async function startPerfProbe(sourceStamp?: string): Promise<void> {
  if (failed) return;
  try { await initializePerfProbe(sourceStamp); } catch (error) { reportPerfFailure(error); }
}
async function initializePerfProbe(sourceStamp?: string): Promise<void> {
  if (!perfProbeRequestedFromWindow()) return;
  const native = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  const desktop = Boolean(native.__TAURI_INTERNALS__ || native.__TAURI__);
  let offset = window.performance.timeOrigin;
  let processStart = offset;
  let clockErrorMs = 0;
  let buildStamp = sourceStamp === undefined ? "" : `${sourceStamp} · ${__BUILD_STAMP__}`;
  let nativeOpen: NativeOpen | undefined;
  let createdAt: number | undefined = offset;
  let write: (record: PerfRecord) => void;
  if (desktop) {
    const { invoke } = await import("@tauri-apps/api/core");
    let registration = buildStamp || undefined;
    const aligned = await calibrateClock(() => window.performance.now(), () => {
      const buildStamp = registration; registration = undefined;
      return invoke<NativeClock>("perf_log_clock", { buildStamp });
    });
    buildStamp = aligned.buildStamp ?? buildStamp;
    nativeOpen = aligned.nativeOpen;
    createdAt = aligned.createdAt;
    offset = aligned.offset; processStart = aligned.processStart; clockErrorMs = aligned.error;
    // Serialize only our writes; never make a command or render await logging.
    let queue = Promise.resolve();
    let queued = 0;
    write = record => {
      if (queued >= 256) { reportPerfFailure(new Error("Perf probe log queue full")); return; }
      queued++;
      queue = queue.then(() => { if (!failed) return invoke<void>("perf_log_append", { line: JSON.stringify(record) }); })
        .catch(reportPerfFailure).finally(() => { queued--; });
    };
  } else {
    // Web preview has no app_data_dir. Keep the same JSONL shape in a bounded browser buffer.
    write = record => {
      if (failed) return;
      try {
        const line = `${JSON.stringify(record)}\n`;
        const previous = window.localStorage.getItem("chemdraft.perfLog") ?? "";
        window.localStorage.setItem("chemdraft.perfLog", previous.length + line.length > 1024 * 1024 ? line : previous + line);
      } catch (error) { reportPerfFailure(error); }
    };
  }
  if (failed) return;
  clockOffset = offset;
  const role = windowRole(window.location.search);
  const cleanups: (() => void)[] = [];
  let stopped = false;
  const addCleanup = (cleanup: () => void) => {
    if (stopped) { try { cleanup(); } catch { /* Already stopped. */ } }
    else cleanups.push(cleanup);
  };
  const listen = (type: string, listener: EventListener) => {
    window.addEventListener(type, listener);
    addCleanup(() => window.removeEventListener(type, listener));
  };
  perfProbe = createPerfProbe(true, () => ({ target: {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => window.addEventListener(type, listener, options),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => window.removeEventListener(type, listener, options)
  }, now: () => window.performance.now() + offset,
    eventTime: stamp => alignEventTime(stamp, window.performance.timeOrigin, offset),
    frame: callback => window.requestAnimationFrame(callback), cancelFrame: id => window.cancelAnimationFrame(id),
    afterPaint,
    defer: callback => window.queueMicrotask(callback), timeout: (callback, delayMs = 120_000) => window.setTimeout(callback, delayMs),
    clearTimeout: id => window.clearTimeout(id),
    correlationDelayMs: desktop && role === "main" ? 250 : undefined,
    write, window: role, platform: probePlatform(), onFailure: reportPerfFailure,
    onStop: () => {
      stopped = true;
      for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* Attempt every cleanup. */ } }
    },
    ...(desktop && ["toolset", "settings", "inspector", "palette-popover"].includes(role) ? {
      forwardInput: (origin: { inputId: string; t0: number; commandId: string }) => {
        perfHook(() => invoke("perf_log_clock", { forwardInput: origin }));
      }
    } : {}),
    buildStamp, processStart, clockErrorMs }));
  if (failed) return;
  if (desktop && role === "main") listen("chemdraft:perf-forward", event => perfHook(() => perfProbe?.forwardedInput(
    (event as CustomEvent<{ inputId: string; t0: number; commandId: string; window: string }>).detail
  )));
  if (desktop) listen("chemdraft:perf-complete", event => perfHook(() => perfProbe?.guard(() => {
    const detail = (event as CustomEvent<{ requestKey: string; signal: DoneSignal; at: number; frameAt?: number; rafAt?: number; shownAt?: number; window: string }>).detail;
    if (!detail) return;
    const native = detail as typeof detail & { target?: string };
    if (native.target && native.signal === "window-painted" && native.frameAt !== undefined && native.rafAt !== undefined) {
      return perfProbe?.remoteNativePaint(native.target, native.at, native.frameAt, native.window, native.rafAt);
    }
    if (["popover-shown", "no-op", "failed"].includes(detail.signal) && ["toolset", "settings", "inspector"].includes(windowRole(window.location.search))) {
      const shown = detail as typeof detail & { flyoutId: string };
      return perfProbe?.popoverShown(shown.flyoutId, shown.at, shown.frameAt ?? undefined, shown.window, shown.signal as "popover-shown" | "no-op" | "failed", shown.rafAt ?? undefined);
    } else if (detail.window === "main" && windowRole(window.location.search) === "dialog" && detail.signal === "dialog-open") {
      window.requestAnimationFrame(() => perfHook(() => perfProbe?.guard(() => {
        const rafAt = perfHook(() => perfProbe?.timestamp());
        afterPaint(() => perfHook(() => perfProbe?.guard(() => {
          const paintedAt = perfHook(() => perfProbe?.timestamp());
          sendPerfCompletion("main", detail.requestKey, detail.signal, paintedAt, paintedAt, rafAt, detail.at);
        })));
      })));
    } else return perfProbe?.remoteCompletion(detail.requestKey, detail.signal, detail.at, detail.frameAt ?? undefined, detail.window, detail.rafAt ?? undefined, detail.shownAt ?? undefined);
  })));
  // All secondary React roots share this one observer. It measures DOM commits, including async
  // state updates, without touching their event handlers or requiring extra IPC permissions.
  const root = window.document.getElementById("root");
  if (root) {
    const role = windowRole(window.location.search);
    const contentSurface = ["toolset", "settings", "inspector", "preferences", "plugin-panel", "spin3d-debugger"].includes(role);
    const surface = new URLSearchParams(window.location.search).get("toolsetId") ?? role;
    let reported: string | undefined;
    let scheduled = false;
    let firstContentfulAt: number | undefined;
    const supportsPaint = typeof window.PerformanceObserver === "function"
      && window.PerformanceObserver.supportedEntryTypes?.includes("paint");
    const contentPaint = () => perfHook(() => perfProbe?.guard(() => {
      if (!contentSurface || !root.firstElementChild || scheduled) return;
      if (!nativeOpen && createdAt === undefined) throw new Error("Missing native window creation timestamp");
      const request = nativeOpen ?? { target: "", inputId: `startup-${role}`, t0: createdAt, cold: true };
      if ((nativeOpen && nativeOpen.shownAt === undefined) || reported === request.inputId) return;
      if (request.cold && supportsPaint && firstContentfulAt === undefined) return;
      scheduled = true;
      window.requestAnimationFrame(() => perfHook(() => perfProbe?.guard(() => {
        const rafAt = perfHook(() => perfProbe?.timestamp());
        afterPaint(() => perfHook(() => perfProbe?.guard(() => {
          scheduled = false;
          if (nativeOpen && nativeOpen.inputId !== request.inputId) { contentPaint(); return; }
          if (rafAt === undefined || !root.firstElementChild) return;
          reported = request.inputId;
          return perfProbe?.destinationPaint({ ...request, t0: request.t0! }, perfHook(() => perfProbe?.timestamp())!, rafAt, surface,
            request.cold ? firstContentfulAt : undefined,
            request.cold && firstContentfulAt !== undefined ? "first-contentful-paint" : "post-paint-content");
        })));
      })));
    }));
    if (contentSurface && supportsPaint) {
      const paintObserver = new window.PerformanceObserver(entries => perfHook(() => perfProbe?.guard(() => {
        const paint = entries.getEntries().find(entry => entry.name === "first-contentful-paint");
        if (paint) { firstContentfulAt = paint.startTime + offset; contentPaint(); }
      })));
      paintObserver.observe({ type: "paint", buffered: true });
      addCleanup(() => paintObserver.disconnect());
    }
    if (desktop) listen("chemdraft:perf-open", event => perfHook(() => perfProbe?.guard(() => {
      nativeOpen = (event as CustomEvent<NativeOpen>).detail; contentPaint();
    })));
    const observer = new window.MutationObserver(() => perfHook(() => { perfHook(() => perfProbe?.rendered()); contentPaint(); }));
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    addCleanup(() => observer.disconnect());
    contentPaint(); // React may already have mounted while clock calibration was in flight.
  }
  // Install completion/content listeners before this async subscription: a cold native window's
  // show receipt can arrive while the secondary toolbar transport is still loading.
  if (desktop && ["toolset", "settings", "inspector"].includes(windowRole(window.location.search))) {
    const toolsetId = new URLSearchParams(window.location.search).get("toolsetId") ?? "core.main";
    const { listenForToolsetPopoverContent } = await import("../window-manager");
    const stop = await listenForToolsetPopoverContent(payload => perfHook(() => perfProbe?.guard(() => {
      if (payload.toolsetId === toolsetId && payload.kind === "flyout" && payload.flyout.commands.length > 0) return perfProbe?.popoverRequested(payload.flyout.flyoutId);
    })));
    addCleanup(stop);
  }
  for (const listener of startedListeners) perfHook(listener);
  if (canvasReadyAt !== undefined) perfHook(() => perfProbe?.readyCanvas(canvasReadyAt! + offset));
}
