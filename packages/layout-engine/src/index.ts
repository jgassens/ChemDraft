import {
  DefaultNativeDrawingStyle,
  nativeDrawingStyleFromObjectStyle,
  nativeTextStyleFromObjectStyle,
  type BondRef,
  type BracketObject,
  type CrossingOverride,
  type DocumentObject,
  type DocumentPage,
  type ElectronMarkObject,
  type ArrowObject,
  type GraphicPaint,
  type GraphicObject,
  type MoleculeAtom,
  type MoleculeBond as CoreMoleculeBond,
  type MoleculeObject,
  type NativeDrawingStyle,
  type TextObject,
  type TextSpan
} from "@chemdraft/chem-core";
import {
  planNativeArtVisual as planNativeArtVisualFromArtEngine,
  visualEffectPlansForStyle,
  visualEffectsForStyle
} from "@chemdraft/art-engine";
import type {
  NativeArtEffectPlan,
  NativeArtFillPlan,
  NativeArtGradientStopPlan,
  NativeArtGlossGradientPlan,
  NativeArtMarkerPlan,
  NativeArtPaintPlan,
  NativeArtProjectionMatrix,
  NativeArtStrokePlan,
  NativeArtStrokeTerminalPlan,
  NativeArtVisualCoordinateSpace,
  NativeArtVisualPlan
} from "@chemdraft/art-engine";

export type {
  NativeArtEffectPlan,
  NativeArtFillPlan,
  NativeArtGradientStopPlan,
  NativeArtGlossGradientPlan,
  NativeArtMarkerPlan,
  NativeArtPaintPlan,
  NativeArtProjectionMatrix,
  NativeArtStrokePlan,
  NativeArtStrokeTerminalPlan,
  NativeArtVisualCoordinateSpace,
  NativeArtVisualPlan
} from "@chemdraft/art-engine";

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

const defaultTargetBondAngleDegrees = 120;
const defaultTargetBondAngleToleranceDegrees = 6;

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
    bonds: input.bonds,
    bondLength: input.bondLength,
    pageBounds: input.pageBounds,
    maxBondsPerAtom,
    targetBondAngleDegrees: input.targetBondAngleDegrees ?? defaultTargetBondAngleDegrees,
    collisionRadius: input.collisionRadius ?? input.bondLength * 0.45
  });
  const plannedNewAtomPoint = clampPointToBounds({
    x: source.atom.x + direction.x * input.bondLength,
    y: source.atom.y + direction.y * input.bondLength
  }, input.pageBounds);
  const targetAtom = guidedBondTargetAtom({
    atoms: input.atoms,
    bonds: input.bonds,
    sourceAtom: source.atom,
    neighbors,
    plannedPoint: plannedNewAtomPoint,
    bondLength: input.bondLength,
    hitRadius: Math.min(input.hitRadius, input.bondLength * 0.3),
    maxBondsPerAtom,
    targetBondAngleDegrees: input.targetBondAngleDegrees ?? defaultTargetBondAngleDegrees
  });
  const newAtomPoint = targetAtom ? clampPointToBounds(targetAtom, input.pageBounds) : plannedNewAtomPoint;
  const resolvedDirection = targetAtom
    ? normalize({
        x: targetAtom.x - source.atom.x,
        y: targetAtom.y - source.atom.y
      })
    : direction;

  return {
    sourceAtomId: source.atom.id,
    terminalAtomId: source.atom.id,
    neighborAtomIds: neighbors.map((neighbor) => neighbor.id),
    neighborAtomId: neighbors[0]?.id,
    targetAtomId: targetAtom?.id,
    newAtomPoint,
    direction: resolvedDirection,
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

function guidedBondTargetAtom(input: {
  atoms: readonly MoleculeLayoutAtom[];
  bonds: readonly MoleculeLayoutBond[];
  sourceAtom: MoleculeLayoutAtom;
  neighbors: readonly MoleculeLayoutAtom[];
  plannedPoint: LayoutPoint;
  bondLength: number;
  hitRadius: number;
  maxBondsPerAtom: number;
  targetBondAngleDegrees: number;
}): MoleculeLayoutAtom | undefined {
  if (input.neighbors.length === 0 || input.hitRadius < 0) {
    return undefined;
  }

  const degrees = atomDegrees(input.atoms, input.bonds);
  const sourceNeighborIds = new Set(input.neighbors.map((neighbor) => neighbor.id));
  const targetAngle = degreesToRadians(input.targetBondAngleDegrees);
  const angleTolerance = degreesToRadians(defaultTargetBondAngleToleranceDegrees);
  const lengthTolerance = Math.max(input.hitRadius, input.bondLength * 0.12);

  return input.atoms
    .filter((atom) => atom.id !== input.sourceAtom.id)
    .filter((atom) => !sourceNeighborIds.has(atom.id))
    .filter((atom) => (degrees.get(atom.id) ?? 0) < input.maxBondsPerAtom)
    .filter((atom) => !input.bonds.some((bond) =>
      (bond.fromAtomId === input.sourceAtom.id && bond.toAtomId === atom.id) ||
      (bond.fromAtomId === atom.id && bond.toAtomId === input.sourceAtom.id)
    ))
    .map((atom) => ({
      atom,
      plannedDistance: distance(atom, input.plannedPoint),
      bondLengthError: Math.abs(distance(input.sourceAtom, atom) - input.bondLength),
      angleError: nearestTargetAngleError(input.sourceAtom, input.neighbors, atom, targetAngle)
    }))
    .filter((candidate) =>
      candidate.plannedDistance <= lengthTolerance &&
      candidate.bondLengthError <= lengthTolerance &&
      candidate.angleError <= angleTolerance
    )
    .sort((left, right) =>
      left.plannedDistance - right.plannedDistance ||
      left.angleError - right.angleError ||
      left.atom.id.localeCompare(right.atom.id)
    )[0]?.atom;
}

function nearestTargetAngleError(
  sourceAtom: MoleculeLayoutAtom,
  neighbors: readonly MoleculeLayoutAtom[],
  targetAtom: MoleculeLayoutAtom,
  targetAngle: number
): number {
  const targetDirectionAngle = angleBetweenPoints(sourceAtom, targetAtom);
  return Math.min(...neighbors.map((neighbor) =>
    Math.abs(angularDistance(targetDirectionAngle, angleBetweenPoints(sourceAtom, neighbor)) - targetAngle)
  ));
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
  bonds: readonly MoleculeLayoutBond[];
  bondLength: number;
  pageBounds: LayoutBounds;
  maxBondsPerAtom: number;
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
  const guidedTargetAtPlannedPoint = guidedBondTargetAtom({
    atoms: input.atoms,
    bonds: input.bonds,
    sourceAtom: input.sourceAtom,
    neighbors: input.neighbors,
    plannedPoint,
    bondLength: input.bondLength,
    hitRadius: Math.min(input.collisionRadius, input.bondLength * 0.3),
    maxBondsPerAtom: input.maxBondsPerAtom,
    targetBondAngleDegrees: input.targetBondAngleDegrees
  });
  const duplicatePenalty =
    nearestCollisionDistance < input.bondLength * 0.25 && guidedTargetAtPlannedPoint === undefined ? 20 : 0;
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

export type PageSvgAttributeValue = string | number | boolean | undefined;

export interface PageSvgTextFragment {
  kind: "text";
  key: string;
  text: string;
}

export interface PageSvgElementFragment {
  kind: "element";
  key: string;
  tag: string;
  attrs: Record<string, PageSvgAttributeValue>;
  children: PageSvgFragment[];
}

export type PageSvgFragment = PageSvgElementFragment | PageSvgTextFragment;

export interface PageSvgRenderWarning {
  code: string;
  message: string;
  objectId?: string;
}

export interface NativeMoleculeRing {
  ringKey: string;
  atomIds: readonly string[];
  bondIds: readonly string[];
  center: LayoutPoint;
  points: readonly LayoutPoint[];
  area: number;
  pathD: string;
}

export interface ResolvedBondCrossing {
  key: string;
  bonds: [BondRef, BondRef];
  front: BondRef;
  back: BondRef;
  point: LayoutPoint;
  clearancePx: number;
  hasOverride: boolean;
}

export interface PageSvgRenderPlan {
  fragments: PageSvgElementFragment[];
  crossings: ResolvedBondCrossing[];
  warnings: PageSvgRenderWarning[];
}

type DoubleBondSide = NonNullable<CoreMoleculeBond["display"]>["doubleBondSide"];
type BondDisplayStyle = NonNullable<CoreMoleculeBond["display"]>["bondStyle"];

interface PageBondLineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  segment: "primary" | "secondary" | "outer";
  doubleBondSide?: DoubleBondSide;
}

type PageMoleculeBondSegment = PageBondLineSegment & { bond: CoreMoleculeBond; key: string };

interface PageMoleculeBondSegmentGroup {
  bond: CoreMoleculeBond;
  drawingStyle: NativeDrawingStyle;
  segments: PageMoleculeBondSegment[];
}

interface NativeCarbonJunctionPlan {
  atomId: string;
  x: number;
  y: number;
  radius: number;
  fill: string;
}

export interface BondDepthCandidate {
  ref: BondRef;
  objectLayerIndex: number;
  bondIndex: number;
}

export interface BondDepthContext {
  overrides?: readonly CrossingOverride[];
}

interface PageNativeBondCandidate extends BondDepthCandidate {
  object: MoleculeObject;
  bond: CoreMoleculeBond;
  fromAtom: MoleculeAtom;
  toAtom: MoleculeAtom;
  start: LayoutPoint;
  end: LayoutPoint;
  localStart: LayoutPoint;
  localEnd: LayoutPoint;
  drawingStyle: NativeDrawingStyle;
}

interface InternalResolvedBondCrossing extends ResolvedBondCrossing {
  backLocalPoint: LayoutPoint;
  frontCandidate: PageNativeBondCandidate;
  backCandidate: PageNativeBondCandidate;
}

interface BondCrossingGap {
  point: LayoutPoint;
  clearancePx: number;
}

/** Shortest secondary line a double bond may draw before the inset stops shrinking it. Exported
 *  because the Spin-3D overlay applies the same inset and had its own copy of the number. */
export const doubleBondMinimumVisibleSegmentPx = 13;
const crossingIntersectionEpsilon = 0.000001;
const crossingEndpointEpsilon = 0.0001;
const crossingHitRadiusPx = 10;
const minimumCrossingClearancePx = 7;
const maximumCrossingClearancePx = 30;
const minimumCrossingAngleSin = 0.28;

export function bondRefKey(ref: BondRef): string {
  return `${ref.objectId}::${ref.bondId}`;
}

export function crossingPairKey(bonds: [BondRef, BondRef]): string {
  return canonicalBondRefs(bonds).map(bondRefKey).join("|");
}

export function compareBondDepth(
  left: BondDepthCandidate,
  right: BondDepthCandidate,
  context: BondDepthContext = {}
): number {
  const crossingKey = crossingPairKey([left.ref, right.ref]);
  const override = context.overrides?.find((candidate) => crossingPairKey(candidate.bonds) === crossingKey);
  if (override) {
    if (sameBondRef(override.front, left.ref)) {
      return 1;
    }
    if (sameBondRef(override.front, right.ref)) {
      return -1;
    }
  }

  if (left.objectLayerIndex !== right.objectLayerIndex) {
    return left.objectLayerIndex - right.objectLayerIndex;
  }

  if (left.ref.objectId === right.ref.objectId && left.bondIndex !== right.bondIndex) {
    return left.bondIndex - right.bondIndex;
  }

  return bondRefKey(left.ref).localeCompare(bondRefKey(right.ref));
}

function resolvePageBondCrossings(
  page: DocumentPage,
  warnings: PageSvgRenderWarning[]
): InternalResolvedBondCrossing[] {
  const candidates = page.objects.flatMap((object, objectLayerIndex) =>
    object.type === "molecule" && isNativeMoleculeGraph(object)
      ? nativeBondCandidates(object, objectLayerIndex)
      : []
  );
  const resolved: InternalResolvedBondCrossing[] = [];
  const overrides = page.crossings;

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      if (!left || !right || shouldSkipCrossingCandidatePair(left, right)) {
        continue;
      }
      const intersection = segmentIntersection(left.start, left.end, right.start, right.end);
      if (!intersection) {
        continue;
      }
      const depth = compareBondDepth(left, right, { overrides });
      const frontCandidate = depth >= 0 ? left : right;
      const backCandidate = depth >= 0 ? right : left;
      const key = crossingPairKey([left.ref, right.ref]);
      const override = overrides.find((candidate) => crossingPairKey(candidate.bonds) === key);
      const clearancePx = crossingClearancePx(frontCandidate, backCandidate, intersection.angleSin, override);
      resolved.push({
        key,
        bonds: canonicalBondRefs([left.ref, right.ref]),
        front: frontCandidate.ref,
        back: backCandidate.ref,
        point: intersection.point,
        backLocalPoint: inverseTransformPointForObject(backCandidate.object, intersection.point),
        clearancePx,
        hasOverride: override !== undefined,
        frontCandidate,
        backCandidate
      });
    }
  }

  warnForDepthCycles(resolved, warnings);
  return resolved.sort((left, right) => left.key.localeCompare(right.key));
}

function nativeBondCandidates(object: MoleculeObject, objectLayerIndex: number): PageNativeBondCandidate[] {
  const atomById = new Map(object.atoms.map((atom) => [atom.id, atom]));
  const drawingStyle = nativeDrawingStyleFromObjectStyle(object.style);
  return object.bonds.flatMap((bond, bondIndex) => {
    const fromAtom = atomById.get(bond.fromAtomId);
    const toAtom = atomById.get(bond.toAtomId);
    if (!fromAtom || !toAtom) {
      return [];
    }
    const localStart = { x: fromAtom.x, y: fromAtom.y };
    const localEnd = { x: toAtom.x, y: toAtom.y };
    const start = transformPointForObject(object, localStart);
    const end = transformPointForObject(object, localEnd);
    return [{
      ref: { objectId: object.id, bondId: bond.id },
      objectLayerIndex,
      bondIndex,
      object,
      bond,
      fromAtom,
      toAtom,
      start,
      end,
      localStart,
      localEnd,
      drawingStyle
    }];
  });
}

function shouldSkipCrossingCandidatePair(left: PageNativeBondCandidate, right: PageNativeBondCandidate): boolean {
  if (left.ref.objectId === right.ref.objectId) {
    const sharedAtom = left.bond.fromAtomId === right.bond.fromAtomId ||
      left.bond.fromAtomId === right.bond.toAtomId ||
      left.bond.toAtomId === right.bond.fromAtomId ||
      left.bond.toAtomId === right.bond.toAtomId;
    if (sharedAtom) {
      return true;
    }
  }

  if (!finiteSegment(left.start, left.end) || !finiteSegment(right.start, right.end)) {
    return true;
  }

  return !segmentBoxesOverlap(left.start, left.end, right.start, right.end);
}

function finiteSegment(start: LayoutPoint, end: LayoutPoint): boolean {
  return Number.isFinite(start.x) &&
    Number.isFinite(start.y) &&
    Number.isFinite(end.x) &&
    Number.isFinite(end.y) &&
    distance(start, end) > crossingIntersectionEpsilon;
}

function segmentBoxesOverlap(leftStart: LayoutPoint, leftEnd: LayoutPoint, rightStart: LayoutPoint, rightEnd: LayoutPoint): boolean {
  const leftMinX = Math.min(leftStart.x, leftEnd.x);
  const leftMaxX = Math.max(leftStart.x, leftEnd.x);
  const leftMinY = Math.min(leftStart.y, leftEnd.y);
  const leftMaxY = Math.max(leftStart.y, leftEnd.y);
  const rightMinX = Math.min(rightStart.x, rightEnd.x);
  const rightMaxX = Math.max(rightStart.x, rightEnd.x);
  const rightMinY = Math.min(rightStart.y, rightEnd.y);
  const rightMaxY = Math.max(rightStart.y, rightEnd.y);

  return leftMinX <= rightMaxX &&
    leftMaxX >= rightMinX &&
    leftMinY <= rightMaxY &&
    leftMaxY >= rightMinY;
}

function segmentIntersection(
  leftStart: LayoutPoint,
  leftEnd: LayoutPoint,
  rightStart: LayoutPoint,
  rightEnd: LayoutPoint
): { point: LayoutPoint; angleSin: number } | undefined {
  const leftVector = { x: leftEnd.x - leftStart.x, y: leftEnd.y - leftStart.y };
  const rightVector = { x: rightEnd.x - rightStart.x, y: rightEnd.y - rightStart.y };
  const denominator = cross(leftVector, rightVector);
  if (Math.abs(denominator) <= crossingIntersectionEpsilon) {
    return undefined;
  }

  const originDelta = { x: rightStart.x - leftStart.x, y: rightStart.y - leftStart.y };
  const leftT = cross(originDelta, rightVector) / denominator;
  const rightT = cross(originDelta, leftVector) / denominator;
  if (
    leftT <= crossingEndpointEpsilon ||
    leftT >= 1 - crossingEndpointEpsilon ||
    rightT <= crossingEndpointEpsilon ||
    rightT >= 1 - crossingEndpointEpsilon
  ) {
    return undefined;
  }

  const point = {
    x: leftStart.x + leftVector.x * leftT,
    y: leftStart.y + leftVector.y * leftT
  };
  const angleSin = Math.abs(denominator) / (Math.hypot(leftVector.x, leftVector.y) * Math.hypot(rightVector.x, rightVector.y));
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(angleSin)) {
    return undefined;
  }
  return { point, angleSin };
}

function crossingClearancePx(
  front: PageNativeBondCandidate,
  back: PageNativeBondCandidate,
  angleSin: number,
  override: CrossingOverride | undefined
): number {
  if (override?.clearancePx !== undefined) {
    return clamp(override.clearancePx, minimumCrossingClearancePx, maximumCrossingClearancePx);
  }

  const frontFootprint = nativeBondFootprintPx(front.bond, front.drawingStyle);
  const backStroke = nativeBondStrokeWidth(back.bond, back.drawingStyle);
  const angleFactor = Math.max(minimumCrossingAngleSin, Math.abs(angleSin));
  return clamp(
    (frontFootprint + backStroke + back.drawingStyle.bondOverlapClearancePx * 0.75) / angleFactor,
    minimumCrossingClearancePx,
    maximumCrossingClearancePx
  );
}

function nativeBondFootprintPx(bond: CoreMoleculeBond, drawingStyle: NativeDrawingStyle): number {
  const bondStyle = nativeBondDisplayStyle(bond);
  if (bondStyle === "wedge" || bondStyle === "hashed") {
    return nativeWedgeWidth(drawingStyle);
  }
  const gap = nativeMultipleBondGapPx(drawingStyle);
  if (bond.order === "triple") {
    return gap * 2 + nativeBondStrokeWidth(bond, drawingStyle);
  }
  if (bond.order === "double") {
    return gap + nativeBondStrokeWidth(bond, drawingStyle);
  }
  return nativeBondStrokeWidth(bond, drawingStyle);
}

function warnForDepthCycles(
  crossings: readonly InternalResolvedBondCrossing[],
  warnings: PageSvgRenderWarning[]
): void {
  const edges = crossings.map((crossing) => ({
    from: bondRefKey(crossing.front),
    to: bondRefKey(crossing.back)
  }));

  for (const first of edges) {
    for (const second of edges) {
      if (second.from !== first.to) {
        continue;
      }
      const closing = edges.find((candidate) => candidate.from === second.to && candidate.to === first.from);
      if (closing) {
        warnings.push({
          code: "crossing.depth_cycle",
          message: "The page contains a cyclic over/under relationship that may not be realizable as a 3D weave."
        });
        return;
      }
    }
  }
}

function crossingHitTargetFragment(crossing: ResolvedBondCrossing): PageSvgElementFragment {
  return elementFragment("circle", `crossing-hit-${crossing.key}`, {
    class: "native-crossing-hit-target",
    "data-hit-target": "crossing",
    "data-crossing-key": crossing.key,
    "data-crossing-front-object-id": crossing.front.objectId,
    "data-crossing-front-bond-id": crossing.front.bondId,
    "data-crossing-back-object-id": crossing.back.objectId,
    "data-crossing-back-bond-id": crossing.back.bondId,
    "data-object-id": crossing.front.objectId,
    cx: crossing.point.x,
    cy: crossing.point.y,
    r: crossingHitRadiusPx,
    fill: "transparent",
    stroke: "transparent"
  });
}

function canonicalBondRefs(bonds: [BondRef, BondRef]): [BondRef, BondRef] {
  const [left, right] = bonds;
  return bondRefKey(left).localeCompare(bondRefKey(right)) <= 0 ? [left, right] : [right, left];
}

export function sameBondRef(left: BondRef, right: BondRef): boolean {
  return left.objectId === right.objectId && left.bondId === right.bondId;
}

function cross(left: LayoutPoint, right: LayoutPoint): number {
  return left.x * right.y - left.y * right.x;
}

export function planPageSvgRender(page: DocumentPage): PageSvgRenderPlan {
  const warnings: PageSvgRenderWarning[] = [];
  const crossings = resolvePageBondCrossings(page, warnings);
  const gapsByBondKey = crossings.reduce<Map<string, BondCrossingGap[]>>((byBond, crossing) => {
    const key = bondRefKey(crossing.back);
    const gaps = byBond.get(key) ?? [];
    gaps.push({ point: crossing.backLocalPoint, clearancePx: crossing.clearancePx });
    byBond.set(key, gaps);
    return byBond;
  }, new Map());
  const crossingHitTargets = crossings.map((crossing) => crossingHitTargetFragment(crossing));

  return {
    fragments: page.objects.flatMap((object, layerIndex) => {
      const fragment = planDocumentObjectSvg(object, layerIndex, warnings, gapsByBondKey);
      return fragment ? flattenDocumentObjectSvg(fragment) : [];
    }).concat(crossingHitTargets),
    crossings,
    warnings
  };
}

function flattenDocumentObjectSvg(fragment: PageSvgElementFragment): PageSvgElementFragment[] {
  if (fragment.tag !== "g" || typeof fragment.attrs["data-object-id"] !== "string") {
    return [fragment];
  }

  if (fragment.children.some((child) => child.kind === "text")) {
    return [fragment];
  }

  return fragment.children.map((child) => inheritObjectSvgAttributes(fragment, child));
}

function inheritObjectSvgAttributes(
  parent: PageSvgElementFragment,
  child: PageSvgFragment
): PageSvgElementFragment {
  if (child.kind === "text") {
    throw new Error("Cannot flatten a text node out of an object SVG wrapper.");
  }

  const parentTransform = stringAttribute(parent.attrs.transform);
  const childTransform = stringAttribute(child.attrs.transform);
  const attrs = {
    ...parent.attrs,
    ...child.attrs,
    transform: mergedTransform(parentTransform, childTransform)
  };

  return {
    ...child,
    attrs
  };
}

function stringAttribute(value: PageSvgAttributeValue): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mergedTransform(parentTransform: string | undefined, childTransform: string | undefined): string | undefined {
  return [parentTransform, childTransform].filter((value): value is string => value !== undefined).join(" ") || undefined;
}

function planDocumentObjectSvg(
  object: DocumentObject,
  layerIndex: number,
  warnings: PageSvgRenderWarning[],
  gapsByBondKey: ReadonlyMap<string, readonly BondCrossingGap[]>
): PageSvgElementFragment | undefined {
  switch (object.type) {
    case "molecule":
      return planMoleculeObjectSvg(object, layerIndex, gapsByBondKey);
    case "text":
      return planTextObjectSvg(object, layerIndex);
    case "plus":
      return centeredTextFragment(object, "+", 24, 700, layerIndex);
    case "electron-mark":
      return object.markKind === "charge"
        ? chargeMarkFragment(object, layerIndex)
        : fallbackObjectFragmentWithWarning(object, warnings, layerIndex);
    case "reaction-arrow":
      return reactionArrowFragment(object, layerIndex);
    case "bracket":
      return bracketObjectFragment(object, layerIndex);
    case "graphic":
      return graphicObjectFragment(object, warnings, layerIndex);
    case "group":
      return undefined;
    default:
      return fallbackObjectFragmentWithWarning(object, warnings, layerIndex);
  }
}

function planMoleculeObjectSvg(
  object: MoleculeObject,
  layerIndex: number,
  gapsByBondKey: ReadonlyMap<string, readonly BondCrossingGap[]>
): PageSvgElementFragment {
  if (isNativeMoleculeGraph(object)) {
    return planNativeMoleculeGraphSvg(object, layerIndex, gapsByBondKey);
  }

  const label = object.structureFormat === "smiles" ? object.structure : `${object.structureFormat} object`;
  const formula = object.chemistry?.warnings.length
    ? "warnings"
    : object.chemistry ? "validated" : "adapter-backed";
  return elementFragment("g", `object-${object.id}`, objectAttributes(object, layerIndex, {
    transform: rotationTransform(object)
  }), [
    elementFragment("rect", `fallback-molecule-box-${object.id}`, {
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
      rx: 4,
      fill: "#ffffff",
      stroke: "#2f3b42",
      "stroke-width": 1.5
    }),
    elementFragment("text", `fallback-molecule-label-${object.id}`, {
      x: object.x + 12,
      y: object.y + 34,
      "font-family": "Arial, sans-serif",
      "font-size": 22,
      fill: "#172026"
    }, [textFragment(`fallback-molecule-label-text-${object.id}`, label)]),
    elementFragment("text", `fallback-molecule-formula-${object.id}`, {
      x: object.x + 12,
      y: object.y + object.height - 16,
      "font-family": "Arial, sans-serif",
      "font-size": 11,
      fill: "#52616b"
    }, [textFragment(`fallback-molecule-formula-text-${object.id}`, formula)]),
    ...(object.chemistry ? [
      elementFragment("text", `fallback-molecule-summary-${object.id}`, {
        x: object.x + 12,
        y: object.y + object.height - 32,
        "font-family": "Arial, sans-serif",
        "font-size": 9,
        fill: "#52616b"
      }, [textFragment(`fallback-molecule-summary-text-${object.id}`, formatChemistrySummary(object.chemistry))])
    ] : [])
  ]);
}

