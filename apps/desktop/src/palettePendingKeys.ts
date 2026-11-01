import { listenCurrentWindowEvent } from "./window-manager/tauriEvents";

export const PALETTE_CLICK_PENDING_EVENT = "chemdraft://palette-click-pending";
export const PALETTE_CLICK_OUTSIDE_EVENT = "chemdraft://palette-click-outside";
export const PALETTE_CLICK_TIMEOUT_MS = 1_000;

export interface PaletteClickPendingEvent {
  sequence: number;
  pending: boolean;
  expiresAt: number;
}

type Key = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">;

/** Keep in step with palette_key_guard_state::editing_key (native menu equivalents). */
export function isPendingPaletteEditingKey(event: Key): boolean {
  if (event.key === "Delete" || event.key === "Backspace") return true;
  if (event.metaKey || event.ctrlKey) {
    return !event.altKey && ["a", "x", "v", "z", "y"].includes(event.key.toLowerCase());
  }
  // This includes the single-key tool/bond shortcuts, with or without Shift.
  return [...event.key].length === 1;
}

/** Disabled controls use a focusable shell; only typing belongs to that sink. */
export function isDisabledPaletteTypingKey(event: Key): boolean {
  if (["Delete", "Backspace", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return true;
  if (event.metaKey || event.ctrlKey) return !event.altKey && event.key.toLowerCase() === "a";
  return !event.altKey && [...event.key].length === 1;
}

export function listenPaletteClickPending(listener: (event: PaletteClickPendingEvent) => void): Promise<() => void> {
  return listenCurrentWindowEvent<PaletteClickPendingEvent>(PALETTE_CLICK_PENDING_EVENT, ({ payload }) => listener(payload));
}

async function clearNativeClick(sequence: number, pointerBefore: number): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().emit(PALETTE_CLICK_OUTSIDE_EVENT, { sequence, pointerBefore });
}

/** Installed by MainWindow before document keyboard handlers. No keyup is consumed. */
export function installMainWindowPalettePendingKeys(
  subscribe = listenPaletteClickPending,
  release = clearNativeClick
): () => void {
  let sequence = 0;
  let pending = false;
  let expiresAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  const clear = () => {
    pending = false;
    clearTimeout(timer);
  };
  const update = (event: PaletteClickPendingEvent) => {
    if (disposed || event.sequence < sequence || (event.sequence === sequence && !pending)) return;
    sequence = event.sequence;
    clear();
    if (!event.pending) return;
    expiresAt = Math.min(event.expiresAt, Date.now() + PALETTE_CLICK_TIMEOUT_MS);
    pending = expiresAt > Date.now();
    if (pending) timer = setTimeout(clear, expiresAt - Date.now());
  };
  const keyDown = (event: KeyboardEvent) => {
    if (pending && Date.now() >= expiresAt) clear();
    if (!pending || !isPendingPaletteEditingKey(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const outside = () => {
    const before = Date.now();
    const releasedSequence = sequence;
    clear();
    void release(releasedSequence, before).catch((error: unknown) =>
      console.error("Could not clear palette pointer intent:", error));
  };
  window.addEventListener("keydown", keyDown, true);
  window.addEventListener("pointerdown", outside, true);
  // Native activation decides whether blur is a palette acquisition or app loss.
  void subscribe(update).then((stop) => {
    if (disposed) stop();
    else unsubscribe = stop;
  }).catch((error: unknown) => console.error("Could not observe palette pointer intent:", error));
  return () => {
    disposed = true;
    clear();
    unsubscribe?.();
    window.removeEventListener("keydown", keyDown, true);
    window.removeEventListener("pointerdown", outside, true);
  };
}
