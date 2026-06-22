import { describe, it, expect } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { nativeMoleculeRings } from "@chemdraft/layout-engine";

import {
  createPhase4Document,
  findNativeMoleculeDeleteHit,
  findNativeMoleculeTemplateHit,
  insertNativeSingleBondMolecule,
  insertNativeTemplateMolecule,
  type NativeMoleculeDeleteTarget
} from "../documentWorkflow";
import {
  BOND_HIT_CATCHER_HALF_WIDTH_PX,
  bondHitRadiusForScale,
  currentTemplateTargetFromHoverOrHit,
  hitToleranceForScale,
  hitTestDocument,
  maxModelBondScreenTolerancePx,
  nativeMoleculeTemplateHoverTarget,
  resolveSelectionHit,
  type TemplateHoverSample
} from "./hitTest";

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

// Invariant #1 (step 3): the DOM bond catcher must contain every model-accepted bond hit
// across the whole supported zoom range, so an accepted hit never falls through to the page
// marquee path. The catcher is non-scaling, so its half-width must cover the LARGEST
// effective on-screen model tolerance.
describe("bond DOM catcher is a routing superset of the model (invariant #1)", () => {
  it("catcher half-width covers the max model screen tolerance over 0.5×–8.5×", () => {
    const maxModel = maxModelBondScreenTolerancePx(0.5, 8.5);
    expect(maxModel).toBeLessThanOrEqual(BOND_HIT_CATCHER_HALF_WIDTH_PX);
    // And the max is the value we expect (8.5px at 8.5×), guarding the breakpoint sampling.
    expect(maxModel).toBeCloseTo(8.5);
  });

  it("holds with margin at every supported sample zoom", () => {
    for (const scale of SUPPORTED_ZOOMS) {
      expect(bondHitRadiusForScale(scale) * scale).toBeLessThanOrEqual(BOND_HIT_CATCHER_HALF_WIDTH_PX);
    }
  });
});

// Stage B: the template resolver is bond-preferring ALONG edges (so a ring tool fuses without
// a pixel-perfect mid-bond click) yet keeps a small spiro target at each vertex. The generic
// delete hit stays atom-first — proven by contrast at the same point.
describe("findNativeMoleculeTemplateHit (bond-preferring along edges)", () => {
  it("keeps the atom (spiro) right at the vertex", () => {
    const { molecule } = singleBondMolecule();
    const v = molecule.atoms[0];
    expect(findNativeMoleculeTemplateHit(molecule, { x: v.x, y: v.y }))
      .toMatchObject({ kind: "atom", atomId: v.id });
  });

  it("keeps the atom (spiro) just off the vertex, perpendicular to the bond", () => {
    const { molecule } = singleBondMolecule();
    const { a0, perpendicular } = bondFrame(molecule);
    const point = { x: a0.x + perpendicular.x * 3, y: a0.y + perpendicular.y * 3 };
    expect(findNativeMoleculeTemplateHit(molecule, point)).toMatchObject({ kind: "atom", atomId: a0.id });
  });

  it("prefers the bond along the edge near a vertex, where the delete hit would spiro", () => {
    const { molecule } = singleBondMolecule();
    const { a0, along } = bondFrame(molecule);
    // 8px inboard along the bond: inside the 8px atom radius (so delete picks the atom) but
    // past the ~6.6px vertex cap (so the template fuses).
    const point = { x: a0.x + along.x * 8, y: a0.y + along.y * 8 };
    expect(findNativeMoleculeDeleteHit(molecule, point)).toMatchObject({ kind: "atom", atomId: a0.id });
    expect(findNativeMoleculeTemplateHit(molecule, point)).toMatchObject({ kind: "bond", bondId: "bond_001" });
  });

  it("prefers the bond at mid-edge", () => {
    const { molecule } = singleBondMolecule();
    const { midpoint } = bondFrame(molecule);
    expect(findNativeMoleculeTemplateHit(molecule, midpoint)).toMatchObject({ kind: "bond", bondId: "bond_001" });
  });

  it("returns undefined over empty space", () => {
    const { molecule } = singleBondMolecule();
    expect(findNativeMoleculeTemplateHit(molecule, { x: 24, y: 24 })).toBeUndefined();
  });

  it("nativeMoleculeTemplateHoverTarget tags the owning molecule", () => {
    const { document, molecule } = singleBondMolecule();
    const { midpoint } = bondFrame(molecule);
    expect(nativeMoleculeTemplateHoverTarget(document, midpoint))
      .toMatchObject({ objectId: molecule.id, kind: "bond", bondId: "bond_001" });
  });
});

