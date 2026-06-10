import { describe, expect, it } from "vitest";

import { quatFromAxisAngle, quatIdentity, type Vec3 } from "./rotation3d";
import {
  conformerCentroid,
  initialViewQuaternion,
  medianBondLength2d,
  medianBondLength3d,
  overlayScale,
  projectSpin
} from "./spinOverlay";

const Z: Vec3 = [0, 0, 1];

describe("spinOverlay — measures", () => {
  it("computes the conformer centroid", () => {
    const coords = [0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 0];
    expect(conformerCentroid(coords)).toEqual([1, 1, 0]);
  });

  it("computes median 3D and 2D bond lengths", () => {
    // Two bonds of length 1 and 3 → median 2.
    const coords = [0, 0, 0, 1, 0, 0, 1, 0, 0, 4, 0, 0];
    expect(medianBondLength3d(coords, [[0, 1], [2, 3]])).toBe(2);
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 4, y: 0 }];
    expect(medianBondLength2d(pts, [[0, 1], [2, 3]])).toBe(2);
  });

  it("scales drawn px per conformer unit", () => {
    // Drawn bond length 30 px, conformer bond length 1.5 → scale 20.
    const pts = [{ x: 0, y: 0 }, { x: 30, y: 0 }];
    const coords = [0, 0, 0, 1.5, 0, 0];
    expect(overlayScale(pts, coords, [[0, 1]])).toBe(20);
  });

  it("falls back to scale 1 when a length is unmeasurable", () => {
    expect(overlayScale([{ x: 0, y: 0 }], [0, 0, 0], [])).toBe(1);
  });
});

describe("spinOverlay — projection", () => {
  const placement = { centerX: 100, centerY: 200, scale: 10 };

  it("places the centroid at the screen center (identity rotation)", () => {
    const coords = [0, 0, 0, 2, 0, 0]; // centroid (1,0,0)
    const proj = projectSpin(coords, [[0, 1]], quatIdentity(), placement);
    // Centered: atom0 at (-1,0,0), atom1 at (+1,0,0). Screen x = 100 ± 10.
    expect(proj.atoms[0].sx).toBeCloseTo(90, 9);
    expect(proj.atoms[1].sx).toBeCloseTo(110, 9);
    // Both on the center line, y unchanged.
    expect(proj.atoms[0].sy).toBeCloseTo(200, 9);
  });

  it("negates y (math y-up → document y-down)", () => {
    const coords = [0, 0, 0, 0, 2, 0]; // centroid (0,1,0); atom1 centered at (0,+1,0)
    const proj = projectSpin(coords, [[0, 1]], quatIdentity(), placement);
    // +y in math → smaller screen y (up on screen).
    expect(proj.atoms[1].sy).toBeCloseTo(200 - 1 * 10, 9);
    expect(proj.atoms[0].sy).toBeCloseTo(200 + 1 * 10, 9);
  });

  it("sorts bonds far → near by average depth (painter's order)", () => {
    // Three atoms at distinct z; two bonds with different mean depth.
    // After centering, depths differ; nearer bond must come last.
    const coords = [
      0, 0, -5, // a0 far
      0, 0, 0, // a1 mid
      0, 0, 5 // a2 near
    ];
    const proj = projectSpin(coords, [[0, 1], [1, 2]], quatIdentity(), placement);
    expect(proj.bonds[0].depth).toBeLessThan(proj.bonds[1].depth);
    // The near bond (a1-a2) is painted last.
    expect(proj.bonds[proj.bonds.length - 1].from).toBe(1);
    expect(proj.bonds[proj.bonds.length - 1].to).toBe(2);
  });

  it("initialViewQuaternion turns an edge-on planar molecule toward the viewer", () => {
    // A square in the x-z plane (all y = 0): at identity it projects edge-on (every
    // atom on a line, zero y-spread). The initial orientation must open it up.
    const coords = [1, 0, 1, -1, 0, 1, -1, 0, -1, 1, 0, -1];
    const place = { centerX: 0, centerY: 0, scale: 1 };

    const flat = projectSpin(coords, [], quatIdentity(), place);
    const flatYSpread = Math.max(...flat.atoms.map((a) => a.sy)) - Math.min(...flat.atoms.map((a) => a.sy));
    expect(flatYSpread).toBeLessThan(1e-6); // edge-on at identity

    const opened = projectSpin(coords, [], initialViewQuaternion(coords), place);
    const xs = opened.atoms.map((a) => a.sx);
    const ys = opened.atoms.map((a) => a.sy);
    const xSpread = Math.max(...xs) - Math.min(...xs);
    const ySpread = Math.max(...ys) - Math.min(...ys);
    // Now spread out in BOTH screen axes — the face is toward the viewer.
    expect(xSpread).toBeGreaterThan(1);
    expect(ySpread).toBeGreaterThan(1);
  });

  it("a 90° spin about z swaps the projected x/y of an off-center atom", () => {
    const coords = [0, 0, 0, 2, 0, 0]; // centroid (1,0,0); atom1 centered (+1,0,0)
    const proj = projectSpin(coords, [[0, 1]], quatFromAxisAngle(Z, Math.PI / 2), placement);
    // +x rotates to +y (math) → screen y goes UP (smaller). x returns to center.
    expect(proj.atoms[1].sx).toBeCloseTo(100, 6);
    expect(proj.atoms[1].sy).toBeCloseTo(200 - 1 * 10, 6);
  });
});
