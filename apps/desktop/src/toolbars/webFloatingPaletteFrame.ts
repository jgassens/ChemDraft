/**
 * Browser floating palettes (MainWindow's `.web-floating-palette`) are laid out inside the page's own
 * viewport. Owner decision (8adf1484, 2026-11-25): a fixed toolbar is never shrunk, wrapped or given a
 * scrollbar. So a palette keeps its natural width (the standard Main toolbar is about 1430 px, wider
 * than a 1024 or 1280 px window), may run past the viewport's edge, and the user drags it to reach
 * what lies beyond, as with native palette windows on macOS and Windows.
 *
 * What this guarantees is that it can always be dragged back: a grab margin of the title bar, at
 * least WEB_FLOATING_PALETTE_GRAB_MARGIN_PX wide and the title bar's whole height, stays inside the
 * viewport. The same rule places the palette while dragging, when a stored position is restored and
 * when the viewport resizes; it only ever moves the palette, never resizes it.
 *
 * Native palette windows do not use this (they are placed on the monitor by Rust).
 */

/** Width of the title bar that always stays inside the viewport (or the whole title bar, if narrower). */
export const WEB_FLOATING_PALETTE_GRAB_MARGIN_PX = 48;

/** Height of `.palette-title` (22 px, App.css) plus the frame's 1 px top border. */
export const WEB_FLOATING_PALETTE_TITLE_BAR_PX = 23;

/** The highest a palette's top edge may go: below the app's menu and toolbar strip. */
export const WEB_FLOATING_PALETTE_MIN_Y_PX = 44;

export interface WebFloatingPalettePosition {
  x: number;
  y: number;
}

export interface WebViewportSize {
  width: number;
  height: number;
}

/**
 * Where a palette `width` px wide (its natural width, unchanged) is drawn when the user's position is
 * `position`, in a viewport of `viewport` size. A position that leaves the grab margin inside is
 * kept as is; otherwise the palette is moved, just enough, to bring the margin back inside. The
 * palette may run past the left, right and bottom edges; its title bar never goes above the top.
 */
export function webFloatingPalettePosition(
  width: number,
  position: WebFloatingPalettePosition,
  viewport: WebViewportSize
): WebFloatingPalettePosition {
  const grab = Math.min(WEB_FLOATING_PALETTE_GRAB_MARGIN_PX, Math.max(0, width));
  const minX = grab - width;
  const maxX = Math.max(minX, Math.floor(viewport.width) - grab);
  const minY = WEB_FLOATING_PALETTE_MIN_Y_PX;
  const maxY = Math.max(minY, Math.floor(viewport.height) - Math.max(WEB_FLOATING_PALETTE_TITLE_BAR_PX, WEB_FLOATING_PALETTE_GRAB_MARGIN_PX));
  return {
    x: Math.min(Math.max(position.x, minX), maxX),
    y: Math.min(Math.max(position.y, minY), maxY)
  };
}
