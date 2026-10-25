import type { BondRef } from "./schemas";

/** IDs are arbitrary strings: delimiters must never stand in for tuple identity. */
export function sameBondRef(left: BondRef, right: BondRef): boolean {
  return left.objectId === right.objectId && left.bondId === right.bondId;
}

/** Crossing identity is an unordered pair of structured bond references. */
export function sameCrossingBondPair(left: readonly [BondRef, BondRef], right: readonly [BondRef, BondRef]): boolean {
  return (sameBondRef(left[0], right[0]) && sameBondRef(left[1], right[1])) ||
    (sameBondRef(left[0], right[1]) && sameBondRef(left[1], right[0]));
}
