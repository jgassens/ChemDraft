/**
 * The single hit-test entry point. One geometric pick, reused by both hover and
 * selection, so the two can never disagree about what is under the pointer.
 *
 * Previously hit-testing was split between a DOM-attribute path (which trusted
 * `data-atom-id`/`data-bond-id` and could highlight a stale/re-stacked SVG node, and
 * reported `distanceToPointer: 0` for DOM-hinted bonds which corrupted the cross-object
 * sort) and a model-space fallback. Now the geometric model hit is always the source of
 * truth and the DOM hint is demoted to a near-tie tiebreaker.
 *
 * These functions are pure (the rendered-element hint is read from an already-resolved
 * `EventTarget`, never from live layout), so they unit-test in the node environment.
 */

import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { nativeMoleculeRingAtPoint } from "@chemdraft/layout-engine";
import {
  findNativeMoleculeDeleteHit,
  findNativeMoleculeTemplateHit,
  nativeBondLengthPx,
  type NativeMoleculeDeleteHit,
  type NativeMoleculeDeleteTarget,
  type NativeMoleculeHitTolerance
} from "../documentWorkflow";

export interface Point {
  x: number;
  y: number;
}

/** A resolved hit on a molecule part (atom or bond), tagged with its owning object. */
export type InteractionTarget = NativeMoleculeDeleteTarget;

// Page-space tolerance (px) within which a DOM hint may win a near-tie. The atom hit
// radius is 8px, so 2px keeps the tiebreak well inside the rendered glyph.
const HOVER_DOM_TIEBREAK_PX = 2;

// Bond pick tolerance expressed in SCREEN pixels, so the on-screen target stays a constant
// size at any zoom. The pointer path converts it to page-space (÷ scale) and clamps it:
//   - max: a fraction of bond length, so a zoomed-out click can't span to the wrong bond;
//   - min: a degenerate guard for extreme zoom-in (within 0.5×–8.5× the screen term wins).
// Atom tolerance is intentionally NOT screen-based this pass (see the hardening plan).
export const BOND_HIT_SCREEN_PX = 8;
const BOND_HIT_MIN_PAGE_PX = 1;
const BOND_HIT_MAX_PAGE_FRACTION = 0.45;

/** Page-space bond hit radius for the current camera scale, clamped as described above. */
export function bondHitRadiusForScale(scale: number): number {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const fromScreen = BOND_HIT_SCREEN_PX / safeScale;
  const ceiling = nativeBondLengthPx * BOND_HIT_MAX_PAGE_FRACTION;
  return Math.min(Math.max(fromScreen, BOND_HIT_MIN_PAGE_PX), ceiling);
}

/** The hit tolerances for the current camera scale (pointer path). */
export function hitToleranceForScale(scale: number): NativeMoleculeHitTolerance {
  return { bondHitRadius: bondHitRadiusForScale(scale) };
}

// The transparent DOM stroke that catches bond pointer events (`.native-bond-hit-target`).
// It exists only to ROUTE the event to the molecule; the resolver decides identity. Per
// invariant #1 it must be a superset of the model tolerance at every supported zoom, so an
// accepted hit never falls through to the page/marquee path. The catcher is non-scaling
// (constant screen px), so its half-width must cover the largest effective on-screen model
// tolerance (≈ 8.5px at 8.5×). 10px half-width clears that with margin. Injected into CSS as
// `--bond-hit-stroke-px` so this stays the single source of truth (no re-typed magic number).
export const BOND_HIT_CATCHER_HALF_WIDTH_PX = 10;
export const BOND_HIT_CATCHER_STROKE_PX = BOND_HIT_CATCHER_HALF_WIDTH_PX * 2;

/** The largest effective on-screen bond tolerance the model can accept across [minZoom, maxZoom]. */
export function maxModelBondScreenTolerancePx(minZoom: number, maxZoom: number): number {
  // bondHitRadiusForScale(s) * s is piecewise; sample the endpoints and the clamp breakpoints.
  const breakpoints = [minZoom, maxZoom, BOND_HIT_SCREEN_PX / nativeBondLengthPx / BOND_HIT_MAX_PAGE_FRACTION, BOND_HIT_SCREEN_PX];
  return Math.max(
    ...breakpoints
      .filter((scale) => scale >= minZoom && scale <= maxZoom)
      .map((scale) => bondHitRadiusForScale(scale) * scale)
  );
}

