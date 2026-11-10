import {
  listenForToolsetPopoverContent, listenForToolsetPopoverDismiss, listenForToolsetFlyoutClosed,
  sendToolsetFlyoutKey, toolsetPopoverTimestamp, type ToolsetFlyoutSession
} from "./window-manager";

/** Install in the document and standalone palette windows: nonactivating flyouts
 * preserve either window's focus. Route keys before toolbar buttons, canvas
 * shortcuts and browser defaults, without transferring window or DOM focus. */
export function installNativeFlyoutKeyboard(): () => void {
  let session: ToolsetFlyoutSession | undefined;
  let closedThrough = -Infinity;
  let latestOpenAt = -Infinity;
  const activationKeys = new Set<string>();
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const subscribe = (promise: Promise<() => void>) => {
    void promise.then(stop => disposed ? stop() : cleanups.push(stop)).catch(() => undefined);
  };
  subscribe(listenForToolsetPopoverContent(payload => {
    if (disposed) return;
    const openedAt = payload.openedAt ?? toolsetPopoverTimestamp();
    if (openedAt <= closedThrough || openedAt < latestOpenAt) return;
    latestOpenAt = openedAt;
    session = payload.kind === "flyout" && payload.flyout.variant !== "bondStereo"
      ? { toolsetId: payload.toolsetId, flyoutId: payload.flyout.flyoutId, openedAt }
      : undefined;
  }));
  const dismiss = (requestedAt = toolsetPopoverTimestamp()) => {
    closedThrough = Math.max(closedThrough, requestedAt);
    if (session && session.openedAt <= requestedAt) session = undefined;
  };
  subscribe(listenForToolsetPopoverDismiss(payload => dismiss(payload?.requestedAt)));
  subscribe(listenForToolsetFlyoutClosed(payload => {
    closedThrough = Math.max(closedThrough, payload.openedAt);
    if (session?.toolsetId === payload.toolsetId && session.flyoutId === payload.flyoutId &&
        session.openedAt === payload.openedAt) session = undefined;
  }));
  const keyDown = (event: KeyboardEvent) => {
    if (event.repeat && activationKeys.has(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!session || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const arrow = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key);
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (!arrow && !(plain && (event.key === "Enter" || event.key === " "))) return;
    // All arrows belong to the open flyout, including its unused axis and modified
    // arrows: none may fall through to selection nudging or page scrolling.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!arrow) activationKeys.add(event.key);
    if (plain) void sendToolsetFlyoutKey({ ...session, key: event.key }).catch(() => undefined);
  };
  const keyUp = (event: KeyboardEvent) => {
    if (!activationKeys.delete(event.key)) return;
    // Space's native button click can occur on keyup, after the flyout has closed.
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const pointerAway = () => dismiss();
  const blur = () => { activationKeys.clear(); dismiss(); }; // App deactivation hides utility windows.
  window.addEventListener("keydown", keyDown, true);
  window.addEventListener("keyup", keyUp, true);
  window.addEventListener("pointerdown", pointerAway, true);
  window.addEventListener("blur", blur);
  return () => {
    disposed = true;
    session = undefined;
    cleanups.forEach(stop => stop());
    window.removeEventListener("keydown", keyDown, true);
    window.removeEventListener("keyup", keyUp, true);
    window.removeEventListener("pointerdown", pointerAway, true);
    window.removeEventListener("blur", blur);
  };
}
