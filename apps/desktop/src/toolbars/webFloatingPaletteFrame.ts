/**
 * Browser floating palettes (MainWindow's `.web-floating-palette`) are laid out inside the page's own
 * viewport, so a palette wider than the viewport must not run past its edge: the standard Main
 * toolbar is about 1430 px wide, and on a 1024 or 1280 px window its rightmost tools were outside the
 * frame and out of reach even with the palette dragged fully left. This clamps the frame into the
 * viewport and, when the palette's natural width does not fit, says so: the frame then scrolls its
 * item grid sideways, so every item stays reachable.
 *
 * Native palette windows do not use this (they are placed on the monitor by Rust).
 */

/** Gap kept between a floating palette's frame and the viewport's left and right edges. */
export const WEB_FLOATING_PALETTE_MARGIN_PX = 8;

export interface WebFloatingPaletteFrame {
  /** The frame's left edge, in viewport pixels. */
  x: number;
  /** The frame's width: the natural width, or the viewport's width less its margins. */
  width: number;
  /** True when the natural width does not fit, so the item grid scrolls sideways inside the frame. */
  scrollsHorizontally: boolean;
}

/**
 * The frame for a palette whose items need `naturalWidth` px, at the user's position `x`, in a viewport
 * `viewportWidth` px wide. The width never exceeds the viewport less its margins, and the frame is
 * moved left as far as needed (never past the left margin) so its right edge stays inside. A palette
 * that fits keeps its natural width and its position whenever that position keeps it inside.
 */
export function webFloatingPaletteFrame(naturalWidth: number, x: number, viewportWidth: number): WebFloatingPaletteFrame {
  const margin = WEB_FLOATING_PALETTE_MARGIN_PX;
  const available = Math.max(0, Math.floor(viewportWidth) - 2 * margin);
  const width = Math.min(naturalWidth, available);
  const maxX = Math.max(margin, Math.floor(viewportWidth) - margin - width);
  return {
    x: Math.min(Math.max(x, margin), maxX),
    width,
    scrollsHorizontally: naturalWidth > available
  };
}

/**
 * Turn a vertical wheel over a sideways-scrolling palette grid into horizontal scrolling, so a mouse
 * without a horizontal wheel still reaches every item. Returns whether it scrolled (the caller then
 * prevents the page from also handling the wheel). A wheel that is already horizontal, or a grid that
 * does not overflow, is left to the browser.
 */
export function scrollPaletteGridHorizontally(
  scroller: Pick<HTMLElement, "scrollWidth" | "clientWidth" | "scrollLeft">,
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">
): boolean {
  const range = scroller.scrollWidth - scroller.clientWidth;
  if (range <= 0 || event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return false;
  // deltaMode 1 is lines, 2 is pages; pixels otherwise.
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientWidth : 1;
  const next = Math.min(range, Math.max(0, scroller.scrollLeft + event.deltaY * unit));
  if (next === scroller.scrollLeft) return false;
  scroller.scrollLeft = next;
  return true;
}
