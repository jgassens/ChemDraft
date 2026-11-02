import type { GraphicObject } from "@chemdraft/chem-core";
import { planNativeArtVisual, projectGraphicObjectPoint } from "@chemdraft/art-engine";
import { expect } from "vitest";

type Point = { x: number; y: number };

export const ellipseBoundsCases = [1, 10, 40].flatMap(strokeWidth => [
  ...[30, 45].flatMap(rotation => [
    { rotation, width: 200, height: 200, tiltX: 0, tiltY: 0 },
    { rotation, width: 400, height: 100, tiltX: 0, tiltY: 0 },
    { rotation, width: 200, height: 200, tiltX: 60, tiltY: 0 },
    { rotation, width: 400, height: 100, tiltX: 40, tiltY: 25 }
  ]),
  { rotation: 0, width: 400, height: 100, tiltX: 40, tiltY: 25 },
  { rotation: 90, width: 400, height: 100, tiltX: 85, tiltY: 0 },
  { rotation: 90, width: 200, height: 200, tiltX: 0, tiltY: 0 }
].map(geometry => ({ ...geometry, strokeWidth })));

export function boundsTestEllipse({ rotation, width, height, tiltX, tiltY, strokeWidth }: typeof ellipseBoundsCases[number]): GraphicObject {
  return { id: "ellipse", type: "graphic", graphicKind: "ellipse", x: 250, y: 300,
    width, height, rotation, data: {},
    style: { strokeWidth, fillColor: "#111111", tiltXDegrees: tiltX, tiltYDegrees: tiltY } };
}

/** Sample the renderer's actual closed projected polyline, including its stroke joins. */
export function renderedEllipseOutline(object: GraphicObject): Point[] {
  const plan = planNativeArtVisual(object, { coordinateSpace: "local" });
  const halfStroke = plan.stroke.width / 2;
  const cx = plan.width / 2, cy = plan.height / 2;
  const radians = object.rotation * Math.PI / 180;
  const rotate = (p: Point): Point => ({
    x: object.x + cx + (p.x - cx) * Math.cos(radians) - (p.y - cy) * Math.sin(radians),
    y: object.y + cy + (p.x - cx) * Math.sin(radians) + (p.y - cy) * Math.cos(radians)
  });
  if (!plan.projectedShapePathD) {
    // The untilted renderer uses a native ellipse. Offset its projected centreline
    // along the normal, rather than projecting an already stroked ellipse.
    const centreline = (t: number) => projectGraphicObjectPoint(object, {
      x: cx + Math.max(cx - halfStroke, 0.5) * Math.cos(t),
      y: cy + Math.max(cy - halfStroke, 0.5) * Math.sin(t)
    }, { coordinateSpace: "local" });
    return Array.from({ length: 7200 }, (_, i) => {
      const t = i * Math.PI / 3600, p = centreline(t);
      const before = centreline(t - 0.00001), after = centreline(t + 0.00001);
      const dx = after.x - before.x, dy = after.y - before.y, length = Math.hypot(dx, dy);
      return rotate({ x: p.x + halfStroke * dy / length, y: p.y - halfStroke * dx / length });
    });
  }
  const vertices = Array.from(plan.projectedShapePathD.matchAll(/[ML]\s+([-\d.e+]+)\s+([-\d.e+]+)/g),
    match => ({ x: Number(match[1]), y: Number(match[2]) }));
  // The renderer repeats the first vertex before Z.
  vertices.pop();
  const outline: Point[] = [];
  const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
  for (let i = 0; i < vertices.length; i++) {
    const p = vertices[i]!, next = vertices[(i + 1) % vertices.length]!;
    const previous = vertices[(i + vertices.length - 1) % vertices.length]!;
    const dx = next.x - p.x, dy = next.y - p.y, length = Math.hypot(dx, dy);
    const normal = { x: dy / length, y: -dx / length };
    for (let j = 0; j <= 64; j++) {
      const t = j / 64;
      for (const side of [-1, 1]) outline.push({
        x: p.x + dx * t + side * halfStroke * normal.x,
        y: p.y + dy * t + side * halfStroke * normal.y
      });
    }
    if (plan.stroke.lineJoin === "round") {
      for (let j = 0; j < 360; j++) outline.push({
        x: p.x + halfStroke * Math.cos(j * Math.PI / 180),
        y: p.y + halfStroke * Math.sin(j * Math.PI / 180)
      });
    } else if (plan.stroke.lineJoin === "miter") {
      // Independently intersect the two outward-offset segment lines.
      const incoming = { x: p.x - previous.x, y: p.y - previous.y };
      const incomingLength = Math.hypot(incoming.x, incoming.y);
      const start = { x: p.x + halfStroke * incoming.y / incomingLength,
        y: p.y - halfStroke * incoming.x / incomingLength };
      const end = { x: p.x + halfStroke * normal.x, y: p.y + halfStroke * normal.y };
      const outgoing = { x: dx, y: dy };
      const denominator = cross(incoming, outgoing);
      if (Math.abs(denominator) > 1e-10) {
        const t = cross({ x: end.x - start.x, y: end.y - start.y }, outgoing) / denominator;
        const tip = { x: start.x + t * incoming.x, y: start.y + t * incoming.y };
        if (Math.hypot(tip.x - p.x, tip.y - p.y) <= halfStroke * plan.stroke.miterLimit) outline.push(tip);
      }
    }
  }
  return outline.map(rotate);
}

export function expectTightOutlineBounds(bounds: { x: number; y: number; width: number; height: number }, outline: Point[]) {
  const tolerance = 0.001; // Renderer path coordinates are rounded to four decimal places.
  expect(outline.length).toBeGreaterThan(7000);
  expect(outline.every(p => p.x >= bounds.x - tolerance && p.y >= bounds.y - tolerance &&
    p.x <= bounds.x + bounds.width + tolerance && p.y <= bounds.y + bounds.height + tolerance)).toBe(true);
  const gaps = [Math.min(...outline.map(p => p.x)) - bounds.x,
    Math.min(...outline.map(p => p.y)) - bounds.y,
    bounds.x + bounds.width - Math.max(...outline.map(p => p.x)),
    bounds.y + bounds.height - Math.max(...outline.map(p => p.y))];
  for (const gap of gaps) {
    expect(gap).toBeGreaterThanOrEqual(-tolerance);
    expect(gap).toBeLessThanOrEqual(0.5);
  }
}
