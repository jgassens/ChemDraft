import { listenForPalettePointer, listenForPalettePointerLeave } from "../window-manager";

/** WKWebView in a non-key panel needs the same native cursor feed as the floating toolbars. */
export function installPluginPanelPointerFeed(panelId: string): () => void {
  const label = `plugin-panel-${panelId.replaceAll(".", ":")}`;
  const cleanups: (() => void)[] = [];
  let disposed = false;
  let previous: Element | null = null;
  let capture: { target: Element; pointerId: number } | undefined;
  let outside = false;
  const dispatch = (target: Element, type: string, relatedTarget: Element | null, x = 0, y = 0): void => {
    const init = { bubbles: true, relatedTarget, clientX: x, clientY: y };
    target.dispatchEvent(new PointerEvent(`pointer${type}`, {
      ...init, pointerType: "mouse", pointerId: capture?.pointerId ?? 1, isPrimary: true
    }));
    // React's existing linked peak/atom highlighting consumes mouseover/out, not pointerover/out.
    target.dispatchEvent(new MouseEvent(`mouse${type}`, init));
  };
  const transition = (target: Element | null, x = 0, y = 0): void => {
    if (target === previous) return;
    const from = previous;
    previous = target;
    if (from) {
      dispatch(from, "out", target, x, y);
      from.closest("button")?.classList.remove("panel-synthetic-hover");
    }
    if (target) {
      dispatch(target, "over", from, x, y);
      target.closest("button")?.classList.add("panel-synthetic-hover");
    }
  };
  const clear = (): void => {
    outside = true;
    if (!capture) transition(null);
  };
  const gotCapture = (event: PointerEvent): void => {
    if (!(event.target instanceof Element)) return;
    capture = { target: event.target, pointerId: event.pointerId };
  };
  const lostCapture = (event: PointerEvent): void => {
    if (capture?.pointerId !== event.pointerId) return;
    capture = undefined;
    if (outside) transition(null);
  };
  document.addEventListener("gotpointercapture", gotCapture, true);
  document.addEventListener("lostpointercapture", lostCapture, true);
  const retain = (cleanup: () => void): void => {
    if (disposed) cleanup();
    else cleanups.push(cleanup);
  };
  void listenForPalettePointer(label, ({ x, y }) => {
    outside = false;
    // The key panel gets real events. Synthesizing alongside them would duplicate chart feedback.
    if (document.hasFocus()) {
      previous?.closest("button")?.classList.remove("panel-synthetic-hover");
      previous = null; // Real boundary events take over; do not interrupt a real drag with a leave.
      return;
    }
    if (capture && !capture.target.isConnected) capture = undefined;
    const target = capture?.target ?? document.elementFromPoint(x, y);
    if (capture) {
      // Captured pointers have no hit-test boundary transitions, even outside the spectrum/window.
      previous?.closest("button")?.classList.remove("panel-synthetic-hover");
      previous = target;
    } else transition(target, x, y);
    if (target) dispatch(target, "move", null, x, y);
  }).then(retain).catch(() => undefined);
  void listenForPalettePointerLeave(label, clear).then(retain).catch(() => undefined);
  return () => {
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    document.removeEventListener("gotpointercapture", gotCapture, true);
    document.removeEventListener("lostpointercapture", lostCapture, true);
    capture = undefined;
    clear();
  };
}