function planNativeMoleculeGraphSvg(
  object: MoleculeObject,
  layerIndex: number,
  gapsByBondKey: ReadonlyMap<string, readonly BondCrossingGap[]>
): PageSvgElementFragment {
  const atomById = new Map(object.atoms.map((atom) => [atom.id, atom]));
  const drawingStyle = nativeDrawingStyleFromObjectStyle(object.style);
  const moleculeStrokeOpacity = nativeMoleculeStrokeOpacity(object);
  const atomLabels = planMoleculeAtomLabels(object);
  const labelPlanByAtomId = new Map(atomLabels.map((plan) => [plan.atom.id, plan]));
  // Ring double bonds default their inner line to the ring interior. Computed once per molecule.
  const ringInteriorSides = ringInteriorDoubleBondSides(object);
  const bondSegmentGroups: PageMoleculeBondSegmentGroup[] = object.bonds.flatMap((bond) => {
    const fromAtom = atomById.get(bond.fromAtomId);
    const toAtom = atomById.get(bond.toAtomId);
    if (!fromAtom || !toAtom) {
      return [];
    }
    const fromLabelPlan = labelPlanByAtomId.get(fromAtom.id);
    const toLabelPlan = labelPlanByAtomId.get(toAtom.id);
    const bondDrawingStyle = nativeMoleculeBondDrawingStyle(object, bond.id, drawingStyle);

    const segments = bondLineSegments(
      fromAtom,
      toAtom,
      object,
      bond,
      bondDrawingStyle,
      fromLabelPlan?.label,
      toLabelPlan?.label,
      fromLabelPlan?.drawingStyle,
      toLabelPlan?.drawingStyle,
      ringInteriorSides.get(bond.id)
    ).map((segment, segmentIndex) => ({
      ...segment,
      bond,
      key: `${bond.id}-${segmentIndex}`
    }));

    return [{ bond, drawingStyle: bondDrawingStyle, segments }];
  });
  const primitive = moleculeDrawingPrimitive(object) === "single-bond"
    ? "single-bond"
    : "connected-carbon-chain";
  const carbonJunctionPlans = nativeCarbonJunctionPlans(
    object,
    new Set(atomLabels.map((plan) => plan.atom.id)),
    drawingStyle
  );
  const sketchBasePathD = visualEffectsForStyle(object.style).some((effect) => effect.kind === "sketch")
    ? moleculeEffectSketchBasePathD(object, bondSegmentGroups, gapsByBondKey)
    : undefined;
  const effects = visualEffectPlansForStyle({
    objectId: object.id,
    style: object.style,
    sketchBasePathD,
    sketchStrokeWidthPx: drawingStyle.bondStrokeWidthPx
  });
  const effectFilterId = `molecule-effects-${object.id}`;
  const fillUnderlayFragments = moleculeFillUnderlayFragments(object, drawingStyle);
  const bondLayerFragments = bondSegmentGroups.map(({ bond, drawingStyle: bondDrawingStyle, segments }) =>
    elementFragment("g", `bond-layer-${object.id}-${bond.id}`, {
      "data-bond-layer-id": bond.id
    }, [
      ...segments.map((segment) =>
        elementFragment("line", `bond-hit-${object.id}-${segment.key}`, {
          class: "native-bond-hit-target",
          "data-hit-target": "bond",
          "data-bond-id": segment.bond.id,
          x1: segment.x1,
          y1: segment.y1,
          x2: segment.x2,
          y2: segment.y2
        })
      ),
      ...segments.flatMap((segment) =>
        nativeBondHoverDecoratorFragments(
          segment,
          gapsByBondKey.get(bondRefKey({ objectId: object.id, bondId: segment.bond.id })) ?? []
        )
      ),
      ...segments.flatMap((segment) =>
        nativeBondSegmentFragments(
          object,
          segment,
          bondDrawingStyle,
          moleculeStrokeOpacity,
          gapsByBondKey.get(bondRefKey({ objectId: object.id, bondId: segment.bond.id })) ?? []
        )
      )
    ])
  );
  // Per-labeled-atom depth weight, derived from the incident bonds' baked weights (the SAME
  // derivation the live overlay runs), so labels depth-cue in lock-step with the bonds and the
  // flatten-on-release commit changes nothing visually.
  const incidentBondWeights = new Map<string, (number | undefined)[]>();
  for (const bond of object.bonds) {
    for (const atomId of [bond.fromAtomId, bond.toAtomId]) {
      const list = incidentBondWeights.get(atomId) ?? [];
      list.push(bond.display?.depthWeight);
      incidentBondWeights.set(atomId, list);
    }
  }
  const labelDepthWeightByAtomId = new Map<string, number | undefined>(
    atomLabels.map((plan) => [plan.atom.id, averageDefinedDepthWeights(incidentBondWeights.get(plan.atom.id) ?? [])])
  );
  // Paint labels far → near so a nearer heteroatom's glyph sits over a farther one where the 3D
  // projection stacks them (the "ONH" pile-ups on a symmetric cage). Halos share the order.
  const orderedAtomLabels = [...atomLabels].sort(
    (a, b) =>
      (labelDepthWeightByAtomId.get(a.atom.id) ?? 0.5) - (labelDepthWeightByAtomId.get(b.atom.id) ?? 0.5)
  );
  // The label's knockout is a glyph-hugging halo — a paint-order stroke of the label itself
  // (stroke painted UNDER the fill) — instead of an opaque bounding box, so it clears the bonds
  // right around the letters without an oversized rectangle, and because labels paint far → near
  // a nearer heteroatom's halo knocks a clean gap out of a farther label it overlaps. Per-atom
  // Inspector styling feeds the SAME halo: the per-atom "background color" IS the halo stroke
  // (default paper #ffffff; "transparent" opts out), and the halo width tracks the per-atom font
  // size via the plan's resolved drawing style, so styled labels keep their depth cues.
  const labelFragments = orderedAtomLabels.map((plan) => {
    const depthWeight = labelDepthWeightByAtomId.get(plan.atom.id);
    const scale = depthCuedLabelScale(depthWeight);
    const baseTransform = `translate(${formatNumber(plan.anchor.x)} ${formatNumber(plan.anchor.y)})`;
    return elementFragment("g", `label-${object.id}-${plan.atom.id}`, {
      class: "native-atom-label",
      "data-atom-label": plan.label,
      transform: scale === 1 ? baseTransform : `${baseTransform} scale(${formatNumber(scale)})`,
      fill: depthCuedLabelColor(plan.color, depthWeight),
      "fill-opacity": moleculeStrokeOpacity === 1 ? undefined : moleculeStrokeOpacity,
      stroke: plan.backgroundVisible ? plan.backgroundColor : undefined,
      "stroke-width": plan.backgroundVisible ? formatNumber(atomLabelHaloWidthPx(plan.drawingStyle)) : undefined,
      "stroke-linejoin": plan.backgroundVisible ? "round" : undefined,
      "stroke-linecap": plan.backgroundVisible ? "round" : undefined,
      "paint-order": plan.backgroundVisible ? "stroke" : undefined,
      "font-family": plan.fontFamily,
      "font-size": plan.fontSizePx,
      "font-weight": plan.fontWeight,
      "font-style": plan.fontStyle
    }, plan.layout.runs.map((run, index) =>
      elementFragment("text", `label-run-${object.id}-${plan.atom.id}-${index}`, {
        class: "native-atom-label-run",
        "data-atom-label-run": run.script === "superscript" ? "charge" : run.script,
        x: run.x,
        y: run.y,
        "dominant-baseline": "central",
        "text-anchor": run.textAnchor,
        "font-size": atomLabelRunFontSize(run.script, plan.drawingStyle)
      }, [textFragment(`label-run-text-${object.id}-${plan.atom.id}-${index}`, run.text)])
    ));
  });
  const indicatorFragments = moleculeStructureIndicatorFragments(object, drawingStyle, moleculeStrokeOpacity);
  const atomHitFragments = object.atoms.map((atom) =>
    elementFragment("circle", `atom-hit-${object.id}-${atom.id}`, {
      class: "native-atom-hit-target",
      "data-hit-target": "atom",
      "data-atom-id": atom.id,
      cx: atom.x,
      cy: atom.y,
      r: 8
    })
  );
  const effectSource = moleculeEffectSourceFragment(
    object,
    effects,
    effectFilterId,
    bondSegmentGroups,
    carbonJunctionPlans,
    drawingStyle,
    gapsByBondKey
  );

  return elementFragment("g", `object-${object.id}`, objectAttributes(object, layerIndex, {
    "data-chem-primitive": primitive,
    "data-structure": object.structure,
    "data-atom-count": object.atoms.length,
    "data-bond-count": object.bonds.length,
    "data-style-preset-id": drawingStyle.stylePresetId,
    opacity: nativeMoleculeObjectOpacity(object) === 1 ? undefined : nativeMoleculeObjectOpacity(object),
    transform: rotationTransform(object)
  }), [
    ...svgEffectDefinitionFragmentsForEffects(
      effects,
      effectFilterId,
      svgEffectFilterRegionForBounds(effects, object)
    ),
    ...fillUnderlayFragments,
    ...(effectSource ? [effectSource] : []),
    ...moleculeRingHitTargetFragments(object),
    ...bondLayerFragments,
    ...nativeCarbonJunctionFragments(
      object.id,
      carbonJunctionPlans,
      moleculeStrokeOpacity
    ),
    ...labelFragments,
    ...indicatorFragments,
    ...svgSketchEffectFragmentsForEffects(effects, object.id, {
      className: "native-molecule-sketch",
      dataAttribute: "data-molecule-effect",
      keyPrefix: "molecule-sketch"
    }),
    ...atomHitFragments
  ]);
}

function moleculeFillUnderlayFragments(
  object: MoleculeObject,
  _drawingStyle: NativeDrawingStyle
): PageSvgFragment[] {
  const rings = nativeMoleculeRings(object);
  if (rings.length === 0) {
    return [];
  }

  return rings.flatMap((ring) => {
    const paint = moleculeRingFillPaint(object, ring.ringKey);
    if (paint.kind === "none") {
      return [];
    }

    const opacity = moleculeRingFillOpacity(object, ring.ringKey, paint);
    const effects = visualEffectPlansForStyle({
      objectId: `${object.id}-${stableSvgIdPart(ring.ringKey)}`,
      style: moleculeRingStyle(object, ring.ringKey),
      sketchBasePathD: ring.pathD,
      sketchStrokeWidthPx: 1.5
    });
    const effectFilterId = `molecule-ring-effects-${object.id}-${stableSvgIdPart(ring.ringKey)}`;
    const paintId = `molecule-fill-${object.id}-${stableSvgIdPart(ring.ringKey)}`;
    const filter = effects.some((effect) => effect.kind === "shadow" || effect.kind === "glow")
      ? `url(#${effectFilterId})`
      : undefined;

    return [
      ...moleculePaintDefinitionFragments(paint, paintId, object),
      ...svgEffectDefinitionFragmentsForEffects(
        effects,
        effectFilterId,
        svgEffectFilterRegionForBounds(effects, object)
      ),
      elementFragment("path", `molecule-fill-underlay-${object.id}-${ring.ringKey}`, {
        class: "native-molecule-fill-underlay",
        "data-molecule-fill": "true",
        "data-molecule-fill-ring": "true",
        "data-ring-key": ring.ringKey,
        d: ring.pathD,
        ...moleculePaintAttrs("fill", paint, paintId, opacity),
        filter,
        stroke: "none",
        "pointer-events": "none"
      }),
      ...svgSketchEffectFragmentsForEffects(effects, `${object.id}-${stableSvgIdPart(ring.ringKey)}`, {
        className: "native-molecule-ring-sketch",
        dataAttribute: "data-molecule-ring-effect",
        keyPrefix: "molecule-ring-sketch"
      })
    ];
  });
}

// Transparent interior catchers, one per ring, that route a pointer press on an empty ring
// interior to the owning molecule. They live in the render plan next to the atom/bond catchers
// (one stacking layer, one source of truth) and are emitted below the bond/atom catchers so an
// atom or bond hit always wins. Identity is resolved geometrically (nativeMoleculeRingAtPoint);
// the `data-ring-hit-key` is only a DOM hint. Excluded from export via the hit-target filter.
function moleculeRingHitTargetFragments(object: MoleculeObject): PageSvgFragment[] {
  return nativeMoleculeRings(object).map((ring) =>
    elementFragment("path", `ring-hit-${object.id}-${ring.ringKey}`, {
      class: "native-molecule-ring-hit-target",
      "data-ring-hit-key": ring.ringKey,
      d: ring.pathD
    })
  );
}

interface MoleculeFillRingCycle {
  atomIds: readonly string[];
  bondIds: readonly string[];
}

interface MoleculeFillAdjacencyEdge {
  atomId: string;
  bondId: string;
}

const maxMoleculeFillCycles = 256;

function moleculeFillRingCycles(object: MoleculeObject): MoleculeFillRingCycle[] {
  if (object.atoms.length < 3 || object.bonds.length < 3) {
    return [];
  }

  const atomIds = object.atoms.map((atom) => atom.id);
  const atomIdSet = new Set(atomIds);
  const sortedAtomIds = [...atomIds].sort();
  const adjacency = new Map<string, MoleculeFillAdjacencyEdge[]>(
    sortedAtomIds.map((atomId) => [atomId, []])
  );
  const bondedPairs = new Map<string, string>();

  object.bonds.forEach((bond) => {
    if (
      !atomIdSet.has(bond.fromAtomId) ||
      !atomIdSet.has(bond.toAtomId) ||
      bond.fromAtomId === bond.toAtomId
    ) {
      return;
    }

    adjacency.get(bond.fromAtomId)?.push({ atomId: bond.toAtomId, bondId: bond.id });
    adjacency.get(bond.toAtomId)?.push({ atomId: bond.fromAtomId, bondId: bond.id });
    bondedPairs.set(moleculeFillBondPairKey(bond.fromAtomId, bond.toAtomId), bond.id);
  });
  adjacency.forEach((edges) => edges.sort((left, right) => left.atomId.localeCompare(right.atomId)));

  const cycles = new Map<string, MoleculeFillRingCycle>();
  for (const bond of object.bonds) {
    if (cycles.size >= maxMoleculeFillCycles) {
      break;
    }

    if (
      !atomIdSet.has(bond.fromAtomId) ||
      !atomIdSet.has(bond.toAtomId) ||
      bond.fromAtomId === bond.toAtomId
    ) {
      continue;
    }

    const path = moleculeFillShortestPath(adjacency, bond.fromAtomId, bond.toAtomId, bond.id);
    if (!path || path.atomIds.length < 3) {
      continue;
    }

    const cycle = {
      atomIds: path.atomIds,
      bondIds: [...path.bondIds, bond.id]
    };
    const cycleKey = moleculeFillCycleKey(cycle.bondIds);
    const canonicalCycle = moleculeFillCanonicalCycle(cycle);
    if (!cycles.has(cycleKey) && moleculeFillCycleIsChordless(canonicalCycle, bondedPairs)) {
      cycles.set(cycleKey, canonicalCycle);
    }
  }

  return [...cycles.values()].sort((left, right) =>
    moleculeFillCycleSortKey(left).localeCompare(moleculeFillCycleSortKey(right))
  );
}

export function nativeMoleculeRings(object: MoleculeObject): NativeMoleculeRing[] {
  const atomById = new Map(object.atoms.map((atom) => [atom.id, atom]));
  return moleculeFillRingCycles(object)
    .flatMap((cycle): NativeMoleculeRing[] => {
      const points = cycle.atomIds.flatMap((atomId) => {
        const atom = atomById.get(atomId);
        return atom ? [{ x: atom.x, y: atom.y }] : [];
      });
      if (points.length !== cycle.atomIds.length || points.length < 3) {
        return [];
      }

      const pathD = moleculeRingPathD(cycle, atomById);
      if (!pathD) {
        return [];
      }

      return [{
        ringKey: moleculeFillCycleKey(cycle.bondIds),
        atomIds: [...cycle.atomIds],
        bondIds: [...cycle.bondIds].sort(),
        center: polygonCentroid(points),
        points,
        area: Math.abs(polygonSignedArea(points)),
        pathD
      }];
    })
    .sort((left, right) =>
      moleculeFillCycleSortKey(left).localeCompare(moleculeFillCycleSortKey(right)) ||
      left.ringKey.localeCompare(right.ringKey)
    );
}

/**
 * The ring whose interior polygon contains `point`, or undefined. When a point lies in more than
 * one ring (fused systems overlap near a shared bond), the smallest-area ring wins, then a stable
 * `ringKey`. Geometry-only and owned by the layout engine, so ring selection picks the same ring
 * whether the press arrives via the canvas, a DOM hint, or a test — it never depends on which SVG
 * node the browser delivered the pointer event to. Ring keys stay topology-derived via
 * `nativeMoleculeRings`.
 */
export function nativeMoleculeRingAtPoint(
  object: MoleculeObject,
  point: LayoutPoint
): NativeMoleculeRing | undefined {
  return nativeMoleculeRings(object)
    .filter((ring) => pointInPolygon(point, ring.points))
    .sort((left, right) => left.area - right.area || left.ringKey.localeCompare(right.ringKey))[0];
}

function pointInPolygon(point: LayoutPoint, polygon: readonly LayoutPoint[]): boolean {
  if (polygon.length < 3) {
    return false;
  }

  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index]!;
    const prior = polygon[previous]!;
    const crossesY = (current.y > point.y) !== (prior.y > point.y);
    if (!crossesY) {
      continue;
    }
    const xAtY = ((prior.x - current.x) * (point.y - current.y)) / (prior.y - current.y) + current.x;
    if (point.x <= xAtY) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * For every bond that lies on a ring, the atom ids of the SMALLEST ring containing it — the
 * ring whose interior a double bond's inner line should point into. Built from the same
 * chordless ring perception the aromatic fill uses, so it is consistent across the app.
 */
export function smallestRingAtomIdsByBondId(object: MoleculeObject): Map<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  for (const cycle of moleculeFillRingCycles(object)) {
    for (const bondId of cycle.bondIds) {
      const existing = result.get(bondId);
      if (!existing || cycle.atomIds.length < existing.length) {
        result.set(bondId, cycle.atomIds);
      }
    }
  }
  return result;
}

/**
 * The double-bond side ("left"/"right") whose inner line points toward the ring interior, for
 * every double bond lying on a ring. This is the canonical default for a ring double bond
 * (aromatic or otherwise): the second line sits INSIDE the ring unless the user overrides
 * `bond.display.doubleBondSide`. Non-ring double bonds are absent from the map (callers keep
 * their own default). "left" is the +normal side, matching `bondLineSegments`' offset
 * convention, so the render, the spin overlay, and the flatten commit all agree.
 *
 * This replaces a substituent-count heuristic that mistook a ring bond's *outside* for the
 * interior whenever exocyclic substituents outweighed the ring neighbours (e.g. an aromatic
 * ring carrying amide/carbonyl groups).
 */
export function ringInteriorDoubleBondSides(object: MoleculeObject): Map<string, DoubleBondSide> {
  const rings = smallestRingAtomIdsByBondId(object);
  const result = new Map<string, DoubleBondSide>();
  if (rings.size === 0) {
    return result;
  }
  const atomById = new Map(object.atoms.map((atom) => [atom.id, atom]));
  for (const bond of object.bonds) {
    if (bond.order !== "double") {
      continue;
    }
    const ringAtomIds = rings.get(bond.id);
    if (!ringAtomIds) {
      continue;
    }
    const fromAtom = atomById.get(bond.fromAtomId);
    const toAtom = atomById.get(bond.toAtomId);
    if (!fromAtom || !toAtom) {
      continue;
    }
    const side = doubleBondSideTowardRingInterior(fromAtom, toAtom, ringAtomIds, atomById);
    if (side) {
      result.set(bond.id, side);
    }
  }
  return result;
}

function doubleBondSideTowardRingInterior(
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  ringAtomIds: readonly string[],
  atomById: ReadonlyMap<string, MoleculeAtom>
): DoubleBondSide | undefined {
  const dx = toAtom.x - fromAtom.x;
  const dy = toAtom.y - fromAtom.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return undefined;
  }
  // Bond normal, identical to bondLineSegments: normal = { x: -unit.y, y: unit.x }.
  const nx = -dy / length;
  const ny = dx / length;
  const midX = (fromAtom.x + toAtom.x) / 2;
  const midY = (fromAtom.y + toAtom.y) / 2;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const atomId of ringAtomIds) {
    const atom = atomById.get(atomId);
    if (atom) {
      sumX += atom.x;
      sumY += atom.y;
      count += 1;
    }
  }
  if (count === 0) {
    return undefined;
  }
  // Side of the bond normal the ring centroid falls on. "left" offsets the inner line toward
  // +normal (see bondLineSegments), so the inner line lands inside the ring.
  const dot = (sumX / count - midX) * nx + (sumY / count - midY) * ny;
  if (Math.abs(dot) < 1e-9) {
    return undefined; // centroid on the bond axis — interior ambiguous, keep caller default
  }
  return dot >= 0 ? "left" : "right";
}

function moleculeFillShortestPath(
  adjacency: ReadonlyMap<string, readonly MoleculeFillAdjacencyEdge[]>,
  startAtomId: string,
  endAtomId: string,
  excludedBondId: string
): MoleculeFillRingCycle | undefined {
  const queue = [startAtomId];
  const visitedAtomIds = new Set([startAtomId]);
  const previous = new Map<string, MoleculeFillAdjacencyEdge>();

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const currentAtomId = queue[queueIndex]!;
    for (const edge of adjacency.get(currentAtomId) ?? []) {
      if (edge.bondId === excludedBondId || visitedAtomIds.has(edge.atomId)) {
        continue;
      }

      visitedAtomIds.add(edge.atomId);
      previous.set(edge.atomId, { atomId: currentAtomId, bondId: edge.bondId });
      if (edge.atomId === endAtomId) {
        return moleculeFillReconstructPath(startAtomId, endAtomId, previous);
      }
      queue.push(edge.atomId);
    }
  }

  return undefined;
}

function moleculeFillReconstructPath(
  startAtomId: string,
  endAtomId: string,
  previous: ReadonlyMap<string, MoleculeFillAdjacencyEdge>
): MoleculeFillRingCycle | undefined {
  const atomIds = [endAtomId];
  const bondIds: string[] = [];
  let currentAtomId = endAtomId;

  while (currentAtomId !== startAtomId) {
    const step = previous.get(currentAtomId);
    if (!step) {
      return undefined;
    }
    bondIds.push(step.bondId);
    currentAtomId = step.atomId;
    atomIds.push(currentAtomId);
  }

  return {
    atomIds: atomIds.reverse(),
    bondIds: bondIds.reverse()
  };
}

function moleculeFillCanonicalCycle(cycle: MoleculeFillRingCycle): MoleculeFillRingCycle {
  const firstAtomId = cycle.atomIds[0];
  const forwardAtomId = cycle.atomIds[1];
  const backwardAtomId = cycle.atomIds[cycle.atomIds.length - 1];
  if (!firstAtomId || !forwardAtomId || !backwardAtomId || forwardAtomId.localeCompare(backwardAtomId) <= 0) {
    return cycle;
  }

  return {
    ...cycle,
    atomIds: [
      firstAtomId,
      ...cycle.atomIds.slice(1).reverse()
    ]
  };
}

function moleculeFillCycleIsChordless(
  cycle: MoleculeFillRingCycle,
  bondedPairs: ReadonlyMap<string, string>
): boolean {
  const atomCount = cycle.atomIds.length;
  const cycleBondPairs = new Set<string>();
  cycle.atomIds.forEach((atomId, index) => {
    const nextAtomId = cycle.atomIds[(index + 1) % atomCount];
    if (nextAtomId) {
      cycleBondPairs.add(moleculeFillBondPairKey(atomId, nextAtomId));
    }
  });

  for (let leftIndex = 0; leftIndex < atomCount; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < atomCount; rightIndex += 1) {
      const isCycleNeighbor = rightIndex === leftIndex + 1 || (leftIndex === 0 && rightIndex === atomCount - 1);
      if (isCycleNeighbor) {
        continue;
      }

      const pairKey = moleculeFillBondPairKey(cycle.atomIds[leftIndex]!, cycle.atomIds[rightIndex]!);
      if (bondedPairs.has(pairKey) && !cycleBondPairs.has(pairKey)) {
        return false;
      }
    }
  }

  return true;
}

function moleculeRingPathD(
  cycle: MoleculeFillRingCycle,
  atomById: ReadonlyMap<string, MoleculeAtom>
): string | undefined {
  const atoms = cycle.atomIds.map((atomId) => atomById.get(atomId));
  if (atoms.some((atom) => !atom)) {
    return undefined;
  }
  const ringAtoms = atoms as MoleculeAtom[];
  if (ringAtoms.length < 3) {
    return undefined;
  }

  return [
    `M ${formatNumber(ringAtoms[0]!.x)} ${formatNumber(ringAtoms[0]!.y)}`,
    ...ringAtoms.slice(1).map((atom) => `L ${formatNumber(atom.x)} ${formatNumber(atom.y)}`),
    "Z"
  ].join(" ");
}

function moleculeFillCycleKey(bondIds: readonly string[]): string {
  return [...bondIds].sort().join("|");
}

function moleculeFillCycleSortKey(cycle: MoleculeFillRingCycle): string {
  return [...cycle.atomIds].sort().join("|");
}

function polygonSignedArea(points: readonly LayoutPoint[]): number {
  if (points.length < 3) {
    return 0;
  }

  let area = 0;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length]!;
    area += point.x * next.y - next.x * point.y;
  });
  return area / 2;
}