// Cross-object pick order is geometry-first: the part nearest the pointer wins, and the
// stacking layer only breaks a near-tie. Without this band, a clearly-nearer atom on a
// lower layer was losing to a farther atom on the top-most molecule, so overlapping
// molecules (e.g. a threaded rotaxane) became impossible to target by proximity. The band
// is sub-pixel — large enough to absorb float jitter at near-coincident hits (where the
// visually top-most part is the right pick), small enough that a real proximity difference
// always wins.
const LAYER_TIE_EPSILON_PX = 0.5;

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function pointerHitTargetAttribute(
  eventTarget: EventTarget | null | undefined,
  hitTarget: "atom" | "bond",
  attribute: string
): string | undefined {
  if (typeof Element === "undefined" || !(eventTarget instanceof Element)) {
    return undefined;
  }

  const target = eventTarget.closest(`[data-hit-target="${hitTarget}"]`);
  return target?.getAttribute(attribute) ?? undefined;
}

// The owning molecule of the DOM node under the pointer, read from the nearest
// `data-object-id` ancestor (the molecule wrapper). Atom/bond ids are molecule-local and
// repeat across molecules, so a `data-atom-id="atom_001"` hint is only meaningful inside the
// molecule that actually rendered it. Returns undefined when no owner can be resolved (node
// environment, or a synthetic element with no wrapper), in which case the caller does not
// restrict the hint.
function pointerHitOwnerObjectId(eventTarget: EventTarget | null | undefined): string | undefined {
  if (typeof Element === "undefined" || !(eventTarget instanceof Element)) {
    return undefined;
  }
  return eventTarget.closest("[data-object-id]")?.getAttribute("data-object-id") ?? undefined;
}

export function nativeMoleculeHitFromPointerTarget(
  molecule: MoleculeObject,
  point: Point,
  eventTarget?: EventTarget | null,
  tolerance?: NativeMoleculeHitTolerance
): NativeMoleculeDeleteHit | undefined {
  // The geometric model hit (nearest atom, else nearest bond, each gated by its hit
  // radius) is the source of truth and always reports real distances, so the
  // cross-object sort in nativeMoleculeCanvasHoverTarget stays correct.
  const modelHit = findNativeMoleculeDeleteHit(molecule, point, tolerance);

  // The DOM tells us which glyph the pointer is literally over — a strong intent
  // signal, but only used to break a near-tie in favour of that atom. It must never
  // override a geometrically-closer pick. Bonds rely entirely on the model hit now.
  // The hint is also scoped to its owning molecule: in the page-wide candidate loop this
  // function runs for every molecule with the same event target, and molecule-local ids
  // like `atom_001` repeat, so an unscoped hint could be applied inside the wrong molecule.
  const hintOwnerObjectId = pointerHitOwnerObjectId(eventTarget);
  const hintAppliesToThisMolecule = hintOwnerObjectId === undefined || hintOwnerObjectId === molecule.id;
  const atomId = hintAppliesToThisMolecule
    ? pointerHitTargetAttribute(eventTarget, "atom", "data-atom-id")
    : undefined;
  if (atomId && (modelHit?.kind !== "atom" || modelHit.atomId !== atomId)) {
    const atom = molecule.atoms.find((candidate) => candidate.id === atomId);
    if (atom) {
      const atomDistance = distance(atom, point);
      if (!modelHit || atomDistance <= modelHit.distanceToPointer + HOVER_DOM_TIEBREAK_PX) {
        return { kind: "atom", atomId: atom.id, distanceToPointer: atomDistance, source: "atom-dom-tiebreak" };
      }
    }
  }

  // The geometric pick is the source of truth. Tag it so callers/tests can assert the
  // provenance invariant: a bond hit is only ever produced here (never from the DOM hint).
  return modelHit ? { ...modelHit, source: "model" } : undefined;
}

