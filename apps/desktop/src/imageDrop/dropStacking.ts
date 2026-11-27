/**
 * Paint order for the pictures of one drop. Every picture must keep some area that no picture
 * painted above it covers, so a click can still reach it. Pictures with the same frame are the one
 * exception here: neither has an edge to expose, so only the upper one can show. The arrangement
 * (`arrangeDroppedImages`) moves such a picture off its twin wherever the page leaves room, and the
 * drop's status names the pictures that must stay stacked.
 */

export interface StackFrame { x: number; y: number; width: number; height: number }

/**
 * Strips no wider than this, in page units, do not count as visible area: two edges that differ by
 * rounding alone never expose a picture, and frames within it of each other count as the same.
 */
export const STACK_TOLERANCE = 1e-6;

const right = (frame: StackFrame) => frame.x + frame.width;
const bottom = (frame: StackFrame) => frame.y + frame.height;

/** Frames that match to within the tolerance: the exception, with no edge to expose. */
export function sameFrame(a: StackFrame, b: StackFrame): boolean {
  return Math.abs(a.x - b.x) <= STACK_TOLERANCE && Math.abs(a.y - b.y) <= STACK_TOLERANCE
    && Math.abs(right(a) - right(b)) <= STACK_TOLERANCE && Math.abs(bottom(a) - bottom(b)) <= STACK_TOLERANCE;
}

/**
 * Whether part of `frame` lies outside the union of `covers`, exactly. The covers' left and right
 * edges cut `frame` into vertical strips no cover edge crosses, so within one strip each cover spans
 * the whole width or none of it; a strip is visible where the covers' vertical spans leave a gap.
 * A strip or gap must be wider than `STACK_TOLERANCE` to count.
 */
export function hasUncoveredArea(frame: StackFrame, covers: readonly StackFrame[]): boolean {
  const left = frame.x;
  const top = frame.y;
  const end = right(frame);
  const base = bottom(frame);
  const overlapping = covers.filter(cover => cover.x < end && right(cover) > left && cover.y < base && bottom(cover) > top);
  const cuts = overlapping.flatMap(cover => [cover.x, right(cover)]).filter(x => x > left && x < end);
  const xs = [...new Set([left, end, ...cuts])].sort((a, b) => a - b);
  for (let index = 0; index + 1 < xs.length; index++) {
    if (xs[index + 1]! - xs[index]! <= STACK_TOLERANCE) continue;
    const middle = (xs[index]! + xs[index + 1]!) / 2;
    const spans = overlapping
      .filter(cover => cover.x <= middle && middle <= right(cover))
      .map(cover => [Math.max(cover.y, top), Math.min(bottom(cover), base)] as const)
      .sort((a, b) => a[0] - b[0]);
    let reach = top;
    for (const [start, stop] of spans) {
      if (start - reach > STACK_TOLERANCE) return true;
      reach = Math.max(reach, stop);
    }
    if (base - reach > STACK_TOLERANCE) return true;
  }
  return false;
}

/**
 * A bottom-to-top order of `frames` (indices) in which each keeps visible area under every frame
 * painted above it other than a same frame, or `undefined` when no order does.
 *
 * Drop order when that already works. Otherwise the order is built from the bottom: each step
 * takes the earliest remaining frame with area outside all the others still remaining. Whatever
 * order those take above it, that area stays visible, so the choice is never undone; and if some
 * order works for the remaining frames, its bottom frame is such a frame, so the search fails only
 * when no order works.
 */
export function visiblePaintOrder(frames: readonly StackFrame[]): number[] | undefined {
  const keepsArea = (index: number, above: readonly number[]) => hasUncoveredArea(frames[index]!,
    above.filter(other => other !== index && !sameFrame(frames[other]!, frames[index]!)).map(other => frames[other]!));
  const dropOrder = frames.map((_, index) => index);
  if (dropOrder.every(index => keepsArea(index, dropOrder.slice(index + 1)))) return dropOrder;
  const remaining = [...dropOrder];
  const order: number[] = [];
  while (remaining.length) {
    const at = remaining.findIndex(index => keepsArea(index, remaining));
    if (at < 0) return undefined;
    order.push(...remaining.splice(at, 1));
  }
  return order;
}