function polygonCentroid(points: readonly LayoutPoint[]): LayoutPoint {
  const signedArea = polygonSignedArea(points);
  if (Math.abs(signedArea) < 0.000001) {
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / Math.max(1, points.length),
      y: points.reduce((sum, point) => sum + point.y, 0) / Math.max(1, points.length)
    };
  }

  let x = 0;
  let y = 0;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length]!;
    const cross = point.x * next.y - next.x * point.y;
    x += (point.x + next.x) * cross;
    y += (point.y + next.y) * cross;
  });

  const factor = 1 / (6 * signedArea);
  return {
    x: x * factor,
    y: y * factor
  };
}

function moleculeFillBondPairKey(firstAtomId: string, secondAtomId: string): string {
  return firstAtomId < secondAtomId ? `${firstAtomId}|${secondAtomId}` : `${secondAtomId}|${firstAtomId}`;
}

function moleculePaintAttrs(
  attribute: "fill" | "stroke",
  paint: GraphicPaint,
  id: string,
  opacity: number
): Record<string, PageSvgAttributeValue> {
  if (paint.kind === "solid") {
    return {
      [attribute]: paint.color,
      [`${attribute}-opacity`]: opacity === 1 ? undefined : opacity
    };
  }

  return {
    [attribute]: moleculePaintValue(paint, id),
    [`${attribute}-opacity`]: opacity === 1 ? undefined : opacity
  };
}

function moleculePaintValue(paint: GraphicPaint, id: string): string {
  if (paint.kind === "none") {
    return "none";
  }
  if (paint.kind === "solid") {
    return paint.color;
  }
  return `url(#${id})`;
}

function moleculePaintDefinitionFragments(
  paint: GraphicPaint,
  id: string,
  object: MoleculeObject
): PageSvgElementFragment[] {
  if (paint.kind === "linear-gradient") {
    return [
      elementFragment("defs", `${id}-defs`, {}, [
        elementFragment("linearGradient", `${id}-gradient`, {
          id,
          x1: object.x + object.width * paint.x1,
          y1: object.y + object.height * paint.y1,
          x2: object.x + object.width * paint.x2,
          y2: object.y + object.height * paint.y2,
          gradientUnits: "userSpaceOnUse"
        }, moleculeGradientStopFragments(paint.stops, id))
      ])
    ];
  }

  if (paint.kind === "radial-gradient") {
    const radius = Math.max(object.width, object.height, 1) * paint.r;
    return [
      elementFragment("defs", `${id}-defs`, {}, [
        elementFragment("radialGradient", `${id}-gradient`, {
          id,
          cx: object.x + object.width * paint.cx,
          cy: object.y + object.height * paint.cy,
          r: radius,
          fx: paint.fx === undefined ? undefined : object.x + object.width * paint.fx,
          fy: paint.fy === undefined ? undefined : object.y + object.height * paint.fy,
          gradientUnits: "userSpaceOnUse"
        }, moleculeGradientStopFragments(paint.stops, id))
      ])
    ];
  }

  return [];
}

function moleculeGradientStopFragments(
  stops: Extract<GraphicPaint, { kind: "linear-gradient" | "radial-gradient" }>["stops"],
  id: string
): PageSvgElementFragment[] {
  return [...stops]
    .sort((left, right) => left.offset - right.offset)
    .map((stop, index) =>
      elementFragment("stop", `${id}-stop-${index}`, {
        offset: `${formatNumber(clamp(stop.offset, 0, 1) * 100)}%`,
        "stop-color": stop.color,
        "stop-opacity": stop.opacity === undefined || stop.opacity === 1 ? undefined : clamp(stop.opacity, 0, 1)
      })
    );
}

function moleculeEffectSourceFragment(
  object: MoleculeObject,
  effects: readonly NativeArtEffectPlan[],
  effectFilterId: string,
  bondSegmentGroups: readonly PageMoleculeBondSegmentGroup[],
  carbonJunctionPlans: readonly NativeCarbonJunctionPlan[],
  drawingStyle: NativeDrawingStyle,
  gapsByBondKey: ReadonlyMap<string, readonly BondCrossingGap[]>
): PageSvgElementFragment | undefined {
  const hasFilter = effects.some((effect) => effect.kind === "shadow" || effect.kind === "glow");
  if (!hasFilter) {
    return undefined;
  }

  const children = [
    ...bondSegmentGroups.flatMap(({ bond, drawingStyle: bondDrawingStyle, segments }) =>
      segments.flatMap((segment) =>
        moleculeBondEffectSourceFragments(
          object,
          segment,
          bondDrawingStyle,
          gapsByBondKey.get(bondRefKey({ objectId: object.id, bondId: bond.id })) ?? []
        )
      )
    ),
    ...nativeCarbonJunctionFragments(object.id, carbonJunctionPlans, 1, true)
  ];
  if (children.length === 0) {
    return undefined;
  }

  return elementFragment("g", `molecule-effect-source-${object.id}`, {
    class: "native-molecule-effect-source",
    "data-molecule-effect-source": "true",
    filter: `url(#${effectFilterId})`,
    "pointer-events": "none"
  }, children);
}

function moleculeBondEffectSourceFragments(
  object: MoleculeObject,
  segment: PageMoleculeBondSegment,
  drawingStyle: NativeDrawingStyle,
  crossingGaps: readonly BondCrossingGap[] = []
): PageSvgElementFragment[] {
  const bondStyle = nativeBondDisplayStyle(segment.bond);
  if (bondStyle === "wedge" && segment.segment === "primary") {
    const segmentLength = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
    return splitSegmentByCrossingGaps(segment, crossingGaps).map((visibleSegment, index) =>
      elementFragment("polygon", `molecule-effect-source-bond-${object.id}-${segment.key}-${index}`, {
        points: nativeWedgePolygonPoints(visibleSegment, drawingStyle, object, segment.bond, segmentLength),
        fill: "#000000",
        stroke: "none"
      })
    );
  }

  if (bondStyle === "hashed" && segment.segment === "primary") {
    const hashedWedge = nativeHashedWedgePlan(segment, drawingStyle, object, segment.bond, crossingGaps);
    const hashes = hashedWedge.hashes.flatMap((hash, index) =>
      splitSegmentByCrossingGaps(hash, crossingGaps).map((visibleHash, visibleIndex) =>
        elementFragment("line", `molecule-effect-source-bond-hash-${object.id}-${segment.key}-${index}-${visibleIndex}`, {
          x1: visibleHash.x1,
          y1: visibleHash.y1,
          x2: visibleHash.x2,
          y2: visibleHash.y2,
          stroke: "#000000",
          "stroke-width": hashedWedge.strokeWidth,
          "stroke-linecap": "butt"
        })
      )
    );
    return hashedWedge.terminalJoin
      ? [
          ...hashes,
          elementFragment("polygon", `molecule-effect-source-bond-hash-${object.id}-${segment.key}-terminal`, {
            points: hashedWedge.terminalJoin.points,
            fill: "#000000",
            stroke: "none"
          })
        ]
      : hashes;
  }

  return splitSegmentByCrossingGaps(segment, crossingGaps).map((visibleSegment, index) =>
    elementFragment("line", `molecule-effect-source-bond-${object.id}-${segment.key}-${index}`, {
      x1: visibleSegment.x1,
      y1: visibleSegment.y1,
      x2: visibleSegment.x2,
      y2: visibleSegment.y2,
      stroke: "#000000",
      "stroke-width": nativeBondStrokeWidth(segment.bond, drawingStyle),
      "stroke-linecap": bondStyle === "dashed" ? "butt" : drawingStyle.bondLineCap,
      "stroke-dasharray": bondStyle === "dashed" ? nativeDashedBondDashArray(drawingStyle) : undefined
    })
  );
}

function moleculeEffectSketchBasePathD(
  object: MoleculeObject,
  bondSegmentGroups: readonly PageMoleculeBondSegmentGroup[],
  gapsByBondKey: ReadonlyMap<string, readonly BondCrossingGap[]>
): string | undefined {
  const bondPathParts = bondSegmentGroups.flatMap(({ bond, segments }) =>
    segments.flatMap((segment) =>
      splitSegmentByCrossingGaps(
        segment,
        gapsByBondKey.get(bondRefKey({ objectId: object.id, bondId: bond.id })) ?? []
      ).map((visibleSegment) => linePathD(visibleSegment))
    )
  );
  return bondPathParts.join(" ") || undefined;
}

function linePathD(segment: Pick<PageBondLineSegment, "x1" | "y1" | "x2" | "y2">): string {
  return `M ${formatNumber(segment.x1)} ${formatNumber(segment.y1)} L ${formatNumber(segment.x2)} ${formatNumber(segment.y2)}`;
}

function nativeCarbonJunctionPlans(
  object: MoleculeObject,
  labeledAtomIds: ReadonlySet<string>,
  drawingStyle: NativeDrawingStyle
): NativeCarbonJunctionPlan[] {
  return object.atoms.flatMap((atom) => {
    if (
      nativeElementFromAtomLabel(atom.element) !== "C" ||
      labeledAtomIds.has(atom.id)
    ) {
      return [];
    }

    const incidentBonds = object.bonds.filter((bond) =>
      bond.fromAtomId === atom.id || bond.toAtomId === atom.id
    );
    const continuousBonds = incidentBonds.filter((bond) => {
      const bondStyle = nativeBondDisplayStyle(bond);
      return bondStyle !== "dashed" && bondStyle !== "hashed";
    });
    if (continuousBonds.length < 2) {
      return [];
    }

    const incidentStyles = continuousBonds.map((bond) => {
      const bondDrawingStyle = nativeMoleculeBondDrawingStyle(object, bond.id, drawingStyle);
      return {
        bond,
        drawingStyle: bondDrawingStyle,
        strokeWidth: nativeBondStrokeWidth(bond, bondDrawingStyle)
      };
    });
    const topmost = incidentStyles[incidentStyles.length - 1]!;
    const maximumStrokeWidth = Math.max(...incidentStyles.map(({ strokeWidth }) => strokeWidth));

    return [{
      atomId: atom.id,
      x: atom.x,
      y: atom.y,
      // SVG paints every bond as an independent flat-ended stroke. A small overlap at the
      // unlabeled carbon center removes the antialiasing slit without changing any exposed bond
      // terminal. The extra fraction of a pixel keeps the overlap solid at high canvas zoom.
      radius: maximumStrokeWidth / 2 + Math.max(0.15, maximumStrokeWidth * 0.08),
      // Junctions paint after the bond layers, so use the same color as the last incident bond in
      // the molecule's paint order. Ordinary structures therefore become one continuous black
      // network, while intentional per-bond color/depth styling retains deterministic stacking.
      fill: nativeMoleculeBondColor(object, topmost.bond, topmost.drawingStyle)
    }];
  });
}

function nativeCarbonJunctionFragments(
  objectId: string,
  plans: readonly NativeCarbonJunctionPlan[],
  moleculeStrokeOpacity: number,
  effectSource = false
): PageSvgElementFragment[] {
  return plans.map((plan) =>
    elementFragment(
      "circle",
      `${effectSource ? "molecule-effect-source-" : ""}carbon-junction-${objectId}-${plan.atomId}`,
      {
        class: effectSource
          ? "native-carbon-junction-effect-source"
          : "native-carbon-junction",
        "data-atom-id": plan.atomId,
        cx: plan.x,
        cy: plan.y,
        r: formatNumber(plan.radius),
        fill: effectSource ? "#000000" : plan.fill,
        "fill-opacity": moleculeStrokeOpacity === 1 ? undefined : moleculeStrokeOpacity,
        stroke: "none",
        "pointer-events": "none"
      }
    )
  );
}

function nativeBondHoverDecoratorFragments(
  segment: PageMoleculeBondSegment,
  crossingGaps: readonly BondCrossingGap[] = []
): PageSvgElementFragment[] {
  return splitSegmentByCrossingGaps(segment, crossingGaps).map((visibleSegment, index) =>
    elementFragment("line", `bond-hover-${segment.bond.id}-${segment.key}-${index}`, {
      class: "native-bond-hover-decorator",
      "data-bond-id": segment.bond.id,
      "data-bond-segment": segment.segment,
      x1: visibleSegment.x1,
      y1: visibleSegment.y1,
      x2: visibleSegment.x2,
      y2: visibleSegment.y2
    })
  );
}

function nativeBondSegmentFragments(
  object: MoleculeObject,
  segment: PageMoleculeBondSegment,
  drawingStyle: NativeDrawingStyle,
  moleculeStrokeOpacity: number,
  crossingGaps: readonly BondCrossingGap[] = []
): PageSvgElementFragment[] {
  const bondStyle = nativeBondDisplayStyle(segment.bond);
  const className = [
    "native-bond-line",
    `native-bond-${segment.bond.order}`,
    bondStyle ? `native-bond-style-${bondStyle}` : ""
  ].filter(Boolean).join(" ");
  const commonAttrs = {
    class: className,
    "data-bond-id": segment.bond.id,
    "data-bond-order": segment.bond.order,
    "data-bond-segment": segment.segment,
    "data-bond-style": bondStyle,
    "data-double-bond-side": segment.doubleBondSide
  };
  const stroke = nativeMoleculeBondColor(object, segment.bond, drawingStyle);

  if (bondStyle === "wedge" && segment.segment === "primary") {
    const segmentLength = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
    return splitSegmentByCrossingGaps(segment, crossingGaps).map((visibleSegment, index) =>
      elementFragment("polygon", `bond-${object.id}-${segment.key}-${index}`, {
        ...commonAttrs,
        points: nativeWedgePolygonPoints(visibleSegment, drawingStyle, object, segment.bond, segmentLength),
        fill: stroke,
        "fill-opacity": moleculeStrokeOpacity === 1 ? undefined : moleculeStrokeOpacity,
        stroke: "none"
      })
    );
  }

  if (bondStyle === "hashed" && segment.segment === "primary") {
    const hashedWedge = nativeHashedWedgePlan(segment, drawingStyle, object, segment.bond, crossingGaps);
    return [
      elementFragment("g", `bond-${object.id}-${segment.key}`, commonAttrs, [
        ...hashedWedge.hashes.flatMap((hash, index) =>
          splitSegmentByCrossingGaps(hash, crossingGaps).map((visibleHash, visibleIndex) =>
          elementFragment("line", `bond-hash-${object.id}-${segment.key}-${index}-${visibleIndex}`, {
            class: "native-bond-hash",
            "data-bond-hash-index": index,
            x1: visibleHash.x1,
            y1: visibleHash.y1,
            x2: visibleHash.x2,
            y2: visibleHash.y2,
            stroke,
            "stroke-opacity": moleculeStrokeOpacity === 1 ? undefined : moleculeStrokeOpacity,
            "stroke-width": hashedWedge.strokeWidth,
            "stroke-linecap": "butt"
          })
        )
        ),
        ...(hashedWedge.terminalJoin
          ? [
              elementFragment("polygon", `bond-hash-${object.id}-${segment.key}-terminal`, {
                class: "native-bond-hash",
                "data-bond-hash-index": hashedWedge.terminalJoin.index,
                points: hashedWedge.terminalJoin.points,
                fill: stroke,
                "fill-opacity": moleculeStrokeOpacity === 1 ? undefined : moleculeStrokeOpacity,
                stroke: "none"
              })
            ]
          : [])
      ])
    ];
  }

  return splitSegmentByCrossingGaps(segment, crossingGaps).map((visibleSegment, index) =>
    elementFragment("line", `bond-${object.id}-${segment.key}-${index}`, {
      ...commonAttrs,
      x1: visibleSegment.x1,
      y1: visibleSegment.y1,
      x2: visibleSegment.x2,
      y2: visibleSegment.y2,
      stroke,
      "stroke-opacity": moleculeStrokeOpacity === 1 ? undefined : moleculeStrokeOpacity,
      "stroke-width": nativeBondStrokeWidth(segment.bond, drawingStyle),
      "stroke-linecap": bondStyle === "dashed" ? "butt" : drawingStyle.bondLineCap,
      "stroke-dasharray": bondStyle === "dashed" ? nativeDashedBondDashArray(drawingStyle) : undefined
    })
  );
}

function moleculeStructureIndicatorFragments(
  object: MoleculeObject,
  drawingStyle: NativeDrawingStyle,
  moleculeStrokeOpacity: number
): PageSvgElementFragment[] {
  const atomById = new Map(object.atoms.map((atom) => [atom.id, atom]));
  const stereoAtomIds = nativeStereoAtomIndicatorIds(object);
  const fragments: PageSvgElementFragment[] = [];

  object.atoms.forEach((atom, index) => {
    const atomIndicatorStyle = nativeMoleculeAtomIndicatorStyle(object, atom.id, drawingStyle);
    if (atomIndicatorStyle.atomIndicatorShowAtomNumbers) {
      fragments.push(atomIndicatorTextFragment({
        objectId: object.id,
        atom,
        kind: "number",
        label: String(index + 1),
        offset: { x: 8, y: -8 },
        fill: "#52616b",
        moleculeStrokeOpacity
      }));
    }
  });

  for (const atomId of nativeAtomQueryIndicatorIds(object)) {
    const atom = atomById.get(atomId);
    if (!atom) {
      continue;
    }
    const atomIndicatorStyle = nativeMoleculeAtomIndicatorStyle(object, atom.id, drawingStyle);
    if (atomIndicatorStyle.atomIndicatorShowQuery) {
      fragments.push(atomIndicatorTextFragment({
        objectId: object.id,
        atom,
        kind: "query",
        label: "?",
        offset: { x: 8, y: 8 },
        fill: "#7b4dcc",
        moleculeStrokeOpacity
      }));
    }
  }

  for (const atomId of stereoAtomIds) {
    const atom = atomById.get(atomId);
    if (!atom) {
      continue;
    }
    const atomIndicatorStyle = nativeMoleculeAtomIndicatorStyle(object, atom.id, drawingStyle);
    if (atomIndicatorStyle.atomIndicatorShowStereochemistry) {
      fragments.push(atomIndicatorTextFragment({
        objectId: object.id,
        atom,
        kind: "stereochemistry",
        label: "@",
        offset: { x: -8, y: -8 },
        fill: "#1f5fbf",
        moleculeStrokeOpacity
      }));
    }
  }

  for (const { atomId, label } of nativeEnhancedStereoAtomIndicators(object)) {
    const atom = atomById.get(atomId);
    if (!atom) {
      continue;
    }
    const atomIndicatorStyle = nativeMoleculeAtomIndicatorStyle(object, atom.id, drawingStyle);
    if (atomIndicatorStyle.atomIndicatorShowEnhancedStereochemistry) {
      fragments.push(atomIndicatorTextFragment({
        objectId: object.id,
        atom,
        kind: "enhanced-stereochemistry",
        label,
        offset: { x: 0, y: 10 },
        fill: "#8a5a00",
        moleculeStrokeOpacity
      }));
    }
  }

  for (const bondId of nativeBondQueryIndicatorIds(object)) {
    const bond = object.bonds.find((candidate) => candidate.id === bondId);
    if (!bond) {
      continue;
    }
    const bondDrawingStyle = nativeMoleculeBondDrawingStyle(object, bond.id, drawingStyle);
    if (bondDrawingStyle.bondIndicatorShowQuery) {
      const fragment = bondIndicatorTextFragment({
        object,
        bond,
        kind: "query",
        label: "?",
        offsetSlot: -1,
        fill: "#7b4dcc",
        moleculeStrokeOpacity
      });
      if (fragment) {
        fragments.push(fragment);
      }
    }
  }

  for (const bond of object.bonds) {
    const label = nativeBondStereoIndicatorLabel(bond);
    if (!label) {
      continue;
    }
    const bondDrawingStyle = nativeMoleculeBondDrawingStyle(object, bond.id, drawingStyle);
    if (bondDrawingStyle.bondIndicatorShowStereochemistry) {
      const fragment = bondIndicatorTextFragment({
        object,
        bond,
        kind: "stereochemistry",
        label,
        offsetSlot: 0,
        fill: "#1f5fbf",
        moleculeStrokeOpacity
      });
      if (fragment) {
        fragments.push(fragment);
      }
    }
  }

  for (const bondId of nativeBondReactionIndicatorIds(object)) {
    const bond = object.bonds.find((candidate) => candidate.id === bondId);
    if (!bond) {
      continue;
    }
    const bondDrawingStyle = nativeMoleculeBondDrawingStyle(object, bond.id, drawingStyle);
    if (bondDrawingStyle.bondIndicatorShowReaction) {
      const fragment = bondIndicatorTextFragment({
        object,
        bond,
        kind: "reaction",
        label: "RXN",
        offsetSlot: 1,
        fill: "#b3261e",
        moleculeStrokeOpacity
      });
      if (fragment) {
        fragments.push(fragment);
      }
    }
  }

  return fragments;
}

function atomIndicatorTextFragment(options: {
  objectId: string;
  atom: MoleculeAtom;
  kind: string;
  label: string;
  offset: LayoutPoint;
  fill: string;
  moleculeStrokeOpacity: number;
}): PageSvgElementFragment {
  const x = options.atom.x + options.offset.x;
  const y = options.atom.y + options.offset.y;
  return elementFragment("text", `atom-indicator-${options.objectId}-${options.kind}-${options.atom.id}`, {
    class: `native-atom-indicator native-atom-indicator-${options.kind}`,
    "data-atom-indicator": options.kind,
    "data-atom-id": options.atom.id,
    x,
    y,
    fill: options.fill,
    "fill-opacity": options.moleculeStrokeOpacity === 1 ? undefined : options.moleculeStrokeOpacity,
    "font-family": "Arial, Helvetica, sans-serif",
    "font-size": options.kind === "enhanced-stereochemistry" ? 6 : 7,
    "font-weight": 700,
    "dominant-baseline": "central",
    "text-anchor": "middle",
    "pointer-events": "none"
  }, [textFragment(`atom-indicator-text-${options.objectId}-${options.kind}-${options.atom.id}`, options.label)]);
}

function bondIndicatorTextFragment(options: {
  object: MoleculeObject;
  bond: CoreMoleculeBond;
  kind: string;
  label: string;
  offsetSlot: number;
  fill: string;
  moleculeStrokeOpacity: number;
}): PageSvgElementFragment | undefined {
  const atomById = new Map(options.object.atoms.map((atom) => [atom.id, atom]));
  const fromAtom = atomById.get(options.bond.fromAtomId);
  const toAtom = atomById.get(options.bond.toAtomId);
  if (!fromAtom || !toAtom) {
    return undefined;
  }

  const dx = toAtom.x - fromAtom.x;
  const dy = toAtom.y - fromAtom.y;
  const length = Math.hypot(dx, dy);
  const normal = length > 0
    ? { x: -dy / length, y: dx / length }
    : { x: 0, y: -1 };
  const offset = options.offsetSlot * 9;
  const x = (fromAtom.x + toAtom.x) / 2 + normal.x * offset;
  const y = (fromAtom.y + toAtom.y) / 2 + normal.y * offset;

  return elementFragment("text", `bond-indicator-${options.object.id}-${options.kind}-${options.bond.id}`, {
    class: `native-bond-indicator native-bond-indicator-${options.kind}`,
    "data-bond-indicator": options.kind,
    "data-bond-id": options.bond.id,
    x,
    y,
    fill: options.fill,
    "fill-opacity": options.moleculeStrokeOpacity === 1 ? undefined : options.moleculeStrokeOpacity,
    "font-family": "Arial, Helvetica, sans-serif",
    "font-size": options.kind === "reaction" ? 6 : 7,
    "font-weight": 700,
    "dominant-baseline": "central",
    "text-anchor": "middle",
    "pointer-events": "none"
  }, [textFragment(`bond-indicator-text-${options.object.id}-${options.kind}-${options.bond.id}`, options.label)]);
}

function nativeStereoAtomIndicatorIds(object: MoleculeObject): Set<string> {
  const atomById = new Map(object.atoms.map((atom) => [atom.id, atom]));
  const degreeByAtomId = nativeAtomDegreeById(object.bonds);
  const ids = new Set<string>();

  for (const bond of object.bonds) {
    if (!nativeBondStereoIndicatorLabel(bond)) {
      continue;
    }
    const candidates = [atomById.get(bond.fromAtomId), atomById.get(bond.toAtomId)]
      .filter((atom): atom is MoleculeAtom => atom !== undefined);
    const preferred = candidates.find((atom) => (degreeByAtomId.get(atom.id) ?? 0) >= 3) ?? candidates[0];
    if (preferred) {
      ids.add(preferred.id);
    }
  }

  for (const atomId of unknownRecordObjectKeys(object.compatibility?.unknown, [
    "cdxmlAtomStereochemistryByAtomId",
    "atomStereochemistryByAtomId",
    "stereochemistryByAtomId"
  ])) {
    ids.add(atomId);
  }

  return ids;
}

function nativeEnhancedStereoAtomIndicators(
  object: MoleculeObject
): Array<{ atomId: string; label: string }> {
  // Enhanced stereochemistry (ABS/OR/AND/REL/RAC) is a chemical assertion that lives ONLY in
  // native/imported metadata — never invent it from a plain drawn wedge/hash. Absent that
  // metadata, there are no enhanced-stereo indicators: a bare stereocenter is not "ABS".
  const explicit = unknownRecordStringMap(object.compatibility?.unknown, [
    "enhancedStereoByAtomId",
    "atomEnhancedStereoByAtomId",
    "cdxmlEnhancedStereoByAtomId"
  ]);
  return [...explicit.entries()].map(([atomId, label]) => ({ atomId, label: enhancedStereoLabel(label) }));
}

function enhancedStereoLabel(value: string): string {
  const upper = value.trim().toUpperCase();
  if (upper.startsWith("OR")) {
    return upper;
  }
  if (upper.startsWith("AND")) {
    return upper;
  }
  if (upper === "REL" || upper === "RAC") {
    return upper;
  }
  return "ABS";
}

