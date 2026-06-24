import { describe, expect, it } from "vitest";
import { quatFromAxisAngle, quatIdentity } from "./rotation3d";
import {
  hitTestSpinTug,
  moveSpinAtomsKeepingCentroid,
  projectModelDelta,
  recenterConformer,
  screenDeltaToModel
} from "./spinTug";

function closeArray(actual: ArrayLike<number>, expected: readonly number[], digits = 6) {
  expect(Array.from(actual)).toHaveLength(expected.length);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, digits));
}

describe("spin tug projection math", () => {
  it("maps identity screen movement into model x/y with document-y inverted", () => {
    closeArray(screenDeltaToModel(10, 20, 10, quatIdentity()), [1, -2, 0]);
  });

  it("maps rotated screen movement through the inverse view matrix", () => {
    const quat = quatFromAxisAngle([0, 1, 0], Math.PI / 2);
    const model = screenDeltaToModel(10, 0, 10, quat);
    const projected = projectModelDelta(model, quat);
    expect(projected[0]).toBeCloseTo(1, 6);
    expect(projected[1]).toBeCloseTo(0, 6);
  });

  it("moves selected atoms while preserving the original centroid", () => {
    const moved = moveSpinAtomsKeepingCentroid(new Float64Array([0, 0, 0, 2, 0, 0]), [1], [2, 0, 0]);
    closeArray(moved, [-1, 0, 0, 3, 0, 0]);
  });

  it("recenters relaxed coordinates to the drag-start pivot", () => {
    const recentered = recenterConformer(new Float64Array([10, 0, 0, 12, 0, 0]), [1, 0, 0]);
    closeArray(recentered, [0, 0, 0, 2, 0, 0]);
  });

  it("prefers atom hits over bond hits and moves the smaller acyclic fragment for bond hits", () => {
    const projection = {
      atoms: [
        { index: 0, sx: 0, sy: 0, depth: 0 },
        { index: 1, sx: 10, sy: 0, depth: 0 },
        { index: 2, sx: 20, sy: 0, depth: 0 },
        { index: 3, sx: 30, sy: 0, depth: 0 }
      ],
      bonds: []
    };
    expect(hitTestSpinTug(projection, [[0, 1], [1, 2], [2, 3]], { x: 0, y: 0 }, { atomRadius: 3, bondRadius: 4 }))
      .toEqual({ kind: "atom", atomIndex: 0, atomIndices: [0] });
    expect(hitTestSpinTug(projection, [[0, 1], [1, 2], [2, 3]], { x: 15, y: 0 }, { atomRadius: 3, bondRadius: 4 }))
      .toEqual({ kind: "bond", bondIndex: 1, atomIndices: [0, 1] });
  });

  it("does not expose ring-bond tug components", () => {
    const projection = {
      atoms: [
        { index: 0, sx: 0, sy: 0, depth: 0 },
        { index: 1, sx: 10, sy: 0, depth: 0 },
        { index: 2, sx: 5, sy: 8, depth: 0 }
      ],
      bonds: []
    };
    expect(hitTestSpinTug(projection, [[0, 1], [1, 2], [2, 0]], { x: 5, y: 0 }, { atomRadius: 1, bondRadius: 4 }))
      .toBeUndefined();
  });
});
