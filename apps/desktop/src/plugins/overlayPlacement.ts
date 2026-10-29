export type OverlayRect = { x: number; y: number; width: number; height: number };
export type OverlayCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Convert physical screen frames to CSS coordinates relative to the overlay layer. */
export function paletteFrameInViewport(frame: OverlayRect, documentOrigin: { x: number; y: number }, scale: number, layerOrigin: { x: number; y: number }): OverlayRect {
  return { x: (frame.x - documentOrigin.x) / scale - layerOrigin.x,
    y: (frame.y - documentOrigin.y) / scale - layerOrigin.y,
    width: frame.width / scale, height: frame.height / scale };
}

export function overlayPlacementAvoidingPalettes(overlay: OverlayRect, viewport: OverlayRect,
  palettes: readonly OverlayRect[], corners: readonly OverlayCorner[]): { x: number; y: number; covered: boolean } {
  const free = (rect: OverlayRect) => !palettes.some(p => rect.x < p.x + p.width && rect.x + rect.width > p.x
    && rect.y < p.y + p.height && rect.y + rect.height > p.y);
  if (free(overlay)) return { x: overlay.x, y: overlay.y, covered: false };
  const candidates = corners.map(corner => ({
    x: corner.endsWith("right") ? viewport.x + viewport.width - overlay.width : viewport.x,
    y: corner.startsWith("bottom") ? viewport.y + viewport.height - overlay.height : viewport.y
  })).filter(point => free({ ...overlay, ...point }));
  candidates.sort((a, b) => Math.hypot(a.x - overlay.x, a.y - overlay.y) - Math.hypot(b.x - overlay.x, b.y - overlay.y));
  return candidates.length ? { ...candidates[0]!, covered: false } : { x: overlay.x, y: overlay.y, covered: true };
}
