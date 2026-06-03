export type LayoutCommandId =
  | "layout.group"
  | "layout.ungroup"
  | "layout.align"
  | "layout.distribute"
  | "layout.rotate"
  | "layout.flip";

export interface LayoutOperationRequest {
  commandId: LayoutCommandId;
  objectIds: readonly string[];
}

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MoleculeLayoutAtom extends LayoutPoint {
  id: string;
}

export interface MoleculeLayoutBond {
  id?: string;
  fromAtomId: string;
  toAtomId: string;
}

export interface BondExtensionPlan {
  sourceAtomId: string;
  terminalAtomId: string;
  neighborAtomIds: readonly string[];
  neighborAtomId?: string;
  targetAtomId?: string;
  newAtomPoint: LayoutPoint;
  direction: LayoutPoint;
  distanceToClick: number;
  lengthMode?: "default" | "custom";
}

export interface BondExtensionPlanningInput {
  atoms: readonly MoleculeLayoutAtom[];
  bonds: readonly MoleculeLayoutBond[];
  clickPoint: LayoutPoint;
  bondLength: number;
  hitRadius: number;
  pageBounds: LayoutBounds;
  objectBounds?: LayoutBounds;
  preferredAtomId?: string;
  maxBondsPerAtom?: number;
  targetBondAngleDegrees?: number;
  collisionRadius?: number;
}

export interface FreeformBondExtensionPlanningInput {
  atoms: readonly MoleculeLayoutAtom[];
  bonds: readonly MoleculeLayoutBond[];
  sourceAtomId: string;
  endPoint: LayoutPoint;
  bondLength: number;
  pageBounds: LayoutBounds;
  maxBondsPerAtom?: number;
  minimumBondLength?: number;
  customLengthBreakawayDistance?: number;
  forceCustomLength?: boolean;
  snapHitRadius?: number;
}

export interface AtomHitPlanningInput {
  atoms: readonly MoleculeLayoutAtom[];
  bonds: readonly MoleculeLayoutBond[];
  point: LayoutPoint;
  hitRadius: number;
  maxBondsPerAtom?: number;
}

export interface AtomHit {
  atomId: string;
  degree: number;
  availableBonds: number;
  distance: number;
}

export interface NearestAtomHit {
  atomId: string;
  distance: number;
}

export interface BondHitPlanningInput {
  atoms: readonly MoleculeLayoutAtom[];
  bonds: readonly MoleculeLayoutBond[];
  point: LayoutPoint;
  hitRadius: number;
}

export interface BondHit {
  bondId?: string;
  fromAtomId: string;
  toAtomId: string;
  distance: number;
  terminalAtomIds: readonly string[];
  nearestTerminalAtomId?: string;
}

export function planBondExtension(input: BondExtensionPlanningInput): BondExtensionPlan | undefined {
  if (input.bondLength <= 0 || input.hitRadius < 0) {
    return undefined;
  }

  const maxBondsPerAtom = input.maxBondsPerAtom ?? 4;
  const source = preferredOrNearestEligibleAtom(input, maxBondsPerAtom);
  if (!source) {
    return undefined;
  }
  const nearObject =
    input.objectBounds !== undefined && pointInsideExpandedBounds(input.clickPoint, input.objectBounds, input.hitRadius);
  if (!nearObject && source.distance > input.hitRadius) {
    return undefined;
  }

  const neighbors = bondedNeighbors(input.atoms, input.bonds, source.atom.id);
  const direction = extensionDirection({
    sourceAtom: source.atom,
    neighbors,
    clickPoint: input.clickPoint,
    atoms: input.atoms,
    bondLength: input.bondLength,
    pageBounds: input.pageBounds,
    targetBondAngleDegrees: input.targetBondAngleDegrees ?? 109.5,
    collisionRadius: input.collisionRadius ?? input.bondLength * 0.45
  });

  return {
    sourceAtomId: source.atom.id,
    terminalAtomId: source.atom.id,
    neighborAtomIds: neighbors.map((neighbor) => neighbor.id),
    neighborAtomId: neighbors[0]?.id,
    newAtomPoint: clampPointToBounds({
      x: source.atom.x + direction.x * input.bondLength,
      y: source.atom.y + direction.y * input.bondLength
    }, input.pageBounds),
    direction,
    distanceToClick: source.distance
  };
}

