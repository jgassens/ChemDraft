/**
 * Where the electron marks a molecule owns (charges, radical dots, lone pairs, radical ions) land
 * when the molecule is redrawn with new atom positions: the Spin 3D live overlay, its flatten, a
 * typed or dragged X/Y rotation of a stored 3D model, and 3D clean-up. One rule for all of them,
 * so the overlay paints each mark exactly where the commit puts it.
 *
 * A mark keeps its 2D offset from its atom. When that spot would land on another atom (one nearer
 * the mark than its own atom, so the mark would read as that atom's), on a bond, or on an atom label's
 * letters, the mark turns about its atom, at the same distance, to the nearest free side. The atoms,
 * bonds and labels of other molecules on the page count as well as the molecule's own. If no side is
 * free it takes the side with the most room, and stays where it was carried when nothing is better.
 * Only positions are decided here; the caller keeps every chemical fact (charge, anchor atom,
 * association) as it was.
 *
 * All points are in the molecule's own frame (its atoms' coordinates). The page-frame wrapper every
 * caller uses is `carryElectronMarksToRedrawnMolecule` (index.ts, beside the frame transforms and the
 * mark renderer it needs).
 */

export interface CarriedMarkAtom {
  id: string;
  x: number;
  y: number;
}

export interface CarriedMarkBond {
  fromAtomId: string;
  toAtomId: string;
}

export interface CarriedElectronMark {
  /** The atom the mark follows. */
  atomId: string;
  /** The mark's center minus its atom's position, both from before the move. */
  offset: { x: number; y: number };
  width: number;
  height: number;
  /**
   * How far the mark's ink reaches from its centre as the page renderer draws it (index.ts
   * `electronMarkInkRadius`: a 2+ is drawn in a larger circle than a single charge). Left out, the
   * mark is given `carriedElectronMarkInkRadius`'s footprint for its size.
   */
  inkRadius?: number;
  /**
   * How deep the mark's ink, with its pixel of air, was drawn into the label of each atom of its own
   * molecule before the move (`carriedMarkLabelDepth`, by atom id); it may sit that deep in that
   * atom's label after the move too, and no deeper. The charge tool leaves a '+' just touching the
   * letters of "H3N", which is no reason to move it; a label redrawn the other way round ("NH3") under
   * the mark is.
   */
  labelDepths?: ReadonlyMap<string, number>;
}

/** An atom label's glyph box, turned `rotation` degrees about its centre (0 when left out). */
export interface CarriedMarkLabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  /** The atom the label belongs to, for the redrawn molecule's own labels (another molecule's have none). */
  atomId?: string;
}

/**
 * What else a carried mark must keep off, in the redrawn molecule's frame: other molecules' atoms
 * (a mark nearer one of them than its own atom reads as that atom's) and bond lines, and the glyph
 * boxes of atom labels (the redrawn molecule's own as it will draw them, and other molecules').
 */
export interface CarriedMarkObstacles {
  atoms?: readonly { x: number; y: number }[];
  segments?: readonly { from: { x: number; y: number }; to: { x: number; y: number } }[];
  labelBoxes?: readonly CarriedMarkLabelBox[];
}

export interface CarriedMarkCenter {
  /** The mark's new center. */
  center: { x: number; y: number };
  /** How far the mark turned about its atom to reach a free side, in radians (0 when it kept its offset). */
  turn: number;
}

/** Pixels of air kept between a mark's ink and a bond line, a label's letters, or another mark's ink. */
const inkClearancePx = 1;
/** Rounding slack for a mark that sits exactly as deep in its own molecule's label as it was drawn. */
const labelDepthSlackPx = 1e-6;
/** Candidate sides searched on each hand, one every π/16 (a full turn in all). */
const sideSteps = 16;
/** A crowded mark moves to a not-free side only when that side is clearly roomier than where it was carried. */
const minimumRoomGain = 0.05;

/**
 * The radius a carried mark keeps clear about its centre: its measured ink (`inkRadius`) when the
 * caller gives it, else a footprint for its size (enough for a single charge's circle, a lone pair's
 * two dots or a radical dot).
 */
export function carriedElectronMarkInkRadius(mark: { width: number; height: number; inkRadius?: number }): number {
  return mark.inkRadius ?? Math.min(mark.width, mark.height) * 0.35;
}

function segmentDistance(point: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared))
    : 0;
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy));
}

/** Distance from a point to a (possibly turned) box: 0 inside it. */
function labelBoxDistance(point: { x: number; y: number }, box: CarriedMarkLabelBox): number {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  let dx = point.x - centerX;
  let dy = point.y - centerY;
  if (box.rotation) {
    // Read the point in the box's own (unturned) frame.
    const radians = -box.rotation * Math.PI / 180;
    const cos = Math.cos(radians), sin = Math.sin(radians);
    [dx, dy] = [dx * cos - dy * sin, dx * sin + dy * cos];
  }
  return Math.hypot(Math.max(0, Math.abs(dx) - box.width / 2), Math.max(0, Math.abs(dy) - box.height / 2));
}

/** How deep a mark's ink (`inkRadius` about `center`), with its pixel of air, reaches into a label box; 0 or less when clear of it. */
export function carriedMarkLabelDepth(center: { x: number; y: number }, inkRadius: number, box: CarriedMarkLabelBox): number {
  return inkRadius + inkClearancePx - labelBoxDistance(center, box);
}

/**
 * Place each carried mark (in the order given) against the moved atoms and bonds, and `obstacles`
 * (everything else on the page, in the same frame). A mark whose atom is missing gets `undefined`.
 * Marks never move onto each other: a mark that turns avoids where the others already sit (or were
 * carried, for those not yet placed).
 */
