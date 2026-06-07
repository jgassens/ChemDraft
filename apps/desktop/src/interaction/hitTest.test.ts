import { describe, it, expect } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";

import { createPhase4Document, insertNativeSingleBondMolecule } from "../documentWorkflow";
import { bondHitRadiusForScale, hitToleranceForScale, hitTestDocument } from "./hitTest";

function singleBondMolecule() {
  const document = insertNativeSingleBondMolecule(createPhase4Document("hit-test"), { x: 200, y: 220 });
  const molecule = document.pages[0].objects[0];
  if (molecule.type !== "molecule") {
    throw new Error("expected a molecule fixture");
  }
  return { document, molecule: molecule as MoleculeObject };
}

interface Vec {
  x: number;
  y: number;
}

/**
 * The interaction layer converts a client/screen point to page space by dividing by the
 * camera scale (see camera.ts `clientToPage`). So a fixed on-screen pixel offset `d` lands
 * `d / scale` page-units from the target. These helpers reproduce that relationship so the
 * tests can characterize behavior "at a given zoom" against the page-space hit-test, which
 * is the only thing `hitTestDocument` sees today.
 */
function bondFrame(molecule: MoleculeObject): {
  a0: MoleculeObject["atoms"][number];
  a1: MoleculeObject["atoms"][number];
  midpoint: Vec;
  along: Vec; // unit vector a0 -> a1
  perpendicular: Vec; // unit vector normal to the bond
} {
  const [a0, a1] = molecule.atoms;
  const length = Math.hypot(a1.x - a0.x, a1.y - a0.y);
  const along = { x: (a1.x - a0.x) / length, y: (a1.y - a0.y) / length };
  return {
    a0,
    a1,
    midpoint: { x: (a0.x + a1.x) / 2, y: (a0.y + a1.y) / 2 },
    along,
    perpendicular: { x: -along.y, y: along.x }
  };
}

/** Page point that sits `screenPx` on-screen pixels from `base` along `unit`, at `scale`. */
function atScreenOffset(base: Vec, unit: Vec, screenPx: number, scale: number): Vec {
  const pageOffset = screenPx / scale;
  return { x: base.x + unit.x * pageOffset, y: base.y + unit.y * pageOffset };
}

// The zoom range that actually ships on this branch (createViewportState defaults,
// not overridden by MainWindow): minZoom 0.5, maxZoom 8.5.
const SUPPORTED_ZOOMS = [0.5, 1, 4, 8.5] as const;