export function planFreeformBondExtension(input: FreeformBondExtensionPlanningInput): BondExtensionPlan | undefined {
  const configuredMinimumBondLength = input.minimumBondLength ?? 12;
  const minimumBondLength = input.forceCustomLength
    ? Math.min(configuredMinimumBondLength, 1)
    : configuredMinimumBondLength;
  if (input.bondLength <= 0 || minimumBondLength < 0) {
    return undefined;
  }

  const maxBondsPerAtom = input.maxBondsPerAtom ?? 4;
  const degrees = atomDegrees(input.atoms, input.bonds);
  const source = input.atoms.find((atom) => atom.id === input.sourceAtomId);
  if (!source || (degrees.get(source.id) ?? 0) >= maxBondsPerAtom) {
    return undefined;
  }

  const pointerDistance = distance(source, input.endPoint);
  if (pointerDistance < minimumBondLength) {
    return undefined;
  }

  const breakawayDistance = input.customLengthBreakawayDistance ?? input.bondLength * 1.4;
  const lengthMode = input.forceCustomLength || pointerDistance >= breakawayDistance ? "custom" : "default";
  const snapTarget = lengthMode === "custom"
    ? nearestFreeformSnapTarget({
        atoms: input.atoms,
        bonds: input.bonds,
        degrees,
        sourceAtom: source,
        endPoint: input.endPoint,
        snapHitRadius: input.snapHitRadius ?? 18,
        maxBondsPerAtom
      })
    : undefined;
  if (snapTarget) {
    const neighbors = bondedNeighbors(input.atoms, input.bonds, source.id);
    return {
      sourceAtomId: source.id,
      terminalAtomId: source.id,
      targetAtomId: snapTarget.id,
      neighborAtomIds: neighbors.map((neighbor) => neighbor.id),
      neighborAtomId: neighbors[0]?.id,
      newAtomPoint: clampPointToBounds(snapTarget, input.pageBounds),
      direction: normalize({
        x: snapTarget.x - source.x,
        y: snapTarget.y - source.y
      }),
      distanceToClick: pointerDistance,
      lengthMode
    };
  }

  const pointerDirection = normalize({
    x: input.endPoint.x - source.x,
    y: input.endPoint.y - source.y
  });
  const plannedEndPoint = lengthMode === "custom"
    ? input.endPoint
    : {
        x: source.x + pointerDirection.x * input.bondLength,
        y: source.y + pointerDirection.y * input.bondLength
      };
  const newAtomPoint = clampPointToBounds(plannedEndPoint, input.pageBounds);
  const direction = normalize({
    x: newAtomPoint.x - source.x,
    y: newAtomPoint.y - source.y
  });
  const neighbors = bondedNeighbors(input.atoms, input.bonds, source.id);

  return {
    sourceAtomId: source.id,
    terminalAtomId: source.id,
    neighborAtomIds: neighbors.map((neighbor) => neighbor.id),
    neighborAtomId: neighbors[0]?.id,
    newAtomPoint,
    direction,
    distanceToClick: pointerDistance,
    lengthMode
  };
}

function nearestFreeformSnapTarget(input: {
  atoms: readonly MoleculeLayoutAtom[];
  bonds: readonly MoleculeLayoutBond[];
  degrees: ReadonlyMap<string, number>;
  sourceAtom: MoleculeLayoutAtom;
  endPoint: LayoutPoint;
  snapHitRadius: number;
  maxBondsPerAtom: number;
}): MoleculeLayoutAtom | undefined {
  if (input.snapHitRadius < 0) {
    return undefined;
  }

  const sourceNeighborIds = new Set(
    input.bonds.flatMap((bond) => {
      if (bond.fromAtomId === input.sourceAtom.id) {
        return [bond.toAtomId];
      }
      if (bond.toAtomId === input.sourceAtom.id) {
        return [bond.fromAtomId];
      }
      return [];
    })
  );

  return input.atoms
    .filter((atom) => atom.id !== input.sourceAtom.id)
    .filter((atom) => !sourceNeighborIds.has(atom.id))
    .filter((atom) => (input.degrees.get(atom.id) ?? 0) < input.maxBondsPerAtom)
    .map((atom) => ({ atom, distance: distance(atom, input.endPoint) }))
    .filter((hit) => hit.distance <= input.snapHitRadius)
    .sort((left, right) => left.distance - right.distance || left.atom.id.localeCompare(right.atom.id))[0]?.atom;
}

