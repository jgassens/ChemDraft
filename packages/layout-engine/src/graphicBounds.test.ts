import { describe, expect, it } from "vitest";
import { planNativeArtVisual } from "@chemdraft/art-engine";
import { rotatedGraphicLocalBounds } from "./graphicBounds";
import { boundsTestEllipse, ellipseBoundsCases, expectTightOutlineBounds, renderedEllipseOutline } from "./graphicBounds.testHelpers";

describe("rotatedGraphicLocalBounds", () => {
  it.each(ellipseBoundsCases)("contains the rendered ellipse tightly: rotation $rotation, tilt $tiltX/$tiltY, stroke $strokeWidth ($width × $height)", geometry => {
    const ellipse = boundsTestEllipse(geometry);
    const plan = planNativeArtVisual(ellipse, { coordinateSpace: "local" });
    const bounds = rotatedGraphicLocalBounds(ellipse, plan.frameBounds, ellipse.rotation);
    expectTightOutlineBounds({ ...bounds, x: bounds.x + ellipse.x, y: bounds.y + ellipse.y }, renderedEllipseOutline(ellipse));
    if (ellipse.width === ellipse.height && geometry.tiltX === 0 && geometry.tiltY === 0) {
      expect(bounds.width).toBeCloseTo(ellipse.width, 6);
      expect(bounds.height).toBeCloseTo(ellipse.height, 6);
    }
  });

  it.each([
    { strokeWidth: 1, rotation: 90, tiltX: 85, tiltY: 0, expectedWidth: 9.6284, expectedHeight: 401.2532 },
    { strokeWidth: 10, rotation: 90, tiltX: 85, tiltY: 0, expectedWidth: 17.8440, expectedHeight: 413.9011 },
    { strokeWidth: 40, rotation: 90, tiltX: 85, tiltY: 0, expectedWidth: 45.2294, expectedHeight: 486.7076 },
    { strokeWidth: 1, rotation: 0, tiltX: 40, tiltY: 25, expectedWidth: 362.6383, expectedHeight: 133.2872 },
    { strokeWidth: 10, rotation: 0, tiltX: 40, tiltY: 25, expectedWidth: 363.7085, expectedHeight: 136.4026 },
    { strokeWidth: 40, rotation: 0, tiltX: 40, tiltY: 25, expectedWidth: 368.1626, expectedHeight: 148.0809 }
  ])("matches the review example: rotation $rotation, stroke $strokeWidth", geometry => {
    const ellipse = boundsTestEllipse({ ...geometry, width: 400, height: 100 });
    const plan = planNativeArtVisual(ellipse, { coordinateSpace: "local" });
    const bounds = rotatedGraphicLocalBounds(ellipse, plan.frameBounds, ellipse.rotation);
    // Default projected-polyline miter joins contribute to these dimensions.
    expect(bounds.width).toBeCloseTo(geometry.expectedWidth, 3);
    expect(bounds.height).toBeCloseTo(geometry.expectedHeight, 3);
  });

  it("expands the projected inset centreline by half the stroke for round joins", () => {
    const ellipse = boundsTestEllipse({ width: 400, height: 100, rotation: 90, tiltX: 85, tiltY: 0, strokeWidth: 40 });
    ellipse.style.strokeLineJoin = "round";
    const plan = planNativeArtVisual(ellipse, { coordinateSpace: "local" });
    const bounds = rotatedGraphicLocalBounds(ellipse, plan.frameBounds, ellipse.rotation);
    expect(bounds.width / 2).toBeCloseTo(30 * Math.cos(85 * Math.PI / 180) + 20, 6);
    expect(bounds.height).toBeCloseTo(400, 6);
    expectTightOutlineBounds({ ...bounds, x: bounds.x + ellipse.x, y: bounds.y + ellipse.y }, renderedEllipseOutline(ellipse));
  });
});
