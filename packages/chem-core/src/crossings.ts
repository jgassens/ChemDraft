import type { BondRef } from "./schemas";

/** Collision-free identity for arbitrary object and bond IDs. */
export function bondRefKey(ref: BondRef): string {
  return JSON.stringify([ref.objectId, ref.bondId]);
}

/** Decode only keys produced by bondRefKey; delimiter-joined keys are not supported. */
export function bondRefFromKey(key: string): BondRef {
  const value: unknown = JSON.parse(key);
  if (!Array.isArray(value) || value.length !== 2 ||
      typeof value[0] !== "string" || typeof value[1] !== "string") {
    throw new Error("Invalid bond reference key: expected two string IDs.");
  }
  return { objectId: value[0], bondId: value[1] };
}

export function compareBondRefs(left: BondRef, right: BondRef): number {
  return compareIds(left.objectId, right.objectId) || compareIds(left.bondId, right.bondId);
}

function compareIds(left: string, right: string): number {
  // Collation can equate distinct Unicode strings. Break ties by code units so reversing a pair
  // always produces the same key, even for canonically equivalent but distinct IDs.
  return left.localeCompare(right) || (left < right ? -1 : left > right ? 1 : 0);
}

export function canonicalBondRefs(bonds: readonly [BondRef, BondRef]): [BondRef, BondRef] {
  const [left, right] = bonds;
  return compareBondRefs(left, right) <= 0 ? [left, right] : [right, left];
}

/** Crossing identity is independent of the order of its two bond references. */
export function crossingPairKey(bonds: readonly [BondRef, BondRef]): string {
  return JSON.stringify(canonicalBondRefs(bonds).map((ref) => [ref.objectId, ref.bondId]));
}

/** IDs are arbitrary strings: delimiters must never stand in for tuple identity. */
export function sameBondRef(left: BondRef, right: BondRef): boolean {
  return left.objectId === right.objectId && left.bondId === right.bondId;
}

/** Crossing identity is an unordered pair of structured bond references. */
export function sameCrossingBondPair(left: readonly [BondRef, BondRef], right: readonly [BondRef, BondRef]): boolean {
  return (sameBondRef(left[0], right[0]) && sameBondRef(left[1], right[1])) ||
    (sameBondRef(left[0], right[1]) && sameBondRef(left[1], right[0]));
}