describe("hitTestDocument (geometric source of truth)", () => {
  it("returns the atom exactly under the pointer", () => {
    const { document, molecule } = singleBondMolecule();
    const atom = molecule.atoms[0];

    const hit = hitTestDocument(document, { x: atom.x, y: atom.y });
    expect(hit).toMatchObject({ kind: "atom", atomId: atom.id, objectId: molecule.id });
    expect(hit?.distanceToPointer).toBeCloseTo(0);
  });

  it("picks the geometrically nearest atom, never whichever is listed/stacked first", () => {
    const { document, molecule } = singleBondMolecule();
    const far = molecule.atoms[1];

    const hit = hitTestDocument(document, { x: far.x + 1, y: far.y });
    expect(hit).toMatchObject({ kind: "atom", atomId: far.id });
    expect(hit?.distanceToPointer).toBeCloseTo(1);
  });

  it("reports a real, non-zero distance for bond hits (regression: used to be 0)", () => {
    const { document, molecule } = singleBondMolecule();
    const [a0, a1] = molecule.atoms;
    const midpoint = { x: (a0.x + a1.x) / 2, y: (a0.y + a1.y) / 2 };
    const offset = 2; // perpendicular to the horizontal bond, inside the 4px bond radius

    const hit = hitTestDocument(document, { x: midpoint.x, y: midpoint.y + offset });
    expect(hit?.kind).toBe("bond");
    // The old DOM-hinted bond path hard-coded distanceToPointer: 0, which corrupted the
    // cross-object sort. It must now be the true perpendicular distance.
    expect(hit?.distanceToPointer).toBeCloseTo(offset, 5);
    expect(hit?.distanceToPointer).toBeGreaterThan(0);
  });

  it("returns undefined over empty canvas", () => {
    const { document } = singleBondMolecule();
    expect(hitTestDocument(document, { x: 24, y: 24 })).toBeUndefined();
  });

  it("prefers the nearer molecule when two overlap, tie-broken by top layer", () => {
    const base = insertNativeSingleBondMolecule(createPhase4Document("overlap"), { x: 200, y: 220 });
    const document = insertNativeSingleBondMolecule(base, { x: 200, y: 220 });
    const [lower, upper] = document.pages[0].objects;
    if (lower.type !== "molecule" || upper.type !== "molecule") {
      throw new Error("expected two molecules");
    }

    // Exact overlap on the shared bond midpoint resolves to the top-most layer.
    const hit = hitTestDocument(document, { x: 200, y: 220 });
    expect(hit?.objectId).toBe(upper.id);
  });

  it("picks the geometrically nearer atom on a LOWER layer over a farther hit on top", () => {
    // The interaction lie behind the rotaxane report: two overlapping molecules, and the
    // pointer sits exactly on an atom of the bottom molecule while still inside the hit
    // radius of the top one. Distance must win over stacking order.
    const base = insertNativeSingleBondMolecule(createPhase4Document("overlap"), { x: 200, y: 220 });
    const document = insertNativeSingleBondMolecule(base, { x: 205, y: 220 });
    const [lower, upper] = document.pages[0].objects;
    if (lower.type !== "molecule" || upper.type !== "molecule") {
      throw new Error("expected two molecules");
    }

    const lowerAtom = lower.atoms[0];
    const nearestUpperDistance = Math.min(
      ...upper.atoms.map((atom) => Math.hypot(atom.x - lowerAtom.x, atom.y - lowerAtom.y))
    );
    // Guard the fixture: the top molecule must also be a live candidate here (within the
    // 8px atom radius) or this would not exercise the layer-vs-distance conflict at all.
    expect(nearestUpperDistance).toBeGreaterThan(0.5);
    expect(nearestUpperDistance).toBeLessThan(8);

    const hit = hitTestDocument(document, { x: lowerAtom.x, y: lowerAtom.y });
    expect(hit).toMatchObject({ kind: "atom", atomId: lowerAtom.id, objectId: lower.id });
    expect(hit?.distanceToPointer).toBeCloseTo(0);
  });
});

// ---------------------------------------------------------------------------------------
// CHARACTERIZATION: the DEFAULT (no-tolerance) path is the programmatic / keyboard / test
// path and stays page-space forever, so these document behavior we PRESERVE. The pointer
// path (which passes a scale-derived tolerance) is exercised separately below.
// See docs/architecture/pointer-picking-hardening.md.
// ---------------------------------------------------------------------------------------
describe("hitTestDocument default (no-tolerance) path is page-space", () => {
  // With no tolerance supplied, the model bond radius is a fixed 4 page-units. A pointer
  // held a constant 6px off the bond would therefore be selectable only when zoomed in.
  // This is the brittleness the POINTER path fixes (see the screen-stable suite below);
  // the default path keeps these fixed radii for programmatic callers.
  const BOND_SCREEN_OFFSET_PX = 6;

  it.each(SUPPORTED_ZOOMS)(
    "bond 6px off-axis at zoom %sx: hit iff 6px <= 4*scale (current page-space radius)",
    (scale) => {
      const { document, molecule } = singleBondMolecule();
      const { midpoint, perpendicular } = bondFrame(molecule);
      const point = atScreenOffset(midpoint, perpendicular, BOND_SCREEN_OFFSET_PX, scale);

      const hit = hitTestDocument(document, point);
      const shouldHitToday = BOND_SCREEN_OFFSET_PX <= 4 * scale;
      if (shouldHitToday) {
        expect(hit?.kind).toBe("bond");
      } else {
        expect(hit).toBeUndefined();
      }
    }
  );

  // Atom tolerance is OUT OF SCOPE this pass and stays page-space (radius 8). Pin it so the
  // bond change cannot silently alter atom picking. An atom 6px out (along the bond axis,
  // outboard of a0) is missed only when zoomed all the way out.
  const ATOM_SCREEN_OFFSET_PX = 6;

  it.each(SUPPORTED_ZOOMS)(
    "atom 6px outboard at zoom %sx: hit iff 6px <= 8*scale (unchanged this pass)",
    (scale) => {
      const { document, molecule } = singleBondMolecule();
      const { a0, along } = bondFrame(molecule);
      const outboard = { x: -along.x, y: -along.y };
      const point = atScreenOffset(a0, outboard, ATOM_SCREEN_OFFSET_PX, scale);

      const hit = hitTestDocument(document, point);
      if (ATOM_SCREEN_OFFSET_PX <= 8 * scale) {
        expect(hit).toMatchObject({ kind: "atom", atomId: a0.id });
      } else {
        expect(hit).toBeUndefined();
      }
    }
  );

  it("is deterministic: the same page point always resolves to the same target", () => {
    const { document, molecule } = singleBondMolecule();
    const { midpoint, perpendicular } = bondFrame(molecule);
    const point = atScreenOffset(midpoint, perpendicular, 2, 1);

    const first = hitTestDocument(document, point);
    const second = hitTestDocument(document, point);
    expect(second).toEqual(first);
  });
});

