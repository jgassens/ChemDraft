import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  listenForPaletteTooltipHide,
  listenForPaletteTooltipShow,
  setCurrentWindowLogicalPosition,
  setCurrentWindowLogicalSize,
  type PaletteTooltipPayload
} from "./window-manager";

/**
 * The ONE shared floating tooltip window for all native palettes. A palette webview can't paint
 * outside its content-fit window, so its in-DOM tooltip span is hidden there (App.css) and the
 * visible tooltip lives here instead — a tiny always-existing window (pre-built hidden at app
 * setup, click-through via ignoresMouseEvents so the pointer feed's hit test never mistakes it
 * for "cursor left the palette") that any palette positions near its hovered button.
 *
 * Flow: a palette broadcasts show {text, anchor}; this window renders the text, measures itself,
 * sizes + positions the window (centered on the anchor, flipped above when there's no room
 * below), and shows. A hide broadcast (pointer left the button) hides it again.
 */
function hideTooltipWindow() {
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().hide())
    .catch(() => undefined);
}

function showTooltipWindow() {
  // Rust orders the panel front — the same path that displays the palettes. Tauri's JS show()
  // resolved without error here but never actually displayed this focusable(false) panel.
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("show_toolset_tooltip_window"))
    .catch(() => undefined);
}

export function PaletteTooltipWindow() {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [payload, setPayload] = useState<PaletteTooltipPayload | undefined>();

  useEffect(() => {
    document.documentElement.classList.add("palette-tooltip-window-html");
    document.body.classList.add("palette-tooltip-window-body");
    return () => {
      document.documentElement.classList.remove("palette-tooltip-window-html");
      document.body.classList.remove("palette-tooltip-window-body");
    };
  }, []);

  useEffect(() => {
    let unlistenShow: (() => void) | undefined;
    let unlistenHide: (() => void) | undefined;
    void listenForPaletteTooltipShow(setPayload)
      .then((cleanup) => {
        unlistenShow = cleanup;
      })
      .catch(() => undefined);
    void listenForPaletteTooltipHide(() => {
      setPayload(undefined);
      hideTooltipWindow();
    })
      .then((cleanup) => {
        unlistenHide = cleanup;
      })
      .catch(() => undefined);
    return () => {
      unlistenShow?.();
      unlistenHide?.();
    };
  }, []);

  // Size to the rendered text, position at the anchor, then show. Measured synchronously —
  // useLayoutEffect runs after the DOM mutation and getBoundingClientRect forces layout, and a
  // requestAnimationFrame would NEVER fire here while the window is hidden (no display link), so
  // the popover's measure-on-next-frame pattern would deadlock this window shut.
  useLayoutEffect(() => {
    if (!payload) {
      return;
    }
    const rect = shellRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      return;
    }
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    const margin = 4;
    // window.screen describes the display this window is on. On a multi-display setup whose
    // global origin isn't this display's top-left the clamp is approximate — acceptable for a
    // transient tooltip; the anchor itself is always correct.
    let left = Math.round(payload.anchorCenterX - width / 2);
    const screenRight = window.screen.width > 0 ? window.screen.width : Number.MAX_SAFE_INTEGER;
    left = Math.max(margin, Math.min(left, screenRight - width - margin));
    let top = Math.round(payload.belowY);
    const screenBottom = window.screen.height > 0 ? window.screen.height : Number.MAX_SAFE_INTEGER;
    if (top + height > screenBottom - margin) {
      top = Math.round(payload.aboveY - height);
    }
    let cancelled = false;
    void (async () => {
      await setCurrentWindowLogicalSize({ width, height });
      await setCurrentWindowLogicalPosition({ x: left, y: top });
      if (!cancelled) {
        showTooltipWindow();
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [payload]);

  return (
    <div ref={shellRef} className="palette-floating-tooltip" role="tooltip">
      <span>{payload?.title ?? ""}</span>
      {payload?.description ? <span className="tool-tooltip-description">{payload.description}</span> : null}
      {payload?.shortcut ? <span className="tool-tooltip-shortcut">{payload.shortcut}</span> : null}
    </div>
  );
}
