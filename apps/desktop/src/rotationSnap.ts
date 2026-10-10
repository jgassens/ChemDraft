export const rotationSnapToleranceDegrees = 3;
const rotationStepDegrees = 15;

/** Return a drag delta snapped against the starting absolute orientation,
 * preserving turns past 180° and 360°. Without a reference, snap the delta.
 * Junction fragments may supply an absolute bond-direction grid and extra targets.
 * Shift always constrains the resulting orientation to 15° steps, regardless of that grid.
 */
export function snapRotationDegrees(
  degrees: number,
  options: {
    shiftKey?: boolean;
    referenceDegrees?: number;
    stepDegrees?: number;
    additionalAbsoluteAngles?: readonly number[];
  } = {}
): number {
  const reference = options.referenceDegrees ?? 0;
  const absolute = reference + degrees;
  if (options.shiftKey) {
    return Math.round(absolute / rotationStepDegrees) * rotationStepDegrees - reference;
  }

  const step = options.stepDegrees ?? rotationStepDegrees;
  let adjustment = Math.round(absolute / step) * step - absolute;
  for (const candidate of options.additionalAbsoluteAngles ?? []) {
    const delta = ((candidate - absolute + 180) % 360 + 360) % 360 - 180;
    if (Math.abs(delta) < Math.abs(adjustment)) {
      adjustment = delta;
    }
  }
  return Math.abs(adjustment) <= rotationSnapToleranceDegrees
    ? degrees + adjustment
    : degrees;
}
