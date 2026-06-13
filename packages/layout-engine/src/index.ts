import {
  nativeDrawingStyleFromObjectStyle,
  nativeTextStyleFromObjectStyle,
  type BondRef,
  type CrossingOverride,
  type DocumentObject,
  type DocumentPage,
  type ElectronMarkObject,
  type MoleculeAtom,
  type MoleculeBond as CoreMoleculeBond,
  type MoleculeObject,
  type NativeDrawingStyle,
  type TextObject,
  type TextSpan
} from "@chemdraft/chem-core";

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

const doubleBondMinimumVisibleSegmentPx = 13;
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
  if (bond.order === "triple") {
    return drawingStyle.multipleBondGapPx * 2 + nativeBondStrokeWidth(bond, drawingStyle);
  }
  if (bond.order === "double") {
    return drawingStyle.multipleBondGapPx + nativeBondStrokeWidth(bond, drawingStyle);
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

function sameBondRef(left: BondRef, right: BondRef): boolean {
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
    fragments: page.objects.flatMap((object, layerIndex) =>
      flattenDocumentObjectSvg(planDocumentObjectSvg(object, layerIndex, warnings, gapsByBondKey))
    ).concat(crossingHitTargets),
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
): PageSvgElementFragment {
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
      return lineObjectFragment(object, object.arrowKind, layerIndex);
    case "graphic":
      return graphicObjectFragment(object, warnings, layerIndex);
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
  const atomLabels = object.atoms.flatMap((atom) => {
    const label = atomDisplayLabel(atom, object.bonds);
    return label ? [{ atom, label }] : [];
  });
  const labelByAtomId = new Map(atomLabels.map(({ atom, label }) => [atom.id, label]));
  const bondSegmentGroups = object.bonds.flatMap((bond) => {
    const fromAtom = atomById.get(bond.fromAtomId);
    const toAtom = atomById.get(bond.toAtomId);
    if (!fromAtom || !toAtom) {
      return [];
    }

    const segments = bondLineSegments(
      fromAtom,
      toAtom,
      object,
      bond,
      drawingStyle,
      labelByAtomId.get(fromAtom.id),
      labelByAtomId.get(toAtom.id)
    ).map((segment, segmentIndex) => ({
      ...segment,
      bond,
      key: `${bond.id}-${segmentIndex}`
    }));

    return [{ bond, segments }];
  });
  const primitive = moleculeDrawingPrimitive(object) === "single-bond"
    ? "single-bond"
    : "connected-carbon-chain";

  return elementFragment("g", `object-${object.id}`, objectAttributes(object, layerIndex, {
    "data-chem-primitive": primitive,
    "data-structure": object.structure,
    "data-atom-count": object.atoms.length,
    "data-bond-count": object.bonds.length,
    "data-style-preset-id": drawingStyle.stylePresetId,
    transform: rotationTransform(object)
  }), [
    ...bondSegmentGroups.map(({ bond, segments }) =>
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
            drawingStyle,
            gapsByBondKey.get(bondRefKey({ objectId: object.id, bondId: segment.bond.id })) ?? []
          )
        )
      ])
    ),
    ...atomLabels.map(({ atom, label }) => {
      const box = atomLabelBox(atom, label, drawingStyle);
      return elementFragment("rect", `label-background-${object.id}-${atom.id}`, {
        class: "native-atom-label-background",
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        fill: drawingStyle.atomLabelBackgroundColor
      });
    }),
    ...atomLabels.map(({ atom, label }) =>
      elementFragment("g", `label-${object.id}-${atom.id}`, {
        class: "native-atom-label",
        "data-atom-label": label,
        transform: `translate(${formatNumber(atomLabelAnchor(atom).x)} ${formatNumber(atomLabelAnchor(atom).y)})`,
        fill: nativeMoleculeAtomLabelColor(object, atom.id, drawingStyle),
        "font-family": drawingStyle.atomLabelFontFamily,
        "font-size": drawingStyle.atomLabelFontSizePx,
        "font-weight": drawingStyle.atomLabelFontWeight
      }, atomLabelLayout(label, drawingStyle).runs.map((run, index) =>
        elementFragment("text", `label-run-${object.id}-${atom.id}-${index}`, {
          class: "native-atom-label-run",
          "data-atom-label-run": run.script === "superscript" ? "charge" : run.script,
          x: run.x,
          y: run.y,
          "dominant-baseline": "central",
          "text-anchor": run.textAnchor,
          "font-size": atomLabelRunFontSize(run.script, drawingStyle)
        }, [textFragment(`label-run-text-${object.id}-${atom.id}-${index}`, run.text)])
      ))
    ),
    ...object.atoms.map((atom) =>
      elementFragment("circle", `atom-hit-${object.id}-${atom.id}`, {
        class: "native-atom-hit-target",
        "data-hit-target": "atom",
        "data-atom-id": atom.id,
        cx: atom.x,
        cy: atom.y,
        r: 8
      })
    )
  ]);
}

