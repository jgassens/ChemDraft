import { projectGraphicObjectPoint } from "@chemdraft/art-engine";
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
  return { ...object, width, height: 100, data: { ...object.data, cornerRadiusPx: radius } };
}

describe("corner radius handle placement", () => {
  it.each([0.1, 0.5, 1, 2, 8])("keeps zero and small radii clear at scale %s", (scale) => {
    for (const radius of [0, 0.25, 1]) {
      const object = rectangle(radius, 1000);
      const point = nativeGraphicCornerRadiusHandlePoint(object, scale)!;
      expect(point.x * scale).toBeCloseTo(GRAPHIC_CORNER_RADIUS_HANDLE_SEPARATION_PX);
      expect(point.y).toBe(0);
      expect(nativeGraphicCornerRadiusEditPoint(object)?.x).toBe(radius);
    }
  });

  it("follows the true radius once it clears the minimum", () => {
    expect(nativeGraphicCornerRadiusHandlePoint(rectangle(30), 1)).toEqual({ x: 30, y: 0 });
  });

  it.each([0.1, 1, 8])("continues outward for shapes too small at scale %s", (scale) => {
    const object = rectangle(0, 2);
    const point = nativeGraphicCornerRadiusHandlePoint(object, scale)!;
    expect(point.x * scale).toBeCloseTo(-GRAPHIC_CORNER_RADIUS_HANDLE_SEPARATION_PX);
    // All resize corners are at or to the right of x=0, so even a collapsed
    // width/height leaves this target separate from every resize target.
    expect(point.x).toBeLessThan(0);
  });

  it("keeps separation under projection and Z rotation", () => {
    const object = { ...rectangle(), rotation: 37, style: { ...rectangle().style, tiltYDegrees: 60 } };
    const point = nativeGraphicCornerRadiusHandlePoint(object, 2)!;
    const projected = projectGraphicObjectPoint(object, point, { coordinateSpace: "local" });
    const corner = projectGraphicObjectPoint(object, { x: 0, y: 0 }, { coordinateSpace: "local" });
    // Z rotation is applied by the visual shell, after local projection.
    const angle = object.rotation * Math.PI / 180;
    const dx = (projected.x - corner.x) * Math.cos(angle) - (projected.y - corner.y) * Math.sin(angle);
    const dy = (projected.x - corner.x) * Math.sin(angle) + (projected.y - corner.y) * Math.cos(angle);
    expect(Math.hypot(dx, dy) * 2).toBeCloseTo(GRAPHIC_CORNER_RADIUS_HANDLE_SEPARATION_PX);
  });
});
