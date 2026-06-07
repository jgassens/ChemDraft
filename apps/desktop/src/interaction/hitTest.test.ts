import { describe, it, expect } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";

import { createPhase4Document, insertNativeSingleBondMolecule } from "../documentWorkflow";
import { hitTestDocument } from "./hitTest";

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
// CHARACTERIZATION: pin TODAY's behavior before the bond-tolerance refactor. The bond
// assertions here document the *brittleness* (zoom-dependent bond tolerance); they are the
// tests that will legitimately flip in step 2/3 when bond tolerance becomes screen-stable.
// The atom and provenance assertions document behavior we intend to PRESERVE.
// See docs/architecture/pointer-picking-hardening.md.
// ---------------------------------------------------------------------------------------
describe("hitTestDocument zoom-derived tolerance (characterization)", () => {
  // A pointer held a constant 6px off the bond is selectable when zoomed IN but not when
  // zoomed out, because the model bond radius is a fixed 4 page-units (= 4*scale screen px).
  // This is exactly the "lights up but won't click" / "marquee instead of bond" report.
  // STEP 2/3 WILL CHANGE THIS: a constant screen offset should resolve consistently.
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
