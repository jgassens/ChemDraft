import type { Point } from "./schemas";

/** Pure planar rotation shared with layout-engine. Positive angles turn clockwise in page/SVG coordinates. */
export function rotatePointAboutCenter(point: Point, center: Point, angleRadians: number): Point {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const cos = Math.cos(angleRadians);
  const sin = Math.sin(angleRadians);
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos
  };
}