function nativeBondHoverDecoratorFragments(
  segment: PageBondLineSegment & { bond: CoreMoleculeBond; key: string },
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
  segment: PageBondLineSegment & { bond: CoreMoleculeBond; key: string },
  drawingStyle: NativeDrawingStyle,
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
  const stroke = nativeMoleculeBondColor(object, segment.bond.id, drawingStyle);

  if (bondStyle === "wedge" && segment.segment === "primary") {
    return splitSegmentByCrossingGaps(segment, crossingGaps).map((visibleSegment, index) =>
      elementFragment("polygon", `bond-${object.id}-${segment.key}-${index}`, {
        ...commonAttrs,
        points: nativeWedgePolygonPoints(visibleSegment, drawingStyle),
        fill: stroke,
        stroke: "none"
      })
    );
  }

  if (bondStyle === "hashed" && segment.segment === "primary") {
    return [
      elementFragment("g", `bond-${object.id}-${segment.key}`, commonAttrs, nativeHashedWedgeSegments(segment, drawingStyle).flatMap((hash, index) =>
        splitSegmentByCrossingGaps(hash, crossingGaps).map((visibleHash, visibleIndex) =>
          elementFragment("line", `bond-hash-${object.id}-${segment.key}-${index}-${visibleIndex}`, {
            class: "native-bond-hash",
            "data-bond-hash-index": index,
            x1: visibleHash.x1,
            y1: visibleHash.y1,
            x2: visibleHash.x2,
            y2: visibleHash.y2,
            stroke,
            "stroke-width": drawingStyle.bondStrokeWidthPx,
            "stroke-linecap": "butt"
          })
        )
      ))
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
      "stroke-width": nativeBondStrokeWidth(segment.bond, drawingStyle),
      "stroke-linecap": bondStyle === "dashed" ? "butt" : drawingStyle.bondLineCap,
      "stroke-dasharray": bondStyle === "dashed" ? nativeDashedBondDashArray(drawingStyle) : undefined
    })
  );
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
  object: Extract<DocumentObject, { type: "graphic" }>,
  warnings: PageSvgRenderWarning[],
  layerIndex: number
): PageSvgElementFragment {
  if (object.graphicKind === "rect") {
    return elementFragment("rect", `object-${object.id}`, objectAttributes(object, layerIndex, {
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
      fill: "none",
      stroke: "#2f3b42",
      "stroke-width": 1.5,
      transform: rotationTransform(object)
    }));
  }

  warnings.push({
    code: "export.svg.graphic_fallback",
    message: `SVG export used a labeled fallback for graphic kind "${object.graphicKind}".`,
    objectId: object.id
  });
  return fallbackObjectFragment(object, layerIndex);
}