export function findNearestAtomHit(input: AtomHitPlanningInput): AtomHit | undefined {
  if (input.hitRadius < 0) {
    return undefined;
  }

  const maxBondsPerAtom = input.maxBondsPerAtom ?? 4;
  const degrees = atomDegrees(input.atoms, input.bonds);
  return input.atoms
    .map((atom) => ({
      atomId: atom.id,
      degree: degrees.get(atom.id) ?? 0,
      availableBonds: maxBondsPerAtom - (degrees.get(atom.id) ?? 0),
      distance: distance(atom, input.point)
    }))
    .filter((hit) => hit.availableBonds > 0 && hit.distance <= input.hitRadius)
    .sort((left, right) => left.distance - right.distance || left.atomId.localeCompare(right.atomId))[0];
}

export function findNearestAtomAtPoint(input: {
  atoms: readonly MoleculeLayoutAtom[];
  point: LayoutPoint;
  hitRadius: number;
}): NearestAtomHit | undefined {
  if (input.hitRadius < 0) {
    return undefined;
  }

  return input.atoms
    .map((atom) => ({
      atomId: atom.id,
      distance: distance(atom, input.point)
    }))
    .filter((hit) => hit.distance <= input.hitRadius)
    .sort((left, right) => left.distance - right.distance || left.atomId.localeCompare(right.atomId))[0];
}

export function findNearestBondHit(input: BondHitPlanningInput): BondHit | undefined {
  if (input.hitRadius < 0) {
    return undefined;
  }

  const atomById = new Map(input.atoms.map((atom) => [atom.id, atom]));
  const degrees = atomDegrees(input.atoms, input.bonds);

  return input.bonds
    .map((bond): BondHit | undefined => {
      const fromAtom = atomById.get(bond.fromAtomId);
      const toAtom = atomById.get(bond.toAtomId);
      if (!fromAtom || !toAtom) {
        return undefined;
      }

      const terminalAtomIds = [bond.fromAtomId, bond.toAtomId].filter((atomId) => (degrees.get(atomId) ?? 0) <= 1);
      const nearestTerminalAtomId = terminalAtomIds
        .map((atomId) => {
          const atom = atomById.get(atomId);
          return atom ? { atomId, distance: distance(atom, input.point) } : undefined;
        })
        .filter((hit): hit is { atomId: string; distance: number } => hit !== undefined)
        .sort((left, right) => left.distance - right.distance || left.atomId.localeCompare(right.atomId))[0]?.atomId;

      const hit: BondHit = {
        fromAtomId: bond.fromAtomId,
        toAtomId: bond.toAtomId,
        distance: distanceToSegment(input.point, fromAtom, toAtom),
        terminalAtomIds
      };
      if (bond.id !== undefined) {
        hit.bondId = bond.id;
      }
      if (nearestTerminalAtomId !== undefined) {
        hit.nearestTerminalAtomId = nearestTerminalAtomId;
      }

      return hit;
    })
    .filter((hit): hit is BondHit => hit !== undefined && hit.distance <= input.hitRadius)
    .sort((left, right) =>
      left.distance - right.distance ||
      (left.bondId ?? `${left.fromAtomId}.${left.toAtomId}`).localeCompare(
        right.bondId ?? `${right.fromAtomId}.${right.toAtomId}`
      )
    )[0];
}

export function atomDegrees(
  atoms: readonly MoleculeLayoutAtom[],
  bonds: readonly MoleculeLayoutBond[]
): ReadonlyMap<string, number> {
  const degrees = new Map(atoms.map((atom) => [atom.id, 0]));
  bonds.forEach((bond) => {
    degrees.set(bond.fromAtomId, (degrees.get(bond.fromAtomId) ?? 0) + 1);
    degrees.set(bond.toAtomId, (degrees.get(bond.toAtomId) ?? 0) + 1);
  });

  return degrees;
}

