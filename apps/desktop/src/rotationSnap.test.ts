import { describe, expect, it } from "vitest";
import { snapRotationDegrees } from "./rotationSnap";

describe("rotation drag snapping", () => {
  it.each([
    [12, 15], [14.9, 15], [15, 15], [18, 15], [18.1, 18.1],
    [-12, -15], [-14.9, -15], [-15, -15], [-18, -15], [-18.1, -18.1],
    [22, 22], [-22, -22],
    [178, 180], [192, 195], [-192, -195],
    [358, 360], [374.9, 375], [378.1, 378.1], [-374.9, -375],
    [718, 720]
  ])("magnetically snaps %s° to %s°", (degrees, expected) => {
    expect(snapRotationDegrees(degrees)).toBe(expected);
  });

  it.each([
    [4, 0], [8, 15], [22, 15], [23, 30], [-8, -15], [-23, -30],
    [184, 180], [188, 195], [364, 360], [368, 375], [-368, -375]
  ])("rounds %s° to %s° with Shift", (degrees, expected) => {
    expect(snapRotationDegrees(degrees, { shiftKey: true })).toBe(expected);
  });

  it("retains junction fragments' absolute grid and relative bond targets", () => {
    expect(snapRotationDegrees(18, { referenceDegrees: 10, stepDegrees: 30 })).toBe(20);
    expect(snapRotationDegrees(9, {
      referenceDegrees: 10, stepDegrees: 30, additionalAbsoluteAngles: [20]
    })).toBe(10);
    expect(snapRotationDegrees(22, {
      shiftKey: true, referenceDegrees: 10, stepDegrees: 30, additionalAbsoluteAngles: [20]
    })).toBe(20);
  });

  it.each([
    [7, 8, 15], [7, 15, 15], [7, 22, 30], [7, 37, 45],
    [100, -7, 90], [100, 4, 105], [358, 8, 360], [-7, -22, -30]
  ])("Shift snaps orientation %s° plus delta %s° to %s°", (referenceDegrees, delta, expected) => {
    expect(referenceDegrees + snapRotationDegrees(delta, { referenceDegrees, shiftKey: true })).toBe(expected);
  });

  it.each([
    [7, 6, 15], [7, 10, 15], [7, 15, 22], [7, 20, 30],
    [100, 3, 105], [100, 8.1, 108.1], [358, 4, 360], [-7, -6, -15]
  ])("magnetically snaps orientation %s° plus delta %s° to %s°", (referenceDegrees, delta, expected) => {
    expect(referenceDegrees + snapRotationDegrees(delta, { referenceDegrees })).toBeCloseTo(expected, 8);
  });
});
