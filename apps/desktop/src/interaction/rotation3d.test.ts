import { describe, expect, it } from "vitest";

import { flattenPerspectiveFrom3D } from "@chemdraft/chem-core";
import type { MoleculeObject } from "@chemdraft/chem-core";
import {
  applyTrackballDrag,
  projectPoint,
  projectToTrackball,
  quatFromAxisAngle,
  quatIdentity,
  quatMultiply,
  quatNormalize,
  quatToViewMatrix,
  rotateVectorByQuat,
  trackballRotation,
  type Quaternion,
  type Vec3
} from "./rotation3d";

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];

function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}
function vecClose(a: Vec3, b: Vec3, eps = 1e-9): void {
  expect(near(a[0], b[0], eps), `x: ${a[0]} vs ${b[0]}`).toBe(true);
  expect(near(a[1], b[1], eps), `y: ${a[1]} vs ${b[1]}`).toBe(true);
  expect(near(a[2], b[2], eps), `z: ${a[2]} vs ${b[2]}`).toBe(true);
}

describe("rotation3d — quaternion algebra", () => {
  it("identity rotates nothing", () => {
    vecClose(rotateVectorByQuat(quatIdentity(), [3, -2, 5]), [3, -2, 5]);
  });

  it("90° about +z sends +x to +y", () => {
    const q = quatFromAxisAngle(Z, Math.PI / 2);
    vecClose(rotateVectorByQuat(q, X), Y, 1e-12);
  });

  it("90° about +x sends +y to +z", () => {
    const q = quatFromAxisAngle(X, Math.PI / 2);
    vecClose(rotateVectorByQuat(q, Y), Z, 1e-12);
  });

  it("composition is Hamilton order (apply b first, then a)", () => {
    const rotX = quatFromAxisAngle(X, Math.PI / 2); // y→z
    const rotZ = quatFromAxisAngle(Z, Math.PI / 2); // x→y
    // First rotZ (x→y), then rotX (y→z): x should end at z.
    const composed = quatMultiply(rotX, rotZ);
    vecClose(rotateVectorByQuat(composed, X), Z, 1e-12);
  });

  it("a degenerate axis yields identity", () => {
    expect(quatFromAxisAngle([0, 0, 0], 1.2)).toEqual(quatIdentity());
  });
});

describe("rotation3d — matrix matches direct quaternion rotation", () => {
  const cases: Array<{ axis: Vec3; angle: number }> = [
    { axis: X, angle: 0.3 },
    { axis: Y, angle: -1.1 },
    { axis: Z, angle: 2.7 },
    { axis: [1, 2, 3], angle: 0.9 }
  ];
  for (const { axis, angle } of cases) {
    it(`quatToViewMatrix ∘ projectPoint == rotateVectorByQuat for axis=${axis} angle=${angle}`, () => {
      const q = quatFromAxisAngle(axis, angle);
      const m = quatToViewMatrix(q);
      for (const v of [X, Y, Z, [0.4, -0.7, 0.5] as Vec3]) {
        vecClose(projectPoint(m, v), rotateVectorByQuat(q, v), 1e-12);
      }
    });
  }

  it("identity quaternion → identity matrix", () => {
    expect(quatToViewMatrix(quatIdentity())).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1
    ]);
  });

  it("the rotation matrix is orthonormal (columns are unit, orthogonal)", () => {
    const m = quatToViewMatrix(quatFromAxisAngle([1, 1, 1], 1.0));
    const col = (i: number): Vec3 => [m[i], m[i + 4], m[i + 8]];
    const c0 = col(0);
    const c1 = col(1);
    const c2 = col(2);
    expect(near(c0[0] * c0[0] + c0[1] * c0[1] + c0[2] * c0[2], 1, 1e-12)).toBe(true);
    expect(near(c1[0] * c1[0] + c1[1] * c1[1] + c1[2] * c1[2], 1, 1e-12)).toBe(true);
    expect(near(c2[0] * c2[0] + c2[1] * c2[1] + c2[2] * c2[2], 1, 1e-12)).toBe(true);
    expect(near(c0[0] * c1[0] + c0[1] * c1[1] + c0[2] * c1[2], 0, 1e-12)).toBe(true);
  });
});

