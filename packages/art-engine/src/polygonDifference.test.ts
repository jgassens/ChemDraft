import Flatten from "@flatten-js/core";
import { describe, expect, it } from "vitest";
import { subtractPolygonPaths } from "./index";

const rectangle = (x: number, y: number, width: number, height: number) => [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }
];
const subject = rectangle(10, 20, 100, 80);

describe("generic polygon path difference", () => {
  it("reports a duplicate clearance already removed by an earlier cut", () => {
    const cutout = rectangle(30, 40, 20, 10);
    const single = subtractPolygonPaths(subject, [cutout]);
    const duplicate = subtractPolygonPaths(subject, [cutout, cutout]);
    expect(duplicate.overlappingCutoutIndices).toEqual([0, 1]);
    expect(duplicate.pathD).toBe(single.pathD);
  });

  it("rejects edge contact and bbox overlap without polygon overlap after an earlier cut", () => {
    const triangle = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
    const result = subtractPolygonPaths(triangle, [
      rectangle(10, 10, 10, 10), rectangle(80, 80, 10, 10), rectangle(100, 0, 10, 10)
    ]);
    expect(result.overlappingCutoutIndices).toEqual([0]);
  });

  it("preserves input coordinates and emits an interior hole", () => {
    const result = subtractPolygonPaths(subject, [rectangle(30, 40, 20, 10)]);
    expect(result.overlappingCutoutIndices).toEqual([0]);
    expect(result.pathD.match(/M /g)).toHaveLength(2);
    expect(result.pathD).toContain("10 20");
    // Oppositely oriented hole faces, also suitable for nonzero-rule consumers.
    const faces = result.pathD.split("Z").filter((face) => face.trim()).map((face) => {
      const values = face.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      return new Flatten.Polygon(Array.from({ length: values.length / 2 }, (_, i) => [values[i * 2]!, values[i * 2 + 1]!] as [number, number]));
    });
    expect(faces[0]!.orientation()).not.toBe(faces[1]!.orientation());
    expect(Math.abs(faces[0]!.area() - faces[1]!.area())).toBeCloseTo(7800);
  });

  it("ignores outside cutters, handles overlapping cutters, and reports labels after total removal", () => {
    expect(subtractPolygonPaths(subject, [rectangle(200, 200, 20, 20)]).overlappingCutoutIndices).toEqual([]);
    const overlapping = subtractPolygonPaths(subject, [rectangle(30, 40, 20, 20), rectangle(40, 40, 20, 20)]);
    expect(overlapping.overlappingCutoutIndices).toEqual([0, 1]);
    expect(overlapping.pathD.match(/M /g)).toHaveLength(2);
    const empty = subtractPolygonPaths(subject, [rectangle(0, 0, 200, 200), rectangle(30, 40, 20, 20)]);
    expect(empty).toEqual({ pathD: "", overlappingCutoutIndices: [0, 1] });
  });

  it("is independent of the subject and cutter winding", () => {
    const cutout = rectangle(30, 40, 20, 10);
    const expected = subtractPolygonPaths(subject, [cutout]);
    const canonicalFaces = (pathD: string) => pathD.split("Z").filter((face) => face.trim()).map((face) => {
      const values = face.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      return Array.from({ length: values.length / 2 }, (_, i) => `${values[i * 2]},${values[i * 2 + 1]}`).sort();
    });
    for (const result of [subtractPolygonPaths([...subject].reverse(), [cutout]), subtractPolygonPaths(subject, [[...cutout].reverse()])]) {
      expect(result.overlappingCutoutIndices).toEqual([0]);
      expect(canonicalFaces(result.pathD)).toEqual(canonicalFaces(expected.pathD));
    }
  });
});
