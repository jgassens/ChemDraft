/**
 * Opt-in console mirror for the Spin 3D conformer trace stream.
 *
 * The whole Spin 3D pipeline already emits `chemdraft:spin3d-trace` events (the same
 * ones the Spin 3D debugger window renders): prefetch dispatch, worker cache hit/miss,
 * engine selection, embed/refine spans, and the overlay commit. This attaches a logger
 * that mirrors them to the browser console with attach-relative timing, so the timeline
 * can be captured headlessly (automated browser checks, log scraping) WITHOUT opening the
 * debugger window — and without `await`-ing the click first, which over-counts latency.
 *
 * Disabled by default (zero cost). Enable per session with either:
 *   localStorage.setItem("chemdraft.spin3d.console", "1")   // then reload
 *   …or append ?spin3dlog=1 to the URL.
 */
import {
  DOM_SPIN3D_TRACE_EVENT,
  isSpin3dTraceEvent,
  type Spin3dTraceEvent
} from "./conformerDebug";

const STORAGE_KEY = "chemdraft.spin3d.console";

/** Whether the console mirror is opted in (URL param or localStorage flag). */
export function spin3dTraceConsoleEnabled(): boolean {
  try {
    if (typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("spin3dlog") === "1") {
      return true;
    }
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "1";
  } catch {
    // Blocked/disabled storage — treat as off.
    return false;
  }
}

/** One compact line per trace event, e.g.
 *  `+93ms [worker] worker.cache info cache=hit atoms=64 queue=0 · queue 0`. */
function formatTrace(event: Spin3dTraceEvent, tMs: number): string {
  const parts = [`+${tMs}ms`, `[${event.kind}]`, event.stage, event.status];
  if (event.cacheStatus) parts.push(`cache=${event.cacheStatus}`);
  if (typeof event.atomCount === "number") parts.push(`atoms=${event.atomCount}`);
  if (typeof event.queueDepth === "number") parts.push(`queue=${event.queueDepth}`);
  if (typeof event.durationMs === "number") parts.push(`${event.durationMs}ms`);
  if (event.message) parts.push(`· ${event.message}`);
  if (event.error) parts.push(`· ERROR ${event.error}`);
  return parts.join(" ");
}

// Attach at most ONCE per page, for the page's lifetime. The host effect can run many times
// (React StrictMode double-invoke, Fast Refresh, the several MainWindow mount cycles during
// boot); a flag that effect-cleanup resets would still re-attach and print every line N
// times. This flag is never reset, so additional calls are no-ops — one listener, no dupes.
let attached = false;

/**
 * Idempotently start mirroring spin3d traces to the console (page-lifetime; no detach — it's
 * an opt-in debug aid). No-op when disabled / off-DOM, so it's safe to call from any effect.
 */
export function attachSpin3dTraceConsole(): void {
  if (attached || typeof window === "undefined" || !spin3dTraceConsoleEnabled()) return;
  attached = true;
  const t0 = performance.now();
  window.addEventListener(DOM_SPIN3D_TRACE_EVENT, (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isSpin3dTraceEvent(detail)) return;
    console.log(`[spin3d] ${formatTrace(detail, Math.round(performance.now() - t0))}`);
  });
  console.info(`[spin3d] trace console attached — disable with localStorage.removeItem("${STORAGE_KEY}")`);
}