describe("rotation3d — trackball", () => {
  const config = { center: { x: 100, y: 100 }, radius: 100 };

  it("lifts the center of the ball to the pole (+z toward viewer)", () => {
    vecClose(projectToTrackball({ x: 100, y: 100 }, config), [0, 0, 1], 1e-12);
  });

  it("flips screen-y so dragging the cursor downward maps to -y on the ball", () => {
    const below = projectToTrackball({ x: 100, y: 150 }, config);
    expect(below[1]).toBeLessThan(0); // screen-down → world-down
  });

  it("a zero-length drag is the identity rotation", () => {
    const q = trackballRotation({ x: 130, y: 90 }, { x: 130, y: 90 }, config);
    expect(quatNormalize(q)).toEqual(quatIdentity());
  });

  it("the drag rotation carries the grabbed point onto the release point", () => {
    const from = { x: 100, y: 100 }; // pole
    const to = { x: 150, y: 100 };
    const q = trackballRotation(from, to, config);
    const p1 = projectToTrackball(from, config);
    const p2 = projectToTrackball(to, config);
    vecClose(rotateVectorByQuat(q, p1), p2, 1e-9);
  });

  it("accumulates drags onto a running orientation", () => {
    let q: Quaternion = quatIdentity();
    q = applyTrackballDrag(q, { x: 100, y: 100 }, { x: 120, y: 100 }, config);
    q = applyTrackballDrag(q, { x: 120, y: 100 }, { x: 140, y: 100 }, config);
    // Still a unit quaternion, and not the identity (we moved).
    expect(near(Math.hypot(q.x, q.y, q.z, q.w), 1, 1e-12)).toBe(true);
    expect(near(q.x, 0) && near(q.y, 0) && near(q.z, 0) && near(q.w, 1)).toBe(false);
  });
});

describe("rotation3d — feeds the flatten contract directly", () => {
  // A single tetrahedral stereocenter; quatToViewMatrix output must be accepted by
  // flattenPerspectiveFrom3D as a ViewMatrix and commit a sound wedge.
  function chiralMol(): { mol: MoleculeObject; coords3d: number[] } {
    const verts: Array<[number, number, number]> = [
      [1, 1, 1],
      [-1, -1, 1],
      [-1, 1, -1],
      [1, -1, -1]
    ];
    const coords3d = [0, 0, 0, ...verts.flat()];
    const mol: MoleculeObject = {
      id: "mol_spin",
      type: "molecule",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      style: {},
      structureFormat: "molfile-v3000",
      structure: "MOCK",
      atoms: [
        { id: "a0", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "a1", element: "F", x: verts[0][0], y: verts[0][1], formalCharge: 0 },
        { id: "a2", element: "Cl", x: verts[1][0], y: verts[1][1], formalCharge: 0 },
        { id: "a3", element: "Br", x: verts[2][0], y: verts[2][1], formalCharge: 0 },
        { id: "a4", element: "I", x: verts[3][0], y: verts[3][1], formalCharge: 0 }
      ],
      bonds: [
        { id: "b1", fromAtomId: "a0", toAtomId: "a1", order: "single", display: { bondStyle: "wedge" } },
        { id: "b2", fromAtomId: "a0", toAtomId: "a2", order: "single" },
        { id: "b3", fromAtomId: "a0", toAtomId: "a3", order: "single" },
        { id: "b4", fromAtomId: "a0", toAtomId: "a4", order: "single" }
      ],
      superatoms: [],
      rGroups: []
    };
    return { mol, coords3d };
  }

  it("a small spin still commits a single sound wedge", () => {
    const { mol, coords3d } = chiralMol();
    const m = quatToViewMatrix(quatFromAxisAngle([0.2, 1, 0.1], 0.4));
    const result = flattenPerspectiveFrom3D(mol, coords3d, m, { objectId: mol.id });
    expect(result.status).toBe("committed");
    const wedges = (result.mol2dProjected as MoleculeObject).bonds.filter(
      (b) => b.display?.bondStyle === "wedge" || b.display?.bondStyle === "hashed"
    );
    expect(wedges).toHaveLength(1);
  });
});
