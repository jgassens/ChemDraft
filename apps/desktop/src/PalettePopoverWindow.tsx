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
  kind = "artColor"
}: {
  toolsetId?: string;
  kind?: string;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  // The window is built hidden (Rust open_toolset_popover) so the cold webview never flashes a blank
  // loading window; we reveal it once it has painted real content at the right size. One-shot per
  // window lifetime — warm reuse is shown by Rust.
  const revealedRef = useRef(false);
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

  // The owning palette pushes what this window should show. Request it on mount too — the palette
  // may have emitted the content before this window finished subscribing (first open).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForToolsetPopoverContent((payload) => {
      if (payload.toolsetId !== toolsetId) {
        return;
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

  // Reveal the (initially hidden) window once it has real content to show — the color picker is ready
  // immediately; a flyout is ready when its commands arrive. Size to the painted content on the next
  // frame, then show, so the first open appears already-correct instead of blank.
  useEffect(() => {
    const ready = content.kind === "artColor" || (content.kind === "flyout" && content.flyout.commands.length > 0);
    if (!ready || revealedRef.current) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      if (revealedRef.current) {
        return;
      }
      const rect = shellRef.current?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        void setCurrentWindowLogicalSize({ width: Math.ceil(rect.width), height: Math.ceil(rect.height) }).catch(
          () => undefined
        );
      }
      revealedRef.current = true;
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().show())
        .catch(() => undefined);
    });
    return () => cancelAnimationFrame(raf);
  }, [content]);

  // Safety net: if content never arrives (e.g. the owning palette went away mid-open), show anyway so
  // the window can't get stuck invisible.
  useEffect(() => {
    const fallback = window.setTimeout(() => {
      if (revealedRef.current) {
        return;
      }
      revealedRef.current = true;
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().show())
        .catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(fallback);
  }, []);

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
              {command.assetName ? (
                <img
                  className="tool-icon-image"
                  src={toolbarAsset(command.assetName as ToolbarAssetName)}
                  alt=""
                  aria-hidden="true"
                />
              ) : command.icon ? (
                <Icon name={command.icon as IconName} />
              ) : null}
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
