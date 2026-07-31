import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  listenForPaletteTooltipHide,
  listenForPaletteTooltipShow,
  monitorLogicalBoundsAt,
  setCurrentWindowLogicalPosition,
  setCurrentWindowLogicalSize,
  type MonitorLogicalBounds,
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

/**
 * Pure placement: center on the anchor, flip above when there's no room below, and clamp
 * within the bounds of the monitor the ANCHOR lives on (global logical coordinates). The
 * old clamp used `window.screen` — the display this (hidden, usually primary-screen)
 * window was on — which dragged tooltips for a second-screen palette back to the primary
 * display's edge. With no bounds (anchor on no known monitor), place at the anchor unclamped:
 * a tooltip at the anchor is always better than one on the wrong screen.
 */
export function placePaletteTooltip(input: {
  anchorCenterX: number;
  belowY: number;
  aboveY: number;
  width: number;
  height: number;
  bounds?: MonitorLogicalBounds;
}): { x: number; y: number } {
  const { anchorCenterX, belowY, aboveY, width, height, bounds } = input;
  const margin = 4;
  let x = Math.round(anchorCenterX - width / 2);
  let y = Math.round(belowY);
  if (bounds) {
    x = Math.max(bounds.left + margin, Math.min(x, bounds.right - width - margin));
    if (y + height > bounds.bottom - margin) {
      y = Math.round(aboveY - height);
    }
    y = Math.max(bounds.top + margin, y);
  }
  return { x, y };
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
    let cancelled = false;
    void (async () => {
      // Clamp against the monitor that contains the ANCHOR (the hovered button), not
      // whichever display this floating window is currently on — see placePaletteTooltip.
      const anchorProbeY = (payload.aboveY + payload.belowY) / 2;
      const bounds = await monitorLogicalBoundsAt(payload.anchorCenterX, anchorProbeY);
      const { x, y } = placePaletteTooltip({
        anchorCenterX: payload.anchorCenterX,
        belowY: payload.belowY,
        aboveY: payload.aboveY,
        width,
        height,
        bounds
      });
      await setCurrentWindowLogicalSize({ width, height });
      await setCurrentWindowLogicalPosition({ x, y });
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