function lineObjectFragment(object: DocumentObject, label: string, layerIndex: number): PageSvgElementFragment {
  const startX = object.x;
  const startY = object.y + object.height / 2;
  const endX = object.x + object.width;
  const endY = startY;
  return elementFragment("g", `object-${object.id}`, objectAttributes(object, layerIndex, {
    transform: rotationTransform(object)
  }), [
    elementFragment("line", `line-${object.id}`, {
      x1: startX,
      y1: startY,
      x2: endX,
      y2: endY,
      stroke: "#172026",
      "stroke-width": 1.5
    }),
    elementFragment("text", `line-label-${object.id}`, {
      x: object.x,
      y: object.y - 6,
      "font-family": "Arial, sans-serif",
      "font-size": 10,
      fill: "#52616b"
    }, [textFragment(`line-label-text-${object.id}`, label)])
  ]);
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
  toLabel?: string
): PageBondLineSegment[] {
  const dx = toAtom.x - fromAtom.x;
  const dy = toAtom.y - fromAtom.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return [{ x1: fromAtom.x, y1: fromAtom.y, x2: toAtom.x, y2: toAtom.y, segment: "primary" }];
  }

  const unit = { x: dx / length, y: dy / length };
  const clearance = labelEndpointClearance(fromAtom, toAtom, fromLabel, toLabel, drawingStyle, length, unit);
  const x1 = fromAtom.x + unit.x * clearance.from;
  const y1 = fromAtom.y + unit.y * clearance.from;
  const x2 = toAtom.x - unit.x * clearance.to;
  const y2 = toAtom.y - unit.y * clearance.to;
  const trimmedLength = Math.hypot(x2 - x1, y2 - y1);
  const normal = { x: -unit.y, y: unit.x };
  const gap = drawingStyle.multipleBondGapPx;

  if (bond.order === "double") {
    const doubleBondSide = bond.display?.doubleBondSide ?? "left";
    if (isTerminalHeteroatomDoubleBond(fromAtom, toAtom, object, bond)) {
      const offset = gap / 2;
      return [
        {
          x1: x1 + normal.x * offset,
          y1: y1 + normal.y * offset,
          x2: x2 + normal.x * offset,
          y2: y2 + normal.y * offset,
          segment: "primary",
          doubleBondSide
        },
        {
          x1: x1 - normal.x * offset,
          y1: y1 - normal.y * offset,
          x2: x2 - normal.x * offset,
          y2: y2 - normal.y * offset,
          segment: "secondary",
          doubleBondSide
        }
      ];
    }

    const offset = doubleBondSide === "left" ? gap : -gap;
    const minimumSecondaryLength = Math.min(doubleBondMinimumVisibleSegmentPx, trimmedLength);
    const inset = Math.min(
      drawingStyle.doubleBondInsetPx,
      Math.max(0, (trimmedLength - minimumSecondaryLength) / 2)
    );
    return [
      { x1, y1, x2, y2, segment: "primary", doubleBondSide },
      {
        x1: x1 + unit.x * inset + normal.x * offset,
        y1: y1 + unit.y * inset + normal.y * offset,
        x2: x2 - unit.x * inset + normal.x * offset,
        y2: y2 - unit.y * inset + normal.y * offset,
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

function labelEndpointClearance(
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  fromLabel: string | undefined,
  toLabel: string | undefined,
  drawingStyle: NativeDrawingStyle,
  bondLength: number,
  unit: { x: number; y: number }
): { from: number; to: number } {
  const from = atomLabelBondClearance(fromAtom, fromLabel, drawingStyle, unit);
  const to = atomLabelBondClearance(toAtom, toLabel, drawingStyle, { x: -unit.x, y: -unit.y });
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

  return Math.max(drawingStyle.atomLabelBondClearancePx, Math.max(0, labelBoundaryDistance));
}

function atomLabelBox(
  atom: MoleculeAtom,
  label: string,
  drawingStyle: NativeDrawingStyle
): { x: number; y: number; width: number; height: number } {
  const anchor = atomLabelAnchor(atom);
  const { bounds } = atomLabelLayout(label, drawingStyle);
  return {
    x: anchor.x + bounds.x,
    y: anchor.y + bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

function atomLabelAnchor(atom: MoleculeAtom): LayoutPoint {
  return {
    x: atom.x + (atom.labelOffset?.x ?? 0),
    y: atom.y + (atom.labelOffset?.y ?? 0)
  };
}

function atomLabelBoundsRelativeToAtom(
  atom: MoleculeAtom,
  label: string,
  drawingStyle: NativeDrawingStyle
): { x: number; y: number; width: number; height: number } {
  const { bounds } = atomLabelLayout(label, drawingStyle);
  return {
    x: (atom.labelOffset?.x ?? 0) + bounds.x,
    y: (atom.labelOffset?.y ?? 0) + bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

type AtomLabelScript = "normal" | "subscript" | "superscript";

interface AtomLabelRun {
  text: string;
  script: AtomLabelScript;
}

interface AtomLabelLayoutRun extends AtomLabelRun {
  x: number;
  y: number;
  textAnchor: "middle" | "start";
}

interface AtomLabelLayout {
  bounds: { x: number; y: number; width: number; height: number };
  runs: AtomLabelLayoutRun[];
}

function atomLabelLayout(label: string, drawingStyle: NativeDrawingStyle): AtomLabelLayout {
  const { bodyRuns, chargeRun } = atomLabelParts(label);
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
  return {
    bounds: {
      x: -baseHalfWidth - padding,
      y: top - padding,
      width: right + baseHalfWidth + padding * 2,
      height: bottom - top + padding * 2
    },
    runs
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
  return run.text.length * fontSize * widthFactor;
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

function atomLabelRunFontSize(script: AtomLabelScript, drawingStyle: NativeDrawingStyle): number | undefined {
  if (script === "normal") {
    return undefined;
  }

  return drawingStyle.atomLabelFontSizePx * (script === "superscript" ? 0.88 : 0.72);
}

function atomDisplayLabel(atom: MoleculeAtom, bonds: readonly CoreMoleculeBond[]): string | undefined {
  const element = nativeElementFromAtomLabel(atom.element);
  if (!element) {
    const symbol = atom.element.trim() || "C";
    return `${symbol}${chargeLabelSuffix(atom.formalCharge)}`;
  }
  const valenceUsed = nativeAtomBondOrderUsage(atom.id, bonds);
  const formalCharge = atom.formalCharge;

  if (element === "C" && valenceUsed > 0 && formalCharge === 0 && atom.labelVisible !== true) {
    return undefined;
  }

  return `${element}${implicitHydrogenLabel(Math.max(0, (nativeAtomValence[element] ?? 0) - valenceUsed))}${chargeLabelSuffix(formalCharge)}`;
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
  return nativeBondDisplayStyle(bond) === "bold"
    ? drawingStyle.bondStrokeWidthPx * 2.4
    : drawingStyle.bondStrokeWidthPx;
}

function nativeDashedBondDashArray(drawingStyle: NativeDrawingStyle): string {
  const dash = Math.max(3, drawingStyle.bondStrokeWidthPx * 2.2);
  const gap = Math.max(3, drawingStyle.bondStrokeWidthPx * 1.8);
  return `${formatNumber(dash)} ${formatNumber(gap)}`;
}

function nativeWedgeWidth(drawingStyle: NativeDrawingStyle): number {
  return Math.max(8, drawingStyle.bondStrokeWidthPx * 5.2);
}

function nativeWedgePolygonPoints(
  segment: Pick<PageBondLineSegment, "x1" | "y1" | "x2" | "y2">,
  drawingStyle: NativeDrawingStyle
): string {
  const geometry = nativeSegmentVectorGeometry(segment);
  if (!geometry) {
    return `${formatNumber(segment.x1)},${formatNumber(segment.y1)} ${formatNumber(segment.x2)},${formatNumber(segment.y2)}`;
  }

  const halfWidth = nativeWedgeWidth(drawingStyle) / 2;
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

function nativeHashedWedgeSegments(
  segment: Pick<PageBondLineSegment, "x1" | "y1" | "x2" | "y2">,
  drawingStyle: NativeDrawingStyle
): Pick<PageBondLineSegment, "x1" | "y1" | "x2" | "y2">[] {
  const geometry = nativeSegmentVectorGeometry(segment);
  if (!geometry) {
    return [];
  }

  const hashCount = Math.max(5, Math.min(9, Math.round(geometry.length / 9)));
  const maxWidth = nativeWedgeWidth(drawingStyle);
  return Array.from({ length: hashCount }, (_, index) => {
    const t = (index + 1) / (hashCount + 1);
    const center = {
      x: segment.x1 + geometry.unit.x * geometry.length * t,
      y: segment.y1 + geometry.unit.y * geometry.length * t
    };
    const halfWidth = maxWidth * t / 2;
    return {
      x1: center.x + geometry.normal.x * halfWidth,
      y1: center.y + geometry.normal.y * halfWidth,
      x2: center.x - geometry.normal.x * halfWidth,
      y2: center.y - geometry.normal.y * halfWidth
    };
  });
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

function isTerminalHeteroatomDoubleBond(
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

function isTerminalHeteroatom(atom: MoleculeAtom, object: MoleculeObject): boolean {
  return atom.element !== "C" && atom.element !== "H" && atomBondCount(object, atom.id) === 1;
}

function atomBondCount(object: MoleculeObject, atomId: string): number {
  return object.bonds.filter((bond) => bond.fromAtomId === atomId || bond.toAtomId === atomId).length;
}

function nativeMoleculeBondColor(
  object: MoleculeObject,
  bondId: string,
  drawingStyle: NativeDrawingStyle
): string {
  return styleColorMapValue(object.style.bondColors, bondId) ?? drawingStyle.bondColor;
}

function nativeMoleculeAtomLabelColor(
  object: MoleculeObject,
  atomId: string,
  drawingStyle: NativeDrawingStyle
): string {
  return styleColorMapValue(object.style.atomLabelColors, atomId) ?? drawingStyle.atomLabelColor;
}

function styleColorMapValue(value: unknown, id: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const color = (value as Record<string, unknown>)[id];
  return typeof color === "string" ? color : undefined;
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
