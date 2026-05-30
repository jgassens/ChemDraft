import { describe, expect, it } from "vitest";
import {
  createViewportState,
  pageToScreen,
  screenToPage,
  viewportCssVars,
  wheelDeltaToZoomFactor,
  zoomViewportAtPoint,
  zoomViewportBy
} from "./index";

describe("viewport engine", () => {
  it("converts screen and page coordinates through the same transform", () => {
    const viewport = createViewportState({
      scale: 1.5,
      translateX: 20,
      translateY: -10,
      scrollOriginX: 5,
      scrollOriginY: 7,
      pageOriginX: 100,
      pageOriginY: 50
    });

    const pagePoint = screenToPage({ x: 265, y: 183 }, viewport);
    expect(pagePoint).toEqual({ x: 100, y: 100 });
    expect(pageToScreen(pagePoint, viewport)).toEqual({ x: 265, y: 183 });
  });

  it("keeps the focal point stable when zooming", () => {
    const viewport = createViewportState({ scale: 1, pageOriginX: 40, pageOriginY: 60 });
    const focal = { x: 200, y: 240 };
    const before = screenToPage(focal, viewport);
    const zoomed = zoomViewportAtPoint(viewport, 1.5, focal);

    expect(screenToPage(focal, zoomed)).toEqual(before);
    expect(zoomed.scale).toBe(1.5);
  });

  it("clamps zoom deltas to the configured bounds", () => {
    const viewport = createViewportState({ scale: 1, minZoom: 0.5, maxZoom: 2 });

    expect(zoomViewportBy(viewport, 100, { x: 0, y: 0 }).scale).toBe(2);
    expect(zoomViewportBy(viewport, 0.01, { x: 0, y: 0 }).scale).toBe(0.5);
  });

  it("exposes ruler CSS variables from viewport state", () => {
    const viewport = createViewportState({ scale: 1.25 });

    expect(viewportCssVars(viewport)).toMatchObject({
      "--page-scale": 1.25,
      "--ruler-unit-px": "120px",
      "--ruler-minor-px": "15px"
    });
  });

  it("converts trackpad wheel deltas into smooth zoom factors", () => {
    expect(wheelDeltaToZoomFactor(-120)).toBeGreaterThan(1);
    expect(wheelDeltaToZoomFactor(120)).toBeLessThan(1);
    expect(wheelDeltaToZoomFactor(0)).toBe(1);
  });
});