function nativeAtomQueryIndicatorIds(object: MoleculeObject): Set<string> {
  const ids = new Set<string>();
  for (const atom of object.atoms) {
    if (isQueryLikeAtomLabel(atom.element)) {
      ids.add(atom.id);
    }
  }

  for (const rGroup of object.rGroups ?? []) {
    if (rGroup.querySemantics !== "query") {
      continue;
    }
    for (const anchor of rGroup.attachmentPoints ?? []) {
      if (anchor.kind === "atom" && anchor.atomId) {
        ids.add(anchor.atomId);
      }
    }
  }

  for (const atomId of unknownRecordStringSet(object.compatibility?.unknown, [
    "atomQueryIds",
    "queryAtomIds",
    "cdxmlAtomQueryIds"
  ])) {
    ids.add(atomId);
  }
  for (const atomId of unknownRecordObjectKeys(object.compatibility?.unknown, [
    "atomQueriesById",
    "queryAtomsById",
    "cdxmlAtomQueriesById"
  ])) {
    ids.add(atomId);
  }

  return ids;
}

function nativeBondQueryIndicatorIds(object: MoleculeObject): Set<string> {
  const ids = new Set<string>();
  for (const bond of object.bonds) {
    if (bond.order === "unknown") {
      ids.add(bond.id);
    }
  }

  for (const bondId of unknownRecordStringSet(object.compatibility?.unknown, [
    "bondQueryIds",
    "queryBondIds",
    "cdxmlBondQueryIds"
  ])) {
    ids.add(bondId);
  }
  for (const bondId of unknownRecordObjectKeys(object.compatibility?.unknown, [
    "bondQueriesById",
    "queryBondsById",
    "cdxmlBondQueriesById"
  ])) {
    ids.add(bondId);
  }

  return ids;
}

function nativeBondReactionIndicatorIds(object: MoleculeObject): Set<string> {
  // Reaction-role indicators come ONLY from explicit imported reaction-bond metadata. Never paint
  // every bond "RXN" just because the source format string happens to mention a reaction — that
  // marks a whole molecule as a reaction with no per-bond information behind it.
  const ids = new Set<string>();
  for (const bondId of unknownRecordStringSet(object.compatibility?.unknown, [
    "reactionBondIds",
    "rxnBondIds",
    "cdxmlReactionBondIds"
  ])) {
    ids.add(bondId);
  }
  for (const bondId of unknownRecordObjectKeys(object.compatibility?.unknown, [
    "reactionBondsById",
    "rxnBondsById",
    "bondReactionRolesById"
  ])) {
    ids.add(bondId);
  }

  return ids;
}

function nativeAtomDegreeById(bonds: readonly CoreMoleculeBond[]): Map<string, number> {
  const degreeByAtomId = new Map<string, number>();
  for (const bond of bonds) {
    degreeByAtomId.set(bond.fromAtomId, (degreeByAtomId.get(bond.fromAtomId) ?? 0) + 1);
    degreeByAtomId.set(bond.toAtomId, (degreeByAtomId.get(bond.toAtomId) ?? 0) + 1);
  }
  return degreeByAtomId;
}

function nativeBondStereoIndicatorLabel(bond: CoreMoleculeBond): string | undefined {
  const style = nativeBondDisplayStyle(bond);
  if (style === "wedge") {
    return "UP";
  }
  if (style === "hashed") {
    return "DN";
  }
  if (style === "dashed") {
    return "ST";
  }
  return undefined;
}

function isQueryLikeAtomLabel(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "*" || /^R\d*$/i.test(trimmed)) {
    return true;
  }
  return nativeElementFromAtomLabel(trimmed) === undefined &&
    /^(A|Q|X|M|L|R#|\[[^\]]+\])$/i.test(trimmed);
}

function unknownRecordStringSet(
  unknown: Record<string, unknown> | undefined,
  keys: readonly string[]
): Set<string> {
  const values = new Set<string>();
  if (!unknown) {
    return values;
  }
  for (const key of keys) {
    const value = unknown[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.length > 0) {
          values.add(item);
        }
      }
    }
  }
  return values;
}

function unknownRecordObjectKeys(
  unknown: Record<string, unknown> | undefined,
  keys: readonly string[]
): Set<string> {
  const values = new Set<string>();
  if (!unknown) {
    return values;
  }
  for (const key of keys) {
    const value = unknown[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const itemKey of Object.keys(value)) {
        if (itemKey.length > 0) {
          values.add(itemKey);
        }
      }
    }
  }
  return values;
}

function unknownRecordStringMap(
  unknown: Record<string, unknown> | undefined,
  keys: readonly string[]
): Map<string, string> {
  const values = new Map<string, string>();
  if (!unknown) {
    return values;
  }
  for (const key of keys) {
    const value = unknown[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    for (const [itemKey, itemValue] of Object.entries(value)) {
      if (itemKey.length > 0 && typeof itemValue === "string" && itemValue.length > 0) {
        values.set(itemKey, itemValue);
      }
    }
  }
  return values;
}

function splitSegmentByCrossingGaps(
  segment: Pick<PageBondLineSegment, "x1" | "y1" | "x2" | "y2">,
  crossingGaps: readonly BondCrossingGap[]
): Pick<PageBondLineSegment, "x1" | "y1" | "x2" | "y2">[] {
  if (crossingGaps.length === 0) {
    return [segment];
  }

  const geometry = nativeSegmentVectorGeometry(segment);
  if (!geometry) {
    return [];
  }

  const intervals = crossingGaps.flatMap((gap) => {
    const projected = projectionDistanceAlongSegment(gap.point, segment, geometry.length);
    if (!projected || projected.closestDistance > Math.max(gap.clearancePx, crossingHitRadiusPx)) {
      return [];
    }

    const halfGap = gap.clearancePx / 2;
    return [{
      start: clamp(projected.distance - halfGap, 0, geometry.length),
      end: clamp(projected.distance + halfGap, 0, geometry.length)
    }];
  }).filter((interval) => interval.end - interval.start > 0.5)
    .sort((left, right) => left.start - right.start);

  if (intervals.length === 0) {
    return [segment];
  }

  const merged = intervals.reduce<{ start: number; end: number }[]>((current, interval) => {
    const previous = current[current.length - 1];
    if (!previous || interval.start > previous.end) {
      current.push({ ...interval });
      return current;
    }
    previous.end = Math.max(previous.end, interval.end);
    return current;
  }, []);

  const visible: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const gap of merged) {
    if (gap.start - cursor > 0.5) {
      visible.push({ start: cursor, end: gap.start });
    }
    cursor = Math.max(cursor, gap.end);
  }
  if (geometry.length - cursor > 0.5) {
    visible.push({ start: cursor, end: geometry.length });
  }

  return visible.map((interval) => ({
    x1: segment.x1 + geometry.unit.x * interval.start,
    y1: segment.y1 + geometry.unit.y * interval.start,
    x2: segment.x1 + geometry.unit.x * interval.end,
    y2: segment.y1 + geometry.unit.y * interval.end
  }));
}

function projectionDistanceAlongSegment(
  point: LayoutPoint,
  segment: Pick<PageBondLineSegment, "x1" | "y1" | "x2" | "y2">,
  segmentLength: number
): { distance: number; closestDistance: number } | undefined {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= crossingIntersectionEpsilon) {
    return undefined;
  }
  const t = clamp(((point.x - segment.x1) * dx + (point.y - segment.y1) * dy) / lengthSquared, 0, 1);
  const closest = {
    x: segment.x1 + dx * t,
    y: segment.y1 + dy * t
  };
  return {
    distance: segmentLength * t,
    closestDistance: distance(point, closest)
  };
}

function planTextObjectSvg(object: TextObject, layerIndex: number): PageSvgElementFragment {
  const textStyle = nativeTextStyleFromObjectStyle(object.style);
  const lines = textObjectSpanLines(object);
  const textAnchor = textStyle.textAlign === "center"
    ? "middle"
    : textStyle.textAlign === "right" ? "end" : "start";
  const x = textStyle.textAlign === "center"
    ? object.x + object.width / 2
    : textStyle.textAlign === "right" ? object.x + object.width : object.x;
  const y = object.y + textStyle.fontSizePx;
  const lineAdvance = textStyle.fontSizePx * textStyle.lineHeight + textStyle.paragraphSpacingPx;
  const lineFragments = lines.length > 0
    ? lines.flatMap((line, lineIndex) => textSpanLineFragments(line, lineIndex, x, lineAdvance))
    : [elementFragment("tspan", `text-empty-${object.id}`, { x }, [])];

  return elementFragment("text", `object-${object.id}`, objectAttributes(object, layerIndex, {
    x,
    y,
    "font-family": textStyle.fontFamily,
    "font-size": textStyle.fontSizePx,
    "font-weight": textStyle.fontWeight,
    "font-style": textStyle.fontStyle,
    "text-decoration": textStyle.textDecoration,
    "letter-spacing": textStyle.letterSpacingPx,
    "text-anchor": textAnchor,
    fill: textStyle.color,
    transform: rotationTransform(object)
  }), lineFragments);
}

function textSpanLineFragments(
  line: TextSpan[],
  lineIndex: number,
  x: number,
  lineAdvancePx: number
): PageSvgElementFragment[] {
  if (line.length === 0) {
    return [
      elementFragment("tspan", `text-line-empty-${lineIndex}`, {
        x,
        dy: lineIndex === 0 ? undefined : lineAdvancePx
      })
    ];
  }

  return line.map((span, spanIndex) =>
    elementFragment("tspan", `text-line-${lineIndex}-${spanIndex}-${span.text}`, {
      x: spanIndex === 0 ? x : undefined,
      dy: spanIndex === 0 && lineIndex > 0 ? lineAdvancePx : undefined,
      "baseline-shift": span.script === "normal" ? undefined : span.script === "superscript" ? "super" : "sub",
      "font-size": span.script === "normal" ? metadataNumber(span.style.fontSizePx) : "72%",
      fill: metadataString(span.style.color),
      "font-family": metadataString(span.style.fontFamily),
      "font-weight": metadataNumber(span.style.fontWeight),
      "font-style": metadataFontStyle(span.style.fontStyle),
      "text-decoration": metadataString(span.style.textDecoration),
      "letter-spacing": metadataNumber(span.style.letterSpacingPx)
    }, [textFragment(`text-line-${lineIndex}-${spanIndex}-text`, span.text)])
  );
}

function textObjectSpanLines(object: TextObject): TextSpan[][] {
  const spans = textObjectSpansForRendering(object);
  return spans.reduce<TextSpan[][]>((lines, span) => {
    const parts = span.text.split(/\r?\n/);
    parts.forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
      }
      if (part.length > 0) {
        lines[lines.length - 1].push({ ...span, text: part });
      }
    });
    return lines;
  }, [[]]);
}

export function textObjectSpansForRendering(object: TextObject): TextSpan[] {
  const spans = object.spans.filter((span) => span.text.length > 0);
  if (spans.length > 0 && spans.map((span) => span.text).join("") === object.text) {
    return spans;
  }

  return [{ text: object.text, script: "normal", style: {} }];
}

function chargeMarkFragment(object: ElectronMarkObject, layerIndex: number): PageSvgElementFragment {
  const charge = object.charge === -1 ? -1 : 1;
  return elementFragment("g", `object-${object.id}`, objectAttributes(object, layerIndex, {
    "data-mark-kind": "charge",
    "data-charge": charge,
    transform: rotationTransform(object)
  }), [
    elementFragment("text", `charge-${object.id}`, {
      x: object.x + object.width / 2,
      y: object.y + object.height / 2,
      "dominant-baseline": "central",
      "text-anchor": "middle",
      "font-family": "Arial, Helvetica, sans-serif",
      "font-size": 18,
      "font-weight": 700,
      fill: "#111111"
    }, [textFragment(`charge-text-${object.id}`, charge > 0 ? "+" : "-")])
  ]);
}

function graphicObjectFragment(
  object: GraphicObject,
  warnings: PageSvgRenderWarning[],
  layerIndex: number
): PageSvgElementFragment {
  warnForGraphicSvgEffects(object, warnings);
  const plan = planNativeArtVisual(object, { coordinateSpace: "page" });
  const freehandPath = graphicObjectIsFreehandPath(object);
  const gradientId = `graphic-gloss-${object.id}`;
  const fillAttrs = plan.glossGradient
    ? {
        fill: `url(#${gradientId})`
      }
    : svgPaintAttrs("fill", plan.fill.paint, `graphic-fill-${object.id}`);
  const strokeAttrs = {
    class: "graphic-glyph-stroke",
    ...svgPaintAttrs("stroke", plan.stroke.paint, `graphic-stroke-${object.id}`),
    "stroke-width": plan.stroke.width,
    "stroke-dasharray": plan.stroke.dasharray,
    "stroke-linecap": plan.stroke.lineCap,
    "stroke-linejoin": plan.stroke.lineJoin,
    "stroke-miterlimit": plan.stroke.miterLimit
  };
  const closedFillEffectSource = plan.capabilities.supportsFill && !plan.capabilities.isOpenStroke;
  const pathFillEffectSource = freehandPath || closedFillEffectSource || !plan.capabilities.supportsStroke;
  const hasSketchEffect = plan.effects.some((effect) => effect.kind === "sketch");
  const cleanStrokeAttrs = hasSketchEffect ? { ...strokeAttrs, stroke: "none" } : strokeAttrs;
  const sketchEffectSourceFragments = hasSketchEffect ? svgSketchEffectSourceFragments(plan, object.id) : [];
  const sketchEffectLayerFragments = svgEffectLayerFragmentsForSource(plan.effects, object.id, sketchEffectSourceFragments);
  const effectLayerFragmentsForSource = (source: PageSvgElementFragment | undefined) =>
    hasSketchEffect
      ? sketchEffectLayerFragments
      : svgEffectLayerFragmentsForSource(plan.effects, object.id, source ? [source] : []);
  const children: PageSvgFragment[] = [
    ...svgPaintDefinitionFragments(plan.fill.paint, `graphic-fill-${object.id}`),
    ...svgPaintDefinitionFragments(plan.stroke.paint, `graphic-stroke-${object.id}`),
    ...(plan.glossGradient ? [
      elementFragment("defs", `graphic-gloss-defs-${object.id}`, {}, [
        elementFragment("radialGradient", `graphic-gloss-gradient-${object.id}`, {
          id: gradientId,
          cx: plan.glossGradient.cx,
          cy: plan.glossGradient.cy,
          r: plan.glossGradient.r,
          gradientTransform: plan.glossGradient.gradientTransform,
          gradientUnits: "userSpaceOnUse"
        }, svgGradientStopFragments(plan.glossGradient.stops, `graphic-gloss-${object.id}`, plan.fill.opacity))
      ])
    ] : [])
  ];
  let renderedGraphic = false;

  if (plan.projectedShapePathD) {
    renderedGraphic = true;
    const source = !hasSketchEffect
      ? elementFragment("path", `graphic-effect-source-${object.id}`, {
          d: plan.projectedShapePathD,
          ...svgEffectSourceAttrs(plan, closedFillEffectSource)
        })
      : undefined;
    children.push(...effectLayerFragmentsForSource(source));
    children.push(elementFragment("path", `graphic-projected-${object.id}`, {
      d: plan.projectedShapePathD,
      ...cleanStrokeAttrs,
      class: "graphic-glyph-stroke graphic-glyph-projected-shape",
      ...fillAttrs
    }));
  } else if (object.graphicKind === "line" && plan.line) {
    renderedGraphic = true;
    const visibleLine = plan.visibleLine ?? plan.line;
    const source = !hasSketchEffect
      ? elementFragment("line", `graphic-effect-source-${object.id}`, {
          x1: visibleLine.x1,
          y1: visibleLine.y1,
          x2: visibleLine.x2,
          y2: visibleLine.y2,
          ...svgEffectSourceAttrs(plan, false),
          transform: plan.projectionTransform
        })
      : undefined;
    children.push(...effectLayerFragmentsForSource(source));
    children.push(elementFragment("line", `graphic-line-${object.id}`, {
      x1: visibleLine.x1,
      y1: visibleLine.y1,
      x2: visibleLine.x2,
      y2: visibleLine.y2,
      ...cleanStrokeAttrs,
      transform: plan.projectionTransform
    }));
  } else if (object.graphicKind === "path" && plan.pathD) {
    renderedGraphic = true;
    const source = !hasSketchEffect
      ? elementFragment("path", `graphic-effect-source-${object.id}`, {
          d: plan.visiblePathD ?? plan.pathD,
          ...svgEffectSourceAttrs(plan, pathFillEffectSource),
          transform: plan.projectionTransform
        })
      : undefined;
    children.push(...effectLayerFragmentsForSource(source));
    children.push(elementFragment("path", `graphic-path-${object.id}`, {
      d: plan.visiblePathD ?? plan.pathD,
      ...cleanStrokeAttrs,
      class: "graphic-glyph-stroke graphic-glyph-path",
      ...(freehandPath || plan.capabilities.supportsFill ? fillAttrs : { fill: "none" }),
      transform: plan.projectionTransform
    }));
  } else if (object.graphicKind === "rect") {
    renderedGraphic = true;
    const source = !hasSketchEffect
      ? elementFragment("rect", `graphic-effect-source-${object.id}`, {
          x: object.x + plan.stroke.width / 2,
          y: object.y + plan.stroke.width / 2,
          width: Math.max(object.width - plan.stroke.width, 0.5),
          height: Math.max(object.height - plan.stroke.width, 0.5),
          rx: plan.cornerRadius,
          ry: plan.cornerRadius,
          ...svgEffectSourceAttrs(plan, closedFillEffectSource)
        })
      : undefined;
    children.push(...effectLayerFragmentsForSource(source));
    children.push(elementFragment("rect", `graphic-rect-${object.id}`, {
      x: object.x + plan.stroke.width / 2,
      y: object.y + plan.stroke.width / 2,
      width: Math.max(object.width - plan.stroke.width, 0.5),
      height: Math.max(object.height - plan.stroke.width, 0.5),
      rx: plan.cornerRadius,
      ry: plan.cornerRadius,
      ...cleanStrokeAttrs,
      ...fillAttrs
    }));
  } else if (object.graphicKind === "ellipse") {
    renderedGraphic = true;
    const source = !hasSketchEffect
      ? elementFragment("ellipse", `graphic-effect-source-${object.id}`, {
          cx: object.x + object.width / 2,
          cy: object.y + object.height / 2,
          rx: Math.max(object.width / 2 - plan.stroke.width / 2, 0.5),
          ry: Math.max(object.height / 2 - plan.stroke.width / 2, 0.5),
          ...svgEffectSourceAttrs(plan, closedFillEffectSource)
        })
      : undefined;
    children.push(...effectLayerFragmentsForSource(source));
    children.push(elementFragment("ellipse", `graphic-ellipse-${object.id}`, {
      cx: object.x + object.width / 2,
      cy: object.y + object.height / 2,
      rx: Math.max(object.width / 2 - plan.stroke.width / 2, 0.5),
      ry: Math.max(object.height / 2 - plan.stroke.width / 2, 0.5),
      ...cleanStrokeAttrs,
      ...fillAttrs
    }));
  }

  if (renderedGraphic) {
    children.push(...svgSketchEffectFragments(plan, object.id));
    children.push(...svgFlattenedGraphicMarkerFragments(plan, object.id));
    return elementFragment("g", `object-${object.id}`, objectAttributes(object, layerIndex, {
      opacity: plan.opacity === 1 ? undefined : plan.opacity,
      transform: rotationTransform(object)
    }), children);
  }

  warnings.push({
    code: "export.svg.graphic_fallback",
    message: `SVG export used a labeled fallback for graphic kind "${object.graphicKind}".`,
    objectId: object.id
  });
  return fallbackObjectFragment(object, layerIndex);
}

function graphicObjectIsFreehandPath(object: GraphicObject): boolean {
  return object.graphicKind === "path" && object.data.artPathKind === "freehand";
}

function svgPaintAttrs(
  attribute: "fill" | "stroke",
  paint: NativeArtPaintPlan,
  id: string
): Record<string, PageSvgAttributeValue> {
  const value = svgPaintValue(paint, id);
  if (paint.kind === "solid") {
    return {
      [attribute]: value,
      [`${attribute}-opacity`]: paint.opacity === 1 ? undefined : paint.opacity
    };
  }

  return { [attribute]: value };
}

function svgPaintValue(paint: NativeArtPaintPlan, id: string): string {
  if (paint.kind === "none") {
    return "none";
  }
  if (paint.kind === "solid") {
    return paint.color;
  }
  return `url(#${id})`;
}

function svgPaintDefinitionFragments(paint: NativeArtPaintPlan, id: string): PageSvgFragment[] {
  if (paint.kind === "linear-gradient") {
    return [
      elementFragment("defs", `${id}-defs`, {}, [
        elementFragment("linearGradient", `${id}-gradient`, {
          id,
          x1: paint.x1,
          y1: paint.y1,
          x2: paint.x2,
          y2: paint.y2,
          gradientTransform: paint.gradientTransform,
          gradientUnits: "userSpaceOnUse"
        }, svgGradientStopFragments(paint.stops, id))
      ])
    ];
  }

  if (paint.kind === "radial-gradient") {
    return [
      elementFragment("defs", `${id}-defs`, {}, [
        elementFragment("radialGradient", `${id}-gradient`, {
          id,
          cx: paint.cx,
          cy: paint.cy,
          r: paint.r,
          fx: paint.fx,
          fy: paint.fy,
          gradientTransform: paint.gradientTransform,
          gradientUnits: "userSpaceOnUse"
        }, svgGradientStopFragments(paint.stops, id))
      ])
    ];
  }

  return [];
}

function svgEffectSourceAttrs(
  plan: NativeArtVisualPlan,
  includeFill: boolean
): Record<string, PageSvgAttributeValue> | undefined {
  const hasFilter = plan.effects.some((effect) => effect.kind === "shadow" || effect.kind === "glow");
  if (!hasFilter) {
    return undefined;
  }

  return {
    class: "graphic-glyph-effect-source",
    "data-graphic-effect-source": "true",
    fill: includeFill && plan.fill.paint.kind !== "none" ? "#000000" : "none",
    stroke: plan.capabilities.supportsStroke && plan.stroke.paint.kind !== "none" ? "#000000" : "none",
    "stroke-width": plan.stroke.width,
    "stroke-dasharray": plan.stroke.dasharray,
    "stroke-linecap": plan.stroke.lineCap,
    "stroke-linejoin": plan.stroke.lineJoin,
    "stroke-miterlimit": plan.stroke.miterLimit,
    "vector-effect": "non-scaling-stroke",
    "pointer-events": "none"
  };
}

function svgEffectLayerFragmentsForSource(
  effects: readonly NativeArtEffectPlan[],
  objectId: string,
  sourceFragments: readonly PageSvgElementFragment[]
): PageSvgElementFragment[] {
  if (sourceFragments.length === 0) {
    return [];
  }

  return effects.flatMap((effect) => {
    if (effect.kind === "shadow") {
      const layers = [
        { width: effect.blurPx * 2, opacity: effect.opacity * 0.18 },
        { width: effect.blurPx, opacity: effect.opacity * 0.28 },
        { width: 0, opacity: effect.opacity * 0.54 }
      ];
      return layers.flatMap((layer, layerIndex) =>
        sourceFragments.map((source, sourceIndex) =>
          svgEffectLayerFragment(source, {
            objectId,
            effectKind: "shadow",
            color: effect.color,
            opacity: layer.opacity,
            strokeExpansion: layer.width,
            transform: `translate(${formatNumber(effect.offsetX)} ${formatNumber(effect.offsetY)})`,
            layerIndex,
            sourceIndex,
            includeFill: true
          })
        )
      );
    }

    if (effect.kind === "glow") {
      const layers = [
        { width: effect.spreadPx * 2 + effect.blurPx * 2.2, opacity: effect.opacity * 0.1 },
        { width: effect.spreadPx * 2 + effect.blurPx * 1.35, opacity: effect.opacity * 0.16 },
        { width: effect.spreadPx * 2 + effect.blurPx * 0.65, opacity: effect.opacity * 0.24 },
        { width: effect.spreadPx * 2, opacity: effect.opacity * 0.32 }
      ];
      return layers.flatMap((layer, layerIndex) =>
        sourceFragments.map((source, sourceIndex) =>
          svgEffectLayerFragment(source, {
            objectId,
            effectKind: "glow",
            color: effect.color,
            opacity: layer.opacity,
            strokeExpansion: layer.width,
            layerIndex,
            sourceIndex,
            includeFill: false
          })
        )
      );
    }

    return [];
  });
}

function svgEffectLayerFragment(
  source: PageSvgElementFragment,
  options: {
    objectId: string;
    effectKind: "shadow" | "glow";
    color: string;
    opacity: number;
    strokeExpansion: number;
    transform?: string;
    layerIndex: number;
    sourceIndex: number;
    includeFill: boolean;
  }
): PageSvgElementFragment {
  const sourceStroke = source.attrs.stroke;
  const sourceFill = source.attrs.fill;
  const hasStroke = sourceStroke !== undefined && sourceStroke !== "none";
  const hasFill = sourceFill !== undefined && sourceFill !== "none";
  const baseStrokeWidth = svgNumericAttribute(source.attrs["stroke-width"]) ?? 0;
  const effectStrokeWidth = hasStroke
    ? Math.max(0.5, baseStrokeWidth + options.strokeExpansion)
    : undefined;
  return {
    ...source,
    key: `${source.key}-${options.effectKind}-${options.layerIndex}-${options.sourceIndex}`,
    attrs: {
      ...source.attrs,
      class: "graphic-glyph-effect-layer",
      "data-graphic-effect": options.effectKind,
      "data-graphic-effect-layer": options.layerIndex + 1,
      "data-graphic-effect-source": undefined,
      fill: options.includeFill && hasFill ? options.color : "none",
      "fill-opacity": options.includeFill && hasFill ? clampSvgOpacity(options.opacity) : undefined,
      stroke: hasStroke ? options.color : "none",
      "stroke-width": effectStrokeWidth,
      "stroke-opacity": hasStroke ? clampSvgOpacity(options.opacity) : undefined,
      transform: appendSvgTransform(source.attrs.transform, options.transform),
      "pointer-events": "none"
    },
    children: source.children
  };
}