// Stage A: a template click must commit exactly what the highlight is painting. The fixture
// presses on an ATOM glyph while the recent hover resolved the incident BOND — the classic
// "magical spot": a fresh per-object recompute would spiro onto the atom, but parity must
// reuse the hovered bond and fuse. Staleness (changed tool/template, far press, vanished
// target, no hover) must instead fall back to a fresh resolve (which, on the atom, is the atom).
describe("currentTemplateTargetFromHoverOrHit (template click parity)", () => {
  function bondTarget(molecule: MoleculeObject): NativeMoleculeDeleteTarget {
    const bond = molecule.bonds[0];
    return {
      objectId: molecule.id,
      kind: "bond",
      bondId: bond.id,
      fromAtomId: bond.fromAtomId,
      toAtomId: bond.toAtomId,
      distanceToPointer: 0
    };
  }

  function benzeneHover(molecule: MoleculeObject, pagePoint: Vec): TemplateHoverSample {
    return { pagePoint, toolCommandId: "tool.benzene", templateId: "benzene", target: bondTarget(molecule) };
  }

  const benzenePress = (pagePoint: Vec) => ({
    pagePoint,
    toolCommandId: "tool.benzene",
    templateId: "benzene"
  });

  it("reuses the hovered bond verbatim even when the press lands on an atom glyph", () => {
    const { document, molecule } = singleBondMolecule();
    const atom = molecule.atoms[0];
    const at = { x: atom.x, y: atom.y };

    const resolved = currentTemplateTargetFromHoverOrHit(
      document,
      benzenePress(at),
      benzeneHover(molecule, at),
      1
    );
    expect(resolved).toMatchObject({ kind: "bond", bondId: molecule.bonds[0].id });

    // Sanity: a fresh resolve at the same point (no hover) is the ATOM — proving the parity
    // path changed the outcome, not the geometry.
    expect(currentTemplateTargetFromHoverOrHit(document, benzenePress(at), undefined, 1))
      .toMatchObject({ kind: "atom", atomId: atom.id });
  });

  it("falls back to a fresh resolve when the template id changed", () => {
    const { document, molecule } = singleBondMolecule();
    const atom = molecule.atoms[0];
    const at = { x: atom.x, y: atom.y };
    const staleHover = { ...benzeneHover(molecule, at), templateId: "cyclohexane" };

    expect(currentTemplateTargetFromHoverOrHit(document, benzenePress(at), staleHover, 1))
      .toMatchObject({ kind: "atom", atomId: atom.id });
  });

  it("falls back to a fresh resolve when the tool command changed", () => {
    const { document, molecule } = singleBondMolecule();
    const atom = molecule.atoms[0];
    const at = { x: atom.x, y: atom.y };
    const staleHover = { ...benzeneHover(molecule, at), toolCommandId: "tool.cyclohexane" };

    expect(currentTemplateTargetFromHoverOrHit(document, benzenePress(at), staleHover, 1))
      .toMatchObject({ kind: "atom", atomId: atom.id });
  });

  it("falls back when the press is too far from where we hovered (screen distance)", () => {
    const { document, molecule } = singleBondMolecule();
    const atom = molecule.atoms[0];
    const at = { x: atom.x, y: atom.y };
    // Hover sampled 20 page-units away; at scale 1 that is 20px > the 6px reuse slack.
    const farHover = benzeneHover(molecule, { x: atom.x + 20, y: atom.y });

    expect(currentTemplateTargetFromHoverOrHit(document, benzenePress(at), farHover, 1))
      .toMatchObject({ kind: "atom", atomId: atom.id });
  });

  it("falls back when the hovered target no longer exists in the document", () => {
    const { document, molecule } = singleBondMolecule();
    const atom = molecule.atoms[0];
    const at = { x: atom.x, y: atom.y };
    const goneHover: TemplateHoverSample = {
      ...benzeneHover(molecule, at),
      target: { objectId: molecule.id, kind: "bond", bondId: "bond_999", fromAtomId: "x", toAtomId: "y", distanceToPointer: 0 }
    };

    expect(currentTemplateTargetFromHoverOrHit(document, benzenePress(at), goneHover, 1))
      .toMatchObject({ kind: "atom", atomId: atom.id });
  });

  it("returns undefined (standalone) when nothing is hovered and the press is on empty canvas", () => {
    const { document } = singleBondMolecule();
    expect(currentTemplateTargetFromHoverOrHit(document, benzenePress({ x: 24, y: 24 }), undefined, 1))
      .toBeUndefined();
  });
});

