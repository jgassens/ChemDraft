import { describe, expect, it } from "vitest";
import { createViewportState, nativeScreenRectToPage } from "./index";

describe("native screen rectangle to page coordinates", () => {
  it.each([1, 2])("converts scale %s with zoom, titlebar/webview offset, pan and scroll", scale => {
    const documentOrigin = { x: -1200, y: 150 };
    const webviewOffset = { x: 8 * scale, y: 32 * scale };
    const viewport = createViewportState({ scale: 1.5, pageOriginX: 40, pageOriginY: 100,
      translateX: 20, translateY: -10, scrollOriginX: 75, scrollOriginY: 180 });
    // Page (200, 300) -> client (285, 360) -> native desktop.
    expect(nativeScreenRectToPage({ x: documentOrigin.x + webviewOffset.x + 285 * scale,
      y: documentOrigin.y + webviewOffset.y + 360 * scale, width: 150 * scale, height: 90 * scale }, {
      documentOrigin, webviewOffset, screenUnitsPerCssPixel: scale, viewport
    })).toEqual({ x: 200, y: 300, width: 100, height: 60 });
  });

  it("uses the document scale for a dialog on a differently scaled monitor", () => {
    // A 100%-DPI dialog overlaps a 200%-DPI document. Both frames stay in physical desktop pixels.
    expect(nativeScreenRectToPage({ x: 1900, y: 200, width: 400, height: 600 }, {
      documentOrigin: { x: 1800, y: 100 }, webviewOffset: { x: 0, y: 60 },
      screenUnitsPerCssPixel: 2, viewport: createViewportState({ scale: 0.5 })
    })).toEqual({ x: 100, y: 40, width: 400, height: 600 });
  });

  it("accepts the live scrolled DOM page origin without counting scroll twice", () => {
    expect(nativeScreenRectToPage({ x: 300, y: 400, width: 80, height: 100 }, {
      documentOrigin: { x: 100, y: 100 }, webviewOffset: { x: 0, y: 30 }, screenUnitsPerCssPixel: 1,
      viewport: createViewportState({ scale: 2, pageOriginX: -100, pageOriginY: -230 })
    })).toEqual({ x: 150, y: 250, width: 40, height: 50 });
  });

  it.each([0, -1, NaN, Infinity])("refuses invalid scales (%s)", screenUnitsPerCssPixel => {
    expect(nativeScreenRectToPage({ x: 0, y: 0, width: 20, height: 20 }, {
      documentOrigin: { x: 0, y: 0 }, webviewOffset: { x: 0, y: 0 }, screenUnitsPerCssPixel,
      viewport: createViewportState()
    })).toBeUndefined();
  });
});
