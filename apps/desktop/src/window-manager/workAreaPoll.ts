import type { PaletteWorkArea } from "./index";

/** How often a window re-reads its monitor's work area. */
export const WORK_AREA_POLL_MS = 1000;

/** A work area as a comparable key. */
export function workAreaKey(area: PaletteWorkArea): string {
  const bounds = `${area.left}:${area.top}:${area.right}:${area.bottom}`;
  return area.x11ContentScale === undefined ? bounds : `${bounds}@x11:${area.x11ContentScale}`;
}

/**
 * Call `onChange` when the current window's work area changes with no window event: a taskbar,
 * Dock or panel added, removed or resized changes it without moving or resizing the window. Reads
 * once now (the baseline, never a change) and then every `intervalMs`; skips a read while the page
 * is hidden or the previous read is still pending. Returns the stop function.
 *
 * The resizable inspector uses it on every platform. Content-fit palettes use it on Linux only,
 * where the same change left a palette capped or uncapped until its next move (PaletteWindow).
 */
export function pollWorkAreaChanges(
  onChange: () => void,
  readArea: () => Promise<PaletteWorkArea>,
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
      if (lastArea !== undefined && lastArea !== area) onChange();
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
