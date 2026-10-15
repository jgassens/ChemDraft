import { listenForPalettePointer, listenForPalettePointerLeave } from "../window-manager";

/** WKWebView in a non-key panel needs the same native cursor feed as the floating toolbars. */
export function installPluginPanelPointerFeed(panelId: string): () => void {
  const label = `plugin-panel-${panelId.replaceAll(".", ":")}`;
  const cleanups: (() => void)[] = [];
  let disposed = false;
  let previous: Element | null = null;
  const dispatch = (target: Element, type: string, relatedTarget: Element | null, x = 0, y = 0): void => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerType: "mouse", relatedTarget, clientX: x, clientY: y
    }));
  };
  const clear = (): void => {
    if (!previous) return;
    dispatch(previous, "pointerout", null);
    previous.closest("button")?.classList.remove("panel-synthetic-hover");
    previous = null;
  };
  const retain = (cleanup: () => void): void => {
    if (disposed) cleanup();
    else cleanups.push(cleanup);
  };
  void listenForPalettePointer(label, ({ x, y }) => {
    // The key panel gets real events. Synthesizing alongside them would duplicate chart feedback.
    if (document.hasFocus()) { clear(); return; }
    const target = document.elementFromPoint(x, y);
    if (target !== previous) {
      clear();
      previous = target;
      if (target) {
        dispatch(target, "pointerover", null, x, y);
        target.closest("button")?.classList.add("panel-synthetic-hover");
      }
    }
    if (target) dispatch(target, "pointermove", null, x, y);
  }).then(retain).catch(() => undefined);
  void listenForPalettePointerLeave(label, clear).then(retain).catch(() => undefined);
  return () => {
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    clear();
  };
}
