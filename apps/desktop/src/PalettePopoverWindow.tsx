import { useEffect, useRef, useState } from "react";
import { ColorPickerPopoverBody } from "./ToolPalette";
import { normalizeHexColor, objectCustomColorCommandId } from "./commands";
import {
  listenForToolsetTextStyle,
  requestToolsetTextStyle,
  sendPaletteCommandCancel,
  sendPaletteCommandCommit,
  sendPaletteCommandPreview,
  setCurrentWindowLogicalSize,
  type ToolsetArtPaintTarget,
  type ToolsetArtStylePayload
} from "./window-manager";

/**
 * A palette popover (currently the Art fill/stroke color picker) rendered in its OWN small
 * floating window so it overflows the little palette and floats over the document — the native
 * way (a webview can't paint outside its window). It reuses the exact same `ColorPickerPopoverBody`
 * the inline/web palette uses, fed by the shared toolset-text-style broadcast and routing colour
 * changes through the same preview/commit transport the palette already uses.
 *
 * Dismissal: Escape here, re-clicking the swatch (the palette toggles it closed), or the app
 * deactivating (the panel hides on deactivate). It deliberately does NOT close on every commit —
 * the picker commits on each RGB/hex keystroke, which would make the window vanish mid-edit.
 */
export function PalettePopoverWindow({ kind = "artColor" }: { toolsetId?: string; kind?: string }) {
  const shellRef = useRef<HTMLDivElement | null>(null);
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

  // Follow the shared broadcast so the picker always opens on the current object's colour.
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

  // Once the live colour arrives (or changes because the selection changed), stop showing a stale
  // local draft — the picker should reflect whatever the current object actually is.
  useEffect(() => {
    setDraft(undefined);
  }, [currentColor]);

  // Fit the window to the picker's natural size in both dimensions.
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

  // Escape dismisses (and cancels any in-flight preview).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      void sendPaletteCommandCancel("palette.preview.cancel").catch(() => undefined);
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().hide())
        .catch(() => undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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

  return (
    <div ref={shellRef} className="palette-popover-shell" data-popover-kind={kind}>
      <div className="art-color-popover" role="dialog" aria-label="Art color picker">
        <ColorPickerPopoverBody
          activeColor={currentColor}
          value={value}
          onPreviewColor={previewColor}
          onCommitColor={commitColor}
        />
      </div>
    </div>
  );
}
