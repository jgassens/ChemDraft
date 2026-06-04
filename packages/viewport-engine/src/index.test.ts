import { describe, expect, it } from "vitest";
import {
  buildCrosshairTicks,
  buildRulerTicks,
  centimeterRulerUnit,
  createRulerRenderState,
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

  it("allows high default zoom for close structure inspection", () => {
    const viewport = createViewportState({ scale: 8.33 });

    expect(viewport.scale).toBe(8.33);
    expect(viewport.maxZoom).toBe(8.5);
    expect(zoomViewportBy(viewport, 2, { x: 0, y: 0 }).scale).toBe(8.5);
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

  it("creates ruler renderer settings from the same viewport scale", () => {
    const viewport = createViewportState({ scale: 1.5 });

    expect(createRulerRenderState(viewport, 816, 96)).toEqual({
      scrollPos: 1,
      zoom: 144,
      unit: 1,
      segment: 8,
      range: [0, 8.5]
    });
  });

  it("builds measurement ticks that move and zoom with page coordinates", () => {
    const normalTicks = buildRulerTicks({
      visibleLengthPx: 220,
      scrollOffsetPx: 0,
      pageLengthPx: 816,
      scale: 1
    });
    const zoomedTicks = buildRulerTicks({
      visibleLengthPx: 220,
      scrollOffsetPx: 0,
      pageLengthPx: 816,
      scale: 2
    });
    const scrolledTicks = buildRulerTicks({
      visibleLengthPx: 220,
      scrollOffsetPx: 48,
      pageLengthPx: 816,
      scale: 1
    });

    expect(normalTicks.find((tick) => tick.label === "1")?.position).toBe(96);
    expect(zoomedTicks.find((tick) => tick.label === "1")?.position).toBe(192);
    expect(scrolledTicks.find((tick) => tick.label === "1")?.position).toBe(48);
    expect(normalTicks.some((tick) => tick.kind === "minor")).toBe(true);
    expect(normalTicks.some((tick) => tick.kind === "mid")).toBe(true);
  });

  it("builds crosshair ticks from exact eighth-inch ruler subdivisions", () => {
    const ticks = buildCrosshairTicks(96);

    expect(ticks.slice(0, 9).map((tick) => tick.position)).toEqual([0, 12, 24, 36, 48, 60, 72, 84, 96]);
    expect(ticks.slice(0, 9).map((tick) => tick.kind)).toEqual([
      "half",
      "minor",
      "quarter",
      "minor",
      "half",
      "minor",
      "quarter",
      "minor",
      "half"
    ]);
  });

  it("builds metric ruler and crosshair ticks from centimeter subdivisions", () => {
    const viewport = createViewportState({ rulerUnit: centimeterRulerUnit });
    const ticks = buildCrosshairTicks(centimeterRulerUnit.pixelsPerUnit, centimeterRulerUnit);

    expect(createRulerRenderState(viewport, centimeterRulerUnit.pixelsPerUnit * 21, 0)).toMatchObject({
      scrollPos: 0,
      zoom: centimeterRulerUnit.pixelsPerUnit,
      segment: 10,
      range: [0, 21]
    });
    expect(ticks.slice(0, 11).map((tick) => tick.position)).toEqual(
      Array.from({ length: 11 }, (_, index) => index * (centimeterRulerUnit.pixelsPerUnit / 10))
    );
    expect(ticks.slice(0, 11).map((tick) => tick.kind)).toEqual([
      "half",
      "minor",
      "minor",
      "minor",
      "minor",
      "half",
      "minor",
      "minor",
      "minor",
      "minor",
      "half"
    ]);
  });
});