export function carryElectronMarksWithAtoms(
  atoms: readonly CarriedMarkAtom[],
  bonds: readonly CarriedMarkBond[],
  marks: readonly CarriedElectronMark[],
  obstacles: CarriedMarkObstacles = {}
): Array<CarriedMarkCenter | undefined> {
  const atomById = new Map(atoms.map(atom => [atom.id, atom]));
  const ownSegments = bonds.flatMap(bond => {
    const from = atomById.get(bond.fromAtomId);
    const to = atomById.get(bond.toAtomId);
    return from && to ? [{ from, to }] : [];
  });
  const placed: Array<{ center: { x: number; y: number }; ink: number } | undefined> = marks.map(mark => {
    const atom = atomById.get(mark.atomId);
    return atom ? { center: { x: atom.x + mark.offset.x, y: atom.y + mark.offset.y }, ink: carriedElectronMarkInkRadius(mark) } : undefined;
  });

  const placements: Array<CarriedMarkCenter | undefined> = [];
  marks.forEach((mark, index) => {
    const atom = atomById.get(mark.atomId);
    const carried = placed[index];
    if (!atom || !carried) {
      placements.push(undefined);
      return;
    }
    const placement = placeCarriedMark(atom, mark, carried, placed.filter((other, otherIndex): other is NonNullable<typeof other> =>
      otherIndex !== index && other !== undefined));
    placed[index] = { center: placement.center, ink: carried.ink };
    placements.push(placement);
  });
  return placements;

  function placeCarriedMark(
    atom: CarriedMarkAtom,
    mark: CarriedElectronMark,
    carried: { center: { x: number; y: number }; ink: number },
    others: readonly { center: { x: number; y: number }; ink: number }[]
  ): CarriedMarkCenter {
    const radius = Math.hypot(mark.offset.x, mark.offset.y);
    // A mark drawn on its atom has no side to turn to.
    if (!(radius > 1e-6)) return { center: carried.center, turn: 0 };
    const ink = carried.ink;
    // Every spot tried is `radius` from the atom, so another molecule's atom more than 2 × radius from
    // it, or a line or label box farther than `reach`, leaves every spot clear (positive room) and can
    // never decide a placement: leave it out.
    const reach = radius + ink + inkClearancePx;
    const otherAtoms = [
      ...atoms.filter(other => other.id !== atom.id),
      ...(obstacles.atoms ?? []).filter(other => Math.hypot(other.x - atom.x, other.y - atom.y) <= 2 * radius)
    ];
    const segments = [
      ...ownSegments,
      ...(obstacles.segments ?? []).filter(segment => segmentDistance(atom, segment.from, segment.to) <= reach)
    ];
    const labelBoxes = (obstacles.labelBoxes ?? []).filter(box => labelBoxDistance(atom, box) <= reach);
    // How clearly the spot reads as this atom's (>= 1: its own atom is the nearest), and how much
    // air its ink keeps from every bond line, every label's letters and every other mark.
    const atomRoom = (center: { x: number; y: number }) => {
      let nearest = Infinity;
      for (const other of otherAtoms) nearest = Math.min(nearest, Math.hypot(center.x - other.x, center.y - other.y));
      return nearest / radius;
    };
    const bondRoom = (center: { x: number; y: number }) => {
      let room = Infinity;
      for (const segment of segments) room = Math.min(room, segmentDistance(center, segment.from, segment.to) - ink - inkClearancePx);
      for (const box of labelBoxes) {
        const drawnDepth = box.atomId === undefined ? 0 : Math.max(0, mark.labelDepths?.get(box.atomId) ?? 0) + labelDepthSlackPx;
        room = Math.min(room, drawnDepth - carriedMarkLabelDepth(center, ink, box));
      }
      return room;
    };
    const markRoom = (center: { x: number; y: number }) => {
      let room = Infinity;
      for (const other of others) {
        room = Math.min(room, Math.hypot(center.x - other.center.x, center.y - other.center.y) - ink - other.ink - inkClearancePx);
      }
      return room;
    };
    // Kept where it was carried unless another atom is now nearer than its own, or a bond or a
    // label's letters run under it.
    if (atomRoom(carried.center) >= 1 && bondRoom(carried.center) >= 0) return { center: carried.center, turn: 0 };

    const start = Math.atan2(mark.offset.y, mark.offset.x);
    const spot = (turn: number) => ({ x: atom.x + Math.cos(start + turn) * radius, y: atom.y + Math.sin(start + turn) * radius });
    // One number for "how much room": the tightest of the three, each scaled to the mark's distance
    // (bonds and label letters share one: both are ink the mark must not touch).
    const room = (center: { x: number; y: number }) =>
      Math.min(atomRoom(center) - 1, bondRoom(center) / radius, markRoom(center) / radius);
    let roomiest: { turn: number; center: { x: number; y: number }; room: number } | undefined;
    for (let step = 1; step <= sideSteps; step += 1) {
      const sides = [step, -step].map(signed => {
        const turn = signed * Math.PI / sideSteps;
        const center = spot(turn);
        return { turn, center, room: room(center) };
      });
      // The smaller turn wins; between the two hands, the roomier one (then the positive one).
      sides.sort((left, right) => right.room - left.room);
      const free = sides.find(side => atomRoom(side.center) >= 1 && bondRoom(side.center) >= 0 && markRoom(side.center) >= 0);
      if (free) return { center: free.center, turn: free.turn };
      if (!roomiest || sides[0]!.room > roomiest.room) roomiest = sides[0];
    }
    return roomiest && roomiest.room > room(carried.center) + minimumRoomGain
      ? { center: roomiest.center, turn: roomiest.turn }
      : { center: carried.center, turn: 0 };
  }
}
