import type { GraphicObject } from "@chemdraft/chem-core";
import { planNativeArtVisual, projectGraphicObjectPoint } from "@chemdraft/art-engine";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Local visual bounds after the graphic's plane projection and in-plane rotation. */
export function rotatedGraphicLocalBounds(
  object: GraphicObject,
  bounds: Bounds,
  rotationDegrees: number
): Bounds {
  const ellipsePlan = object.graphicKind === "ellipse"
    ? planNativeArtVisual(object, { coordinateSpace: "local" })
    : undefined;
  if (Math.abs(rotationDegrees) < 0.001 && !ellipsePlan?.projectionMatrix) return bounds;
  const cx = Math.max(object.width, 1) / 2;
  const cy = Math.max(object.height, 1) / 2;
  const radians = rotationDegrees * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const rotate = (point: { x: number; y: number }) => ({
    x: cx + (point.x - cx) * cos - (point.y - cy) * sin,
    y: cy + (point.x - cx) * sin + (point.y - cy) * cos
  });
  if (ellipsePlan) {
    // An affine ellipse is centre + u*cos(t) + v*sin(t). Its axis extrema
    // are hypot(u.x, v.x) and hypot(u.y, v.y), including after a plane tilt.
    // A square source frame is circular only BEFORE projection; skipping its
    // rotation clips a tilted circle. Rotating its bounding rectangle is loose.
    const project = (point: { x: number; y: number }) => rotate(
      projectGraphicObjectPoint(object, point, { coordinateSpace: "local" }));
    // Match ellipsePathPoints: inset BEFORE projection (including its minimum
    // radius), then paint a full-width, unprojected stroke around that path.
    const halfStroke = Math.max(ellipsePlan.stroke.width / 2, 0);
    const u = project({ x: cx + Math.max(cx - halfStroke, 0.5), y: cy });
    const v = project({ x: cx, y: cy + Math.max(cy - halfStroke, 0.5) });
    const rx = Math.hypot(u.x - cx, v.x - cx) + halfStroke;
    const ry = Math.hypot(u.y - cy, v.y - cy) + halfStroke;
    const extrema = [{ x: cx - rx, y: cy - ry }, { x: cx + rx, y: cy + ry }];
    // Tilted ellipses render as closed polylines. Their miter joins can extend
    // beyond a smooth ellipse's stroke, especially at a nearly edge-on tip.
    if (ellipsePlan.projectedShapePathD && ellipsePlan.stroke.lineJoin === "miter") {
      extrema.push(...projectedEllipseMiterTips(ellipsePlan.projectedShapePathD,
        halfStroke, ellipsePlan.stroke.miterLimit).map(rotate));
    }
    const x = Math.min(...extrema.map(point => point.x));
    const y = Math.min(...extrema.map(point => point.y));
    return { x, y, width: Math.max(...extrema.map(point => point.x)) - x,
      height: Math.max(...extrema.map(point => point.y)) - y };
  }

  const points = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height }
  ].map(rotate);
  const x = Math.min(...points.map(point => point.x));
  const y = Math.min(...points.map(point => point.y));
  const round = (value: number) => Number(value.toFixed(3));
  return { x: round(x), y: round(y),
    width: round(Math.max(...points.map(point => point.x)) - x),
    height: round(Math.max(...points.map(point => point.y)) - y) };
}

function projectedEllipseMiterTips(pathD: string, halfStroke: number, miterLimit: number) {
  // Consume the renderer's actual rounded M/L vertices rather than maintaining
  // another tessellation or assuming its sampling count.
  const vertices = Array.from(pathD.matchAll(/[ML]\s+([-\d.e+]+)\s+([-\d.e+]+)/g),
    match => ({ x: Number(match[1]), y: Number(match[2]) }));
  const first = vertices[0], last = vertices[vertices.length - 1];
  if (first && last && first.x === last.x && first.y === last.y) vertices.pop();
  const tips: { x: number; y: number }[] = [];
  for (let i = 0; i < vertices.length; i++) {
    const previous = vertices[(i + vertices.length - 1) % vertices.length]!;
    const point = vertices[i]!, next = vertices[(i + 1) % vertices.length]!;
    const incoming = { x: point.x - previous.x, y: point.y - previous.y };
    const outgoing = { x: next.x - point.x, y: next.y - point.y };
    const a = Math.hypot(incoming.x, incoming.y), b = Math.hypot(outgoing.x, outgoing.y);
    if (a === 0 || b === 0) continue;
    const nx = incoming.y / a + outgoing.y / b;
    const ny = -incoming.x / a - outgoing.x / b;
    const denominator = 1 + (incoming.x * outgoing.x + incoming.y * outgoing.y) / (a * b);
    if (denominator <= 0) continue;
    const dx = halfStroke * nx / denominator, dy = halfStroke * ny / denominator;
    // SVG falls back to bevel when the miter exceeds the limit. Bevel and round
    // joins are already contained by the analytic ellipse plus half a stroke.
    if (Math.hypot(dx, dy) <= halfStroke * miterLimit) {
      tips.push({ x: point.x + dx, y: point.y + dy });
    }
  }
  return tips;
}