// Step 5: provenance. Every resolved hit is tagged with where it came from, and the key
// invariant (#5) is that a bond hit is ALWAYS model-derived — the DOM never assigns bond
// identity. See docs/architecture/pointer-picking-hardening.md.
describe("hit provenance (invariant #5)", () => {
  it("tags geometric atom and bond hits as model", () => {
    const { document, molecule } = singleBondMolecule();
    const atom = molecule.atoms[0];
    expect(hitTestDocument(document, { x: atom.x, y: atom.y })?.source).toBe("model");

    const { midpoint, perpendicular } = bondFrame(molecule);
    const bondHit = hitTestDocument(document, atScreenOffset(midpoint, perpendicular, 2, 1));
    expect(bondHit?.kind).toBe("bond");
    expect(bondHit?.source).toBe("model");
  });

  it("never yields a bond hit that is not model-derived (swept around the bond)", () => {
    const { document, molecule } = singleBondMolecule();
    const { midpoint, perpendicular, along } = bondFrame(molecule);
    for (const t of [-0.4, -0.1, 0, 0.1, 0.4]) {
      for (const d of [0, 1, 2, 3, 5]) {
        const base = { x: midpoint.x + along.x * t * 12, y: midpoint.y + along.y * t * 12 };
        const hit = hitTestDocument(document, atScreenOffset(base, perpendicular, d, 1));
        if (hit?.kind === "bond") {
          expect(hit.source).toBe("model");
        }
      }
    }
  });
});

describe("resolveSelectionHit", () => {
  function benzene() {
    const document = insertNativeTemplateMolecule(createPhase4Document("ring-hit"), { x: 240, y: 240 }, "benzene");
    const molecule = document.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("expected a benzene fixture");
    }
    const ring = nativeMoleculeRings(molecule)[0];
    if (!ring) {
      throw new Error("expected a benzene ring");
    }
    return { document, molecule, ring };
  }

  it("resolves a ring interior only when rings are included", () => {
    const { document, ring } = benzene();
    expect(resolveSelectionHit(document, ring.center, { includeRings: false })).toBeUndefined();
    const hit = resolveSelectionHit(document, ring.center, { includeRings: true });
    expect(hit?.kind).toBe("ring");
    expect(hit?.kind === "ring" ? hit.ringKey : undefined).toBe(ring.ringKey);
  });

  it("resolves rings geometrically with no DOM event target", () => {
    const { document, ring } = benzene();
    const hit = resolveSelectionHit(document, ring.center, { includeRings: true, eventTarget: null });
    expect(hit?.kind === "ring" ? hit.ringKey : undefined).toBe(ring.ringKey);
  });

  it("lets an atom hit win over the ring interior", () => {
    const { document, molecule } = benzene();
    const atom = molecule.atoms[0];
    const hit = resolveSelectionHit(document, { x: atom.x, y: atom.y }, { includeRings: true });
    expect(hit?.kind).toBe("atom");
  });
});
