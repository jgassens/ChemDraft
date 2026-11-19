import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";
import {
  isToolsetPopoverFocusTransfer, isToolsetPopoverVisible, listenForAcceptedToolsetPopoverContent, listenForToolsetPopoverContent,
  listenForToolsetPopoverClosed, listenForToolsetPopoverDismiss, listenForToolsetFlyoutClosed,
  sendToolsetFlyoutKey, toolsetPopoverTimestamp, type ToolsetFlyoutSession
} from "./window-manager";
import {
  acceptFlyoutOpening, closeFlyoutMenu, closeFlyoutOpening, currentFlyoutOpening, dismissFlyoutOpenings,
  latestLiveFlyoutOpening, matchesToolsetPopoverOpening, newFlyoutOpeningState
} from "./window-manager/flyoutOpeningRule";

/** Install in the document and standalone palette windows: nonactivating flyouts
 * preserve either window's focus. Route keys before toolbar buttons, canvas
 * shortcuts and browser defaults, without transferring window or DOM focus. */
export function installNativeFlyoutKeyboard(platform: ShortcutPlatform = detectDesktopShortcutPlatform()): () => void {
  let openings = newFlyoutOpeningState();
  type KeyQueue = { session: ToolsetFlyoutSession; keys: string[]; accepted: boolean; flushing: boolean };
  const queues = new Map<string, KeyQueue>();
  const focusChecks = new Set<{ requestedAt: number }>();
  const activationKeys = new Set<string>();
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const subscribe = (promise: Promise<() => void>) => {
    void promise.then(stop => disposed ? stop() : cleanups.push(stop)).catch(() => undefined);
  };
  const updateOpenings = (next: typeof openings) => {
    openings = next;
    for (const [toolsetId, queue] of queues) {
      if (currentFlyoutOpening(openings, toolsetId) !== queue.session) queues.delete(toolsetId);
    }
  };
  const checkingFocus = (session: ToolsetFlyoutSession) => {
    for (const check of focusChecks) if (session.openedAt <= check.requestedAt) return true;
    return false;
  };
  const flush = async (queue: KeyQueue) => {
    if (!queue.accepted || queue.flushing || checkingFocus(queue.session)) return;
    const { toolsetId } = queue.session;
    queue.flushing = true;
    while (queues.get(toolsetId) === queue && queue.keys.length && !checkingFocus(queue.session)) {
      // Even an accepted reveal can be hidden by the OS before its close notice arrives.
      const visible = await isToolsetPopoverVisible(toolsetId).catch(() => false);
      if (queues.get(toolsetId) !== queue || checkingFocus(queue.session)) break;
      if (!visible) {
        updateOpenings(closeFlyoutOpening(openings, queue.session));
        break;
      }
      await sendToolsetFlyoutKey({ ...queue.session, key: queue.keys.shift()! }).catch(() => undefined);
    }
    queue.flushing = false;
  };
  subscribe(listenForAcceptedToolsetPopoverContent(opening => {
    if (disposed) return;
    updateOpenings(acceptFlyoutOpening(openings, opening));
    const session = currentFlyoutOpening(openings, opening.toolsetId);
    if (session?.flyoutId === undefined || opening.flyoutId !== session.flyoutId ||
        !matchesToolsetPopoverOpening(opening, session)) return;
    const queue = queues.get(session.toolsetId) ??
      { session: session as ToolsetFlyoutSession, keys: [], accepted: true, flushing: false };
    queues.set(session.toolsetId, queue);
    queue.accepted = true;
    void flush(queue);
  }));
  subscribe(listenForToolsetPopoverContent(payload => {
    // Only the renderer assigns identities to legacy content without an opening timestamp.
    if (disposed || payload.openedAt === undefined) return;
    const flyoutId = payload.kind === "flyout" && payload.flyout.variant !== "bondStereo" ? payload.flyout.flyoutId : undefined;
    const opening = { toolsetId: payload.toolsetId, openedAt: payload.openedAt, generation: payload.generation };
    const session = flyoutId === undefined ? undefined : { ...opening, flyoutId };
    const next = acceptFlyoutOpening(openings, session ?? opening);
    if (next === openings) return;
    updateOpenings(next);
    if (session) queues.set(session.toolsetId, { session, keys: [], accepted: false, flushing: false });
  }));
  subscribe(listenForToolsetPopoverDismiss(payload => {
    // Only the renderer knows what it had accepted when an unstamped broadcast arrived.
    // Its close notice retires that opening even if its content notice is still in flight.
    if (!disposed && payload) updateOpenings(dismissFlyoutOpenings(openings, payload));
  }));
  subscribe(listenForToolsetPopoverClosed(payload => {
    if (!disposed) updateOpenings(closeFlyoutOpening(openings, payload));
  }));
  subscribe(listenForToolsetFlyoutClosed(payload => {
    if (!disposed) updateOpenings(closeFlyoutMenu(openings, payload));
  }));
  const keyDown = (event: KeyboardEvent) => {
    if (event.repeat && activationKeys.has(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const session = latestLiveFlyoutOpening(openings);
    if (session?.flyoutId === undefined || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const arrow = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key);
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (!arrow && !(plain && (event.key === "Enter" || event.key === " "))) return;
    // All arrows belong to the open flyout, including its unused axis and modified
    // arrows: none may fall through to selection nudging or page scrolling.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!arrow) activationKeys.add(event.key);
    if (plain) {
      const queue = queues.get(session.toolsetId);
      if (queue) {
        queue.keys.push(event.key);
        void flush(queue);
      }
    }
  };
  const keyUp = (event: KeyboardEvent) => {
    if (!activationKeys.delete(event.key)) return;
    // Space's native button click can occur on keyup, after the flyout has closed.
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const blur = () => {
    activationKeys.clear();
    const requestedAt = toolsetPopoverTimestamp();
    // Windows can hand focus back to WebView2 during native open, before the palette
    // sends its already-stamped content. Scope blur to the openings we know about.
    const targets = platform === "windows"
      ? [...openings.latest.values()].filter(opening => opening.openedAt <= requestedAt)
      : undefined;
    const dismiss = () => {
      // App deactivation can hide a native utility without a renderer close notice.
      if (!disposed) updateOpenings(dismissFlyoutOpenings(openings, { requestedAt, openings: targets }));
    };
    const opening = latestLiveFlyoutOpening(openings);
    if (opening?.flyoutId === undefined) {
      dismiss();
      return;
    }
    const check = { requestedAt };
    focusChecks.add(check);
    // WebView2 can blur during the reveal/release while the owner retains native
    // focus. The flyout itself can also briefly receive focus during the handoff.
    const finish = (keptFocus: boolean) => {
      if (disposed) return;
      focusChecks.delete(check);
      if (!keptFocus) dismiss();
      for (const queue of queues.values()) void flush(queue);
    };
    void isToolsetPopoverFocusTransfer(opening.toolsetId, platform === "windows").then(finish, () => finish(false));
  };
  window.addEventListener("keydown", keyDown, true);
  window.addEventListener("keyup", keyUp, true);
  window.addEventListener("blur", blur);
  return () => {
    disposed = true;
    queues.clear();
    focusChecks.clear();
    cleanups.forEach(stop => stop());
    window.removeEventListener("keydown", keyDown, true);
    window.removeEventListener("keyup", keyUp, true);
    window.removeEventListener("blur", blur);
  };
}