function svgNumericAttribute(value: PageSvgAttributeValue): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampSvgOpacity(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function appendSvgTransform(
  existing: PageSvgAttributeValue,
  next: string | undefined
): PageSvgAttributeValue {
  if (!next) {
    return existing;
  }
  return existing ? `${existing} ${next}` : next;
}

type SvgEffectFilterRegion = { x: number; y: number; width: number; height: number };

function svgEffectPadding(effect: NativeArtEffectPlan): number {
  if (effect.kind === "shadow") {
    return Math.max(Math.abs(effect.offsetX), Math.abs(effect.offsetY)) + effect.blurPx * 4 + 2;
  }
  if (effect.kind === "glow") {
    return effect.blurPx * 4 + effect.spreadPx * 2 + 2;
  }
  return 0;
}

function svgEffectFilterRegionForBounds(
  effects: readonly NativeArtEffectPlan[],
  bounds: { x: number; y: number; width: number; height: number }
): SvgEffectFilterRegion {
  const padding = Math.max(24, ...effects.map(svgEffectPadding));
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: Math.max(bounds.width + padding * 2, 1),
    height: Math.max(bounds.height + padding * 2, 1)
  };
}

function svgEffectDefinitionFragments(plan: NativeArtVisualPlan, id: string): PageSvgFragment[] {
  return svgEffectDefinitionFragmentsForEffects(
    plan.effects,
    id,
    svgEffectFilterRegionForBounds(plan.effects, plan.frameBounds)
  );
}

function svgEffectDefinitionFragmentsForEffects(
  effects: readonly NativeArtEffectPlan[],
  id: string,
  region: SvgEffectFilterRegion
): PageSvgFragment[] {
  const filterEffects = effects.filter((effect): effect is Extract<NativeArtEffectPlan, { kind: "shadow" | "glow" }> =>
    effect.kind === "shadow" || effect.kind === "glow"
  );
  if (filterEffects.length === 0) {
    return [];
  }

  const filterChildren: PageSvgFragment[] = [];
  const mergeInputs: string[] = [];
  filterEffects.forEach((effect) => {
    if (effect.kind === "shadow") {
      const blurResult = `${id}-shadow-blur`;
      const offsetResult = `${id}-shadow-offset`;
      const floodResult = `${id}-shadow-color`;
      const result = `${id}-shadow`;
      filterChildren.push(
        elementFragment("feGaussianBlur", blurResult, {
          in: "SourceAlpha",
          stdDeviation: effect.blurPx,
          result: blurResult
        }),
        elementFragment("feOffset", offsetResult, {
          in: blurResult,
          dx: effect.offsetX,
          dy: effect.offsetY,
          result: offsetResult
        }),
        elementFragment("feFlood", floodResult, {
          "flood-color": effect.color,
          "flood-opacity": effect.opacity,
          result: floodResult
        }),
        elementFragment("feComposite", result, {
          in: floodResult,
          in2: offsetResult,
          operator: "in",
          result
        })
      );
      mergeInputs.push(result);
      return;
    }

    const spreadResult = `${id}-glow-spread`;
    const blurInput = effect.spreadPx > 0 ? spreadResult : "SourceAlpha";
    const blurResult = `${id}-glow-blur`;
    const floodResult = `${id}-glow-color`;
    const compositeResult = `${id}-glow`;
    if (effect.spreadPx > 0) {
      filterChildren.push(elementFragment("feMorphology", spreadResult, {
        in: "SourceAlpha",
        operator: "dilate",
        radius: effect.spreadPx,
        result: spreadResult
      }));
    }
    filterChildren.push(
      elementFragment("feGaussianBlur", blurResult, {
        in: blurInput,
        stdDeviation: effect.blurPx,
        result: blurResult
      }),
      elementFragment("feFlood", floodResult, {
        "flood-color": effect.color,
        "flood-opacity": effect.opacity,
        result: floodResult
      }),
      elementFragment("feComposite", compositeResult, {
        in: floodResult,
        in2: blurResult,
        operator: "in",
        result: compositeResult
      })
    );
    mergeInputs.push(compositeResult);
  });

  filterChildren.push(elementFragment("feMerge", `${id}-merge`, {}, [
    ...mergeInputs.map((input, index) => elementFragment("feMergeNode", `${id}-merge-${index}`, { in: input }))
  ]));

  return [
    elementFragment("defs", `${id}-defs`, {}, [
      elementFragment("filter", id, {
        id,
        filterUnits: "userSpaceOnUse",
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        "color-interpolation-filters": "sRGB"
      }, filterChildren)
    ])
  ];
}

function svgSketchEffectFragments(plan: NativeArtVisualPlan, objectId: string): PageSvgFragment[] {
  const transform = plan.projectedShapePathD ? undefined : plan.projectionTransform;
  return svgSketchEffectFragmentsForEffects(plan.effects, objectId, {
    className: "graphic-glyph-sketch",
    dataAttribute: "data-graphic-effect",
    keyPrefix: "graphic-sketch",
    transform
  });
}

function svgSketchEffectSourceFragments(plan: NativeArtVisualPlan, objectId: string): PageSvgElementFragment[] {
  const sketch = plan.effects.find((effect) => effect.kind === "sketch");
  if (!sketch) {
    return [];
  }

  const transform = plan.projectedShapePathD ? undefined : plan.projectionTransform;
  return sketch.paths.map((path, index) => elementFragment("path", `graphic-sketch-effect-source-${objectId}-${index}`, {
    class: "graphic-glyph-effect-source",
    "data-graphic-effect-source": "true",
    d: path.d,
    fill: path.fill && path.fill !== "none" ? "#000000" : "none",
    stroke: "#000000",
    "stroke-width": path.strokeWidth,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    transform,
    "pointer-events": "none"
  }));
}

function svgSketchEffectFragmentsForEffects(
  effects: readonly NativeArtEffectPlan[],
  objectId: string,
  options: {
    className: string;
    dataAttribute: string;
    keyPrefix: string;
    transform?: string;
  }
): PageSvgFragment[] {
  const sketch = effects.find((effect) => effect.kind === "sketch");
  if (!sketch) {
    return [];
  }

  return sketch.paths.map((path, index) => elementFragment("path", `${options.keyPrefix}-${objectId}-${index}`, {
    class: options.className,
    [options.dataAttribute]: "sketch",
    d: path.d,
    fill: path.fill ?? "none",
    stroke: path.stroke,
    "stroke-width": path.strokeWidth,
    "stroke-opacity": sketch.opacity === 1 ? undefined : sketch.opacity,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    transform: options.transform,
    "pointer-events": "none"
  }));
}

/** The no-reaction ✗ drawn across a shaft midpoint. Mirrors the canvas renderer's geometry (two
 *  strokes at ±45° to the local tangent, each `sizePx` long, centred on the mark point) — without
 *  this the mark was planned but never exported, so a no-reaction arrow left the app as an ordinary
 *  forward arrow. */
function svgFlattenedShaftMarkFragments(plan: NativeArtVisualPlan, objectId: string): PageSvgFragment[] {
  const mark = plan.shaftMark;
  if (!mark) {
    return [];
  }

  const normal = { x: -mark.direction.y, y: mark.direction.x };
  const arm = mark.sizePx / 2;
  const invSqrt2 = Math.SQRT1_2;
  const armA = {
    x: (mark.direction.x + normal.x) * invSqrt2,
    y: (mark.direction.y + normal.y) * invSqrt2
  };
  const armB = {
    x: (mark.direction.x - normal.x) * invSqrt2,
    y: (mark.direction.y - normal.y) * invSqrt2
  };
  const d = [
    `M ${formatNumber(mark.point.x - armA.x * arm)} ${formatNumber(mark.point.y - armA.y * arm)}`,
    `L ${formatNumber(mark.point.x + armA.x * arm)} ${formatNumber(mark.point.y + armA.y * arm)}`,
    `M ${formatNumber(mark.point.x - armB.x * arm)} ${formatNumber(mark.point.y - armB.y * arm)}`,
    `L ${formatNumber(mark.point.x + armB.x * arm)} ${formatNumber(mark.point.y + armB.y * arm)}`
  ].join(" ");
  return [elementFragment("path", `graphic-shaft-mark-${objectId}`, {
    "data-graphic-shaft-mark": mark.kind,
    d,
    fill: "none",
    stroke: plan.stroke.color,
    "stroke-opacity": plan.stroke.opacity === 1 ? undefined : plan.stroke.opacity,
    "stroke-width": Math.max(1.6, plan.stroke.width),
    "stroke-linecap": "round",
    transform: plan.projectionTransform
  })];
}

function svgFlattenedGraphicMarkerFragments(plan: NativeArtVisualPlan, objectId: string): PageSvgFragment[] {
  return [
    ...svgFlattenedShaftMarkFragments(plan, objectId),
    ...(plan.markerStart && plan.markerStartTerminal
      ? svgFlattenedMarkerFragments(
          plan.markerStart,
          plan.markerStartTerminal,
          `graphic-marker-start-${objectId}`,
          "start",
          plan.stroke.color,
          plan.stroke.opacity,
          plan.projectionTransform
        )
      : []),
    ...(plan.markerEnd && plan.markerEndTerminal
      ? svgFlattenedMarkerFragments(
          plan.markerEnd,
          plan.markerEndTerminal,
          `graphic-marker-end-${objectId}`,
          "end",
          plan.stroke.color,
          plan.stroke.opacity,
          plan.projectionTransform
        )
      : [])
  ];
}

function svgFlattenedMarkerFragments(
  marker: NativeArtMarkerPlan,
  terminal: NativeArtStrokeTerminalPlan,
  id: string,
  placement: "start" | "end",
  color: string,
  opacity: number,
  transform: string | undefined
): PageSvgFragment[] {
  const size = Math.max(2, marker.sizePx);
  const half = size / 2;
  const direction = marker.angleDegrees === 0
    ? markerTerminalDirection(terminal)
    : { x: Math.cos(degreesToRadians(marker.angleDegrees)), y: Math.sin(degreesToRadians(marker.angleDegrees)) };
  const normal = { x: -direction.y, y: direction.x };
  const strokeWidth = Math.max(1.4, size * 0.16);
  const strokeAttrs = {
    stroke: color,
    "stroke-opacity": opacity === 1 ? undefined : opacity,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "stroke-width": strokeWidth
  };
  const fillAttrs = {
    fill: color,
    "fill-opacity": opacity === 1 ? undefined : opacity
  };

  const attrs = {
    id,
    "data-graphic-marker": placement,
    transform
  };
  const tip = terminal.point;
  const markerPoint = (back: number, offset: number): LayoutPoint => ({
    x: tip.x - direction.x * back + normal.x * offset,
    y: tip.y - direction.y * back + normal.y * offset
  });
  const markerPath = (points: readonly LayoutPoint[], closed = true): string => [
    `M ${formatNumber(points[0]?.x ?? tip.x)} ${formatNumber(points[0]?.y ?? tip.y)}`,
    ...points.slice(1).map((point) => `L ${formatNumber(point.x)} ${formatNumber(point.y)}`),
    closed ? "Z" : ""
  ].filter(Boolean).join(" ");

  if (marker.kind === "filled-arrow") {
    return [elementFragment("path", id, {
      ...attrs,
      d: markerPath([tip, markerPoint(size, -half), markerPoint(size, half)]),
      ...fillAttrs,
      stroke: "none"
    })];
  }

  if (marker.kind === "half-arrow") {
    // Fishhook: a single-sided barb whose inner point sits back along the shaft. Same geometry the
    // canvas draws (MainWindow's marker renderer) — without this branch it fell through to the bar
    // fallback below and every fishhook/equilibrium head exported as a perpendicular crossbar.
    return [elementFragment("path", id, {
      ...attrs,
      d: markerPath([tip, markerPoint(size, -half), markerPoint(size * 0.4, 0)]),
      ...fillAttrs,
      stroke: "none"
    })];
  }

  if (marker.kind === "open-arrow") {
    return [elementFragment("path", id, {
      ...attrs,
      d: [
        `M ${formatNumber(tip.x)} ${formatNumber(tip.y)}`,
        `L ${formatNumber(markerPoint(size, -half).x)} ${formatNumber(markerPoint(size, -half).y)}`,
        `M ${formatNumber(tip.x)} ${formatNumber(tip.y)}`,
        `L ${formatNumber(markerPoint(size, half).x)} ${formatNumber(markerPoint(size, half).y)}`
      ].join(" "),
      fill: "none",
      ...strokeAttrs
    })];
  }

  if (marker.kind === "chevron") {
    return [elementFragment("path", id, {
      ...attrs,
      d: markerPath([
        tip,
        markerPoint(size * 0.82, -half),
        markerPoint(size * 0.52, 0),
        markerPoint(size * 0.82, half)
      ]),
      ...fillAttrs,
      stroke: "none"
    })];
  }

  if (marker.kind === "diamond") {
    return [elementFragment("path", id, {
      ...attrs,
      d: markerPath([
        tip,
        markerPoint(size * 0.5, -half),
        markerPoint(size, 0),
        markerPoint(size * 0.5, half)
      ]),
      ...fillAttrs,
      stroke: "none"
    })];
  }

  if (marker.kind === "dot") {
    const center = markerPoint(half, 0);
    return [elementFragment("circle", id, {
      ...attrs,
      cx: center.x,
      cy: center.y,
      r: Math.max(1, size * 0.38),
      ...fillAttrs
    })];
  }

  const barStart = markerPoint(0, -half);
  const barEnd = markerPoint(0, half);
  return [elementFragment("path", id, {
    ...attrs,
    d: `M ${formatNumber(barStart.x)} ${formatNumber(barStart.y)} L ${formatNumber(barEnd.x)} ${formatNumber(barEnd.y)}`,
    fill: "none",
    ...strokeAttrs
  })];
}

function markerTerminalDirection(terminal: NativeArtStrokeTerminalPlan): LayoutPoint {
  const length = Math.hypot(terminal.direction.x, terminal.direction.y);
  if (!Number.isFinite(length) || length <= 0.001) {
    return { x: 1, y: 0 };
  }

  return {
    x: terminal.direction.x / length,
    y: terminal.direction.y / length
  };
}

function svgGradientStopFragments(
  stops: readonly NativeArtGradientStopPlan[],
  id: string,
  opacityMultiplier = 1
): PageSvgFragment[] {
  return stops.map((stop, index) => {
    const opacity = clamp(stop.opacity * opacityMultiplier, 0, 1);
    return elementFragment("stop", `${id}-stop-${index}`, {
      offset: `${Number((stop.offset * 100).toFixed(4))}%`,
      "stop-color": stop.color,
      "stop-opacity": opacity === 1 ? undefined : opacity
    });
  });
}

function warnForGraphicSvgEffects(object: GraphicObject, warnings: PageSvgRenderWarning[]): void {
  if (object.style.effect === "reflection") {
    warnings.push({
      code: "export.svg.graphic_effect_approximation",
      message: `SVG export omitted the native ${object.style.effect} graphic effect.`,
      objectId: object.id
    });
  }
}

export function planNativeArtVisual(
  object: GraphicObject,
  options: { coordinateSpace?: NativeArtVisualCoordinateSpace } = {}
): NativeArtVisualPlan {
  return planNativeArtVisualFromArtEngine(object, options);
}

function reactionArrowFragment(object: ArrowObject, layerIndex: number): PageSvgElementFragment {
  const start = arrowAnchorPointForObject(object, object.start, { x: object.x, y: object.y + object.height / 2 });
  const end = arrowAnchorPointForObject(object, object.end, { x: object.x + object.width, y: object.y + object.height / 2 });
  const geometry = planReactionArrowGeometry(object.arrowKind, start, end);
  return elementFragment("g", `object-${object.id}`, objectAttributes(object, layerIndex, {
    transform: rotationTransform(object)
  }), [
    ...geometry.lines.map((line, index) =>
      elementFragment("line", `reaction-arrow-line-${object.id}-${index}`, {
        class: "reaction-arrow-line",
        "data-arrow-kind": object.arrowKind,
        x1: line.start.x,
        y1: line.start.y,
        x2: line.end.x,
        y2: line.end.y,
        stroke: "#172026",
        "stroke-width": 1.5,
        "stroke-linecap": "round"
      })
    ),
    ...geometry.heads.map((head, index) =>
      elementFragment("polygon", `reaction-arrow-head-${object.id}-${index}`, {
        class: "reaction-arrow-head",
        "data-arrow-kind": object.arrowKind,
        points: head.points
          .map((point) => `${formatNumber(point.x)},${formatNumber(point.y)}`)
          .join(" "),
        fill: head.filled ? "#172026" : "none",
        stroke: head.filled ? "none" : "#172026",
        "stroke-width": head.filled ? undefined : 1.5,
        "stroke-linejoin": head.filled ? undefined : "round"
      })
    )
  ]);
}

function arrowAnchorPointForObject(
  object: ArrowObject,
  anchor: ArrowObject["start"] | ArrowObject["end"],
  fallback: LayoutPoint
): LayoutPoint {
  if (anchor.kind === "point" && anchor.point) {
    return anchor.point;
  }
  return fallback;
}

/** Shared bracket glyph outline for the canvas renderer and SVG export, in object-local
 *  coordinates. "round" is a single open curve, "curly" a brace with a center spur; "polymer" and
 *  "unknown" fall back to the square outline. */
export function bracketGlyphPathD(
  kind: BracketObject["bracketKind"],
  width: number,
  height: number
): string {
  const right = Math.max(width - 1, 0);
  const bottom = Math.max(height - 1, 0);
  if (kind === "round") {
    return `M ${right} 0 C ${width * 0.18} ${height * 0.16}, ${width * 0.18} ${height * 0.84}, ${right} ${bottom}`;
  }
  if (kind === "curly") {
    return [
      `M ${right} 0`,
      `C ${width * 0.15} ${height * 0.1}, ${width * 0.85} ${height * 0.38}, ${width * 0.2} ${height * 0.5}`,
      `C ${width * 0.85} ${height * 0.62}, ${width * 0.15} ${height * 0.9}, ${right} ${bottom}`
    ].join(" ");
  }
  return `M ${right} 0 L 0 0 L 0 ${bottom} L ${right} ${bottom}`;
}

function bracketObjectFragment(object: BracketObject, layerIndex: number): PageSvgElementFragment {
  const width = Math.max(object.width, 1);
  const height = Math.max(object.height, 1);
  return elementFragment("g", `object-${object.id}`, objectAttributes(object, layerIndex, {
    transform: rotationTransform(object)
  }), [
    elementFragment("path", `bracket-path-${object.id}`, {
      class: "bracket-glyph-path",
      "data-bracket-kind": object.bracketKind,
      transform: `translate(${formatNumber(object.x)} ${formatNumber(object.y)})`,
      d: bracketGlyphPathD(object.bracketKind, width, height),
      fill: "none",
      stroke: "#172026",
      "stroke-width": 1.5,
      "stroke-linecap": "round",
      "stroke-linejoin": "round"
    })
  ]);
}

export interface ReactionArrowGeometry {
  lines: Array<{ start: LayoutPoint; end: LayoutPoint }>;
  heads: Array<{ points: readonly LayoutPoint[]; filled: boolean }>;
}

const reactionArrowHeadLengthPx = 9;
const reactionArrowHeadHalfWidthPx = 4.5;
const equilibriumShaftOffsetPx = 3;
const retroShaftOffsetPx = 2.5;

/** Shared reaction-arrow geometry for the canvas renderer and SVG export: shaft lines plus head
 *  polygons per arrow kind (forward filled head, resonance double head, equilibrium harpoon pair,
 *  retrosynthesis parallel shafts with an open chevron). "unknown" stays a bare line so imported
 *  arrows with unrecognized kinds do not invent a direction. */
export function planReactionArrowGeometry(
  arrowKind: ArrowObject["arrowKind"],
  start: LayoutPoint,
  end: LayoutPoint
): ReactionArrowGeometry {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return { lines: [{ start, end }], heads: [] };
  }

  const unit = { x: dx / length, y: dy / length };
  const normal = { x: -unit.y, y: unit.x };
  const offsetPoint = (point: LayoutPoint, along: number, aside: number): LayoutPoint => ({
    x: point.x + unit.x * along + normal.x * aside,
    y: point.y + unit.y * along + normal.y * aside
  });
  const filledHead = (tip: LayoutPoint, direction: 1 | -1): ReactionArrowGeometry["heads"][number] => {
    const base = offsetPoint(tip, -direction * reactionArrowHeadLengthPx, 0);
    return {
      points: [
        tip,
        offsetPoint(base, 0, reactionArrowHeadHalfWidthPx),
        offsetPoint(base, 0, -reactionArrowHeadHalfWidthPx)
      ],
      filled: true
    };
  };

  if (arrowKind === "unknown") {
    return { lines: [{ start, end }], heads: [] };
  }

  if (arrowKind === "resonance") {
    return { lines: [{ start, end }], heads: [filledHead(end, 1), filledHead(start, -1)] };
  }

  if (arrowKind === "equilibrium") {
    const topStart = offsetPoint(start, 0, -equilibriumShaftOffsetPx);
    const topEnd = offsetPoint(end, 0, -equilibriumShaftOffsetPx);
    const bottomStart = offsetPoint(start, 0, equilibriumShaftOffsetPx);
    const bottomEnd = offsetPoint(end, 0, equilibriumShaftOffsetPx);
    const topHarpoonBase = offsetPoint(topEnd, -reactionArrowHeadLengthPx, 0);
    const bottomHarpoonBase = offsetPoint(bottomStart, reactionArrowHeadLengthPx, 0);
    return {
      lines: [
        { start: topStart, end: topEnd },
        { start: bottomStart, end: bottomEnd }
      ],
      heads: [
        // Top shaft points toward `end` with its single wing away from the centerline; the bottom
        // shaft mirrors it toward `start`.
        { points: [topEnd, offsetPoint(topHarpoonBase, 0, -reactionArrowHeadHalfWidthPx), topHarpoonBase], filled: true },
        { points: [bottomStart, offsetPoint(bottomHarpoonBase, 0, reactionArrowHeadHalfWidthPx), bottomHarpoonBase], filled: true }
      ]
    };
  }

  if (arrowKind === "retrosynthesis") {
    const shaftEnd = -3;
    return {
      lines: [
        { start: offsetPoint(start, 0, -retroShaftOffsetPx), end: offsetPoint(end, shaftEnd, -retroShaftOffsetPx) },
        { start: offsetPoint(start, 0, retroShaftOffsetPx), end: offsetPoint(end, shaftEnd, retroShaftOffsetPx) },
        { start: end, end: offsetPoint(end, -10, 7) },
        { start: end, end: offsetPoint(end, -10, -7) }
      ],
      heads: []
    };
  }

  return { lines: [{ start, end }], heads: [filledHead(end, 1)] };
}

function fallbackObjectFragmentWithWarning(
  object: DocumentObject,
  warnings: PageSvgRenderWarning[],
  layerIndex: number
): PageSvgElementFragment {
  warnings.push({
    code: "export.svg.object_fallback",
    message: `SVG export used a labeled fallback for object type "${object.type}".`,
    objectId: object.id
  });
  return fallbackObjectFragment(object, layerIndex);
}

function fallbackObjectFragment(object: DocumentObject, layerIndex: number): PageSvgElementFragment {
  return elementFragment("g", `object-${object.id}`, objectAttributes(object, layerIndex, {
    transform: rotationTransform(object)
  }), [
    elementFragment("rect", `fallback-box-${object.id}`, {
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
      rx: 4,
      fill: "#ffffff",
      stroke: "#69757d",
      "stroke-width": 1
    }),
    elementFragment("text", `fallback-label-${object.id}`, {
      x: object.x + 8,
      y: object.y + 20,
      "font-family": "Arial, sans-serif",
      "font-size": 11,
      fill: "#52616b"
    }, [textFragment(`fallback-label-text-${object.id}`, object.type)])
  ]);
}

function centeredTextFragment(
  object: DocumentObject,
  label: string,
  fontSize: number,
  fontWeight: number,
  layerIndex: number
): PageSvgElementFragment {
  return elementFragment("text", `object-${object.id}`, objectAttributes(object, layerIndex, {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2,
    "dominant-baseline": "middle",
    "text-anchor": "middle",
    "font-family": "Arial, sans-serif",
    "font-size": fontSize,
    "font-weight": fontWeight,
    fill: "#172026",
    transform: rotationTransform(object)
  }), [textFragment(`centered-text-${object.id}`, label)]);
}

function objectAttributes(
  object: DocumentObject,
  layerIndex: number,
  extra: Record<string, PageSvgAttributeValue> = {}
): Record<string, PageSvgAttributeValue> {
  return {
    "data-object-id": object.id,
    "data-layer-index": layerIndex,
    "data-object-type": object.type,
    ...extra
  };
}

function elementFragment(
  tag: string,
  key: string,
  attrs: Record<string, PageSvgAttributeValue> = {},
  children: PageSvgFragment[] = []
): PageSvgElementFragment {
  return { kind: "element", key, tag, attrs, children };
}

function textFragment(key: string, text: string): PageSvgTextFragment {
  return { kind: "text", key, text };
}

