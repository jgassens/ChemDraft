import { describe, expect, it } from "vitest";
import { rotatePointAboutCenter, type BracketObject } from "@chemdraft/chem-core";
import { rotationTransform, transformPointForObject } from "./index";

describe("shared page rotation convention", () => {
  it.each([0, 37, 90, 180, 270, -90])("uses the SVG frame center and direction at %s degrees", rotation => {
    const bracket: BracketObject = { id: "bracket", type: "bracket", bracketKind: "square", side: "open",
      x: 10, y: 20, width: 20, height: 60, rotation, style: {}, containedObjectIds: [] };
    const center = { x: 20, y: 50 };
    const point = { x: 30, y: 50 };
    const rotated = rotatePointAboutCenter(point, center, rotation * Math.PI / 180);
    expect(transformPointForObject(bracket, point)).toEqual(rotated);
    expect(rotationTransform(bracket)).toBe(rotation === 0 ? undefined : `rotate(${rotation} 20 50)`);
    const restored = rotatePointAboutCenter(rotated, center, -rotation * Math.PI / 180);
    expect(restored.x).toBeCloseTo(point.x, 10);
    expect(restored.y).toBeCloseTo(point.y, 10);
    if (rotation === 90) expect(rotated).toEqual({ x: 20, y: 60 });
  });
});
