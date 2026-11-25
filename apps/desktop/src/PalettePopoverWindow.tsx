import { logToolsetPopoverGeometry, perfHook, perfProbe } from "./perf/runtime";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ColorPickerPopoverBody, symbolToolGlyph, toolbarCommandFlyoutGridStyle } from "./ToolPalette";
import { Icon, ToolbarAssetIcon, type IconName } from "./icons";
import { toolbarAsset, type ToolbarAssetName } from "./toolbarAssets";
import { normalizeHexColor, objectCustomColorCommandId, textCustomColorCommandId, objectEffectColorCommandId } from "./commands";
import { installPaletteInputFocus } from "./plugins/pluginPanelInputFocus";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";
import { preventPaletteCommandPointerFocus } from "./paletteCommandPointerFocus";
import { observePaletteHitBoxes } from "./commandHitBoxes";
import { listenCurrentWindowEvent } from "./window-manager/tauriEvents";
import {
  acceptFlyoutOpening, closeFlyoutOpening, currentFlyoutOpening, dismissFlyoutOpenings,
  matchesToolsetPopoverOpening, newFlyoutOpeningState, resolveFlyoutOpening, wasFlyoutOpeningDismissed
} from "./window-manager/flyoutOpeningRule";
import { popoverAnchorRect, resolveAnchoredPopoverPosition, type PopoverWorkArea } from "./window-manager/popoverPlacement";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import {
  isToolsetPopoverVisible,
  listenForToolsetPopoverContent,
  listenForToolsetPopoverClosed,
  notifyToolsetPopoverContentAccepted,
  notifyToolsetPopoverClosed,
  listenForToolsetPopoverDismiss,
  listenForToolsetPopoverRelease,
  listenForToolsetFlyoutKeys,
  notifyToolsetFlyoutClosed,
  listenForBondStereoPopoverActions,
  listenForToolsetTextStyle,
  requestToolsetPopoverContent,
  requestToolsetTextStyle,
  sendPaletteCommand,
  sendPaletteCommandCancel,
  sendPaletteCommandCommit,
  sendPaletteCommandPreview,
  sendBondStereoPopoverAction,
  monitorLogicalWorkAreaAt,
  setCurrentWindowLogicalPosition,
  setCurrentWindowLogicalSize,
  setPaletteCommandHitBoxes,
  showCurrentToolsetPopoverWindow,
  toolsetPopoverTimestamp,
  type ToolsetArtPaintTarget,
  type ToolsetArtStylePayload,
  type ToolsetFlyoutCommandOpening,
  type ToolsetFlyoutCommandSnapshot,
  type ToolsetPopoverAnchor,
  type ToolsetPopoverContent
} from "./window-manager";

/**
 * A palette popover rendered in its OWN small floating window so it overflows the little palette
 * and floats over the document — the native way (a webview can't paint outside its window). It's
 * content-agnostic: one window per palette, and its owner (PaletteWindow) pushes what to show —
 * the Art colour picker or a flyout dropdown (shape/align/etc.) — so opening one after the other
 * just swaps the content in place; there's never a stale second window to keep in sync.
 *
 * Dismissal (both kinds): Escape, a click anywhere outside (the dismiss broadcast), or the app
 * deactivating (hidesOnDeactivate). The colour picker deliberately does NOT close on every commit
 * (it commits per RGB/hex keystroke); a flyout closes the moment you pick a command.
 */
function hideNativePopoverWindow(isCurrent: () => boolean) {
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => {
      if (isCurrent()) return getCurrentWindow().hide();
    })
    .catch(() => undefined);
}

const keepBondStereoCommand: ToolsetFlyoutCommandSnapshot = {
  id: "keep", title: "Keep unspecified", enabled: true, active: false
};

function flyoutCommandOpening(toolsetId: string, content: ToolsetPopoverContent): ToolsetFlyoutCommandOpening | undefined {
  if (content.kind !== "flyout" || content.openedAt === undefined) return;
  return { toolsetId, flyoutId: content.flyout.flyoutId, openedAt: content.openedAt, generation: content.generation,
    ...(content.flyout.variant === "bondStereo" ? { bondStereoSessionId: content.flyout.id } : {}) };
}