function bondLineSegments(
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  object: MoleculeObject,
  bond: CoreMoleculeBond,
  drawingStyle: NativeDrawingStyle,
  fromLabel?: string,
  toLabel?: string,
  fromLabelStyle?: NativeDrawingStyle,
  toLabelStyle?: NativeDrawingStyle,
  ringInteriorSide?: DoubleBondSide
): PageBondLineSegment[] {
  const dx = toAtom.x - fromAtom.x;
  const dy = toAtom.y - fromAtom.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return [{ x1: fromAtom.x, y1: fromAtom.y, x2: toAtom.x, y2: toAtom.y, segment: "primary" }];
  }

  const unit = { x: dx / length, y: dy / length };
  const clearance = labelEndpointClearance(
    fromAtom,
    toAtom,
    fromLabel,
    toLabel,
    drawingStyle,
    length,
    unit,
    fromLabelStyle,
    toLabelStyle
  );
  const x1 = fromAtom.x + unit.x * clearance.from;
  const y1 = fromAtom.y + unit.y * clearance.from;
  const x2 = toAtom.x - unit.x * clearance.to;
  const y2 = toAtom.y - unit.y * clearance.to;
  const trimmedLength = Math.hypot(x2 - x1, y2 - y1);
  const normal = { x: -unit.y, y: unit.x };
  const gap = nativeMultipleBondGapPx(drawingStyle);

  if (bond.order === "double") {
    const terminalHeteroatomSide = terminalHeteroatomDoubleBondInnerSide(
      fromAtom,
      toAtom,
      object,
      bond
    );
    // A terminal heteroatom double bond with no derivable inner side (a ketone's two backbone
    // neighbors, formaldehyde's none) has no publication convention to lean on: keep the legacy
    // symmetric ±gap/2 straddle so a symmetric molecule never picks an arbitrary side. The user's
    // explicit side still wins below.
    if (
      bond.display?.doubleBondSide === undefined &&
      ringInteriorSide === undefined &&
      terminalHeteroatomSide === undefined &&
      isTerminalHeteroatomDoubleBond(fromAtom, toAtom, object, bond)
    ) {
      const halfGap = gap / 2;
      return [
        {
          x1: x1 + normal.x * halfGap,
          y1: y1 + normal.y * halfGap,
          x2: x2 + normal.x * halfGap,
          y2: y2 + normal.y * halfGap,
          segment: "primary",
          doubleBondSide: "left"
        },
        {
          x1: x1 - normal.x * halfGap,
          y1: y1 - normal.y * halfGap,
          x2: x2 - normal.x * halfGap,
          y2: y2 - normal.y * halfGap,
          segment: "secondary",
          doubleBondSide: "left"
        }
      ];
    }

    // Default a ring double bond's inner line to the ring interior; the user's explicit side
    // (bond.display.doubleBondSide) always wins. A terminal heteroatom double bond (such as an
    // aldehyde C=O) follows the same publication convention as a ring: the primary line stays on
    // the bond centerline and meets the backbone junction, while the short secondary line sits on
    // the side facing the adjacent backbone bond.
    const doubleBondSide =
      bond.display?.doubleBondSide ??
      ringInteriorSide ??
      terminalHeteroatomSide ??
      "left";

    const offset = doubleBondSide === "left" ? gap : -gap;
    const minimumSecondaryLength = Math.min(doubleBondMinimumVisibleSegmentPx, trimmedLength);
    const inset = Math.min(
      drawingStyle.doubleBondInsetPx,
      Math.max(0, (trimmedLength - minimumSecondaryLength) / 2)
    );
    const methyleneEnds = terminalMethyleneCarbons(fromAtom, toAtom, object, bond);
    const secondaryFromInset = methyleneEnds.some((atom) => atom.id === fromAtom.id) ? 0 : inset;
    const secondaryToInset = methyleneEnds.some((atom) => atom.id === toAtom.id) ? 0 : inset;
    return [
      { x1, y1, x2, y2, segment: "primary", doubleBondSide },
      {
        x1: x1 + unit.x * secondaryFromInset + normal.x * offset,
        y1: y1 + unit.y * secondaryFromInset + normal.y * offset,
        x2: x2 - unit.x * secondaryToInset + normal.x * offset,
        y2: y2 - unit.y * secondaryToInset + normal.y * offset,
        segment: "secondary",
        doubleBondSide
      }
    ];
  }

  if (bond.order === "triple") {
    return [-gap, 0, gap].map((offset, index) => ({
      x1: x1 + normal.x * offset,
      y1: y1 + normal.y * offset,
      x2: x2 + normal.x * offset,
      y2: y2 + normal.y * offset,
      segment: index === 1 ? "primary" : "outer"
    }));
  }

  return [{ x1, y1, x2, y2, segment: "primary" }];
}

export function labelEndpointClearance(
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  fromLabel: string | undefined,
  toLabel: string | undefined,
  drawingStyle: NativeDrawingStyle,
  bondLength: number,
  unit: { x: number; y: number },
  fromLabelStyle: NativeDrawingStyle = drawingStyle,
  toLabelStyle: NativeDrawingStyle = drawingStyle
): { from: number; to: number } {
  const from = atomLabelBondClearance(fromAtom, fromLabel, fromLabelStyle, unit);
  const to = atomLabelBondClearance(toAtom, toLabel, toLabelStyle, { x: -unit.x, y: -unit.y });
  const total = from + to;
  const maximumTotal = bondLength * 0.55;
  if (total <= maximumTotal || total === 0) {
    return { from, to };
  }

  const scale = maximumTotal / total;
  return { from: from * scale, to: to * scale };
}

function atomLabelBondClearance(
  atom: MoleculeAtom,
  label: string | undefined,
  drawingStyle: NativeDrawingStyle,
  direction: { x: number; y: number }
): number {
  if (!label) {
    return 0;
  }

  const bounds = atomLabelBoundsRelativeToAtom(atom, label, drawingStyle);
  const horizontalDistance = direction.x > 0.0001
    ? (bounds.x + bounds.width) / direction.x
    : direction.x < -0.0001
      ? bounds.x / direction.x
      : Number.POSITIVE_INFINITY;
  const verticalDistance = direction.y > 0.0001
    ? (bounds.y + bounds.height) / direction.y
    : direction.y < -0.0001
      ? bounds.y / direction.y
      : Number.POSITIVE_INFINITY;
  const labelBoundaryDistance = Math.min(horizontalDistance, verticalDistance);

  return Math.max(
    drawingStyle.atomLabelBondClearancePx,
    drawingStyle.bondMarginWidthPx,
    Math.max(0, labelBoundaryDistance)
  );
}

