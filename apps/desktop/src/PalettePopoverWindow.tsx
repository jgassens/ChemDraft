import { useEffect, useRef, useState } from "react";
import { ColorPickerPopoverBody, toolbarCommandFlyoutGridStyle } from "./ToolPalette";
import { Icon, type IconName } from "./icons";
import { toolbarAsset, type ToolbarAssetName } from "./toolbarAssets";
import { normalizeHexColor, objectCustomColorCommandId } from "./commands";
import {
  listenForToolsetPopoverContent,
  listenForToolsetPopoverDismiss,
  listenForToolsetTextStyle,
  requestToolsetPopoverContent,
  requestToolsetTextStyle,
  sendPaletteCommand,
  sendPaletteCommandCancel,
  sendPaletteCommandCommit,
  sendPaletteCommandPreview,
  setCurrentWindowLogicalPosition,
  setCurrentWindowLogicalSize,
  type ToolsetArtPaintTarget,
  type ToolsetArtStylePayload,
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
function hidePopoverWindow() {
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().hide())
    .catch(() => undefined);
}

export function PalettePopoverWindow({
  toolsetId = "core.art",
  kind = "artColor",
  prewarm = false
}: {
  toolsetId?: string;
  kind?: string;
  /** Built hidden ahead of use (Rust prewarm_toolset_popover): stay invisible until the palette
   *  pushes real content — never reveal off the initial placeholder state. */
  prewarm?: boolean;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  // Whether the owning palette has pushed content at least once. A prewarmed window must not reveal
  // (or answer its own mount content-request) before then — its initial state is a placeholder.
  const contentPushedRef = useRef(false);
  // Set the moment this popover is dismissed (Escape, click-away, a chosen flyout command) so an
  // in-flight reveal chain cannot show it again after the user has closed it.
  const dismissedRef = useRef(false);
  // Where this open's top-left belongs (global logical). Re-asserted after every content-fit
  // resize: macOS resizes are bottom-anchored, so a height change after Rust's set_position
  // would otherwise shove the window down by the delta — the first-open misposition.
  const anchorRef = useRef<ToolsetPopoverAnchor | undefined>(undefined);
  const [content, setContent] = useState<ToolsetPopoverContent>(() =>
    kind === "flyout"
      ? { kind: "flyout", flyout: { flyoutId: "", title: "", commands: [] } }
      : { kind: "artColor" }
  );
  const [artStyle, setArtStyle] = useState<ToolsetArtStylePayload | undefined>();
  const [artStyleTarget, setArtStyleTarget] = useState<ToolsetArtPaintTarget>("fill");
  const [fallbackColor, setFallbackColor] = useState<string | undefined>();
  const [draft, setDraft] = useState<string | undefined>();

  const effectiveTarget: ToolsetArtPaintTarget = artStyle?.activePaintTarget ?? artStyleTarget ?? "fill";
  const activeColor = effectiveTarget === "fill"
    ? artStyle?.values.fillColor.value
    : artStyle?.values.strokeColor.value;
  const currentColor = normalizeHexColor(activeColor ?? fallbackColor) ?? "#111111";
  const value = draft ?? currentColor;

  useEffect(() => {
    document.documentElement.classList.add("palette-popover-window-html");
    document.body.classList.add("palette-popover-window-body");
    return () => {
      document.documentElement.classList.remove("palette-popover-window-html");
      document.body.classList.remove("palette-popover-window-body");
    };
  }, []);

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
      contentPushedRef.current = true;
      // A fresh push is a fresh open — it may follow a dismissal.
      dismissedRef.current = false;
      if (payload.anchor && typeof payload.anchor.x === "number" && typeof payload.anchor.y === "number") {
        anchorRef.current = payload.anchor;
      }
      setContent(payload.kind === "flyout" ? { kind: "flyout", flyout: payload.flyout } : { kind: "artColor" });
    })
      .then((cleanup) => {
        unlisten = cleanup;
        void requestToolsetPopoverContent(toolsetId).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [toolsetId]);

  // Follow the shared broadcast so the colour picker always opens on the current object's colour.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForToolsetTextStyle((payload) => {
      setArtStyle(payload.currentArtStyle);
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
  }, [currentColor]);

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
          await setCurrentWindowLogicalPosition(anchor);
        }
      })().catch(() => undefined);
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
    const ready = content.kind === "artColor" || (content.kind === "flyout" && content.flyout.commands.length > 0);
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
        await setCurrentWindowLogicalPosition(anchor).catch(() => undefined);
      }
      if (cancelled || dismissedRef.current) {
        return;
      }
      await import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().show())
        .catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(scrubTimer);
      document.body.style.backgroundColor = "";
    };
  }, [content, prewarm]);

  // Safety net for a cold user-initiated open: if content never arrives (e.g. the owning palette went
  // away mid-open), show anyway so the window can't get stuck invisible. Prewarmed windows are the
  // opposite case — hidden is their correct resting state, so they get no net.
  useEffect(() => {
    if (prewarm) {
      return undefined;
    }
    const fallback = window.setTimeout(() => {
      if (contentPushedRef.current) {
        return;
      }
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().show())
        .catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(fallback);
  }, [prewarm]);

  // Escape dismisses (and cancels any in-flight colour preview).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      dismissedRef.current = true;
      void sendPaletteCommandCancel("palette.preview.cancel").catch(() => undefined);
      hidePopoverWindow();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Click-away dismissal: the document window and palettes broadcast a dismiss on any pointer-down
  // that isn't this popover. Hide on that signal, so a popover persists only while you use it.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForToolsetPopoverDismiss(() => {
      dismissedRef.current = true;
      hidePopoverWindow();
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  const previewColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized) {
      return;
    }
    setDraft(normalized);
    void sendPaletteCommandPreview(objectCustomColorCommandId(normalized)).catch(() => undefined);
  };

  const commitColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized) {
      return;
    }
    setDraft(normalized);
    void sendPaletteCommandCommit(objectCustomColorCommandId(normalized)).catch(() => undefined);
  };

  const chooseFlyoutCommand = (command: ToolsetFlyoutCommandSnapshot) => {
    if (!command.enabled) {
      return;
    }
    void sendPaletteCommand(command.id).catch(() => undefined);
    dismissedRef.current = true;
    hidePopoverWindow();
  };

	return (
	  <div ref={shellRef} className="palette-popover-shell" data-popover-kind={content.kind}>
      {content.kind === "flyout" && content.flyout.variant === "distribute" ? (
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
              aria-checked={command.active}
              data-command-id={command.id}
              onClick={() => chooseFlyoutCommand(command)}
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
              data-command-id={command.id}
              data-shortcut-label={command.shortcutLabel ?? "No shortcut"}
              data-toolbar-asset={command.assetName}
              className={command.active ? "active" : undefined}
              aria-pressed={command.active || undefined}
              title={command.enabled ? command.title : `${command.title}: ${command.disabledReason ?? "unavailable"}`}
              onClick={() => chooseFlyoutCommand(command)}
            >
              {(() => {
                // Flyout snapshots arrive over IPC, so assetName is an untrusted raw string — an
                // unknown key makes toolbarAsset() return undefined and renders a broken <img>.
                // Resolve first, fall through to the named icon when it doesn't resolve.
                const assetSrc = command.assetName
                  ? toolbarAsset(command.assetName as ToolbarAssetName)
                  : undefined;
                if (assetSrc) {
                  return <img className="tool-icon-image" src={assetSrc} alt="" aria-hidden="true" />;
                }
                return command.icon ? <Icon name={command.icon as IconName} /> : null;
              })()}
              <span>{command.title}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="art-color-popover" role="dialog" aria-label="Art color picker">
          <ColorPickerPopoverBody
            activeColor={currentColor}
            value={value}
            onPreviewColor={previewColor}
            onCommitColor={commitColor}
          />
        </div>
      )}
    </div>
  );
}