export function nativeMoleculeCanvasHoverTarget(
  document: ChemDraftDocument,
  point: Point,
  eventTarget?: EventTarget | null,
  tolerance?: NativeMoleculeHitTolerance
): NativeMoleculeDeleteTarget | undefined {
  const page = document.pages[0];
  const candidates = page.objects
    .map((object, layerIndex) => {
      if (object.type !== "molecule") {
        return undefined;
      }

      const hit = nativeMoleculeHitFromPointerTarget(object, point, eventTarget, tolerance);
      return hit ? { object, hit, layerIndex } : undefined;
    })
    .filter((entry): entry is { object: MoleculeObject; hit: NativeMoleculeDeleteHit; layerIndex: number } =>
      entry !== undefined
    )
    .sort((left, right) => {
      const byDistance = left.hit.distanceToPointer - right.hit.distanceToPointer;
      if (Math.abs(byDistance) > LAYER_TIE_EPSILON_PX) {
        // A clearly-nearer part wins regardless of stacking order.
        return byDistance;
      }
      // Near-coincident hits: defer to the top-most layer, then a stable id order.
      return right.layerIndex - left.layerIndex || left.object.id.localeCompare(right.object.id);
    });
  const target = candidates[0];

  return target ? { objectId: target.object.id, ...target.hit } : undefined;
}

/**
 * Template-tool counterpart to {@link nativeMoleculeCanvasHoverTarget}: resolves the molecule
 * part a ring/template tool should act on, bond-preferring along edges (see
 * findNativeMoleculeTemplateHit). It is purely geometric — no DOM atom hint — so it never
 * flips a bond back to an atom, and the highlight it paints equals the click it commits.
 * Cross-object ordering matches the generic hover: nearest part wins, top layer breaks ties.
 */
export function nativeMoleculeTemplateHoverTarget(
  document: ChemDraftDocument,
  point: Point,
  tolerance?: NativeMoleculeHitTolerance
): NativeMoleculeDeleteTarget | undefined {
  const page = document.pages[0];
  const candidates = page.objects
    .map((object, layerIndex) => {
      if (object.type !== "molecule") {
        return undefined;
      }
      const hit = findNativeMoleculeTemplateHit(object, point, tolerance);
      return hit ? { object, hit, layerIndex } : undefined;
    })
    .filter((entry): entry is { object: MoleculeObject; hit: NativeMoleculeDeleteHit; layerIndex: number } =>
      entry !== undefined
    )
    .sort((left, right) => {
      const byDistance = left.hit.distanceToPointer - right.hit.distanceToPointer;
      if (Math.abs(byDistance) > LAYER_TIE_EPSILON_PX) {
        return byDistance;
      }
      return right.layerIndex - left.layerIndex || left.object.id.localeCompare(right.object.id);
    });
  const target = candidates[0];

  return target ? { objectId: target.object.id, ...target.hit } : undefined;
}

// Screen-space slack (px) within which a press may reuse the last template hover target.
// A click is normally preceded by a pointermove to the same spot, so the press point and
// the last hover point are within a pixel or two; this rejects a hover left somewhere else
// (pointer left and re-entered, programmatic move, etc.).
const TEMPLATE_HOVER_REUSE_SCREEN_PX = 6;

/**
 * A captured template-tool hover: the page point we resolved it at, the tool/template
 * identity at that moment, and the resolved atom/bond target. Used by
 * `currentTemplateTargetFromHoverOrHit` so a template commit reuses exactly what the
 * highlight is showing instead of recomputing a (possibly disagreeing) per-object hit.
 */
export type TemplateHoverSample = {
  pagePoint: Point;
  toolCommandId: string;
  templateId: string;
  target: NativeMoleculeDeleteTarget;
};

/** True when the target's owning molecule and its atom/bond still exist in the document. */
export function templateTargetStillExists(
  document: ChemDraftDocument,
  target: NativeMoleculeDeleteTarget
): boolean {
  const molecule = document.pages[0]?.objects.find(
    (object): object is MoleculeObject => object.id === target.objectId && object.type === "molecule"
  );
  if (!molecule) {
    return false;
  }
  return target.kind === "atom"
    ? molecule.atoms.some((atom) => atom.id === target.atomId)
    : molecule.bonds.some((bond) => bond.id === target.bondId);
}

