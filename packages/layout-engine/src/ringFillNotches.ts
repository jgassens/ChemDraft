import { subtractPolygonPaths } from "@chemdraft/art-engine";
import type { AtomLabelPlan, LayoutBounds, LayoutPoint } from "./index";

interface LabelClearance {
  bounds: LayoutBounds;
  radius: number;
}

// Geometry values survive fresh document copies. Keep only a small working set of rings;
// cached differences contain neither document objects nor atom IDs.
const notchCacheLimit = 256;
const notchCache = new Map<string, ReturnType<typeof subtractPolygonPaths>>();
// A descriptor is built once per molecule render and may touch several rings.
const clearancePolygons = new WeakMap<LabelClearance, LayoutPoint[]>();

export function atomLabelRingClearance(plan: AtomLabelPlan, scale: number): LabelClearance {
  const width = plan.layout.bounds.width * scale;
  const height = plan.layout.bounds.height * scale;
  // Circumscribe the text-box corners, plus the existing 1–2 px bond clearance.
  const padding = Math.max(1, Math.min(2, plan.drawingStyle.atomLabelBondClearancePx)) * scale
    + (Math.SQRT2 - 1) * Math.min(width, height) / 2;
  return {
    bounds: {
      x: plan.anchor.x + plan.layout.bounds.x * scale - padding,
      y: plan.anchor.y + plan.layout.bounds.y * scale - padding,
      width: width + 2 * padding,
      height: height + 2 * padding
    },
    radius: Math.min(width, height) / 2 + padding
  };
}

export function ringOverlappingClearances(
  points: readonly LayoutPoint[], clearances: readonly LabelClearance[]
): number[] {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  const indices: number[] = [];
  clearances.forEach(({ bounds }, index) => {
    if (bounds.x <= right && bounds.x + bounds.width >= left
      && bounds.y <= bottom && bounds.y + bounds.height >= top) indices.push(index);
  });
  return indices;
}

/** Internal geometry cache; indices refer to the supplied, bbox-filtered clearances. */
export function notchedRingPath(
  points: readonly LayoutPoint[], clearances: readonly LabelClearance[]
): ReturnType<typeof subtractPolygonPaths> {
  const key = JSON.stringify([points.map(({ x, y }) => [x, y]), clearances]);
  const cached = notchCache.get(key);
  if (cached) {
    notchCache.delete(key);
    notchCache.set(key, cached);
    return cached;
  }
  const result = subtractPolygonPaths(points, clearances.map(atomLabelRingClearancePolygon));
  notchCache.set(key, result);
  if (notchCache.size > notchCacheLimit) notchCache.delete(notchCache.keys().next().value!);
  return result;
}

function atomLabelRingClearancePolygon(clearance: LabelClearance): LayoutPoint[] {
  const cached = clearancePolygons.get(clearance);
  if (cached) return cached;
  const { bounds, radius } = clearance;
  const left = bounds.x, top = bounds.y;
  const right = left + bounds.width, bottom = top + bounds.height;
  const centers = [
    { x: right - radius, y: top + radius },
    { x: right - radius, y: bottom - radius },
    { x: left + radius, y: bottom - radius },
    { x: left + radius, y: top + radius }
  ];
  // A 0.1 px chord error is at most 0.4 screen pixels at 4x zoom, below a pixel
  // even there. Keep the same stadium and padding, with far fewer boolean edges.
  const steps = Math.max(3, Math.ceil(Math.PI / 2 / (2 * Math.acos(1 - Math.min(0.1 / radius, 1)))));
  const points = centers.flatMap((center, corner) => Array.from({ length: steps + 1 }, (_, step) => {
    const angle = -Math.PI / 2 + (corner + step / steps) * Math.PI / 2;
    return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
  }));
  clearancePolygons.set(clearance, points);
  return points;
}
