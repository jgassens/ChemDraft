import { createViewportState, nativeScreenRectToPage, type ViewportRect } from "@chemdraft/viewport-engine";
import { isDesktopRuntime } from "./index";

export interface CanvasOcclusion {
  documentFrame: ViewportRect;
  webviewOffset: [number, number];
  screenUnitsPerCssPixel: number;
  coveringRects: ViewportRect[];
}

/** Sample at insertion time, so moving/resizing retained dialogs is reflected on every insert. */
export async function readCanvasOcclusion(): Promise<CanvasOcclusion | undefined> {
  if (!isDesktopRuntime()) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CanvasOcclusion>("document_canvas_occlusion");
}

export function pageOcclusionRects(geometry: CanvasOcclusion | undefined,
  pageClientOrigin: { x: number; y: number }, zoom: number): ViewportRect[] {
  if (!geometry) return [];
  // getBoundingClientRect already includes document scrolling, pan and the page's CSS offset.
  // Supplying its current origin avoids applying scroll a second time.
  const viewport = createViewportState({ scale: zoom, pageOriginX: pageClientOrigin.x, pageOriginY: pageClientOrigin.y });
  return geometry.coveringRects.flatMap(rect => {
    const converted = nativeScreenRectToPage(rect, { documentOrigin: geometry.documentFrame,
      webviewOffset: { x: geometry.webviewOffset[0], y: geometry.webviewOffset[1] },
      screenUnitsPerCssPixel: geometry.screenUnitsPerCssPixel, viewport });
    return converted ? [converted] : [];
  });
}
