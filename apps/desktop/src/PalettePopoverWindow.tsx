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
  setCurrentWindowLogicalSize,
  type ToolsetArtPaintTarget,
  type ToolsetArtStylePayload,
  type ToolsetFlyoutCommandSnapshot,
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

  // The owning palette pushes what this window should show. A cold user-initiated open also requests
  // it on mount — the palette may have emitted before this window finished subscribing. A prewarmed
  // window must NOT request: nothing was opened, and the palette's remembered answer (its default)
  // would masquerade as a push and reveal an unrequested popover.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForToolsetPopoverContent((payload) => {
      if (payload.toolsetId !== toolsetId) {
        return;
      }
      contentPushedRef.current = true;
      setContent(payload.kind === "flyout" ? { kind: "flyout", flyout: payload.flyout } : { kind: "artColor" });
    })
      .then((cleanup) => {
        unlisten = cleanup;
        if (!prewarm) {
          void requestToolsetPopoverContent(toolsetId).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [prewarm, toolsetId]);

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

  // Fit the window to whatever content it's showing, in both dimensions.
  useEffect(() => {
    const shell = shellRef.current;
    const applySize = () => {
      const rect = shell?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) {
        return;
      }
      void setCurrentWindowLogicalSize({ width: Math.ceil(rect.width), height: Math.ceil(rect.height) }).catch(
        () => undefined
      );
    };

    applySize();
    if (!shell || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => applySize());
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  // Reveal the window once the requested content has painted at the right size. This runs on EVERY
  // content push, not once: Rust never shows a reused window (that would flash whatever it painted
  // last), so each open — cold, warm, or after a dismissal — is revealed here, already-correct.
  // The color picker is ready immediately; a flyout is ready when its commands arrive. A prewarmed
  // window sits on placeholder state until the first push, and must not reveal before it.
  useEffect(() => {
    const ready = content.kind === "artColor" || (content.kind === "flyout" && content.flyout.commands.length > 0);
    if (!ready || (prewarm && !contentPushedRef.current)) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      const rect = shellRef.current?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        void setCurrentWindowLogicalSize({ width: Math.ceil(rect.width), height: Math.ceil(rect.height) }).catch(
          () => undefined
        );
      }
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().show())
        .catch(() => undefined);
    });
    return () => cancelAnimationFrame(raf);
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
    void listenForToolsetPopoverDismiss(() => hidePopoverWindow())
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
