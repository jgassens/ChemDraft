import { isBlockedByModalDialog, shouldIgnoreShortcutTarget } from "@chemdraft/shortcut-engine";
import {
  dismissToolsetPopovers, listenForToolsetPopoverContent, listenForToolsetPopoverDismiss,
  listenForToolsetPopoverClosed, listenForToolsetPopoverNativeClose, toolsetPopoverTimestamp, isToolsetPopoverVisible,
  compareToolsetPopoverOpenings, type ToolsetPopoverOpening
} from "./index";

// Inline menus live in this webview. Native announcements identify candidates only;
// they never establish visibility. Every native Escape decision reads the OS window.
const inlineDismissals = new Set<() => void>();
export function registerInlinePopover(dismiss: () => void): () => void {
  inlineDismissals.add(dismiss);
  return () => { inlineDismissals.delete(dismiss); };
}

/** Install on document/palette windows only. Editors and dialogs retain ownership of Escape. */
export function installPopoverEscapeRouting(editorOpen: () => boolean = () => false): () => void {
  type Opening = ToolsetPopoverOpening & { toolsetId: string; revision: number; checking: boolean; ready: Promise<void>; stop?: () => void };
  const opens = new Map<string, Opening>();
  const closed = new Map<string, ToolsetPopoverOpening>();
  let dismissedAt = -Infinity;
  let disposed = false;
  const stops: (() => void)[] = [];
  const forwarded = new WeakSet<KeyboardEvent>();
  let composing = false;
  const compositionStart = () => { composing = true; };
  const compositionEnd = () => { composing = false; };
  // AppKit can hide a utility without a renderer close. Invalidate in-flight reads,
  // not a visibility cache: the next Escape must read the OS again after activation.
  const invalidateVisibility = () => { for (const opening of opens.values()) opening.revision++; };
  const retain = (stop: () => void) => { if (disposed) stop(); else stops.push(stop); };
  const retire = (opening: Opening) => {
    const previous = closed.get(opening.toolsetId);
    if (!previous || compareToolsetPopoverOpenings(opening, previous) > 0) {
      closed.set(opening.toolsetId, { openedAt: opening.openedAt, generation: opening.generation });
    }
    if (opens.get(opening.toolsetId) === opening) opens.delete(opening.toolsetId);
    opening.revision++;
    opening.stop?.();
  };
  void listenForToolsetPopoverContent(payload => {
    const at = payload.openedAt;
    const previous = opens.get(payload.toolsetId);
    const tombstone = closed.get(payload.toolsetId);
    if (at === undefined || at <= dismissedAt || (tombstone && compareToolsetPopoverOpenings(payload, tombstone) <= 0)
      || (previous && compareToolsetPopoverOpenings(payload, previous) <= 0)) return;
    if (previous) retire(previous);
    const opening: Opening = { toolsetId: payload.toolsetId, openedAt: at, generation: payload.generation,
      revision: 0, checking: false, ready: Promise.resolve() };
    opens.set(payload.toolsetId, opening);
    opening.ready = listenForToolsetPopoverNativeClose(payload.toolsetId, () => retire(opening)).then(stop => {
      if (disposed || opens.get(payload.toolsetId) !== opening) stop();
      else opening.stop = stop;
    }).catch(() => retire(opening));
  }).then(retain).catch(() => undefined);
  void listenForToolsetPopoverClosed(payload => {
    const previous = closed.get(payload.toolsetId);
    if (!previous || compareToolsetPopoverOpenings(payload, previous) > 0) closed.set(payload.toolsetId, payload);
    const opening = opens.get(payload.toolsetId);
    if (opening && compareToolsetPopoverOpenings(opening, payload) === 0) retire(opening);
  }).then(retain).catch(() => undefined);
  void listenForToolsetPopoverDismiss(payload => {
    if (payload?.openings) {
      for (const target of payload.openings) {
        const previous = closed.get(target.toolsetId);
        if (!previous || compareToolsetPopoverOpenings(target, previous) > 0) closed.set(target.toolsetId, target);
        const opening = opens.get(target.toolsetId);
        if (opening && compareToolsetPopoverOpenings(opening, target) === 0) retire(opening);
      }
      return;
    }
    const at = payload?.requestedAt ?? toolsetPopoverTimestamp();
    dismissedAt = Math.max(dismissedAt, at);
    for (const opening of opens.values()) if (opening.openedAt! <= at) retire(opening);
  }).then(retain).catch(() => undefined);

  const ownedElsewhere = (event: KeyboardEvent, target: EventTarget | null = event.target) => event.isComposing || composing || editorOpen()
    || isBlockedByModalDialog(target) || shouldIgnoreShortcutTarget(target, event.key);
  const currentTarget = (event: KeyboardEvent): EventTarget => {
    // Focus may still be scheduled when an editor or modal opens. Resolve its DOM
    // owner explicitly instead of replaying to the canvas that owned the original key.
    const modal = document.querySelector<HTMLElement>('[aria-modal="true"]:not([hidden])');
    const active = document.activeElement;
    const editor = editorOpen() ? document.querySelector<HTMLElement>(
      '.text-object-editor, [data-atom-label-editor="true"], [data-table-cell-editor] textarea'
    ) : null;
    return modal ? (active && modal.contains(active) ? active : modal) : editor ?? (
      active && active !== document.body ? active : event.target instanceof Node && event.target.isConnected ? event.target : window
    );
  };
  const resumeEscape = (event: KeyboardEvent) => {
    if (disposed || event.isComposing || composing) return;
    const next = new KeyboardEvent("keydown", event);
    forwarded.add(next);
    currentTarget(event).dispatchEvent(next);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || ownedElsewhere(event)) return;
    if (forwarded.has(event)) return;
    const pending = [...opens.values()].filter(opening => !opening.checking);
    const hadInline = inlineDismissals.size > 0;
    if (!pending.length && !hadInline) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const requestedAt = toolsetPopoverTimestamp();
    for (const dismiss of [...inlineDismissals]) { inlineDismissals.delete(dismiss); dismiss(); }
    if (hadInline) return;
    // A second Escape can act on the canvas while the first read is pending. Keep
    // lifecycle subscriptions alive until it resolves, so close/blur can invalidate it.
    const checks = pending.map(async opening => {
      opening.checking = true;
      const revision = opening.revision;
      await opening.ready;
      if (disposed || opens.get(opening.toolsetId) !== opening || opening.revision !== revision) return false;
      const visible = await isToolsetPopoverVisible(opening.toolsetId).catch(() => false);
      return visible ? { opening, revision } : false;
    });
    void Promise.all(checks).then(visible => {
      if (disposed) return;
      const targets = visible.flatMap(result => result && opens.get(result.opening.toolsetId) === result.opening &&
        result.opening.revision === result.revision ? [result.opening] : []);
      pending.forEach(retire);
      // Re-evaluate every ownership guard after IPC, even when the flyout is visible.
      if (ownedElsewhere(event, currentTarget(event))) {
        resumeEscape(event);
      } else if (targets.length) {
        void dismissToolsetPopovers(requestedAt, "escape", targets.map(({ toolsetId, openedAt, generation }) =>
          ({ toolsetId, openedAt, generation }))).catch(() => undefined);
      } else {
        resumeEscape(event);
      }
    });
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", invalidateVisibility);
  window.addEventListener("compositionstart", compositionStart, true);
  window.addEventListener("compositionend", compositionEnd, true);
  return () => {
    disposed = true;
    opens.forEach(opening => opening.stop?.());
    stops.forEach(stop => stop());
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", invalidateVisibility);
    window.removeEventListener("compositionstart", compositionStart, true);
    window.removeEventListener("compositionend", compositionEnd, true);
  };
}
