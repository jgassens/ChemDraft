import type { MonitorLogicalBounds } from "./index";

/** How often a window re-reads its monitor's work area. */
export const WORK_AREA_POLL_MS = 1000;

/** A work area as a comparable key. */
export function workAreaKey(area: MonitorLogicalBounds): string {
  return `${area.left}:${area.top}:${area.right}:${area.bottom}`;
}

/**
 * A work area and the display scale as one comparable key: what Rust caps a Linux palette's width
 * against (toolset_content_placement). A scale change alone is a different key.
 */
export function workAreaPlacementKey(
  area: MonitorLogicalBounds,
  devicePixelRatio: number = window.devicePixelRatio || 1
): string {
  return `${workAreaKey(area)}@${devicePixelRatio}`;
}

/**
 * Call `onChange` when the current window's work area changes with no window event: a taskbar,
 * Dock or panel added, removed or resized changes it without moving or resizing the window. Reads
 * once now (the baseline, never a change) and then every `intervalMs`; skips a read while the page
 * is hidden or the previous read is still pending. Returns the stop function.
 *
 * A new work area is recorded only once `onChange` has dealt with it: when `onChange` returns (or
 * resolves to) `false`, or throws, the area stays unrecorded and the next read reports the same
 * change again, so a refused refit is retried. Anything else (including no return value) records it.
 *
 * The resizable inspector uses it on every platform. Content-fit palettes use
 * `pollPlacementAgainstFit` instead, which compares with their last accepted fit.
 */
export function pollWorkAreaChanges(
  onChange: () => void | boolean | Promise<void | boolean>,
  readArea: () => Promise<MonitorLogicalBounds>,
  options: { intervalMs?: number; isHidden?: () => boolean } = {}
): () => void {
  const isHidden = options.isHidden ?? (() => document.hidden);
  let lastArea: string | undefined;
  let checking = false;
  let stopped = false;
  const checkWorkArea = async () => {
    if (checking || isHidden()) return;
    checking = true;
    try {
      const area = workAreaKey(await readArea());
      if (stopped) return;
      if (lastArea !== undefined && lastArea !== area) {
        // Record the area only after the change was handled: a refused or failed refit leaves the
        // old area in place, so the next read sees the change again and retries it.
        const handled = await onChange();
        if (stopped || handled === false) return;
      }
      lastArea = area;
    } finally {
      checking = false;
    }
  };
  const check = () => { void checkWorkArea().catch(() => undefined); };
  check();
  const timer = window.setInterval(check, options.intervalMs ?? WORK_AREA_POLL_MS);
  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}

/**
 * Linux content-fit palettes: every `intervalMs`, read the work area and call `refit` when its
 * placement key (`workAreaPlacementKey`: the area and the display scale) differs from `fittedKey()`,
 * the key of the last fit the native side accepted. The poll records nothing itself: the caller
 * records the key of the area its fit actually used, once that fit is accepted. So a fit made
 * between polls for another area (a move) is what the next read is compared with, a silent return
 * to an earlier area is still a change, and a refused fit leaves the old key and is retried.
 * Skips a read while hidden, while the previous one is pending, or before any fit was accepted.
 * Returns the stop function.
 */
export function pollPlacementAgainstFit(
  refit: () => unknown,
  readArea: () => Promise<MonitorLogicalBounds>,
  fittedKey: () => string | undefined,
  options: { intervalMs?: number; isHidden?: () => boolean } = {}
): () => void {
  const isHidden = options.isHidden ?? (() => document.hidden);
  let checking = false;
  let stopped = false;
  const checkPlacement = async () => {
    if (checking || stopped || isHidden() || fittedKey() === undefined) return;
    checking = true;
    try {
      const key = workAreaPlacementKey(await readArea());
      const fitted = fittedKey();
      if (!stopped && fitted !== undefined && key !== fitted) await refit();
    } finally {
      checking = false;
    }
  };
  const timer = window.setInterval(() => {
    void checkPlacement().catch(() => undefined);
  }, options.intervalMs ?? WORK_AREA_POLL_MS);
  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}
