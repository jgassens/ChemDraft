import { snapRotationDegrees } from "./rotationSnap";

/** Placement always uses the existing absolute 15° grid; Alt/Option frees the aim. */
export function snapPlacementDegrees(degrees: number, altKey = false): number {
  return altKey ? degrees : snapRotationDegrees(degrees, { shiftKey: true });
}