function preferredOrNearestEligibleAtom(
  input: BondExtensionPlanningInput,
  maxBondsPerAtom: number
): { atom: MoleculeLayoutAtom; distance: number } | undefined {
  const degrees = atomDegrees(input.atoms, input.bonds);
  if (input.preferredAtomId) {
    const preferred = input.atoms.find((atom) => atom.id === input.preferredAtomId);
    if (!preferred || (degrees.get(preferred.id) ?? 0) >= maxBondsPerAtom) {
      return undefined;
    }
    return { atom: preferred, distance: distance(preferred, input.clickPoint) };
  }

  return input.atoms
    .filter((atom) => (degrees.get(atom.id) ?? 0) < maxBondsPerAtom)
    .map((atom) => ({ atom, distance: distance(atom, input.clickPoint) }))
    .sort((left, right) => left.distance - right.distance || left.atom.id.localeCompare(right.atom.id))[0];
}

function bondedNeighbors(
  atoms: readonly MoleculeLayoutAtom[],
  bonds: readonly MoleculeLayoutBond[],
  atomId: string
): MoleculeLayoutAtom[] {
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  return bonds
    .map((bond) => {
      if (bond.fromAtomId === atomId) {
        return atomById.get(bond.toAtomId);
      }
      if (bond.toAtomId === atomId) {
        return atomById.get(bond.fromAtomId);
      }
      return undefined;
    })
    .filter((atom): atom is MoleculeLayoutAtom => atom !== undefined);
}

interface ExtensionDirectionInput {
  sourceAtom: MoleculeLayoutAtom;
  neighbors: readonly MoleculeLayoutAtom[];
  clickPoint: LayoutPoint;
  atoms: readonly MoleculeLayoutAtom[];
  bondLength: number;
  pageBounds: LayoutBounds;
  targetBondAngleDegrees: number;
  collisionRadius: number;
}

function extensionDirection(input: ExtensionDirectionInput): LayoutPoint {
  const clickDirection = normalizeOrUndefined({
    x: input.clickPoint.x - input.sourceAtom.x,
    y: input.clickPoint.y - input.sourceAtom.y
  });
  const candidates = directionCandidates(input.sourceAtom, input.neighbors, clickDirection, input.targetBondAngleDegrees);
  const scored = candidates
    .map((angle) => ({
      angle,
      direction: directionFromAngle(angle),
      score: scoreDirectionCandidate(angle, input, clickDirection)
    }))
    .sort((left, right) => right.score - left.score || left.angle - right.angle);

  return scored[0]?.direction ?? clickDirection ?? { x: 1, y: 0 };
}

function directionCandidates(
  sourceAtom: MoleculeLayoutAtom,
  neighbors: readonly MoleculeLayoutAtom[],
  clickDirection: LayoutPoint | undefined,
  targetBondAngleDegrees: number
): number[] {
  if (neighbors.length === 0) {
    return [clickDirection ? angleFromDirection(clickDirection) : 0];
  }

  const targetAngle = degreesToRadians(targetBondAngleDegrees);
  const neighborAngles = neighbors.map((neighbor) => angleBetweenPoints(sourceAtom, neighbor));
  const rawCandidates = neighborAngles.flatMap((angle) => [angle + targetAngle, angle - targetAngle]);

  if (neighbors.length > 1) {
    rawCandidates.push(oppositeAverageAngle(neighborAngles));
    rawCandidates.push(...largestGapBisectors(neighborAngles));
  }

  return uniqueAngles(rawCandidates);
}

function scoreDirectionCandidate(
  angle: number,
  input: ExtensionDirectionInput,
  clickDirection: LayoutPoint | undefined
): number {
  const direction = directionFromAngle(angle);
  const neighborAngles = input.neighbors.map((neighbor) => angleBetweenPoints(input.sourceAtom, neighbor));
  const minClearance = neighborAngles.length > 0
    ? Math.min(...neighborAngles.map((neighborAngle) => angularDistance(angle, neighborAngle)))
    : Math.PI;
  const clickAlignment = clickDirection ? dot(direction, clickDirection) : 0;
  const plannedPoint = {
    x: input.sourceAtom.x + direction.x * input.bondLength,
    y: input.sourceAtom.y + direction.y * input.bondLength
  };
  const nearestCollisionDistance = nearestOtherAtomDistance(input.atoms, input.sourceAtom.id, plannedPoint);
  const duplicatePenalty = nearestCollisionDistance < input.bondLength * 0.25 ? 20 : 0;
  const collisionPenalty =
    duplicatePenalty === 0 &&
    nearestCollisionDistance < input.collisionRadius &&
    clickAlignment < 0.9
      ? 10
      : 0;
  const boundsPenalty = pointInsideExpandedBounds(plannedPoint, input.pageBounds, 0) ? 0 : 3;

  return minClearance * 10 + clickAlignment * 4 - duplicatePenalty - collisionPenalty - boundsPenalty;
}

