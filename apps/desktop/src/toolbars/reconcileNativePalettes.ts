import type { ToolsetWindowState } from "../window-manager";

/**
 * Injectable dependencies for {@link reconcileNativePaletteWindows}. Real callers wire these to
 * the window-manager IPC + the live toolbar registry; tests pass fakes.
 */
export interface NativePaletteReconcileDeps {
  /** Current native toolset window states (some may already be open, e.g. OS-restored). */
  listToolsetWindowStates: () => Promise<ToolsetWindowState[]>;
  /** Ask Rust to open (or reveal) one toolset's native floating window. */
  openToolsetWindow: (toolsetId: string) => Promise<ToolsetWindowState>;
  /** Is this id a real toolset in the current registry? (stale layout ids are ignored). */
  isKnownToolset: (toolsetId: string) => boolean;
  /** The toolsets the user wants visible right now (from layout state). */
  desiredVisibleToolsetIds: () => string[];
  /** Fallback set of toolsets to show when the user hasn't chosen any. */
  defaultVisibleToolsetIds: () => string[];
  delay?: (ms: number) => Promise<void>;
  /** Lets an unmounting effect abandon the reconcile without touching React state. */
  isCancelled?: () => boolean;
  /** How many times to try before concluding native windows are genuinely unavailable. */
  maxAttempts?: number;
  retryDelayMs?: number;
}

export type NativePaletteReconcileResult =
  | { outcome: "native"; openedToolsetIds: string[] }
  | { outcome: "fallback" }
  | { outcome: "cancelled" };

const defaultDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Opens the toolsets that should be visible as native floating windows, and reports whether the
 * app can stay in native-palette mode or must fall back to in-window web palettes.
 *
 * Why retry: `open_toolset_window` reports a window as open via `is_visible()`, which can briefly
 * return false on the frame the window is first created — so a single startup pass can see zero
 * open windows even though creation succeeded. The previous one-shot reconciler latched
 * `webPaletteFallback` permanently on that transient miss, trapping the user in in-window toolbars
 * ("stuck in the viewport") for the whole session. Retrying a few times lets the windows settle
 * before we decide, and we only fall back when native windows are *genuinely* unavailable.
 */
export async function reconcileNativePaletteWindows(
  deps: NativePaletteReconcileDeps
): Promise<NativePaletteReconcileResult> {
  const {
    listToolsetWindowStates,
    openToolsetWindow,
    isKnownToolset,
    desiredVisibleToolsetIds,
    defaultVisibleToolsetIds,
    delay = defaultDelay,
    isCancelled = () => false,
    maxAttempts = 3,
    retryDelayMs = 200
  } = deps;

  const attempts = Math.max(1, maxAttempts);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (isCancelled()) {
      return { outcome: "cancelled" };
    }

    try {
      const existing = await listToolsetWindowStates();
      if (isCancelled()) {
        return { outcome: "cancelled" };
      }

      const opened = new Set(
        existing.filter((state) => state.open && isKnownToolset(state.toolsetId)).map((state) => state.toolsetId)
      );

      const desired = desiredVisibleToolsetIds().filter(isKnownToolset);
      const target = desired.length > 0 ? desired : defaultVisibleToolsetIds().filter(isKnownToolset);

      for (const toolsetId of target) {
        if (opened.has(toolsetId)) {
          continue;
        }
        const state = await openToolsetWindow(toolsetId);
        if (isCancelled()) {
          return { outcome: "cancelled" };
        }
        if (state.open) {
          opened.add(toolsetId);
        }
      }

      if (opened.size > 0) {
        return { outcome: "native", openedToolsetIds: [...opened] };
      }
    } catch {
      if (isCancelled()) {
        return { outcome: "cancelled" };
      }
      // Swallow and retry: a transient IPC/window-timing failure must not permanently trap the
      // user in in-window palettes.
    }

    if (attempt < attempts) {
      await delay(retryDelayMs);
    }
  }

  return isCancelled() ? { outcome: "cancelled" } : { outcome: "fallback" };
}