export function PalettePopoverWindow({
  toolsetId = "core.art",
  kind = "artColor",
  prewarm = false,
  platform = detectDesktopShortcutPlatform()
}: {
  toolsetId?: string;
  kind?: string;
  /** Built hidden ahead of use (Rust prewarm_toolset_popover): stay invisible until the palette
   *  pushes real content — never reveal off the initial placeholder state. */
  prewarm?: boolean;
  platform?: ShortcutPlatform;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  // Whether the owning palette has pushed content at least once. A prewarmed window must not reveal
  // (or answer its own mount content-request) before then — its initial state is a placeholder.
  const contentPushedRef = useRef(false);
  const openingsRef = useRef(newFlyoutOpeningState());
  const perfShownRef = useRef<ReturnType<NonNullable<typeof perfProbe>["surfaceStarted"]>>(undefined);
  // Set the moment this popover is dismissed (Escape, click-away, a chosen flyout command) so an
  // in-flight reveal chain cannot show it again after the user has closed it.
  const dismissedRef = useRef(false);
  const keepWindowFocusRef = useRef(false);
  const hidePopoverWindow = (notify = true) => {
    keepWindowFocusRef.current = false;
    const current = contentRef.current;
    const { openedAt, generation } = current;
    if (notify && openedAt !== undefined) {
      openingsRef.current = closeFlyoutOpening(openingsRef.current, { toolsetId, openedAt, generation });
      void notifyToolsetPopoverClosed(toolsetId, openedAt, generation).catch(() => undefined);
      if (current.kind === "flyout" && current.flyout.variant !== "bondStereo") {
        void notifyToolsetFlyoutClosed({ toolsetId, flyoutId: current.flyout.flyoutId, openedAt, generation,
          ...(generation === undefined ? { exactOpening: true } : {})
        }).catch(() => undefined);
      }
    }
    hideNativePopoverWindow(() => contentRef.current === current);
  };
  const closedBondStereoSessions = useRef(new Set<string>());
  // Where this open's top-left belongs (global logical). Re-asserted after every content-fit
  // resize: macOS resizes are bottom-anchored, so a height change after Rust's set_position
  // would otherwise shove the window down by the delta — the first-open misposition.
  const anchorRef = useRef<ToolsetPopoverAnchor | undefined>(undefined);
  // The work area of the monitor under the current anchor, read once per anchor.
  const anchorWorkAreaRef = useRef<{ anchor: ToolsetPopoverAnchor; area: Promise<PopoverWorkArea | undefined> } | undefined>(
    undefined
  );
  // Never the bare anchor: below it the popover can run past the work area — under the Windows
  // taskbar or the Dock — when its control is near the bottom (or right) of the screen. Flip above
  // or shift so the whole frame stays on the anchor's monitor (popoverPlacement.ts).
  const anchoredPosition = async (anchor: ToolsetPopoverAnchor, size: { width: number; height: number }) => {
    if (anchorWorkAreaRef.current?.anchor !== anchor) {
      const rect = popoverAnchorRect(anchor);
      anchorWorkAreaRef.current = {
        anchor,
        area: Promise.resolve()
          .then(() => monitorLogicalWorkAreaAt((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2))
          .catch(() => undefined)
      };
    }
    const area = anchorWorkAreaRef.current.area;
    return resolveAnchoredPopoverPosition(anchor, { width: Math.ceil(size.width), height: Math.ceil(size.height) }, () => area);
  };
  const [content, setContent] = useState<ToolsetPopoverContent>(() =>
    kind === "flyout"
      ? { kind: "flyout", flyout: { flyoutId: "", title: "", commands: [] } }
      : { kind: kind === "textColor" ? "textColor" : "artColor" }
  );
  const [artStyle, setArtStyle] = useState<ToolsetArtStylePayload | undefined>();
  const contentRef = useRef(content);
  const shownContentRef = useRef<ToolsetPopoverContent | undefined>(undefined);
  const pendingChoiceRef = useRef<ToolsetPopoverContent | undefined>(undefined);
  const [highlightedCommandId, setHighlightedCommandId] = useState<string>();
  const highlightedCommandRef = useRef<string | undefined>(undefined);
  const resetScroll = (phase: "reveal" | "release" | "guard" = "guard") => {
    const reset = () => {
      // A reused WKWebView can retain scrolling from layout at its previous, smaller size.
      for (const element of [document.scrollingElement, document.documentElement, document.body,
        document.getElementById("root"), shellRef.current, shellRef.current?.firstElementChild]) {
        if (element) { element.scrollTop = 0; element.scrollLeft = 0; }
      }
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    };
    if (contentRef.current.kind === "flyout" && shellRef.current) {
      // Sample every repair, including capture-phase scroll events, before it clears offsets.
      logToolsetPopoverGeometry(phase, shellRef.current, reset);
    } else reset();
  };
  useLayoutEffect(resetScroll, [content]);
  const notifyBondStereoClose = (current = contentRef.current) => {
    if (current.kind === "flyout" && current.flyout.variant === "bondStereo" && current.flyout.id) {
      void sendBondStereoPopoverAction({ sessionId: current.flyout.id, action: "close" }).catch(() => undefined);
    }
  };
  const [artStyleTarget, setArtStyleTarget] = useState<ToolsetArtPaintTarget>("fill");
  const [fallbackColor, setFallbackColor] = useState<string | undefined>();
  const [colorContextKey, setColorContextKey] = useState<string | undefined>();
  const [draft, setDraft] = useState<string | undefined>();

  const effectiveTarget: ToolsetArtPaintTarget = artStyle?.activePaintTarget ?? artStyleTarget ?? "fill";
  const effectKind = content.kind === "artColor" ? content.effectKind : undefined;
  const activeColor = effectKind ? artStyle?.effectControls[effectKind]?.color.value ?? "#52616b" : effectiveTarget === "fill"
    ? artStyle?.values.fillColor.value
    : artStyle?.values.strokeColor.value;
  const currentColor = normalizeHexColor(content.kind === "textColor" ? fallbackColor : activeColor ?? fallbackColor) ?? "#111111";
  const value = draft ?? currentColor;

  useEffect(() => {
    const shell = shellRef.current;
    if (shell) return installPaletteInputFocus(shell, platform, undefined, () => keepWindowFocusRef.current);
  }, [platform]);

  useEffect(() => {
    const shell = shellRef.current;
    if (platform !== "windows" || !shell) return;
    return observePaletteHitBoxes(shell, setPaletteCommandHitBoxes, refresh =>
      listenCurrentWindowEvent("chemdraft://palette-command-hit-boxes-refresh", refresh));
  }, [platform, toolsetId]);

  useEffect(() => () => {
    if (platform === "windows") void setPaletteCommandHitBoxes([], []).catch(() => undefined);
  }, [platform]);

  useEffect(() => {
    document.documentElement.classList.add("palette-popover-window-html");
    document.body.classList.add("palette-popover-window-body");
    // overflow:hidden prevents user scrolling; this also catches browser focus/scroll anchoring.
    const guardScroll = () => resetScroll();
    document.addEventListener("scroll", guardScroll, true);
    window.addEventListener("scroll", guardScroll);
    document.addEventListener("focusin", guardScroll);
    return () => {
      document.removeEventListener("scroll", guardScroll, true);
      window.removeEventListener("scroll", guardScroll);
      document.removeEventListener("focusin", guardScroll);
      document.documentElement.classList.remove("palette-popover-window-html");
      document.body.classList.remove("palette-popover-window-body");
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // The opening press is captured by the OWNER window, not this separate webview.
    const afterRelease = (payload?: { toolsetId: string; releasedAt: number }) => {
      if (payload && (payload.toolsetId !== toolsetId || payload.releasedAt < (contentRef.current.openedAt ?? 0))) return;
      window.setTimeout(() => {
        if (disposed || dismissedRef.current) return;
        resetScroll("release");
      }, 0);
    };
    const localRelease = () => afterRelease();
    window.addEventListener("pointerup", localRelease, true);
    void listenForToolsetPopoverRelease(afterRelease).then(stop => {
      if (disposed) stop(); else unlisten = stop;
    }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); window.removeEventListener("pointerup", localRelease, true); };
  }, [toolsetId]);

  // The owning palette pushes what this window should show. Request it on mount too — an open may
  // have emitted before this window finished subscribing (a cold first open, or a press landing
  // while a prewarmed webview was still loading). The palette only answers once a real open has
  // happened, so a prewarmed window that nothing opened stays silent and hidden.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForToolsetPopoverContent((payload) => {
      if (payload.toolsetId !== toolsetId) {
        return;
      }
      const previous = openingsRef.current;
      const opening = resolveFlyoutOpening(previous, payload, toolsetPopoverTimestamp());
      const accepted = { ...opening, toolsetId,
        flyoutId: payload.kind === "flyout" && payload.flyout.variant !== "bondStereo" ? payload.flyout.flyoutId : undefined
      };
      const nextOpenings = acceptFlyoutOpening(previous, accepted);
      if (nextOpenings === previous) {
        if (wasFlyoutOpeningDismissed(previous, opening.openedAt)) notifyBondStereoClose(payload);
        const current = currentFlyoutOpening(previous, toolsetId);
        if (current && matchesToolsetPopoverOpening(current, opening)) {
          // A router that missed the first acceptance can catch up on a replay.
          if (!dismissedRef.current && shownContentRef.current === contentRef.current) {
            void notifyToolsetPopoverContentAccepted(current).catch(() => undefined);
          }
        } else if (payload.openedAt !== undefined) {
          // A router that missed the close or replacement may still be waiting.
          void notifyToolsetPopoverClosed(toolsetId, opening.openedAt, opening.generation).catch(() => undefined);
        }
        return;
      }
      if (payload.kind === "flyout" && payload.flyout.variant === "bondStereo" && payload.flyout.id) {
        if (closedBondStereoSessions.current.has(payload.flyout.id)) return;
        const current = contentRef.current;
        // Startup replay and the owner's push can both arrive. Replaying a session
        // must not restore focus or resurrect a popover after an action/dismissal.
        if (current.kind === "flyout" && current.flyout.id === payload.flyout.id) return;
      }
      openingsRef.current = nextOpenings;
      if (perfShownRef.current) perfHook(() => perfProbe?.surfaceShown(perfShownRef.current, "no-op"));
      perfShownRef.current = perfHook(() => perfProbe?.surfaceStarted("palette-popover", undefined, payload.kind === "flyout" ? payload.flyout.flyoutId : payload.kind));
      // A fresh push is a fresh open — it may follow a dismissal.
      contentPushedRef.current = true;
      highlightedCommandRef.current = platform === "windows" && payload.kind === "flyout" &&
        payload.flyout.variant === "bondStereo" && payload.flyout.keyboardOpen
        ? payload.flyout.commands.find(command => command.enabled)?.id ?? "keep" : undefined;
      setHighlightedCommandId(highlightedCommandRef.current);
      dismissedRef.current = false;
      if (payload.anchor && typeof payload.anchor.x === "number" && typeof payload.anchor.y === "number") {
        anchorRef.current = payload.anchor;
      }
      if (payload.kind === "textColor" || payload.kind === "artColor") setDraft(undefined);
      const next: ToolsetPopoverContent = { ...payload, ...opening,
        ...(payload.kind === "artColor" || payload.kind === "textColor" ? {
          effectKind: payload.kind === "artColor" &&
            (payload.effectKind === "glow" || payload.effectKind === "shadow" || payload.effectKind === "sketch")
            ? payload.effectKind : undefined
        } : {}) };
      contentRef.current = next;
      setContent(next);
    })
      .then((cleanup) => {
        unlisten = cleanup;
        void requestToolsetPopoverContent(toolsetId).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [toolsetId, platform]);

  // The owner can close an opening while its content is still in transit.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForToolsetPopoverClosed(payload => {
      if (disposed || payload.toolsetId !== toolsetId) return;
      const wasOpen = currentFlyoutOpening(openingsRef.current, toolsetId);
      openingsRef.current = closeFlyoutOpening(openingsRef.current, payload);
      if (wasOpen && !currentFlyoutOpening(openingsRef.current, toolsetId)) {
        dismissedRef.current = true;
        hidePopoverWindow(false);
      }
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [toolsetId]);

  // Follow the shared broadcast so the colour picker always opens on the current object's colour.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForToolsetTextStyle((payload) => {
      setArtStyle(payload.currentArtStyle);
      setColorContextKey(payload.colorContextKey);
      setArtStyleTarget(payload.currentArtStyle?.activePaintTarget ?? payload.currentArtStyleTarget ?? "fill");
      setFallbackColor(payload.currentTextStyle?.color);
    })
      .then((cleanup) => {
        unlisten = cleanup;
        void requestToolsetTextStyle().catch(() => undefined);
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  // Once the live colour arrives (or changes because the selection changed), drop any stale local
  // draft — the picker should reflect whatever the current object actually is.
  useEffect(() => {
    setDraft(undefined);
  }, [currentColor, colorContextKey]);

  // Fit the window to whatever content it's showing, in both dimensions. Every resize
  // re-asserts the anchored position: a bottom-anchored macOS resize moves the top-left,
  // so size and position travel as a pair.
  useEffect(() => {
    const shell = shellRef.current;
    const applySize = () => {
      const rect = shell?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) {
        return;
      }
      void (async () => {
        await setCurrentWindowLogicalSize({ width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
        const anchor = anchorRef.current;
        if (anchor) {
          await setCurrentWindowLogicalPosition(await anchoredPosition(anchor, rect));
        }
      })().catch(() => undefined).finally(resetScroll);
    };

    applySize();
    if (!shell || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => applySize());
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  // Reveal the window once the requested content is committed and measured. This runs on EVERY
  // content push, not once: Rust never shows a reused window (that would flash whatever it painted
  // last), so each open — cold, warm, or after a dismissal — is revealed here, already-correct.
  // The color picker is ready immediately; a flyout is ready when its commands arrive. A prewarmed
  // window sits on placeholder state until the first push, and must not reveal before it.
  //
  // Deliberately NOT deferred to requestAnimationFrame: a hidden webview that has idled long enough
  // (a prewarmed or previously dismissed popover) has rAF suspended, and it only resumes once the
  // window is shown — gating show() on rAF deadlocks into a popover that never appears. Layout still
  // runs while hidden, so measuring synchronously after the React commit is safe; the ResizeObserver
  // effect above keeps the size pixel-perfect once painting resumes.
  useEffect(() => {
    const ready = content.kind !== "flyout" || content.flyout.commands.length > 0;
    if (!ready && perfShownRef.current) {
      perfHook(() => perfProbe?.surfaceShown(perfShownRef.current, "no-op"));
      perfShownRef.current = undefined;
    }
    if (!ready && content.openedAt !== undefined && contentRef.current === content && !dismissedRef.current) {
      dismissedRef.current = true;
      hidePopoverWindow();
    }
    if (!ready || (prewarm && !contentPushedRef.current)) {
      return;
    }
    // One-frame background scrub before the reveal: a reused hidden webview can come back
    // with stale pixels of its previous content composited under the new (the same WKWebView
    // under-invalidation family as the canvas chrome ghosts). Flipping the background forces
    // a full repaint of this small window. setTimeout, not requestAnimationFrame — rAF is
    // suspended while the window is hidden (see the reveal comment above).
    document.body.style.backgroundColor = "#fffefe";
    const scrubTimer = window.setTimeout(() => {
      document.body.style.backgroundColor = "";
    }, 30);
    // Size, THEN position, THEN show — the tooltip window's proven order. Positioning before
    // the content-fit resize let the bottom-anchored resize drag the top edge down by the
    // height delta, which is exactly where the first open used to land.
    const rect = shellRef.current?.getBoundingClientRect();
    // A dismissal (or a newer content push) during this awaited chain must stop it: the trailing
    // show() would otherwise resurrect a popover the user just clicked away from, and a superseded
    // chain's position write would move the visible window back to the old anchor.
    let cancelled = false;
    const perfShown = perfShownRef.current;
    void (async () => {
      if (rect && rect.width > 0 && rect.height > 0) {
        await setCurrentWindowLogicalSize({ width: Math.ceil(rect.width), height: Math.ceil(rect.height) }).catch(
          () => undefined
        );
      }
      if (cancelled) {
        return;
      }
      const anchor = anchorRef.current;
      if (anchor) {
        const size = rect && rect.width > 0 && rect.height > 0 ? rect : { width: window.innerWidth, height: window.innerHeight };
        const position = await anchoredPosition(anchor, size).catch(() => anchor);
        if (!cancelled) {
          await setCurrentWindowLogicalPosition(position).catch(() => undefined);
        }
      }
      if (cancelled || dismissedRef.current || contentRef.current !== content) {
        perfHook(() => perfProbe?.surfaceShown(perfShown, "no-op"));
        return;
      }
      resetScroll();
      try {
        // Windows E/Z keys stay in the document; macOS retains its native focus.
        const preserveFocus = content.kind === "flyout" &&
          (platform === "windows" || !(content.flyout.variant === "bondStereo" && content.flyout.keyboardOpen));
        keepWindowFocusRef.current = platform !== "windows" && toolsetId === "core.bondStereo" && content.kind === "flyout" &&
          content.flyout.variant === "bondStereo" && !!content.flyout.keyboardOpen;
        const focusMode = preserveFocus ? "preserve" : "focus";
        const flyoutOpening = flyoutCommandOpening(toolsetId, content);
        const shown = await (flyoutOpening ? showCurrentToolsetPopoverWindow(focusMode, content.kind, flyoutOpening)
          : showCurrentToolsetPopoverWindow(focusMode, content.kind));
        if (!shown) throw new Error("Native toolset popover remained hidden");
        resetScroll("reveal");
        if (cancelled || dismissedRef.current || contentRef.current !== content) {
          // An older reveal may complete after a fresh open. Only hide the content
          // this chain belongs to; the new session owns the reused window now.
          if (contentRef.current === content) hidePopoverWindow();
          return;
        }
        shownContentRef.current = content;
        const opening = currentFlyoutOpening(openingsRef.current, toolsetId);
        if (opening && matchesToolsetPopoverOpening(opening, content)) {
          void notifyToolsetPopoverContentAccepted(opening).catch(() => undefined);
        }
        if (platform !== "windows" && content.kind === "flyout" && content.flyout.variant === "bondStereo" && content.flyout.keyboardOpen && !cancelled && !dismissedRef.current) {
          const [{ getCurrentWindow }, { getCurrentWebview }] = await Promise.all([
            import("@tauri-apps/api/window"), import("@tauri-apps/api/webview")
          ]);
          if (!cancelled && !dismissedRef.current) {
            await getCurrentWindow().setFocus();
            if (cancelled || dismissedRef.current) return;
            await getCurrentWebview().setFocus();
            if (cancelled || dismissedRef.current) return;
            shellRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
          }
        }
        perfHook(() => perfProbe?.surfaceShown(perfShown, "popover-shown"));
        if (perfShownRef.current === perfShown) perfShownRef.current = undefined;
      } catch (error) {
        console.warn("Toolset popover reveal failed", error);
        // A failed nonactivating reveal must release the document's E/Z session,
        // without hiding or closing a newer session that reused this window.
        if (contentRef.current === content) {
          dismissedRef.current = true;
          notifyBondStereoClose();
          hidePopoverWindow();
        }
        perfHook(() => perfProbe?.surfaceShown(perfShown, "failed"));
        if (perfShownRef.current === perfShown) perfShownRef.current = undefined;
      }
    })();
    return () => {
      cancelled = true;
      if (shownContentRef.current === content) shownContentRef.current = undefined;
      keepWindowFocusRef.current = false;
      perfHook(() => perfProbe?.surfaceShown(perfShown, "no-op"));
      window.clearTimeout(scrubTimer);
      document.body.style.backgroundColor = "";
    };
  }, [content, prewarm, toolsetId, platform]);

  // Safety net for a cold user-initiated open: if content never arrives (e.g. the owning palette went
  // away mid-open), show anyway so the window can't get stuck invisible. Prewarmed windows are the
  // opposite case — hidden is their correct resting state, so they get no net.
  useEffect(() => {
    if (prewarm || toolsetId === "core.bondStereo") {
      return undefined;
    }
    const fallback = window.setTimeout(() => {
      if (contentPushedRef.current || dismissedRef.current) {
        return;
      }
      resetScroll();
      void showCurrentToolsetPopoverWindow(contentRef.current.kind === "flyout" ? "preserve" : "focus",
        contentRef.current.kind).then(shown => { if (shown) resetScroll("reveal"); }).catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(fallback);
  }, [prewarm, toolsetId]);

  // Escape dismisses (and cancels any in-flight colour preview).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || dismissedRef.current || event.isComposing) {
        return;
      }
      event.preventDefault();
      dismissedRef.current = true;
      notifyBondStereoClose();
      if (contentRef.current.kind !== "textColor") void sendPaletteCommandCancel("palette.preview.cancel").catch(() => undefined);
      hidePopoverWindow();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The owner also cancels pending/cold opens. Remember closure before a delayed
  // snapshot arrives, so it cannot reveal a window the document already dismissed.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForBondStereoPopoverActions(payload => {
      if (payload.action !== "close") return;
      closedBondStereoSessions.current.add(payload.sessionId);
      if (closedBondStereoSessions.current.size > 128) {
        closedBondStereoSessions.current.delete(closedBondStereoSessions.current.values().next().value!);
      }
      const current = contentRef.current;
      if (current.kind === "flyout" && current.flyout.variant === "bondStereo" && current.flyout.id === payload.sessionId) {
        dismissedRef.current = true;
        hidePopoverWindow();
      }
    }).then(cleanup => { if (disposed) cleanup(); else unlisten = cleanup; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // Click-away dismissal: the document window and palettes broadcast a dismiss on any pointer-down
  // that isn't this popover. Hide on that signal, so a popover persists only while you use it.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForToolsetPopoverDismiss(payload => {
      if (payload?.openings && !payload.openings.some(opening => opening.toolsetId === toolsetId)) return;
      const wasOpen = currentFlyoutOpening(openingsRef.current, toolsetId);
      openingsRef.current = dismissFlyoutOpenings(openingsRef.current, payload);
      if (currentFlyoutOpening(openingsRef.current, toolsetId) || (!wasOpen && contentPushedRef.current)) return;
      const cancelPreview = payload?.reason === "escape" && contentPushedRef.current && !dismissedRef.current;
      dismissedRef.current = true;
      notifyBondStereoClose();
      if (cancelPreview && contentRef.current.kind !== "textColor") {
        void sendPaletteCommandCancel("palette.preview.cancel").catch(() => undefined);
      }
      hidePopoverWindow();
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [toolsetId]);

  // Both refuse once the popover is dismissed: hiding it blurs whichever field had focus, and a blur
  // that settles a half-typed value would otherwise apply a colour the user just walked away from.
  const applyTextColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized || dismissedRef.current) return;
    setDraft(normalized);
    void sendPaletteCommand(textCustomColorCommandId(normalized), { preserveInputFocus: true }).catch(() => undefined);
  };

  const previewColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized || dismissedRef.current) {
      return;
    }
    setDraft(normalized);
    void sendPaletteCommandPreview(effectKind ? objectEffectColorCommandId(effectKind, normalized) : objectCustomColorCommandId(normalized)).catch(() => undefined);
  };

  const commitColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized || dismissedRef.current) {
      return;
    }
    setDraft(normalized);
    void sendPaletteCommandCommit(effectKind ? objectEffectColorCommandId(effectKind, normalized) : objectCustomColorCommandId(normalized)).catch(() => undefined);
  };

  const chooseFlyoutCommand = async (command: ToolsetFlyoutCommandSnapshot) => {
    const current = contentRef.current;
    const canChoose = () => !dismissedRef.current && contentRef.current === current && shownContentRef.current === current;
    if (!command.enabled || current.kind !== "flyout" || pendingChoiceRef.current === current || !canChoose()) return;
    const opening = flyoutCommandOpening(toolsetId, current);
    if (!opening) return;

    // The OS can hide this window after the owner forwards a key, without a close event.
    pendingChoiceRef.current = current;
    const visible = await isToolsetPopoverVisible(toolsetId).catch(() => false);
    if (pendingChoiceRef.current === current) pendingChoiceRef.current = undefined;
    if (!visible || !canChoose()) return;

    dismissedRef.current = true;
    // Native dispatch must check the sending window before this choice hides it.
    try {
      if (current.flyout.variant === "bondStereo") {
        const action = command.id === "keep" ? "keep" : command.id === "molecule.bondStereo:flipped" ? "flipped" : "geometry";
        if (current.flyout.id) await sendBondStereoPopoverAction({ sessionId: current.flyout.id, action }, opening);
      } else await sendPaletteCommand(command.id, { flyoutOpening: opening });
    } catch {
      // A failed dispatch still dismisses the chosen opening.
    } finally {
      if (contentRef.current === current) hidePopoverWindow();
    }
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForToolsetFlyoutKeys(payload => {
      const current = contentRef.current;
      if (disposed || dismissedRef.current || shownContentRef.current !== current || current.kind !== "flyout" ||
          payload.toolsetId !== toolsetId || payload.flyoutId !== current.flyout.flyoutId ||
          !matchesToolsetPopoverOpening(payload, current)) return;
      const bondStereo = current.flyout.variant === "bondStereo";
      if (bondStereo && (platform !== "windows" || payload.sessionId !== current.flyout.id)) return;
      const commands = current.flyout.commands.filter(command => command.enabled);
      if (bondStereo) commands.push(keepBondStereoCommand);
      // Match the inline flyout: both axes navigate, including multi-column ring
      // grids. The owning palette's orientation does not determine its menu's axis.
      const backward = payload.key === "ArrowLeft" || payload.key === "ArrowUp" || (payload.key === "Tab" && payload.shiftKey);
      const index = commands.findIndex(command => command.id === highlightedCommandRef.current);
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(payload.key) || (bondStereo && payload.key === "Tab")) {
        const next = index < 0 ? (backward ? commands.length - 1 : 0)
          : (index + (backward ? commands.length - 1 : 1)) % commands.length;
        highlightedCommandRef.current = commands[next]?.id;
        setHighlightedCommandId(highlightedCommandRef.current);
      } else if ((payload.key === "Enter" || payload.key === " ") && index >= 0) {
        void chooseFlyoutCommand(commands[index]!);
      }
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [toolsetId, platform]);

	return (
	  <div ref={shellRef} className="palette-popover-shell" data-popover-kind={content.kind}
      onPointerDownCapture={event => preventPaletteCommandPointerFocus(event, platform)}
      onMouseDownCapture={event => preventPaletteCommandPointerFocus(event, platform)}>
      {content.kind === "flyout" && content.flyout.variant === "bondStereo" ? (
        <div className="bond-stereo-popover" role="dialog" aria-label="E/Z not specified"
          onKeyDown={event => {
            if (event.key !== "Tab" || platform === "windows") return;
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            event.preventDefault(); event.stopPropagation();
            buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus({ preventScroll: true });
          }}>
          <strong>E/Z not specified</strong>
          <p>This double bond's geometry wasn't given, so ChemDraft shows it as either E or Z.</p>
          {content.flyout.commands.map(command => <button key={command.id} type="button" disabled={!command.enabled}
            data-keyboard-highlighted={command.enabled && command.id === highlightedCommandId || undefined}
            title={command.disabledReason} data-command-id={command.id} onClick={() => void chooseFlyoutCommand(command)}>{command.title}</button>)}
          <button type="button" data-keyboard-highlighted={highlightedCommandId === "keep" || undefined}
            onClick={() => void chooseFlyoutCommand(keepBondStereoCommand)}>{keepBondStereoCommand.title}</button>
        </div>
      ) : content.kind === "flyout" && content.flyout.variant === "distribute" ? (
        // Plain-text radio choice (Centers / Equal gaps) — icon-less, so it must NOT use the
        // icon+label grid layout below: with no icon element that grid places the lone label in
        // its narrow icon column and ellipsizes it (the "C…" / "E…" bug).
        <div
          className="toolbar-distribute-menu"
          role="menu"
          aria-label={content.flyout.title}
          data-command-flyout-menu={content.flyout.flyoutId}
        >
          {content.flyout.commands.map((command) => (
            <button
              key={command.id}
              type="button"
              role="menuitemradio"
              disabled={!command.enabled}
              aria-checked={command.active}
              data-keyboard-highlighted={command.enabled && command.id === highlightedCommandId || undefined}
              data-command-id={command.id}
              onClick={() => void chooseFlyoutCommand(command)}
            >
              {command.title}
            </button>
          ))}
        </div>
      ) : content.kind === "flyout" ? (
        <div
          className="toolbar-command-flyout-menu"
          role="menu"
          aria-label={`${content.flyout.title} commands`}
          data-command-flyout-menu={content.flyout.flyoutId}
          data-toolbar-command-grid-columns={content.flyout.columns && content.flyout.columns > 1 ? content.flyout.columns : undefined}
          style={toolbarCommandFlyoutGridStyle(content.flyout.columns)}
        >
          {content.flyout.commands.map((command) => (
            <button
              key={command.id}
              type="button"
              role="menuitem"
              disabled={!command.enabled}
              data-keyboard-highlighted={command.enabled && command.id === highlightedCommandId || undefined}
              data-command-id={command.id}
              data-shortcut-label={command.shortcutLabel ?? "No shortcut"}
              data-toolbar-asset={command.assetName}
              className={command.active ? "active" : undefined}
              aria-pressed={command.active || undefined}
              title={command.enabled ? command.title : `${command.title}: ${command.disabledReason ?? "unavailable"}`}
              onClick={() => void chooseFlyoutCommand(command)}
            >
              {(() => {
                const symbolGlyph = symbolToolGlyph(command.id);
                if (symbolGlyph) {
                  return <span className="symbol-tool-glyph" aria-hidden="true">{symbolGlyph}</span>;
                }
                // Flyout snapshots arrive over IPC, so assetName is an untrusted raw string — an
                // unknown key makes toolbarAsset() return undefined and renders a broken <img>.
                // Resolve first, fall through to the named icon when it doesn't resolve.
                const assetSrc = command.assetName
                  ? toolbarAsset(command.assetName as ToolbarAssetName)
                  : undefined;
                if (assetSrc) {
                  return <ToolbarAssetIcon assetName={command.assetName as ToolbarAssetName} src={assetSrc} />;
                }
                return command.icon ? <Icon name={command.icon as IconName} /> : null;
              })()}
              <span className="toolbar-command-label">{command.title}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="art-color-popover" role="dialog" aria-label={content.kind === "textColor" ? "Text color picker" : effectKind ? `${effectKind} effect color picker` : "Art color picker"}>
          <ColorPickerPopoverBody
            key={content.kind === "textColor" ? content.openedAt : effectKind ?? "paint"}
            contextKey={colorContextKey}
            activeColor={currentColor}
            value={value}
            onPreviewColor={content.kind === "textColor" ? applyTextColor : previewColor}
            onCommitColor={content.kind === "textColor" ? applyTextColor : commitColor}
          />
        </div>
      )}
    </div>
  );
}