function atomLabelBox(
  atom: MoleculeAtom,
  label: string,
  drawingStyle: NativeDrawingStyle
): { x: number; y: number; width: number; height: number } {
  const layout = atomLabelLayout(label, drawingStyle);
  const anchor = atomLabelAnchor(atom, label, drawingStyle, layout);
  const { bounds } = layout;
  return {
    x: anchor.x + bounds.x,
    y: anchor.y + bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

function atomLabelAnchor(
  atom: MoleculeAtom,
  label: string,
  drawingStyle: NativeDrawingStyle,
  layout = atomLabelLayout(label, drawingStyle)
): LayoutPoint {
  const offset = atomLabelAnchorOffset(atom, label, drawingStyle, layout);
  return {
    x: atom.x + offset.x,
    y: atom.y + offset.y
  };
}

export function atomLabelAnchorOffset(
  atom: MoleculeAtom,
  label: string,
  drawingStyle: NativeDrawingStyle = DefaultNativeDrawingStyle,
  layout = atomLabelLayout(label, drawingStyle)
): LayoutPoint {
  if (atom.labelOffset) {
    return atom.labelOffset;
  }

  const verticalGap = drawingStyle.atomLabelFontSizePx * 0.35;
  if (drawingStyle.atomLabelPlacement === "above") {
    return { x: 0, y: -(layout.bounds.height / 2 + verticalGap) };
  }
  if (drawingStyle.atomLabelPlacement === "below") {
    return { x: 0, y: layout.bounds.height / 2 + verticalGap };
  }

  return { x: 0, y: 0 };
}

function atomLabelBoundsRelativeToAtom(
  atom: MoleculeAtom,
  label: string,
  drawingStyle: NativeDrawingStyle
): { x: number; y: number; width: number; height: number } {
  const layout = atomLabelLayout(label, drawingStyle);
  const { bounds } = layout;
  const anchorOffset = atomLabelAnchorOffset(atom, label, drawingStyle, layout);
  return {
    x: anchorOffset.x + bounds.x,
    y: anchorOffset.y + bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

export type AtomLabelScript = "normal" | "subscript" | "superscript";

export interface AtomLabelRun {
  text: string;
  script: AtomLabelScript;
}

export interface AtomLabelLayoutRun extends AtomLabelRun {
  x: number;
  y: number;
  textAnchor: "middle" | "start" | "end";
}

export interface AtomLabelLayout {
  bounds: { x: number; y: number; width: number; height: number };
  runs: AtomLabelLayoutRun[];
}

export interface AtomLabelPlan {
  atom: MoleculeAtom;
  label: string;
  anchor: LayoutPoint;
  anchorOffset: LayoutPoint;
  layout: AtomLabelLayout;
  drawingStyle: NativeDrawingStyle;
  color: string;
  backgroundColor: string;
  backgroundVisible: boolean;
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  fontStyle: NativeDrawingStyle["atomLabelFontStyle"];
}

export function planMoleculeAtomLabels(object: MoleculeObject): AtomLabelPlan[] {
  const drawingStyle = nativeDrawingStyleFromObjectStyle(object.style);
  return object.atoms.flatMap((atom) => {
    const atomLabelStyle = nativeMoleculeAtomLabelStyle(object, atom.id, drawingStyle);
    const plan = planAtomLabel(
      atom,
      object.bonds,
      atomLabelStyle,
      atomLabelStyle.atomLabelColor,
      object.atoms
    );
    return plan ? [plan] : [];
  });
}

export function planAtomLabel(
  atom: MoleculeAtom,
  bonds: readonly CoreMoleculeBond[],
  drawingStyle: NativeDrawingStyle = DefaultNativeDrawingStyle,
  color = drawingStyle.atomLabelColor,
  atoms: readonly MoleculeAtom[] = []
): AtomLabelPlan | undefined {
  const label = atomDisplayLabel(atom, bonds, drawingStyle, atoms);
  if (!label) {
    return undefined;
  }

  const layout = atomLabelLayout(label, drawingStyle);
  const anchorOffset = atomLabelAnchorOffset(atom, label, drawingStyle);
  const anchor = {
    x: atom.x + anchorOffset.x,
    y: atom.y + anchorOffset.y
  };
  const backgroundColor = drawingStyle.atomLabelBackgroundColor;
  return {
    atom,
    label,
    anchor,
    anchorOffset,
    layout,
    drawingStyle,
    color,
    backgroundColor,
    backgroundVisible: backgroundColor !== "transparent",
    fontFamily: drawingStyle.atomLabelFontFamily,
    fontSizePx: drawingStyle.atomLabelFontSizePx,
    fontWeight: drawingStyle.atomLabelFontWeight,
    fontStyle: drawingStyle.atomLabelFontStyle
  };
}

export function atomLabelLayout(label: string, drawingStyle: NativeDrawingStyle): AtomLabelLayout {
  const { bodyRuns, chargeRun } = atomLabelParts(label);
  const leadingHydrogenElement = leadingImplicitHydrogenElement(label);
  if (leadingHydrogenElement) {
    return leadingImplicitHydrogenAtomLabelLayout(
      leadingHydrogenElement,
      chargeRun,
      drawingStyle
    );
  }
  const baseText = bodyRuns.filter((run) => run.script === "normal").map((run) => run.text).join("") || label;
  const suffixRuns = bodyRuns.filter((run) => run.script !== "normal");
  const baseWidth = atomLabelRunWidth({ text: baseText, script: "normal" }, drawingStyle);
  const baseHalfWidth = baseWidth / 2;
  const baseHalfHeight = drawingStyle.atomLabelFontSizePx * 0.54;
  const runs: AtomLabelLayoutRun[] = [
    {
      text: baseText,
      script: "normal",
      x: 0,
      y: 0,
      textAnchor: "middle"
    }
  ];
  let right = baseHalfWidth;
  let top = -baseHalfHeight;
  let bottom = baseHalfHeight;
  let cursor = baseHalfWidth + drawingStyle.atomLabelFontSizePx * 0.04;

  for (const run of suffixRuns) {
    const fontSize = atomLabelRunFontSize(run.script, drawingStyle) ?? drawingStyle.atomLabelFontSizePx;
    const width = atomLabelRunWidth(run, drawingStyle);
    const y = run.script === "subscript"
      ? drawingStyle.atomLabelFontSizePx * 0.34
      : -drawingStyle.atomLabelFontSizePx * 0.42;
    runs.push({
      ...run,
      x: cursor,
      y,
      textAnchor: "start"
    });
    right = Math.max(right, cursor + width);
    top = Math.min(top, y - fontSize * 0.52);
    bottom = Math.max(bottom, y + fontSize * 0.52);
    cursor += width + drawingStyle.atomLabelFontSizePx * 0.03;
  }

  if (chargeRun) {
    const fontSize = atomLabelRunFontSize(chargeRun.script, drawingStyle) ?? drawingStyle.atomLabelFontSizePx;
    const width = atomLabelRunWidth(chargeRun, drawingStyle);
    const x = Math.max(cursor, baseHalfWidth + drawingStyle.atomLabelFontSizePx * 0.08);
    const y = -drawingStyle.atomLabelFontSizePx * 0.48;
    runs.push({
      ...chargeRun,
      x,
      y,
      textAnchor: "start"
    });
    right = Math.max(right, x + width);
    top = Math.min(top, y - fontSize * 0.52);
    bottom = Math.max(bottom, y + fontSize * 0.52);
  }

  const padding = drawingStyle.atomLabelPaddingPx;
  const horizontalShift = drawingStyle.atomLabelAlignment === "left"
    ? baseHalfWidth
    : drawingStyle.atomLabelAlignment === "right"
      ? -right
      : 0;
  return {
    bounds: {
      x: -baseHalfWidth + horizontalShift - padding,
      y: top - padding,
      width: right + baseHalfWidth + padding * 2,
      height: bottom - top + padding * 2
    },
    runs: horizontalShift === 0
      ? runs
      : runs.map((run) => ({ ...run, x: run.x + horizontalShift }))
  };
}

function leadingImplicitHydrogenElement(label: string): NativeElementSymbol | undefined {
  const { body } = splitAtomLabelCharge(label);
  const match = body.match(/^H([A-Z][a-z]?)$/);
  if (!match?.[1] || match[1] === "H") {
    return undefined;
  }

  return nativeElementSymbolSet.has(match[1])
    ? match[1] as NativeElementSymbol
    : undefined;
}

function leadingImplicitHydrogenAtomLabelLayout(
  element: NativeElementSymbol,
  chargeRun: AtomLabelRun | undefined,
  drawingStyle: NativeDrawingStyle
): AtomLabelLayout {
  const hydrogenRun: AtomLabelRun = { text: "H", script: "normal" };
  const elementRun: AtomLabelRun = { text: element, script: "normal" };
  const hydrogenWidth = atomLabelRunWidth(hydrogenRun, drawingStyle);
  const elementWidth = atomLabelRunWidth(elementRun, drawingStyle);
  // SVG text is anchored at the glyph baseline, while this layout helper only has an estimated
  // advance width. Round element glyphs (especially O) extend farther left than half that estimate.
  // Reserve their cap-width plus a small publication-style gap so a leading H reads as "HO"
  // instead of visually running into the element.
  const elementHalfWidth = Math.max(
    elementWidth / 2,
    drawingStyle.atomLabelFontSizePx * 0.38
  );
  const hydrogenElementGap = drawingStyle.atomLabelFontSizePx * 0.12;
  const hydrogenRight = -elementHalfWidth - hydrogenElementGap;
  const baseHalfHeight = drawingStyle.atomLabelFontSizePx * 0.54;
  const runs: AtomLabelLayoutRun[] = [
    {
      ...hydrogenRun,
      x: hydrogenRight,
      y: 0,
      textAnchor: "end"
    },
    {
      ...elementRun,
      x: 0,
      y: 0,
      textAnchor: "middle"
    }
  ];
  let left = hydrogenRight - hydrogenWidth;
  let right = elementHalfWidth;
  let top = -baseHalfHeight;
  let bottom = baseHalfHeight;

  if (chargeRun) {
    const fontSize = atomLabelRunFontSize(chargeRun.script, drawingStyle) ?? drawingStyle.atomLabelFontSizePx;
    const width = atomLabelRunWidth(chargeRun, drawingStyle);
    const x = right + drawingStyle.atomLabelFontSizePx * 0.08;
    const y = -drawingStyle.atomLabelFontSizePx * 0.48;
    runs.push({
      ...chargeRun,
      x,
      y,
      textAnchor: "start"
    });
    right = x + width;
    top = Math.min(top, y - fontSize * 0.52);
    bottom = Math.max(bottom, y + fontSize * 0.52);
  }

  const horizontalShift = drawingStyle.atomLabelAlignment === "left"
    ? -left
    : drawingStyle.atomLabelAlignment === "right"
      ? -right
      : 0;
  const padding = drawingStyle.atomLabelPaddingPx;
  return {
    bounds: {
      x: left + horizontalShift - padding,
      y: top - padding,
      width: right - left + padding * 2,
      height: bottom - top + padding * 2
    },
    runs: horizontalShift === 0
      ? runs
      : runs.map((run) => ({ ...run, x: run.x + horizontalShift }))
  };
}

function atomLabelParts(label: string): { bodyRuns: AtomLabelRun[]; chargeRun?: AtomLabelRun } {
  const { body, charge } = splitAtomLabelCharge(label);
  const runs = Array.from(body).reduce<AtomLabelRun[]>((currentRuns, character) => {
    const script = atomLabelScript(character);
    const previous = currentRuns[currentRuns.length - 1];
    if (previous?.script === script) {
      previous.text += character;
      return currentRuns;
    }

    currentRuns.push({ text: character, script });
    return currentRuns;
  }, []);

  return {
    bodyRuns: runs.length > 0 ? runs : [{ text: label, script: "normal" }],
    chargeRun: charge ? { text: charge, script: "superscript" } : undefined
  };
}

function splitAtomLabelCharge(label: string): { body: string; charge?: string } {
  const twoCharacterCharge = label.match(/^(.*?)(\d[+-])$/);
  if (twoCharacterCharge && twoCharacterCharge[1] && !twoCharacterCharge[1].endsWith("H")) {
    return { body: twoCharacterCharge[1], charge: twoCharacterCharge[2] };
  }

  const oneCharacterCharge = label.match(/^(.*)([+-])$/);
  if (oneCharacterCharge && oneCharacterCharge[1]) {
    return { body: oneCharacterCharge[1], charge: oneCharacterCharge[2] };
  }

  return { body: label };
}

function atomLabelRunWidth(run: AtomLabelRun, drawingStyle: NativeDrawingStyle): number {
  const fontSize = atomLabelRunFontSize(run.script, drawingStyle) ?? drawingStyle.atomLabelFontSizePx;
  const widthFactor = run.script === "normal" ? 0.62 : 0.5;
  const weightFactor = drawingStyle.atomLabelFontWeight >= 600 ? 1.08 : 1;
  const italicFactor = drawingStyle.atomLabelFontStyle === "italic" ? 1.06 : 1;
  return run.text.length * fontSize * widthFactor * weightFactor * italicFactor;
}

function atomLabelScript(character: string): AtomLabelScript {
  if (/\d/.test(character)) {
    return "subscript";
  }
  if (character === "+" || character === "-") {
    return "superscript";
  }
  return "normal";
}

export function atomLabelRunFontSize(script: AtomLabelScript, drawingStyle: NativeDrawingStyle): number | undefined {
  if (script === "normal") {
    return undefined;
  }

  return drawingStyle.atomLabelFontSizePx * (script === "superscript" ? 0.88 : 0.72);
}

/**
 * The label a native atom renders with in 2D — element symbol + implicit hydrogens +
 * charge, or undefined for plain bonded carbons. Exported so the 3D spin overlay can
 * label its atoms IDENTICALLY to the drawing it floats over.
 */
export function atomDisplayLabel(
  atom: MoleculeAtom,
  bonds: readonly CoreMoleculeBond[],
  drawingStyle: NativeDrawingStyle = DefaultNativeDrawingStyle,
  atoms: readonly MoleculeAtom[] = []
): string | undefined {
  const element = nativeElementFromAtomLabel(atom.element);
  if (!element) {
    const symbol = atom.element.trim() || "C";
    return `${symbol}${chargeLabelSuffix(atom.formalCharge)}`;
  }
  const valenceUsed = nativeAtomBondOrderUsage(atom.id, bonds);
  const formalCharge = atom.formalCharge;
  const implicitHydrogens = drawingStyle.atomLabelHideImplicitHydrogens
    ? ""
    : implicitHydrogenLabel(Math.max(0, (nativeAtomValence[element] ?? 0) - valenceUsed));

  if (element === "C" && formalCharge === 0) {
    const terminalCarbon = atoms.length > 0 && heavyAtomNeighborCount(atom.id, bonds, atoms) === 1;
    const shouldShowCarbon =
      atom.labelVisible === true ||
      valenceUsed === 0 ||
      (atom.labelVisible !== false && drawingStyle.atomLabelShowTerminalCarbons && terminalCarbon);
    if (!shouldShowCarbon) {
      return undefined;
    }
  }

  const singleHeavyNeighbor = singleHeavyAtomNeighbor(atom.id, bonds, atoms);
  const hydrogenBeforeElement =
    implicitHydrogens === "H" &&
    element !== "H" &&
    singleHeavyNeighbor !== undefined &&
    singleHeavyNeighbor.x > atom.x + 0.001;
  return hydrogenBeforeElement
    ? `${implicitHydrogens}${element}${chargeLabelSuffix(formalCharge)}`
    : `${element}${implicitHydrogens}${chargeLabelSuffix(formalCharge)}`;
}

const nativeElementSymbols = [
  "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne",
  "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca",
  "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
  "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr",
  "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn",
  "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd",
  "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb",
  "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
  "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th",
  "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm",
  "Md", "No", "Lr", "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds",
  "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og"
] as const;
type NativeElementSymbol = typeof nativeElementSymbols[number];
const nativeElementSymbolSet = new Set<string>(nativeElementSymbols);
const nativeAtomValence: Partial<Record<NativeElementSymbol, number>> = {
  H: 1,
  B: 3,
  C: 4,
  N: 3,
  O: 2,
  F: 1,
  Si: 4,
  P: 3,
  S: 2,
  Cl: 1,
  Br: 1,
  I: 1
};
const nativeBondOrderValue: Record<string, number> = {
  single: 1,
  double: 2,
  triple: 3,
  aromatic: 1.5,
  unknown: 1
};

function nativeElementFromAtomLabel(value: string): NativeElementSymbol | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const elementCandidate = `${trimmed[0]?.toUpperCase() ?? ""}${trimmed.slice(1).toLowerCase()}`;
  return nativeElementSymbolSet.has(elementCandidate) ? elementCandidate as NativeElementSymbol : undefined;
}

function nativeAtomBondOrderUsage(atomId: string, bonds: readonly CoreMoleculeBond[]): number {
  return bonds.reduce((sum, bond) => (
    bond.fromAtomId === atomId || bond.toAtomId === atomId
      ? sum + (nativeBondOrderValue[bond.order] ?? 1)
      : sum
  ), 0);
}

function heavyAtomNeighborCount(
  atomId: string,
  bonds: readonly CoreMoleculeBond[],
  atoms: readonly MoleculeAtom[]
): number {
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const neighborIds = new Set<string>();
  for (const bond of bonds) {
    const neighborId = bond.fromAtomId === atomId
      ? bond.toAtomId
      : bond.toAtomId === atomId
        ? bond.fromAtomId
        : undefined;
    if (!neighborId || neighborIds.has(neighborId)) {
      continue;
    }
    const neighbor = atomById.get(neighborId);
    if (nativeElementFromAtomLabel(neighbor?.element ?? "") !== "H") {
      neighborIds.add(neighborId);
    }
  }
  return neighborIds.size;
}

function singleHeavyAtomNeighbor(
  atomId: string,
  bonds: readonly CoreMoleculeBond[],
  atoms: readonly MoleculeAtom[]
): MoleculeAtom | undefined {
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const neighbors = new Map<string, MoleculeAtom>();
  for (const bond of bonds) {
    const neighborId = bond.fromAtomId === atomId
      ? bond.toAtomId
      : bond.toAtomId === atomId
        ? bond.fromAtomId
        : undefined;
    const neighbor = neighborId ? atomById.get(neighborId) : undefined;
    if (neighbor && nativeElementFromAtomLabel(neighbor.element) !== "H") {
      neighbors.set(neighbor.id, neighbor);
    }
  }

  return neighbors.size === 1 ? [...neighbors.values()][0] : undefined;
}

function implicitHydrogenLabel(count: number): string {
  if (count <= 0) {
    return "";
  }

  return count === 1 ? "H" : `H${count}`;
}

function chargeLabelSuffix(charge: number): string {
  if (charge === 0) {
    return "";
  }

  const magnitude = Math.abs(charge);
  const sign = charge > 0 ? "+" : "-";
  return magnitude === 1 ? sign : `${magnitude}${sign}`;
}

function nativeBondDisplayStyle(bond: CoreMoleculeBond): BondDisplayStyle | undefined {
  return bond.display?.bondStyle;
}

function nativeBondStrokeWidth(bond: CoreMoleculeBond, drawingStyle: NativeDrawingStyle): number {
  const base = nativeBondDisplayStyle(bond) === "bold"
    ? drawingStyle.bondBoldWidthPx
    : drawingStyle.bondStrokeWidthPx;
  return depthCuedBondStrokeWidth(base, bond.display?.depthWeight);
}

/**
 * Perspective depth → stroke width, shared by the committed 2D rendering AND the live
 * 3D spin overlay so flatten-on-release changes nothing visually. Near bonds are a
 * little heavier, far bonds a little lighter (1.2px–2.8px for a 2px drawing style)
 * without turning face-on structures chunky.
 */
export function depthCuedBondStrokeWidth(baseWidthPx: number, depthWeight: number | undefined): number {
  if (depthWeight === undefined) return baseWidthPx;
  return baseWidthPx * (0.6 + clamp(depthWeight, 0, 1) * 0.8);
}

function nativeDashedBondDashArray(drawingStyle: NativeDrawingStyle): string {
  const dash = Math.max(3, drawingStyle.bondStrokeWidthPx * 2.2);
  const gap = Math.max(3, drawingStyle.bondStrokeWidthPx * 1.8);
  return `${formatNumber(dash)} ${formatNumber(gap)}`;
}

function nativeWedgeWidth(drawingStyle: NativeDrawingStyle, visibleLength?: number): number {
  // Keep the wide end proportional to the document's bond length. This matters for pasted SMILES,
  // which use a 28 px bond instead of the 22 px drawing default: a fixed 5.04 px base shrank from
  // 23% to 18% of a bond. The 24% profile matches the ruler-normalized reference while remaining
  // far narrower than the old 48% wedge. Cap label-trimmed wedges by their visible length so they
  // cannot turn into squat triangles.
  const nominalWidth = Math.max(
    4,
    drawingStyle.bondStrokeWidthPx * 2.2,
    drawingStyle.bondBoldWidthPx * 1.05,
    drawingStyle.bondLengthPx * 0.24
  );
  return visibleLength === undefined
    ? nominalWidth
    : Math.min(nominalWidth, visibleLength * 0.28);
}

export function nativeMultipleBondGapPx(drawingStyle: NativeDrawingStyle): number {
  if (drawingStyle.bondSpacingMode === "percent") {
    return Math.max(0.5, drawingStyle.bondLengthPx * drawingStyle.bondSpacingPercent / 100);
  }
  return drawingStyle.multipleBondGapPx;
}

function nativeWedgePolygonPoints(
  segment: Pick<PageBondLineSegment, "x1" | "y1" | "x2" | "y2">,
  drawingStyle: NativeDrawingStyle,
  object?: MoleculeObject,
  bond?: CoreMoleculeBond,
  // Length used for the width cap. Crossing gaps split one wedge into several fragments; each
  // fragment must inherit the whole segment's base width or the pieces flare at different rates.
  widthCapLength?: number
): string {
  const geometry = nativeSegmentVectorGeometry(segment);
  if (!geometry) {
    return `${formatNumber(segment.x1)},${formatNumber(segment.y1)} ${formatNumber(segment.x2)},${formatNumber(segment.y2)}`;
  }

  const width = nativeWedgeWidth(drawingStyle, widthCapLength ?? geometry.length);
  const miteredWideEnd = object && bond
    ? nativeWedgeWideEndMiter(object, bond, segment, geometry, width)
    : undefined;
  if (miteredWideEnd) {
    const points = [
      `${formatNumber(segment.x1)},${formatNumber(segment.y1)}`,
      `${formatNumber(miteredWideEnd.wideLeft.x)},${formatNumber(miteredWideEnd.wideLeft.y)}`
    ];
    if (miteredWideEnd.leftContinuation && miteredWideEnd.rightContinuation) {
      points.push(
        `${formatNumber(miteredWideEnd.leftContinuation.x)},${formatNumber(miteredWideEnd.leftContinuation.y)}`,
        `${formatNumber(miteredWideEnd.rightContinuation.x)},${formatNumber(miteredWideEnd.rightContinuation.y)}`
      );
    }
    points.push(
      `${formatNumber(miteredWideEnd.wideRight.x)},${formatNumber(miteredWideEnd.wideRight.y)}`
    );
    return points.join(" ");
  }

  const halfWidth = width / 2;
  const wideLeft = {
    x: segment.x2 + geometry.normal.x * halfWidth,
    y: segment.y2 + geometry.normal.y * halfWidth
  };
  const wideRight = {
    x: segment.x2 - geometry.normal.x * halfWidth,
    y: segment.y2 - geometry.normal.y * halfWidth
  };

  return [
    `${formatNumber(segment.x1)},${formatNumber(segment.y1)}`,
    `${formatNumber(wideLeft.x)},${formatNumber(wideLeft.y)}`,
    `${formatNumber(wideRight.x)},${formatNumber(wideRight.y)}`
  ].join(" ");
}

function nativeWedgeWideEndMiter(
  object: MoleculeObject,
  bond: CoreMoleculeBond,
  segment: Pick<PageBondLineSegment, "x1" | "y1" | "x2" | "y2">,
  geometry: NonNullable<ReturnType<typeof nativeSegmentVectorGeometry>>,
  width: number
): {
  wideLeft: LayoutPoint;
  wideRight: LayoutPoint;
  leftContinuation?: LayoutPoint;
  rightContinuation?: LayoutPoint;
} | undefined {
  const narrowAtom = object.atoms.find((atom) => atom.id === bond.fromAtomId);
  const wideAtom = object.atoms.find((atom) => atom.id === bond.toAtomId);
  if (
    !narrowAtom ||
    !wideAtom ||
    distance(narrowAtom, { x: segment.x1, y: segment.y1 }) > 0.001 ||
    distance(wideAtom, { x: segment.x2, y: segment.y2 }) > 0.001
  ) {
    return undefined;
  }

  const atomById = new Map(object.atoms.map((atom) => [atom.id, atom]));
  const adjacentConnections = object.bonds
    .filter((candidate) => candidate.id !== bond.id)
    .flatMap((candidate) => {
      const neighborId = candidate.fromAtomId === wideAtom.id
        ? candidate.toAtomId
        : candidate.toAtomId === wideAtom.id
          ? candidate.fromAtomId
          : undefined;
      const neighbor = neighborId ? atomById.get(neighborId) : undefined;
      if (!neighbor) {
        return [];
      }
      const dx = neighbor.x - wideAtom.x;
      const dy = neighbor.y - wideAtom.y;
      const length = Math.hypot(dx, dy);
      return length > 0.001
        ? [{
            bond: candidate,
            length,
            unit: { x: dx / length, y: dy / length }
          }]
        : [];
    });
  // Changing a regular bond into a wedge must retain the regular bond's centerline as the wedge
  // axis. ChemDraw's toggle behavior makes this especially clear: the broad end expands equally to
  // both sides while every neighboring bond remains fixed. Keep the full 24%-of-bond base centered
  // on the atom instead of pushing the entire flare toward the outside of the turn.
  const halfWidth = width / 2;
  const wideLeft = {
    x: wideAtom.x + geometry.normal.x * halfWidth,
    y: wideAtom.y + geometry.normal.y * halfWidth
  };
  const wideRight = {
    x: wideAtom.x - geometry.normal.x * halfWidth,
    y: wideAtom.y - geometry.normal.y * halfWidth
  };
  const result: {
    wideLeft: LayoutPoint;
    wideRight: LayoutPoint;
    leftContinuation?: LayoutPoint;
    rightContinuation?: LayoutPoint;
  } = { wideLeft, wideRight };

  // Two wedges that are both broad at the same carbon must share one outside corner. Rendering
  // their centered bases independently leaves two visible horns ("twin peaks") at the turn.
  // Intersect the two outside taper edges and give both polygons that same miter point, just as a
  // continuous stroked path would do. The inside corners remain centered on the atom and are
  // covered by the normal carbon-junction fill.
  const adjacentWideEndWedges = adjacentConnections.filter((connection) =>
    nativeBondDisplayStyle(connection.bond) === "wedge" &&
    connection.bond.toAtomId === wideAtom.id
  );
  if (adjacentWideEndWedges.length === 1) {
    const adjacentConnection = adjacentWideEndWedges[0]!;
    // A label at the adjacent wedge's narrow end trims its rendered segment, so that wedge fails
    // the exact-endpoint guard above: it skips mitering and caps its base width by the shorter
    // visible length. A shared corner computed here from its full atom-to-atom flare would never
    // meet any edge it actually draws, so keep the plain centered base instead.
    const adjacentNarrowAtom = atomById.get(adjacentConnection.bond.fromAtomId);
    const adjacentNarrowLabel = adjacentNarrowAtom
      ? atomDisplayLabel(
          adjacentNarrowAtom,
          object.bonds,
          nativeMoleculeAtomLabelStyle(
            object,
            adjacentNarrowAtom.id,
            nativeDrawingStyleFromObjectStyle(object.style)
          ),
          object.atoms
        )
      : undefined;
    if (adjacentNarrowLabel !== undefined) {
      return result;
    }
    const adjacentDrawingStyle = nativeMoleculeBondDrawingStyle(
      object,
      adjacentConnection.bond.id
    );
    const adjacentWidth = nativeWedgeWidth(
      adjacentDrawingStyle,
      adjacentConnection.length
    );
    const sharedMiter = nativeSharedWideEndWedgeMiter(
      { x: segment.x1, y: segment.y1 },
      wideAtom,
      geometry,
      width,
      adjacentConnection.unit,
      adjacentConnection.length,
      adjacentWidth
    );
    if (sharedMiter) {
      if (sharedMiter.currentSide === "left") {
        result.wideLeft = sharedMiter.point;
      } else {
        result.wideRight = sharedMiter.point;
      }
    }
    return result;
  }

  // A narrow-end stereo bond does not own either outside corner at this carbon. It may therefore
  // coexist with one ordinary bond without forcing the broad solid wedge back to an isolated,
  // centered base. This is the common wedge + hash + plain-bond stereocenter: the ordinary bond
  // still owns the visible continuation, while the narrow hash emerges from the carbon center.
  const plainSingleConnections = adjacentConnections.filter((connection) =>
    connection.bond.order === "single" &&
    nativeBondDisplayStyle(connection.bond) === undefined
  );
  const nonPlainConnectionsAreNarrowStereo = adjacentConnections.every((connection) => {
    if (plainSingleConnections.includes(connection)) {
      return true;
    }
    const style = nativeBondDisplayStyle(connection.bond);
    return (
      (style === "wedge" || style === "hashed") &&
      connection.bond.fromAtomId === wideAtom.id
    );
  });
  if (
    plainSingleConnections.length !== 1 ||
    !nonPlainConnectionsAreNarrowStereo
  ) {
    return result;
  }
  const adjacentConnection = plainSingleConnections[0]!;

  // A plain single bond must cover the wedge's entire broad edge. Continue both wedge corners only
  // far enough to meet the unchanged neighboring stroke. This overlap is fully inside that stroke:
  // visually, only the selected bond changes from a centerline into a taper.
  const adjacentDrawingStyle = nativeMoleculeBondDrawingStyle(
    object,
    adjacentConnection.bond.id
  );
  const adjacentHalfStroke = nativeBondStrokeWidth(
    adjacentConnection.bond,
    adjacentDrawingStyle
  ) / 2;
  const adjacentNormal = {
    x: -adjacentConnection.unit.y,
    y: adjacentConnection.unit.x
  };
  const adjacentEdgeLeftAtAtom = {
    x: wideAtom.x + adjacentNormal.x * adjacentHalfStroke,
    y: wideAtom.y + adjacentNormal.y * adjacentHalfStroke
  };
  const adjacentEdgeRightAtAtom = {
    x: wideAtom.x - adjacentNormal.x * adjacentHalfStroke,
    y: wideAtom.y - adjacentNormal.y * adjacentHalfStroke
  };
  const leftAssignment =
    distance(wideLeft, adjacentEdgeLeftAtAtom) + distance(wideRight, adjacentEdgeRightAtAtom);
  const rightAssignment =
    distance(wideLeft, adjacentEdgeRightAtAtom) + distance(wideRight, adjacentEdgeLeftAtAtom);
  let leftEdgeAtAtom: LayoutPoint;
  let rightEdgeAtAtom: LayoutPoint;
  if (leftAssignment <= rightAssignment) {
    leftEdgeAtAtom = adjacentEdgeLeftAtAtom;
    rightEdgeAtAtom = adjacentEdgeRightAtAtom;
  } else {
    leftEdgeAtAtom = adjacentEdgeRightAtAtom;
    rightEdgeAtAtom = adjacentEdgeLeftAtAtom;
  }

  // The visible wedge edges must flow directly into the two parallel edges of the ordinary bond.
  // Keeping the old centered base corners made each edge take a short diagonal step before it
  // reached the regular stroke, producing a little roof/bump. Intersect each taper edge with its
  // assigned regular-bond edge instead. The continuation remains as overlap inside the unchanged
  // regular stroke, while the outside silhouette becomes one clean publication-style miter.
  const leftMiter = infiniteLineIntersection(
    { x: segment.x1, y: segment.y1 },
    wideLeft,
    leftEdgeAtAtom,
    {
      x: leftEdgeAtAtom.x + adjacentConnection.unit.x,
      y: leftEdgeAtAtom.y + adjacentConnection.unit.y
    }
  );
  const rightMiter = infiniteLineIntersection(
    { x: segment.x1, y: segment.y1 },
    wideRight,
    rightEdgeAtAtom,
    {
      x: rightEdgeAtAtom.x + adjacentConnection.unit.x,
      y: rightEdgeAtAtom.y + adjacentConnection.unit.y
    }
  );
  const miterLimit = Math.max(width, adjacentHalfStroke * 2) * 2;
  if (
    !leftMiter ||
    !rightMiter ||
    distance(leftMiter, wideAtom) > miterLimit ||
    distance(rightMiter, wideAtom) > miterLimit
  ) {
    // Near-collinear junctions reject the miter, and then the continuation overlap is NOT hidden
    // by the adjacent stroke: extending the full-width centered base along a bond of ordinary
    // stroke width paints a visible barb past the wide atom. Fall back to the plain centered base.
    return result;
  }
  result.wideLeft = leftMiter;
  result.wideRight = rightMiter;

  // Carry the overlap slightly beyond whichever miter lands farther along the regular bond. This
  // keeps the five-point fill ordered and prevents a sub-pixel fold-back on the inside edge, while
  // remaining entirely hidden under the unchanged regular-bond stroke.
  const leftForward = (
    (result.wideLeft.x - wideAtom.x) * adjacentConnection.unit.x +
    (result.wideLeft.y - wideAtom.y) * adjacentConnection.unit.y
  );
  const rightForward = (
    (result.wideRight.x - wideAtom.x) * adjacentConnection.unit.x +
    (result.wideRight.y - wideAtom.y) * adjacentConnection.unit.y
  );
  const continuationLength = Math.min(
    adjacentConnection.length * 0.5,
    Math.max(halfWidth, leftForward, rightForward, 0) + adjacentHalfStroke
  );
  result.leftContinuation = {
    x: leftEdgeAtAtom.x + adjacentConnection.unit.x * continuationLength,
    y: leftEdgeAtAtom.y + adjacentConnection.unit.y * continuationLength
  };
  result.rightContinuation = {
    x: rightEdgeAtAtom.x + adjacentConnection.unit.x * continuationLength,
    y: rightEdgeAtAtom.y + adjacentConnection.unit.y * continuationLength
  };
  return result;
}

function nativeSharedWideEndWedgeMiter(
  currentTip: LayoutPoint,
  wideAtom: LayoutPoint,
  currentGeometry: NonNullable<ReturnType<typeof nativeSegmentVectorGeometry>>,
  currentWidth: number,
  adjacentRay: LayoutPoint,
  adjacentLength: number,
  adjacentWidth: number
): { point: LayoutPoint; currentSide: "left" | "right" } | undefined {
  const currentRay = {
    x: currentTip.x - wideAtom.x,
    y: currentTip.y - wideAtom.y
  };
  const turn = cross(currentRay, adjacentRay);
  if (Math.abs(turn) <= crossingIntersectionEpsilon) {
    return undefined;
  }

  const currentHalfWidth = currentWidth / 2;
  const currentWideLeft = {
    x: wideAtom.x + currentGeometry.normal.x * currentHalfWidth,
    y: wideAtom.y + currentGeometry.normal.y * currentHalfWidth
  };
  const currentWideRight = {
    x: wideAtom.x - currentGeometry.normal.x * currentHalfWidth,
    y: wideAtom.y - currentGeometry.normal.y * currentHalfWidth
  };

  // adjacentRay points from the shared atom toward the other wedge's narrow end. Its wedge axis
  // runs in the opposite direction, so this is the normal for the adjacent tip-to-atom segment.
  const adjacentNormal = {
    x: adjacentRay.y,
    y: -adjacentRay.x
  };
  const adjacentHalfWidth = adjacentWidth / 2;
  const adjacentWideLeft = {
    x: wideAtom.x + adjacentNormal.x * adjacentHalfWidth,
    y: wideAtom.y + adjacentNormal.y * adjacentHalfWidth
  };
  const adjacentWideRight = {
    x: wideAtom.x - adjacentNormal.x * adjacentHalfWidth,
    y: wideAtom.y - adjacentNormal.y * adjacentHalfWidth
  };
  const adjacentTip = {
    x: wideAtom.x + adjacentRay.x * adjacentLength,
    y: wideAtom.y + adjacentRay.y * adjacentLength
  };

  const currentSide = turn > 0 ? "left" : "right";
  const currentOutside = currentSide === "left" ? currentWideLeft : currentWideRight;
  const adjacentOutside = turn > 0 ? adjacentWideRight : adjacentWideLeft;
  const point = infiniteLineIntersection(
    currentTip,
    currentOutside,
    adjacentTip,
    adjacentOutside
  );
  if (
    !point ||
    distance(point, wideAtom) > Math.max(currentWidth, adjacentWidth) * 2
  ) {
    return undefined;
  }
  return { point, currentSide };
}

function infiniteLineIntersection(
  leftStart: LayoutPoint,
  leftThrough: LayoutPoint,
  rightStart: LayoutPoint,
  rightThrough: LayoutPoint
): LayoutPoint | undefined {
  const leftVector = {
    x: leftThrough.x - leftStart.x,
    y: leftThrough.y - leftStart.y
  };
  const rightVector = {
    x: rightThrough.x - rightStart.x,
    y: rightThrough.y - rightStart.y
  };
  const denominator = cross(leftVector, rightVector);
  if (Math.abs(denominator) <= crossingIntersectionEpsilon) {
    return undefined;
  }
  const originDelta = {
    x: rightStart.x - leftStart.x,
    y: rightStart.y - leftStart.y
  };
  const leftT = cross(originDelta, rightVector) / denominator;
  const point = {
    x: leftStart.x + leftVector.x * leftT,
    y: leftStart.y + leftVector.y * leftT
  };
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : undefined;
}

function nativeHashedWedgePlan(
  segment: Pick<PageBondLineSegment, "x1" | "y1" | "x2" | "y2">,
  drawingStyle: NativeDrawingStyle,
  object?: MoleculeObject,
  bond?: CoreMoleculeBond,
  crossingGaps: readonly BondCrossingGap[] = []
): {
  hashes: Pick<PageBondLineSegment, "x1" | "y1" | "x2" | "y2">[];
  strokeWidth: number;
  terminalJoin?: { index: number; points: string };
} {
  const strokeWidth = bond
    ? nativeBondStrokeWidth(bond, drawingStyle)
    : drawingStyle.bondStrokeWidthPx;
  const geometry = nativeSegmentVectorGeometry(segment);
  if (!geometry) {
    return { hashes: [], strokeWidth };
  }

  const profileLength = nativeStereoBondProfileLength(
    geometry.length,
    object,
    bond
  );
  const hashSpacing = Math.max(2, drawingStyle.bondHashSpacingPx);
  const nominalBondLength = Math.max(hashSpacing, drawingStyle.bondLengthPx);
  const nominalHashCount = Math.max(5, Math.round(nominalBondLength / hashSpacing));
  const wideEndCollides = Boolean(
    object && bond && nativeHashedWedgeWideEndCollides(object, bond, segment)
  );
  // Collision handling omits the terminal bar at the shared broad endpoint. Start with at least
  // three bars in that case so even a short wedge retains the two marks needed to read as hashed.
  const minimumHashCount = wideEndCollides ? 3 : 2;
  const minimumWhiteGap = Math.max(1, strokeWidth);
  const maximumReadableHashCount = Math.max(
    minimumHashCount,
    Math.floor(
      geometry.length /
        (strokeWidth + minimumWhiteGap)
    )
  );
  const hashCount = Math.max(
    minimumHashCount,
    // White space is part of a hashed wedge's meaning. Count bars from the visible ink length and
    // keep each white interval at least one stroke wide, so antialiasing cannot fuse a short bond
    // into a solid wedge at fit-to-page zoom. The independent profileLength below still preserves
    // the full atom-to-atom flare.
    Math.min(
      24,
      maximumReadableHashCount,
      Math.round(nominalHashCount * geometry.length / nominalBondLength)
    )
  );
  const maxWidth = nativeWedgeWidth(drawingStyle, profileLength);
  const minWidth = Math.min(maxWidth, strokeWidth);
  const visibleHashCount = wideEndCollides ? hashCount - 1 : hashCount;
  const nominalCenterSpacing = geometry.length / hashCount;
  const requiredCenterSpacing = strokeWidth + minimumWhiteGap;
  const maximumFittingCenterSpacing = visibleHashCount > 1
    ? Math.max(0, (geometry.length - strokeWidth) / (visibleHashCount - 1))
    : geometry.length;
  const collisionCenterSpacing = Math.min(
    maximumFittingCenterSpacing,
    Math.max(nominalCenterSpacing, requiredCenterSpacing)
  );
  const collisionFirstCenter = (
    geometry.length - collisionCenterSpacing * (visibleHashCount - 1)
  ) / 2;
  const hashes = Array.from({ length: visibleHashCount }, (_, index) => {
    // Do not put a bar at the narrow stereocenter endpoint: it merges into the adjoining bond
    // strokes and turns a five-element hash into four visible stripes. Publication-style wedges
    // place five bars at 20/40/60/80/100% of a full bond; shorter visible segments use fewer bars,
    // leaving every interval distinct while the wide base still meets the far atom. When another
    // broad stereo bond owns that endpoint, center the surviving bars after reserving an omitted
    // terminal position. Expand their axial spacing to one ink width plus one white ink-width gap
    // whenever that physically fits inside the bond.
    const distance = wideEndCollides
      ? collisionFirstCenter + collisionCenterSpacing * index
      : nominalCenterSpacing * (index + 1);
    const progress = distance / geometry.length;
    const center = {
      x: segment.x1 + geometry.unit.x * distance,
      y: segment.y1 + geometry.unit.y * distance
    };
    const halfWidth = (minWidth + (maxWidth - minWidth) * progress) / 2;
    return {
      x1: center.x + geometry.normal.x * halfWidth,
      y1: center.y + geometry.normal.y * halfWidth,
      x2: center.x - geometry.normal.x * halfWidth,
      y2: center.y - geometry.normal.y * halfWidth
    };
  });
  if (wideEndCollides) {
    return { hashes, strokeWidth };
  }

  const wideEndMiter = object && bond
    ? nativeWedgeWideEndMiter(object, bond, segment, geometry, maxWidth)
    : undefined;
  const terminalHash = hashes.at(-1);
  if (
    !terminalHash ||
    !wideEndMiter?.leftContinuation ||
    !wideEndMiter.rightContinuation
  ) {
    return { hashes, strokeWidth };
  }

  // Individual hash bars are split by crossing gaps at the call sites, but the solid terminal
  // band is a polygon and would paint straight across a gap at the wide end. Run the same
  // splitter over the band's axial extent; if a gap touches it, keep the plain terminal crossbar
  // (which then participates in normal gap splitting) instead of the band.
  const bandAxis = {
    x1: segment.x2 - geometry.unit.x * strokeWidth,
    y1: segment.y2 - geometry.unit.y * strokeWidth,
    x2: segment.x2,
    y2: segment.y2
  };
  const bandAxisPieces = splitSegmentByCrossingGaps(bandAxis, crossingGaps);
  if (bandAxisPieces.length !== 1 || bandAxisPieces[0] !== bandAxis) {
    return { hashes, strokeWidth };
  }

  // A complete terminal crossbar sticks out on both sides of the ordinary bond leaving the wide
  // carbon. Replace only that last bar with a filled band: its tip-side edge is exactly the leading
  // edge of the old hash stroke, while its two taper edges meet the same clean miters used by a
  // solid wedge and continue beneath the regular bond. The fifth stripe remains visible, but its
  // root is absorbed into the backbone instead of reading as a hook or tiny letter.
  const halfStroke = strokeWidth / 2;
  const terminalNearLeft = {
    x: terminalHash.x1 - geometry.unit.x * halfStroke,
    y: terminalHash.y1 - geometry.unit.y * halfStroke
  };
  const terminalNearRight = {
    x: terminalHash.x2 - geometry.unit.x * halfStroke,
    y: terminalHash.y2 - geometry.unit.y * halfStroke
  };
  const terminalJoinPoints = [
    terminalNearLeft,
    wideEndMiter.wideLeft,
    wideEndMiter.leftContinuation,
    wideEndMiter.rightContinuation,
    wideEndMiter.wideRight,
    terminalNearRight
  ].map((point) => `${formatNumber(point.x)},${formatNumber(point.y)}`).join(" ");
  return {
    hashes: hashes.slice(0, -1),
    strokeWidth,
    terminalJoin: {
      index: hashes.length - 1,
      points: terminalJoinPoints
    }
  };
}

function nativeStereoBondProfileLength(
  visibleLength: number,
  object?: MoleculeObject,
  bond?: CoreMoleculeBond
): number {
  if (!object || !bond) {
    return visibleLength;
  }
  const fromAtom = object.atoms.find((atom) => atom.id === bond.fromAtomId);
  const toAtom = object.atoms.find((atom) => atom.id === bond.toAtomId);
  if (!fromAtom || !toAtom) {
    return visibleLength;
  }

  // Atom labels shorten only the amount of stereo ink that remains visible; they must not change
  // the stereochemical profile itself. Base hash count and flare on the complete atom-to-atom
  // length so an N/O label cannot collapse a hashed wedge into four nearly equal dashes.
  return Math.max(visibleLength, distance(fromAtom, toAtom));
}

function nativeHashedWedgeWideEndCollides(
  object: MoleculeObject,
  bond: CoreMoleculeBond,
  segment: Pick<PageBondLineSegment, "x1" | "y1" | "x2" | "y2">
): boolean {
  const wideAtom = object.atoms.find((atom) => atom.id === bond.toAtomId);
  if (!wideAtom || distance(wideAtom, { x: segment.x2, y: segment.y2 }) > 0.001) {
    return false;
  }

  // When two hashed wedges widen toward the same atom, their terminal bars cross and read as the
  // letter X. Publication drawings omit those two colliding bars while keeping the preceding taper.
  // Do this only at the shared wide endpoint; ordinary five-bar hashes remain unchanged.
  return object.bonds.filter((candidate) =>
    candidate.toAtomId === wideAtom.id && nativeBondDisplayStyle(candidate) === "hashed"
  ).length > 1;
}

function nativeSegmentVectorGeometry(
  segment: Pick<PageBondLineSegment, "x1" | "y1" | "x2" | "y2">
): { length: number; unit: { x: number; y: number }; normal: { x: number; y: number } } | undefined {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return undefined;
  }

  const unit = { x: dx / length, y: dy / length };
  return {
    length,
    unit,
    normal: { x: -unit.y, y: unit.x }
  };
}

/**
 * Whether a double bond renders as the symmetric ±gap/2 straddle rather than a primary line with an
 * offset secondary. This is the exact condition `bondLineSegments` applies, exported so the Spin-3D
 * overlay can ask instead of approximating it — the overlay used `isTerminalHeteroatomDoubleBond`
 * alone, which is only the LAST of four clauses, so every aldehyde, amide, and exocyclic C=O with a
 * derivable inner side drew one-sided on canvas and symmetric in the live overlay (§5.26/§5.27).
 *
 * `ringInteriorSide` comes from {@link ringInteriorDoubleBondSides}, which is computed once per
 * molecule; pass the entry for this bond.
 */
export function doubleBondRendersSymmetric(
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  object: MoleculeObject,
  bond: CoreMoleculeBond,
  ringInteriorSide: DoubleBondSide | undefined
): boolean {
  return (
    bond.order === "double" &&
    bond.display?.doubleBondSide === undefined &&
    ringInteriorSide === undefined &&
    terminalHeteroatomDoubleBondInnerSide(fromAtom, toAtom, object, bond) === undefined &&
    isTerminalHeteroatomDoubleBond(fromAtom, toAtom, object, bond)
  );
}

export function isTerminalHeteroatomDoubleBond(
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  object: MoleculeObject,
  bond: CoreMoleculeBond
): boolean {
  if (bond.order !== "double") {
    return false;
  }

  return isTerminalHeteroatom(fromAtom, object) || isTerminalHeteroatom(toAtom, object);
}

function terminalHeteroatomDoubleBondInnerSide(
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  object: MoleculeObject,
  bond: CoreMoleculeBond
): DoubleBondSide | undefined {
  if (!isTerminalHeteroatomDoubleBond(fromAtom, toAtom, object, bond)) {
    return undefined;
  }

  const terminalAtom = isTerminalHeteroatom(fromAtom, object) ? fromAtom : toAtom;
  const junctionAtom = terminalAtom.id === fromAtom.id ? toAtom : fromAtom;
  const atomById = new Map(object.atoms.map((atom) => [atom.id, atom]));
  const adjacentAtoms = object.bonds
    .filter((candidate) => candidate.id !== bond.id)
    .flatMap((candidate) => {
      const neighborId = candidate.fromAtomId === junctionAtom.id
        ? candidate.toAtomId
        : candidate.toAtomId === junctionAtom.id
          ? candidate.fromAtomId
          : undefined;
      const neighbor = neighborId ? atomById.get(neighborId) : undefined;
      return neighbor && nativeElementFromAtomLabel(neighbor.element) !== "H"
        ? [neighbor]
        : [];
    });
  if (adjacentAtoms.length !== 1) {
    return undefined;
  }

  const bondDx = toAtom.x - fromAtom.x;
  const bondDy = toAtom.y - fromAtom.y;
  const bondLength = Math.hypot(bondDx, bondDy);
  if (bondLength <= 0.001) {
    return undefined;
  }

  const normal = { x: -bondDy / bondLength, y: bondDx / bondLength };
  const adjacentDirection = {
    x: adjacentAtoms[0]!.x - junctionAtom.x,
    y: adjacentAtoms[0]!.y - junctionAtom.y
  };
  const adjacentSide = adjacentDirection.x * normal.x + adjacentDirection.y * normal.y;
  if (Math.abs(adjacentSide) <= 0.001) {
    return undefined;
  }

  return adjacentSide > 0 ? "left" : "right";
}

function terminalMethyleneCarbons(
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  object: MoleculeObject,
  bond: CoreMoleculeBond
): MoleculeAtom[] {
  if (bond.order !== "double") {
    return [];
  }
  if (
    nativeElementFromAtomLabel(fromAtom.element) !== "C" ||
    nativeElementFromAtomLabel(toAtom.element) !== "C"
  ) {
    return [];
  }

  // Both ends can qualify (ethylene): each terminal CH2 keeps its secondary line flush, so the
  // symmetric molecule renders symmetrically instead of favoring whichever atom comes first.
  return [fromAtom, toAtom].filter((atom) =>
    atom.formalCharge === 0 &&
    atomBondCount(object, atom.id) === 1
  );
}

function isTerminalHeteroatom(atom: MoleculeAtom, object: MoleculeObject): boolean {
  return atom.element !== "C" && atom.element !== "H" && atomBondCount(object, atom.id) === 1;
}

function atomBondCount(object: MoleculeObject, atomId: string): number {
  return object.bonds.filter((bond) => bond.fromAtomId === atomId || bond.toAtomId === atomId).length;
}

function nativeMoleculeBondColor(
  object: MoleculeObject,
  bond: CoreMoleculeBond,
  drawingStyle: NativeDrawingStyle
): string {
  const baseColor = styleColorMapValue(object.style.bondColors, bond.id) ?? drawingStyle.bondColor;
  return depthCuedBondColor(baseColor, bond.display?.depthWeight);
}

export function nativeMoleculeBondDrawingStyle(
  object: MoleculeObject,
  bondId: string,
  drawingStyle: NativeDrawingStyle = nativeDrawingStyleFromObjectStyle(object.style)
): NativeDrawingStyle {
  return {
    ...drawingStyle,
    bondLengthPx: styleNumberMapValue(object.style.bondLengths, bondId) ?? drawingStyle.bondLengthPx,
    bondStrokeWidthPx: styleNumberMapValue(object.style.bondStrokeWidths, bondId) ?? drawingStyle.bondStrokeWidthPx,
    bondBoldWidthPx: styleNumberMapValue(object.style.bondBoldWidths, bondId) ?? drawingStyle.bondBoldWidthPx,
    bondColor: styleColorMapValue(object.style.bondColors, bondId) ?? drawingStyle.bondColor,
    bondLineCap: styleBondLineCapMapValue(object.style.bondLineCaps, bondId) ?? drawingStyle.bondLineCap,
    bondSpacingMode: styleBondSpacingModeMapValue(object.style.bondSpacingModes, bondId) ?? drawingStyle.bondSpacingMode,
    bondSpacingPercent: styleNumberMapValue(object.style.bondSpacingPercents, bondId) ?? drawingStyle.bondSpacingPercent,
    multipleBondGapPx: styleNumberMapValue(object.style.bondMultipleBondGaps, bondId) ?? drawingStyle.multipleBondGapPx,
    doubleBondInsetPx: styleNumberMapValue(object.style.bondDoubleBondInsets, bondId) ?? drawingStyle.doubleBondInsetPx,
    bondMarginWidthPx: styleNumberMapValue(object.style.bondMarginWidths, bondId) ?? drawingStyle.bondMarginWidthPx,
    bondHashSpacingPx: styleNumberMapValue(object.style.bondHashSpacings, bondId) ?? drawingStyle.bondHashSpacingPx,
    bondOverlapClearancePx: styleNumberMapValue(object.style.bondOverlapClearances, bondId) ?? drawingStyle.bondOverlapClearancePx,
    bondIndicatorShowQuery: styleBooleanMapValue(
      object.style.bondIndicatorShowQueryByBondId,
      bondId
    ) ?? drawingStyle.bondIndicatorShowQuery,
    bondIndicatorShowStereochemistry: styleBooleanMapValue(
      object.style.bondIndicatorShowStereochemistryByBondId,
      bondId
    ) ?? drawingStyle.bondIndicatorShowStereochemistry,
    bondIndicatorShowReaction: styleBooleanMapValue(
      object.style.bondIndicatorShowReactionByBondId,
      bondId
    ) ?? drawingStyle.bondIndicatorShowReaction
  };
}

export function nativeMoleculeAtomIndicatorStyle(
  object: MoleculeObject,
  atomId: string,
  drawingStyle: NativeDrawingStyle = nativeDrawingStyleFromObjectStyle(object.style)
): NativeDrawingStyle {
  return {
    ...drawingStyle,
    atomIndicatorShowQuery: styleBooleanMapValue(
      object.style.atomIndicatorShowQueryByAtomId,
      atomId
    ) ?? drawingStyle.atomIndicatorShowQuery,
    atomIndicatorShowStereochemistry: styleBooleanMapValue(
      object.style.atomIndicatorShowStereochemistryByAtomId,
      atomId
    ) ?? drawingStyle.atomIndicatorShowStereochemistry,
    atomIndicatorShowEnhancedStereochemistry: styleBooleanMapValue(
      object.style.atomIndicatorShowEnhancedStereochemistryByAtomId,
      atomId
    ) ?? drawingStyle.atomIndicatorShowEnhancedStereochemistry,
    atomIndicatorShowAtomNumbers: styleBooleanMapValue(
      object.style.atomIndicatorShowAtomNumbersByAtomId,
      atomId
    ) ?? drawingStyle.atomIndicatorShowAtomNumbers
  };
}

/**
 * Perspective depth → bond color, shared by the committed 2D rendering AND the live
 * 3D spin overlay: far bonds fade toward a neutral grey, near bonds keep the full
 * drawing color.
 */
export function depthCuedBondColor(baseColor: string, depthWeight: number | undefined): string {
  if (depthWeight === undefined) {
    return baseColor;
  }

  const color = parseCssRgbColor(baseColor);
  if (!color) {
    return baseColor;
  }

  const near = clamp(depthWeight, 0, 1);
  const farGrey = 150;
  return rgbToHex({
    r: farGrey + (color.r - farGrey) * near,
    g: farGrey + (color.g - farGrey) * near,
    b: farGrey + (color.b - farGrey) * near
  });
}

/**
 * A labeled atom's depth weight, derived as the mean of the depth weights of the bonds meeting
 * it. Atoms don't carry a baked depth weight of their own, but the SAME derivation runs in the
 * committed 2D render and the live spin overlay — both average the identical per-bond weights —
 * so label depth-cueing matches on flatten (no snap on release). Returns undefined when no
 * incident bond is depth-cued (a near-planar view), i.e. no cue, exactly like the bonds.
 */
export function averageDefinedDepthWeights(weights: readonly (number | undefined)[]): number | undefined {
  let sum = 0;
  let count = 0;
  for (const weight of weights) {
    if (weight !== undefined) {
      sum += weight;
      count += 1;
    }
  }
  return count === 0 ? undefined : sum / count;
}

/**
 * Perspective depth → atom-label fill: the label counterpart of {@link depthCuedBondColor}. Fades
 * a far label toward light grey so it recedes with the bonds; near labels keep their base colour.
 * The far grey is a little darker than the bond fog (125 vs 150) so small glyphs stay legible at
 * the back. Shared by the committed render and the live overlay so releasing a spin re-shades
 * nothing.
 */
export function depthCuedLabelColor(baseColor: string, depthWeight: number | undefined): string {
  if (depthWeight === undefined) return baseColor;
  const color = parseCssRgbColor(baseColor);
  if (!color) return baseColor;
  const near = clamp(depthWeight, 0, 1);
  const farGrey = 125;
  return rgbToHex({
    r: farGrey + (color.r - farGrey) * near,
    g: farGrey + (color.g - farGrey) * near,
    b: farGrey + (color.b - farGrey) * near
  });
}

/**
 * Perspective depth → atom-label scale (0.92 far … 1.08 near). A gentle size cue echoing the bond
 * stroke-width cue, applied as a transform scale about the label anchor so the run layout and the
 * halo stay consistent. Kept subtle so the drawing doesn't visibly reflow while spinning.
 */
export function depthCuedLabelScale(depthWeight: number | undefined): number {
  if (depthWeight === undefined) return 1;
  return 0.92 + clamp(depthWeight, 0, 1) * 0.16;
}

/** Glyph-hugging halo stroke width — the paper-coloured knockout that replaces the label box. */
export function atomLabelHaloWidthPx(drawingStyle: NativeDrawingStyle): number {
  return drawingStyle.atomLabelFontSizePx * 0.3;
}

function parseCssRgbColor(value: string): { r: number; g: number; b: number } | undefined {
  const trimmed = value.trim();
  const shortHex = trimmed.match(/^#([0-9a-f]{3})$/i);
  if (shortHex?.[1]) {
    const [r, g, b] = shortHex[1].split("").map((channel) => parseInt(`${channel}${channel}`, 16));
    return { r, g, b };
  }

  const hex = trimmed.match(/^#([0-9a-f]{6})$/i);
  if (hex?.[1]) {
    return {
      r: parseInt(hex[1].slice(0, 2), 16),
      g: parseInt(hex[1].slice(2, 4), 16),
      b: parseInt(hex[1].slice(4, 6), 16)
    };
  }

  const rgb = trimmed.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*\d*(?:\.\d+)?)?\s*\)$/i);
  if (!rgb?.[1] || !rgb[2] || !rgb[3]) {
    return undefined;
  }

  return {
    r: clamp(Number(rgb[1]), 0, 255),
    g: clamp(Number(rgb[2]), 0, 255),
    b: clamp(Number(rgb[3]), 0, 255)
  };
}

function rgbToHex(color: { r: number; g: number; b: number }): string {
  return `#${hexChannel(color.r)}${hexChannel(color.g)}${hexChannel(color.b)}`;
}

function hexChannel(value: number): string {
  return Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0");
}

function nativeMoleculeAtomLabelColor(
  object: MoleculeObject,
  atomId: string,
  drawingStyle: NativeDrawingStyle
): string {
  return styleColorMapValue(object.style.atomLabelColors, atomId) ?? drawingStyle.atomLabelColor;
}

function nativeMoleculeAtomLabelStyle(
  object: MoleculeObject,
  atomId: string,
  drawingStyle: NativeDrawingStyle
): NativeDrawingStyle {
  return {
    ...drawingStyle,
    atomLabelFontFamily: styleStringMapValue(object.style.atomLabelFontFamilies, atomId) ?? drawingStyle.atomLabelFontFamily,
    atomLabelFontSizePx: styleNumberMapValue(object.style.atomLabelFontSizes, atomId) ?? drawingStyle.atomLabelFontSizePx,
    atomLabelFontWeight: styleNumberMapValue(object.style.atomLabelFontWeights, atomId) ?? drawingStyle.atomLabelFontWeight,
    atomLabelFontStyle: styleFontStyleMapValue(object.style.atomLabelFontStyles, atomId) ?? drawingStyle.atomLabelFontStyle,
    atomLabelColor: nativeMoleculeAtomLabelColor(object, atomId, drawingStyle),
    atomLabelBackgroundColor: styleStringMapValue(
      object.style.atomLabelBackgroundColors,
      atomId
    ) ?? drawingStyle.atomLabelBackgroundColor,
    atomLabelPaddingPx: styleNumberMapValue(object.style.atomLabelPaddings, atomId) ?? drawingStyle.atomLabelPaddingPx,
    atomLabelBondClearancePx: styleNumberMapValue(
      object.style.atomLabelBondClearances,
      atomId
    ) ?? drawingStyle.atomLabelBondClearancePx,
    atomLabelAlignment: styleAtomLabelAlignmentMapValue(
      object.style.atomLabelAlignments,
      atomId
    ) ?? drawingStyle.atomLabelAlignment,
    atomLabelPlacement: styleAtomLabelPlacementMapValue(
      object.style.atomLabelPlacements,
      atomId
    ) ?? drawingStyle.atomLabelPlacement,
    atomLabelShowTerminalCarbons: styleBooleanMapValue(
      object.style.atomLabelShowTerminalCarbonsByAtomId,
      atomId
    ) ?? drawingStyle.atomLabelShowTerminalCarbons,
    atomLabelHideImplicitHydrogens: styleBooleanMapValue(
      object.style.atomLabelHideImplicitHydrogensByAtomId,
      atomId
    ) ?? drawingStyle.atomLabelHideImplicitHydrogens
  };
}

function nativeMoleculeStrokeOpacity(object: MoleculeObject): number {
  return clamp(metadataNumber(object.style.strokeOpacity) ?? 1, 0, 1);
}

function nativeMoleculeObjectOpacity(object: MoleculeObject): number {
  return clamp(metadataNumber(object.style.opacity) ?? 1, 0, 1);
}

function moleculeFillOpacity(object: MoleculeObject): number {
  const explicitOpacity = metadataNumber(object.style.fillOpacity);
  if (explicitOpacity !== undefined) {
    return clamp(explicitOpacity, 0, 1);
  }
  const paint = moleculeFillPaintForObject(object);
  return paint.kind === "solid"
    ? clamp(paint.opacity ?? 1, 0, 1)
    : clamp(metadataNumber(object.style.fillOpacity) ?? 1, 0, 1);
}

function moleculeFillPaintForObject(object: MoleculeObject): GraphicPaint {
  const paint = graphicPaintFromMetadata(object.style.fillPaint);
  if (paint) {
    return paint;
  }

  const fillColor = metadataString(object.style.fillColor);
  return fillColor && fillColor.toLowerCase() !== "none"
    ? { kind: "solid", color: fillColor, opacity: moleculeFillOpacityFromStyle(object) }
    : { kind: "none" };
}

function moleculeFillOpacityFromStyle(object: MoleculeObject): number {
  return clamp(metadataNumber(object.style.fillOpacity) ?? 1, 0, 1);
}

function moleculeRingStyle(object: MoleculeObject, ringKey: string): Record<string, unknown> {
  const styles = object.style.ringStyles;
  if (!styles || typeof styles !== "object" || Array.isArray(styles)) {
    return {};
  }

  const style = (styles as Record<string, unknown>)[ringKey];
  return style && typeof style === "object" && !Array.isArray(style)
    ? style as Record<string, unknown>
    : {};
}

function moleculeRingFillPaint(object: MoleculeObject, ringKey: string): GraphicPaint {
  const style = moleculeRingStyle(object, ringKey);
  const ringPaint = graphicPaintFromMetadata(style.fillPaint);
  if (ringPaint) {
    return ringPaint;
  }

  const fillColor = metadataString(style.fillColor);
  if (fillColor) {
    return fillColor.toLowerCase() === "none"
      ? { kind: "none" }
      : { kind: "solid", color: fillColor, opacity: metadataNumber(style.fillOpacity) };
  }

  return moleculeFillPaintForObject(object);
}

function moleculeRingFillOpacity(
  object: MoleculeObject,
  ringKey: string,
  paint: GraphicPaint
): number {
  const style = moleculeRingStyle(object, ringKey);
  const explicitOpacity = metadataNumber(style.fillOpacity);
  if (explicitOpacity !== undefined) {
    return clamp(explicitOpacity, 0, 1);
  }

  if (paint.kind === "solid" && paint.opacity !== undefined) {
    return clamp(paint.opacity, 0, 1);
  }

  return moleculeFillOpacity(object);
}

function graphicPaintFromMetadata(value: unknown): GraphicPaint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const paint = value as Record<string, unknown>;
  if (paint.kind === "none") {
    return { kind: "none" };
  }
  if (paint.kind === "solid" && typeof paint.color === "string") {
    return {
      kind: "solid",
      color: paint.color,
      ...(typeof paint.opacity === "number" ? { opacity: clamp(paint.opacity, 0, 1) } : {})
    };
  }
  if (
    paint.kind === "linear-gradient" &&
    paint.units === "object" &&
    typeof paint.x1 === "number" &&
    typeof paint.y1 === "number" &&
    typeof paint.x2 === "number" &&
    typeof paint.y2 === "number" &&
    Array.isArray(paint.stops)
  ) {
    return {
      kind: "linear-gradient",
      units: "object",
      x1: clamp(paint.x1, 0, 1),
      y1: clamp(paint.y1, 0, 1),
      x2: clamp(paint.x2, 0, 1),
      y2: clamp(paint.y2, 0, 1),
      stops: sanitizeGradientStops(paint.stops)
    };
  }
  if (
    paint.kind === "radial-gradient" &&
    paint.units === "object" &&
    typeof paint.cx === "number" &&
    typeof paint.cy === "number" &&
    typeof paint.r === "number" &&
    Array.isArray(paint.stops)
  ) {
    return {
      kind: "radial-gradient",
      units: "object",
      cx: clamp(paint.cx, 0, 1),
      cy: clamp(paint.cy, 0, 1),
      r: Math.max(0, paint.r),
      ...(typeof paint.fx === "number" ? { fx: clamp(paint.fx, 0, 1) } : {}),
      ...(typeof paint.fy === "number" ? { fy: clamp(paint.fy, 0, 1) } : {}),
      stops: sanitizeGradientStops(paint.stops)
    };
  }
  return undefined;
}