/**
 * Resolve the molecule part a template click should act on. Prefers the last hover target
 * (what the highlight is painting) so click and highlight can never disagree, but only when
 * that hover is not stale: same tool command AND template id, the press is within
 * `TEMPLATE_HOVER_REUSE_SCREEN_PX` of where we hovered, and the target still exists. When
 * the hover is stale or absent it falls back to a fresh resolve via the same bond-preferring
 * template resolver that paints the highlight — never the per-object DOM-tiebreak recompute
 * that can flip a bond into an atom at press time.
 */
export function currentTemplateTargetFromHoverOrHit(
  document: ChemDraftDocument,
  press: { pagePoint: Point; toolCommandId: string; templateId: string },
  hover: TemplateHoverSample | undefined,
  scale: number
): NativeMoleculeDeleteTarget | undefined {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  if (
    hover &&
    hover.toolCommandId === press.toolCommandId &&
    hover.templateId === press.templateId &&
    distance(hover.pagePoint, press.pagePoint) * safeScale <= TEMPLATE_HOVER_REUSE_SCREEN_PX &&
    templateTargetStillExists(document, hover.target)
  ) {
    return hover.target;
  }

  return nativeMoleculeTemplateHoverTarget(document, press.pagePoint, hitToleranceForScale(scale));
}

/**
 * The clean public name for the single hit-test. Returns the molecule part (atom/bond)
 * under the given page-space point, or `undefined` when the pointer is over empty space.
 * Both the hover preview and the selection-on-press path go through this.
 */
export function hitTestDocument(
  document: ChemDraftDocument,
  point: Point,
  eventTarget?: EventTarget | null,
  tolerance?: NativeMoleculeHitTolerance
): InteractionTarget | undefined {
  return nativeMoleculeCanvasHoverTarget(document, point, eventTarget, tolerance);
}

/** A resolved ring interior pick. Carries atom/bond ids so selection re-encoding stays lossless. */
export type SelectionRingHit = {
  objectId: string;
  kind: "ring";
  ringKey: string;
  atomIds: readonly string[];
  bondIds: readonly string[];
};

/** What a selection press resolves to: an atom/bond part, or (inspector-only) a ring interior. */
export type SelectionHit = InteractionTarget | SelectionRingHit;

/**
 * The single selection hit resolver. Precedence is atom → bond → ring, and the ring tier is only
 * consulted when the caller opts in (`includeRings`, wired to "Molecule Inspector open"). Atom/bond
 * reuse the shared hover pick so click and highlight can never disagree; ring identity is resolved
 * geometrically across every molecule (smallest containing interior, then top layer, then a stable
 * object id), so a ring press never depends on which SVG node the browser made `event.target`.
 */
export function resolveSelectionHit(
  document: ChemDraftDocument,
  point: Point,
  options: {
    eventTarget?: EventTarget | null;
    tolerance?: NativeMoleculeHitTolerance;
    includeRings: boolean;
  }
): SelectionHit | undefined {
  const partHit = nativeMoleculeCanvasHoverTarget(document, point, options.eventTarget, options.tolerance);
  if (partHit || !options.includeRings) {
    return partHit;
  }

  const page = document.pages[0];
  const candidates = page.objects
    .flatMap((object, layerIndex) => {
      if (object.type !== "molecule") {
        return [];
      }
      const ring = nativeMoleculeRingAtPoint(object, point);
      return ring ? [{ objectId: object.id, ring, layerIndex }] : [];
    })
    .sort((left, right) =>
      left.ring.area - right.ring.area ||
      right.layerIndex - left.layerIndex ||
      left.objectId.localeCompare(right.objectId)
    );
  const best = candidates[0];
  return best
    ? {
        objectId: best.objectId,
        kind: "ring",
        ringKey: best.ring.ringKey,
        atomIds: best.ring.atomIds,
        bondIds: best.ring.bondIds
      }
    : undefined;
}
