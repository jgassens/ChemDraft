import { planNativeArtVisual, projectGraphicObjectPoint } from "@chemdraft/art-engine";
import type { GraphicObject } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";
import {
  createPhase4Document,
  insertNativeArtGraphicObject,
  nativeGraphicCornerRadiusEditPoint,
  nativeGraphicCornerRadiusHandlePoint,
  GRAPHIC_CORNER_RADIUS_HANDLE_SEPARATION_PX
} from "./documentWorkflow";

function rectangle(radius = 0, width = 100): GraphicObject {
  const document = insertNativeArtGraphicObject(createPhase4Document("Radius"), { x: 200, y: 200 }, "tool.art.rect");
  const object = document.pages[0].objects.find((item) => item.id === document.selection.objectIds[0]);
  if (object?.type !== "graphic") throw new Error("Expected rectangle");
  return { ...object, x: 400, width, height: 100, data: { ...object.data, cornerRadiusPx: radius } };
}

const page = { width: 2000, height: 2000 };

describe("corner radius handle placement", () => {
  it.each([0.1, 0.5, 1, 2, 8])("keeps zero and small radii clear at scale %s", (scale) => {
    for (const radius of [0, 0.25, 1]) {
      const object = rectangle(radius, 1000);
      const point = nativeGraphicCornerRadiusHandlePoint(object, scale, page)!;
      expect(point.x * scale).toBeCloseTo(GRAPHIC_CORNER_RADIUS_HANDLE_SEPARATION_PX);
      expect(point.y).toBe(0);
      expect(nativeGraphicCornerRadiusEditPoint(object)?.x).toBe(radius);
    }
  });

  it("follows the true radius once it clears the minimum", () => {
    expect(nativeGraphicCornerRadiusHandlePoint(rectangle(30), 1, page)).toEqual({ x: 30, y: 0 });
  });

  it.each([0.1, 1, 8])("continues outward for shapes too small at scale %s", (scale) => {
    const object = rectangle(0, 2);
    const point = nativeGraphicCornerRadiusHandlePoint(object, scale, page)!;
    expect(point.x * scale).toBeCloseTo(-GRAPHIC_CORNER_RADIUS_HANDLE_SEPARATION_PX);
    // All resize corners are at or to the right of x=0, so even a collapsed
    // width/height leaves this target separate from every resize target.
    expect(point.x).toBeLessThan(0);
  });

  it("chooses the controlled-corner outside placement near the right page edge", () => {
    const object = { ...rectangle(0, 10), x: page.width - 15 };
    const point = nativeGraphicCornerRadiusHandlePoint(object, 1, page)!;
    expect(point.x).toBeLessThan(0);
    expect(object.x + point.x - 4.5).toBeGreaterThanOrEqual(0);
    expect(object.x + point.x + 4.5).toBeLessThanOrEqual(page.width);
  });

  it("chooses the opposite-corner outside placement near the left page edge", () => {
    const object = { ...rectangle(0, 10), x: 5 };
    const point = nativeGraphicCornerRadiusHandlePoint(object, 1, page)!;
    expect(point.x).toBeGreaterThan(object.width);
    expect(object.x + point.x - 4.5).toBeGreaterThanOrEqual(0);
    expect(object.x + point.x + 4.5).toBeLessThanOrEqual(page.width);
    expect(point.x - 4.5).toBeGreaterThanOrEqual(object.width + 8 + 2);
  });

  it("falls back inside when no full target fits on the top edge", () => {
    const object = { ...rectangle(0, 10), y: 0 };
    expect(nativeGraphicCornerRadiusHandlePoint(object, 1, page)).toEqual({ x: 5, y: 0 });
  });

  it.each([0, 37, 90, 143])("clears every actual resize box with both tilts and rotation %s", (rotation) => {
    const object = { ...rectangle(), rotation, style: { ...rectangle().style, tiltXDegrees: 60, tiltYDegrees: 60 } };
    const scale = 2;
    const point = nativeGraphicCornerRadiusHandlePoint(object, scale, page)!;
    const angle = rotation * Math.PI / 180;
    const rotate = (p: { x: number; y: number }) => ({
      x: (object.width / 2 + (p.x - object.width / 2) * Math.cos(angle) - (p.y - object.height / 2) * Math.sin(angle)) * scale,
      y: (object.height / 2 + (p.x - object.width / 2) * Math.sin(angle) + (p.y - object.height / 2) * Math.cos(angle)) * scale
    });
    const projected = rotate(projectGraphicObjectPoint(object, point, { coordinateSpace: "local" }));
    const bounds = planNativeArtVisual(object, { coordinateSpace: "local" }).frameBounds;
    const corners = [
      { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y },
      { x: bounds.x, y: bounds.y + bounds.height }, { x: bounds.x + bounds.width, y: bounds.y + bounds.height }
    ].map(rotate);
    const left = Math.min(...corners.map(p => p.x));
    const right = Math.max(...corners.map(p => p.x));
    const top = Math.min(...corners.map(p => p.y));
    const bottom = Math.max(...corners.map(p => p.y));
    const half = 4.5 * (Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle)));
    for (const x of [left + 1, right - 1]) {
      for (const y of [top + 1, bottom - 1]) {
        expect(Math.abs(projected.x - x) >= 9 + half + 2 - 1e-8 ||
          Math.abs(projected.y - y) >= 9 + half + 2 - 1e-8).toBe(true);
      }
    }
    if (rotation === 0) {
      const corner = projectGraphicObjectPoint(object, { x: 0, y: 0 }, { coordinateSpace: "local" });
      const unit = projectGraphicObjectPoint(object, { x: 1, y: 0 }, { coordinateSpace: "local" });
      const oldMinimum = GRAPHIC_CORNER_RADIUS_HANDLE_SEPARATION_PX / (scale * Math.hypot(unit.x - corner.x, unit.y - corner.y));
      const old = rotate(projectGraphicObjectPoint(object, { x: oldMinimum, y: 0 }, { coordinateSpace: "local" }));
      expect(Math.abs(old.x - (left + 1))).toBeLessThan(9 + half);
      expect(Math.abs(old.y - (top + 1))).toBeLessThan(9 + half);
      expect(point.x).toBeGreaterThan(oldMinimum);
    }
  });
});
