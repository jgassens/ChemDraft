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
import {
  findNativeMoleculeDeleteHit,
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
        return { kind: "atom", atomId: atom.id, distanceToPointer: atomDistance };
      }
    }
  }

  return modelHit;
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
