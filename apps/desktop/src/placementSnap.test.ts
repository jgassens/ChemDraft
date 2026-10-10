import { describe, expect, it } from "vitest";
import { snapPlacementDegrees } from "./placementSnap";
import { snapRotationDegrees } from "./rotationSnap";

describe("placement uses the existing absolute rotation grid", () => {
  it.each([23, -23, 7, -7, 179, -179, 359, 383])("snaps %s° by default and keeps Alt free", (degrees) => {
    expect(snapPlacementDegrees(degrees)).toBe(snapRotationDegrees(degrees, { shiftKey: true }));
    expect(snapPlacementDegrees(degrees) / 15).toBe(Math.round(degrees / 15));
    expect(snapPlacementDegrees(degrees, true)).toBe(degrees);
  });
});
