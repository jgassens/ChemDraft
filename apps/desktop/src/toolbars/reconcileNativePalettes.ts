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
  /** Ask Rust to close one toolset's native floating window (to honor a hidden/emptied desired set). */
  closeToolsetWindow: (toolsetId: string) => Promise<ToolsetWindowState>;
  /** Is this id a real toolset in the current registry? (stale layout ids are ignored). */
  isKnownToolset: (toolsetId: string) => boolean;
  /** The toolsets the user wants visible right now (from layout state). This is the authoritative
   *  target: an EMPTY set means "hide everything" and is honored as such, not replaced with defaults.
   *  The caller only runs the reconcile once native mode is active, and native mode is disabled on a
   *  layout-load failure, so an empty set here is always a real user choice, never a load error. */
  desiredVisibleToolsetIds: () => string[];
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
 * Reconcile the open native floating windows toward the toolsets the user wants visible: open the
 * desired-but-closed, close the open-but-undesired, and report whether the app can stay in
 * native-palette mode or must fall back to in-window web palettes.
 *
 * Convergent, not open-only: the previous version only ever OPENED windows, so a toolset saved as
 * hidden (but restored open by the OS) stayed open, and "hide everything" was silently replaced with
 * the default set. It now also CLOSES windows that shouldn't be open — but only for KNOWN toolsets.
 * An open window for an *unknown* toolset (a plugin that hasn't finished loading this launch, or one
 * being uninstalled) is left alone: closing it here would fight a plugin that's about to claim its
 * restored window. The reconcile re-runs whenever the registry changes, so it settles as plugins load.
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
    closeToolsetWindow,
    isKnownToolset,
    desiredVisibleToolsetIds,
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

      // The authoritative target — an empty set legitimately means "hide everything".
      const desired = new Set(desiredVisibleToolsetIds().filter(isKnownToolset));

      // Close KNOWN windows that are open but no longer wanted (saved hidden, or hidden-all). Unknown
      // ids are skipped on purpose (see the note above). A per-window close failure is swallowed so it
      // can't abort opening the rest.
      for (const state of existing) {
        if (state.open && isKnownToolset(state.toolsetId) && !desired.has(state.toolsetId)) {
          try {
            await closeToolsetWindow(state.toolsetId);
          } catch {
            // Ignore: a stubborn close must not block the reconcile or trip the fallback.
          }
          if (isCancelled()) {
            return { outcome: "cancelled" };
          }
        }
      }

      // Nothing desired → success (honors hide-all); the close pass above already tidied up. No point
      // retrying when there is nothing to open.
      if (desired.size === 0) {
        return { outcome: "native", openedToolsetIds: [] };
      }

      const opened = new Set(
        existing.filter((state) => state.open && desired.has(state.toolsetId)).map((state) => state.toolsetId)
      );

      for (const toolsetId of desired) {
        if (opened.has(toolsetId)) {
          continue;
        }
        // A rejection is just this palette failing to open — the same outcome as `open: false`, and
        // it must be scoped the same way. Letting it reach the attempt catch discarded the palettes
        // that HAD opened, so one failure dropped the whole session to web palettes and the
        // fallback handler then overwrote the user's saved visibility with the defaults.
        let state: ToolsetWindowState | undefined;
        try {
          state = await openToolsetWindow(toolsetId);
        } catch {
          state = undefined;
        }
        if (isCancelled()) {
          return { outcome: "cancelled" };
        }
        if (state?.open) {
          opened.add(toolsetId);
        }
      }

      // Lenient success: as long as SOMETHING opened, stay native. A palette that missed its creating
      // frame while others opened is reopened by a later reconcile pass — we deliberately don't demand
      // the full desired set here (that would drop to web palettes over one transient miss).
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