// The step-2 fix: when the pointer path supplies a scale-derived tolerance, a constant
// on-screen bond offset resolves consistently across zooms instead of depending on it.
describe("hitTestDocument pointer path is screen-stable for bonds (step 2)", () => {
  // 4px off the bond midpoint, on screen. This is comfortably inside the screen tolerance
  // at every supported zoom (even at 0.5×, where the bond-length ceiling tightens the band),
  // so the pointer path selects the bond consistently — unlike the page-space default path.
  const BOND_SCREEN_OFFSET_PX = 4;

  it.each(SUPPORTED_ZOOMS)(
    "selects the bond 4px off-axis at zoom %sx via the pointer tolerance",
    (scale) => {
      const { document, molecule } = singleBondMolecule();
      const { midpoint, perpendicular } = bondFrame(molecule);
      const point = atScreenOffset(midpoint, perpendicular, BOND_SCREEN_OFFSET_PX, scale);

      const hit = hitTestDocument(document, point, undefined, hitToleranceForScale(scale));
      expect(hit?.kind).toBe("bond");
    }
  );

  it("rescues a zoomed-out bond the page-space default path misses", () => {
    // At 0.5× a 4px-off bond is a miss on the fixed page-space radius (4px-off becomes 8
    // page-units, > radius 4) but a hit once the pointer supplies the screen tolerance.
    const { document, molecule } = singleBondMolecule();
    const { midpoint, perpendicular } = bondFrame(molecule);
    const point = atScreenOffset(midpoint, perpendicular, BOND_SCREEN_OFFSET_PX, 0.5);

    expect(hitTestDocument(document, point)).toBeUndefined();
    expect(hitTestDocument(document, point, undefined, hitToleranceForScale(0.5))?.kind).toBe("bond");
  });

  it("clamps the page-space radius to a flat screen tolerance band", () => {
    // bondLengthPx = 22 → ceiling = 9.9 page-units.
    expect(bondHitRadiusForScale(1)).toBeCloseTo(8); // 8 / 1
    expect(bondHitRadiusForScale(8.5)).toBeCloseTo(1); // 8 / 8.5 ≈ 0.94 → min-page floor
    expect(bondHitRadiusForScale(0.5)).toBeCloseTo(9.9); // 8 / 0.5 = 16 → bond-length ceiling
    // Degenerate scales fall back to a sane radius rather than NaN/Infinity.
    expect(Number.isFinite(bondHitRadiusForScale(0))).toBe(true);
    expect(Number.isFinite(bondHitRadiusForScale(Number.NaN))).toBe(true);
  });

  it("keeps the effective on-screen tolerance in a comfortable, flat band", () => {
    // The whole point: effective screen tolerance (radius × scale) stays roughly constant
    // and never collapses, instead of legacy's 2px (0.5×) … 34px (8.5×) swing.
    for (const scale of SUPPORTED_ZOOMS) {
      const screenTolerance = bondHitRadiusForScale(scale) * scale;
      expect(screenTolerance).toBeGreaterThanOrEqual(4);
      expect(screenTolerance).toBeLessThanOrEqual(9);
    }
  });
});
