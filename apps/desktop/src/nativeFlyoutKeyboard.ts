import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";
import {
  isToolsetPopoverFocusTransfer, isToolsetPopoverVisible, listenForAcceptedToolsetPopoverContent, listenForToolsetPopoverContent,
  listenForToolsetPopoverClosed, listenForToolsetPopoverDismiss, listenForToolsetFlyoutClosed, listenForToolsetFlyoutOpening,
  sendToolsetFlyoutKey, toolsetPopoverTimestamp, type AcceptedToolsetPopoverOpening, type ToolsetFlyoutSession
} from "./window-manager";
import {
  acceptFlyoutOpening, closeFlyoutMenu, closeFlyoutOpening, currentFlyoutOpening, dismissFlyoutOpenings,
  latestLiveFlyoutOpening, matchesToolsetPopoverOpening, newFlyoutOpeningState
} from "./window-manager/flyoutOpeningRule";

const FLYOUT_ACCEPTANCE_TIMEOUT_MS = 1_000;

/** Install in the document and standalone palette windows: nonactivating flyouts
 * preserve either window's focus. Route keys before toolbar buttons, canvas
 * shortcuts and browser defaults, without transferring window or DOM focus. */
export function installNativeFlyoutKeyboard(platform: ShortcutPlatform = detectDesktopShortcutPlatform()): () => void {
  let openings = newFlyoutOpeningState();
  type KeyQueue = { session: ToolsetFlyoutSession; keys: string[]; accepted: boolean; flushing: boolean; acceptanceTimer?: number };
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
      if (currentFlyoutOpening(openings, toolsetId) !== queue.session) {
        window.clearTimeout(queue.acceptanceTimer);
        queues.delete(toolsetId);
      }
    }
  };
  const trackOpening = (opening: AcceptedToolsetPopoverOpening) => {
    const next = acceptFlyoutOpening(openings, opening);
    if (next === openings) return;
    updateOpenings(next);
    if (opening.flyoutId === undefined) return;
    const queue: KeyQueue = { session: opening as ToolsetFlyoutSession, keys: [], accepted: false, flushing: false };
    queues.set(opening.toolsetId, queue);
    if (platform === "windows") {
      // Release the keys after a stalled open. A late acceptance can route fresh keys.
      queue.acceptanceTimer = window.setTimeout(() => queues.delete(opening.toolsetId), FLYOUT_ACCEPTANCE_TIMEOUT_MS);
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
    window.clearTimeout(queue.acceptanceTimer);
    queue.accepted = true;
    void flush(queue);
  }));
  if (platform === "windows") subscribe(listenForToolsetFlyoutOpening(opening => {
    if (!disposed) trackOpening(opening);
  }));
  subscribe(listenForToolsetPopoverContent(payload => {
    // Only the renderer assigns identities to legacy content without an opening timestamp.
    if (disposed || payload.openedAt === undefined) return;
    const flyoutId = payload.kind === "flyout" && payload.flyout.variant !== "bondStereo" ? payload.flyout.flyoutId : undefined;
    trackOpening({ toolsetId: payload.toolsetId, openedAt: payload.openedAt, generation: payload.generation, flyoutId });
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
    const queue = session && queues.get(session.toolsetId);
    if (!queue || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const arrow = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key);
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    const activation = event.key === "Enter" || event.key === " ";
    const awaitingAcceptance = platform === "windows" && !queue.accepted;
    const pendingNavigation = awaitingAcceptance && (event.key === "Home" || event.key === "End");
    if (!arrow && !pendingNavigation && !(plain && activation)) return;
    // All arrows belong to the open flyout, including its unused axis and modified
    // arrows: none may fall through to selection nudging or page scrolling.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (activation) activationKeys.add(event.key);
    // Enter or Space pressed before the native reveal must never choose from it.
    if (plain && (arrow || !awaitingAcceptance)) {
      queue.keys.push(event.key);
      void flush(queue);
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
    const opening = latestLiveFlyoutOpening(openings);
    if (opening?.flyoutId === undefined) {
      // Without a Windows foreground snapshot, a native open's blur can arrive
      // before its stamped notice. Retire only openings already known here.
      const targets = platform === "windows"
        ? [...openings.latest.values()].filter(candidate => candidate.openedAt <= requestedAt)
        : undefined;
      updateOpenings(dismissFlyoutOpenings(openings, { requestedAt, openings: targets }));
      return;
    }
    const check = { requestedAt };
    focusChecks.add(check);
    // WebView2 can blur during the reveal/release while the owner retains native
    // focus. The flyout itself can also briefly receive focus during the handoff.
    const finish = (keptFocus: boolean) => {
      if (disposed) return;
      focusChecks.delete(check);
      // Retire even stamped replacements whose notice arrived during or after the check.
      if (!keptFocus) updateOpenings(dismissFlyoutOpenings(openings, { requestedAt }));
      for (const queue of queues.values()) void flush(queue);
    };
    void isToolsetPopoverFocusTransfer(opening.toolsetId, platform === "windows").then(finish, () => finish(false));
  };
  window.addEventListener("keydown", keyDown, true);
  window.addEventListener("keyup", keyUp, true);
  window.addEventListener("blur", blur);
  return () => {
    disposed = true;
    for (const queue of queues.values()) window.clearTimeout(queue.acceptanceTimer);
    queues.clear();
    focusChecks.clear();
    cleanups.forEach(stop => stop());
    window.removeEventListener("keydown", keyDown, true);
    window.removeEventListener("keyup", keyUp, true);
    window.removeEventListener("blur", blur);
  };
}