function sanitizeGradientStops(
  stops: unknown[]
): Extract<GraphicPaint, { kind: "linear-gradient" | "radial-gradient" }>["stops"] {
  const sanitized = stops.flatMap((stop) => {
    if (!stop || typeof stop !== "object" || Array.isArray(stop)) {
      return [];
    }
    const entry = stop as Record<string, unknown>;
    return typeof entry.offset === "number" && typeof entry.color === "string"
      ? [{
          offset: clamp(entry.offset, 0, 1),
          color: entry.color,
          ...(typeof entry.opacity === "number" ? { opacity: clamp(entry.opacity, 0, 1) } : {})
        }]
      : [];
  }).sort((left, right) => left.offset - right.offset);

  return sanitized.length >= 2
    ? sanitized
    : [
        { offset: 0, color: "#1d7f68" },
        { offset: 1, color: "#ffffff" }
      ];
}

export function styleColorMapValue(value: unknown, id: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const color = (value as Record<string, unknown>)[id];
  return typeof color === "string" ? color : undefined;
}

function styleStringMapValue(value: unknown, id: string): string | undefined {
  const entry = styleMapEntry(value, id);
  return typeof entry === "string" ? entry : undefined;
}

function styleNumberMapValue(value: unknown, id: string): number | undefined {
  const entry = styleMapEntry(value, id);
  return typeof entry === "number" && Number.isFinite(entry) ? entry : undefined;
}

function styleBooleanMapValue(value: unknown, id: string): boolean | undefined {
  const entry = styleMapEntry(value, id);
  return typeof entry === "boolean" ? entry : undefined;
}

function styleFontStyleMapValue(
  value: unknown,
  id: string
): NativeDrawingStyle["atomLabelFontStyle"] | undefined {
  const entry = styleStringMapValue(value, id);
  return entry === "normal" || entry === "italic" ? entry : undefined;
}

function styleBondLineCapMapValue(
  value: unknown,
  id: string
): NativeDrawingStyle["bondLineCap"] | undefined {
  const entry = styleStringMapValue(value, id);
  return entry === "butt" || entry === "round" || entry === "square" ? entry : undefined;
}

function styleBondSpacingModeMapValue(
  value: unknown,
  id: string
): NativeDrawingStyle["bondSpacingMode"] | undefined {
  const entry = styleStringMapValue(value, id);
  return entry === "absolute" || entry === "percent" ? entry : undefined;
}

function styleAtomLabelAlignmentMapValue(
  value: unknown,
  id: string
): NativeDrawingStyle["atomLabelAlignment"] | undefined {
  const entry = styleStringMapValue(value, id);
  return entry === "automatic" || entry === "left" || entry === "center" || entry === "right"
    ? entry
    : undefined;
}

function styleAtomLabelPlacementMapValue(
  value: unknown,
  id: string
): NativeDrawingStyle["atomLabelPlacement"] | undefined {
  const entry = styleStringMapValue(value, id);
  return entry === "automatic" || entry === "above" || entry === "below" ? entry : undefined;
}

function styleMapEntry(value: unknown, id: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[id];
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stableSvgIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_");
}

function metadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataFontStyle(value: unknown): string | undefined {
  return value === "italic" || value === "normal" ? value : undefined;
}

function rotationTransform(object: DocumentObject): string | undefined {
  if (object.rotation === 0) {
    return undefined;
  }

  return `rotate(${formatNumber(object.rotation)} ${formatNumber(object.x + object.width / 2)} ${formatNumber(object.y + object.height / 2)})`;
}

function transformPointForObject(object: DocumentObject, point: LayoutPoint): LayoutPoint {
  if (object.rotation === 0) {
    return point;
  }

  return rotatePoint(point, objectRotationCenter(object), degreesToRadians(object.rotation));
}

function inverseTransformPointForObject(object: DocumentObject, point: LayoutPoint): LayoutPoint {
  if (object.rotation === 0) {
    return point;
  }

  return rotatePoint(point, objectRotationCenter(object), degreesToRadians(-object.rotation));
}

function objectRotationCenter(object: DocumentObject): LayoutPoint {
  return {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2
  };
}

function rotatePoint(point: LayoutPoint, center: LayoutPoint, angleRadians: number): LayoutPoint {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const cos = Math.cos(angleRadians);
  const sin = Math.sin(angleRadians);
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos
  };
}

function moleculeDrawingPrimitive(object: MoleculeObject): "single-bond" | undefined {
  return object.style.drawingPrimitive === "single-bond" && object.atoms.length === 2 ? "single-bond" : undefined;
}

function isNativeMoleculeGraph(object: MoleculeObject): boolean {
  return object.atoms.length > 0;
}

function formatChemistrySummary(chemistry: NonNullable<MoleculeObject["chemistry"]>): string {
  const parts = [
    chemistry.averageMass !== undefined ? `avg ${chemistry.averageMass.toFixed(3)}` : undefined,
    chemistry.exactMass !== undefined ? `exact ${chemistry.exactMass.toFixed(4)}` : undefined,
    chemistry.totalCharge ? `charge ${chemistry.totalCharge}` : undefined,
    chemistry.stereochemistry.length > 0 ? chemistry.stereochemistry.join(", ") : undefined
  ].filter(Boolean);

  return parts.join(" | ");
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}