function nearestOtherAtomDistance(
  atoms: readonly MoleculeLayoutAtom[],
  sourceAtomId: string,
  point: LayoutPoint
): number {
  const distances = atoms
    .filter((atom) => atom.id !== sourceAtomId)
    .map((atom) => distance(atom, point));

  return distances.length > 0 ? Math.min(...distances) : Number.POSITIVE_INFINITY;
}

function largestGapBisectors(angles: readonly number[]): number[] {
  if (angles.length < 2) {
    return [];
  }

  const normalized = angles.map(normalizeAngle).sort((left, right) => left - right);
  const gaps = normalized.map((angle, index) => {
    const next = normalized[(index + 1) % normalized.length] ?? angle;
    const gap = index === normalized.length - 1 ? next + Math.PI * 2 - angle : next - angle;
    return { angle, gap };
  });
  const largestGap = Math.max(...gaps.map((gap) => gap.gap));

  return gaps
    .filter((gap) => Math.abs(gap.gap - largestGap) < 0.0001)
    .map((gap) => gap.angle + gap.gap / 2);
}

function oppositeAverageAngle(angles: readonly number[]): number {
  const sum = angles.reduce(
    (current, angle) => ({
      x: current.x + Math.cos(angle),
      y: current.y + Math.sin(angle)
    }),
    { x: 0, y: 0 }
  );

  return angleFromDirection(normalize({ x: -sum.x, y: -sum.y }));
}

function uniqueAngles(angles: readonly number[]): number[] {
  return angles.reduce<number[]>((unique, angle) => {
    const normalized = normalizeAngle(angle);
    if (!unique.some((existing) => angularDistance(existing, normalized) < degreesToRadians(2))) {
      unique.push(normalized);
    }
    return unique;
  }, []);
}

function pointInsideExpandedBounds(point: LayoutPoint, bounds: LayoutBounds, expansion: number): boolean {
  return (
    point.x >= bounds.x - expansion &&
    point.x <= bounds.x + bounds.width + expansion &&
    point.y >= bounds.y - expansion &&
    point.y <= bounds.y + bounds.height + expansion
  );
}

function clampPointToBounds(point: LayoutPoint, bounds: LayoutBounds): LayoutPoint {
  return {
    x: clamp(point.x, bounds.x, bounds.x + bounds.width),
    y: clamp(point.y, bounds.y, bounds.y + bounds.height)
  };
}

function distance(left: LayoutPoint, right: LayoutPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function distanceToSegment(point: LayoutPoint, start: LayoutPoint, end: LayoutPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return distance(point, start);
  }

  const t = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    0,
    1
  );
  return distance(point, {
    x: start.x + dx * t,
    y: start.y + dy * t
  });
}

function normalize(vector: LayoutPoint): LayoutPoint {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.0001) {
    return { x: 1, y: 0 };
  }
  return { x: vector.x / length, y: vector.y / length };
}

function normalizeOrUndefined(vector: LayoutPoint): LayoutPoint | undefined {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.0001) {
    return undefined;
  }
  return { x: vector.x / length, y: vector.y / length };
}

function dot(left: LayoutPoint, right: LayoutPoint): number {
  return left.x * right.x + left.y * right.y;
}

function directionFromAngle(angle: number): LayoutPoint {
  return {
    x: Math.cos(angle),
    y: Math.sin(angle)
  };
}

function angleBetweenPoints(origin: LayoutPoint, point: LayoutPoint): number {
  return Math.atan2(point.y - origin.y, point.x - origin.x);
}

function angleFromDirection(direction: LayoutPoint): number {
  return Math.atan2(direction.y, direction.x);
}

function angularDistance(left: number, right: number): number {
  const difference = Math.abs(normalizeAngle(left) - normalizeAngle(right));
  return Math.min(difference, Math.PI * 2 - difference);
}

function normalizeAngle(angle: number): number {
  const turn = Math.PI * 2;
  return ((angle % turn) + turn) % turn;
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
