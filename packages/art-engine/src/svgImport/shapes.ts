import type { GraphicObject, Point } from "@chemdraft/chem-core";
import Flatten from "@flatten-js/core";
import {
  boxForPoints, diagonal, length, near, nearZero, numbers, parsePath, pathBounds, point,
  polygonPath, similarityScale, transformPath, type Bounds, type Matrix, type Path, type Size
} from "./geometry";
import type { Declarations } from "./presentation";
import { property } from "./presentation";

export const shapeAttributes: Readonly<Record<string, readonly string[]>> = {
  path: ["d"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"]
};

export interface Shape {
  path: Path;
  primitive?:
    | { kind: "line"; from: Point; to: Point }
    | { kind: "rect" | "ellipse"; box: Bounds; rx: number; ry: number };
}

/** Undefined means unsupported geometry. An empty path is a valid shape with no ink. */
export function readShape(element: Element, css: Declarations, viewport: Size, em: number): Shape | undefined {
  const get = (name: string) => property(element, css, name);
  const coordinate = (name: string, basis: number, fallback = 0) => {
    const value = get(name);
    return value === undefined || value === "auto" ? fallback : length(value, basis, em) ?? NaN;
  };
  const x = (name: string, fallback?: number) => coordinate(name, viewport.width, fallback);
  const y = (name: string, fallback?: number) => coordinate(name, viewport.height, fallback);
  switch (element.localName) {
    case "path": {
      const d = get("d")?.trim();
      const cssPath = css.has("d") && d?.match(/^path\((["'])(.*?)\1\)$/);
      const path = d && d !== "none" ? parsePath(cssPath ? cssPath[2] : d) : [];
      return path ? { path } : undefined;
    }
    case "polyline":
    case "polygon": {
      const coords = numbers(get("points") ?? "");
      if (!coords || coords.length % 2) return;
      const points: Point[] = [];
      for (let i = 0; i < coords.length; i += 2) points.push({ x: coords[i], y: coords[i + 1] });
      return { path: points.length ? polygonPath(points, element.localName === "polygon") : [] };
    }
    case "line": {
      const from = { x: x("x1"), y: y("y1") }, to = { x: x("x2"), y: y("y2") };
      if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return;
      return { path: polygonPath([from, to], false), primitive: { kind: "line", from, to } };
    }
    case "rect": {
      const box = { x: x("x"), y: y("y"), width: x("width"), height: y("height") };
      const rxAuto = get("rx") === undefined || get("rx") === "auto";
      const ryAuto = get("ry") === undefined || get("ry") === "auto";
      const rx = rxAuto ? y("ry") : x("rx");
      const ry = ryAuto ? rx : y("ry");
      if (![box.x, box.y, box.width, box.height, rx, ry].every(Number.isFinite)
        || [box.width, box.height, rx, ry].some(n => n < 0)) return;
      if (box.width === 0 || box.height === 0) return { path: [] };
      const rounded = rx > 0 && ry > 0;
      const radii = { rx: rounded ? Math.min(rx, box.width / 2) : 0, ry: rounded ? Math.min(ry, box.height / 2) : 0 };
      return { path: rectPath(box, radii.rx, radii.ry), primitive: { kind: "rect", box, ...radii } };
    }
    case "circle":
    case "ellipse": {
      const cx = x("cx"), cy = y("cy");
      const circle = element.localName === "circle";
      const rxAuto = get("rx") === undefined || get("rx") === "auto";
      const ryAuto = get("ry") === undefined || get("ry") === "auto";
      const rx = circle ? coordinate("r", diagonal(viewport)) : rxAuto ? y("ry") : x("rx");
      const ry = circle || ryAuto ? rx : y("ry");
      if (![cx, cy, rx, ry].every(Number.isFinite) || rx < 0 || ry < 0) return;
      if (rx === 0 || ry === 0) return { path: [] };
      const box = { x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry };
      const path: Path = [["M", cx + rx, cy], ["A", rx, ry, 0, 0, 1, cx - rx, cy],
        ["A", rx, ry, 0, 0, 1, cx + rx, cy], ["Z"]];
      return { path, primitive: { kind: "ellipse", box, rx, ry } };
    }
  }
}

function rectPath({ x, y, width, height }: Bounds, rx: number, ry: number): Path {
  const right = x + width, bottom = y + height;
  if (rx === 0 || ry === 0) return [["M", x, y], ["L", right, y], ["L", right, bottom], ["L", x, bottom], ["Z"]];
  return [["M", x + rx, y], ["L", right - rx, y], ["A", rx, ry, 0, 0, 1, right, y + ry],
    ["L", right, bottom - ry], ["A", rx, ry, 0, 0, 1, right - rx, bottom],
    ["L", x + rx, bottom], ["A", rx, ry, 0, 0, 1, x, bottom - ry],
    ["L", x, y + ry], ["A", rx, ry, 0, 0, 1, x + rx, y], ["Z"]];
}

export function closeSubpaths(path: Path): Path {
  const closed: Path = [];
  let needsClose = false;
  for (const segment of path) {
    if (segment[0] === "M" && needsClose) closed.push(["Z"]);
    closed.push(segment);
    needsClose = segment[0] !== "Z";
  }
  if (needsClose) closed.push(["Z"]);
  return closed;
}

/** Preserves even-odd fill on simple, noncrossing polygon rings by alternating winding.
 * Curved and self-intersecting compound paths require a different fill rule in the renderer. */
export function nonzeroPathForEvenOdd(path: Path): Path | undefined {
  const closed = closeSubpaths(path);
  const rings: Point[][] = [];
  for (const [command, x, y] of closed) {
    if (command === "M") rings.push([{ x, y }]);
    else if (command === "L") rings.at(-1)?.push({ x, y });
    else if (command !== "Z") return;
  }
  if (!rings.length || closed.length > 512 || rings.some(ring => ring.length < 3)) return;
  const polygons = rings.map(ring => new Flatten.Polygon(ring.map(({ x, y }) => [x, y])));
  if (polygons.some(polygon => !polygon.isValid())) return;
  const result: Path = [];
  for (let i = 0; i < rings.length; i++) {
    const polygon = polygons[i];
    const first = new Flatten.Point(rings[i][0].x, rings[i][0].y);
    let depth = 0;
    for (let j = 0; j < rings.length; j++) {
      if (i === j || !polygon.box.intersect(polygons[j].box)) continue;
      if (polygon.intersect(polygons[j]).length) return;
      if (polygons[j].contains(first)) depth++;
    }
    const area = rings[i].reduce((sum, next, index, ring) => {
      const prev = ring[(index + ring.length - 1) % ring.length];
      return sum + prev.x * next.y - prev.y * next.x;
    }, 0);
    if (area === 0) return;
    const ring = (area > 0) === (depth % 2 === 0) ? rings[i] : [...rings[i]].reverse();
    result.push(...polygonPath(ring, true));
  }
  return result;
}

export const isSimpleClosedPath = (path: Path): boolean =>
  path.length >= 4 && path[0][0] === "M" && path.at(-1)?.[0] === "Z"
  && path.slice(1, -1).every(segment => segment[0] !== "M" && segment[0] !== "Z");

export const isLinearPath = (path: Path): boolean =>
  path.every(segment => segment[0] === "M" || segment[0] === "L" || segment[0] === "Z");

/** Rects and ellipses use an editable frame that includes the renderer's stroke inset.
 * A non-uniform transform, reflection, or arbitrary rotation goes through path geometry. */
export function primitiveGeometry(shape: Shape, matrix: Matrix, strokeInset: number, dashed: boolean):
  (Bounds & Pick<GraphicObject, "graphicKind" | "data">) | undefined {
  const primitive = shape.primitive;
  if (!primitive) return;
  if (primitive.kind === "line") {
    const lineStart = point(matrix, primitive.from.x, primitive.from.y);
    const lineEnd = point(matrix, primitive.to.x, primitive.to.y);
    return { ...boxForPoints([lineStart, lineEnd]), graphicKind: "line", data: { lineStart, lineEnd } };
  }
  const factor = similarityScale(matrix);
  const [a, b, c, d] = matrix;
  if (!factor || a <= 0 || d <= 0 || !nearZero(b, factor) || !nearZero(c, factor)
    || (primitive.kind === "rect" && !near(primitive.rx, primitive.ry))) return;
  const { box, rx } = primitive;
  const { x, y } = point(matrix, box.x, box.y);
  const width = box.width * factor, height = box.height * factor;
  // The canvas clamps the outer frame to 1 and the inset rectangle to 0.5.
  const minimum = primitive.kind === "ellipse" ? 1 : Math.max(0.5, 1 - 2 * strokeInset);
  if (Math.min(width, height) < minimum) return;
  // A native SVG ellipse starts at its right edge, as does the fallback path.
  // Rounded native rects share the source's starting corner, except for sub-millipixel rounding.
  if (primitive.kind === "rect" && rx > 0 && dashed) return;
  return { x: x - strokeInset, y: y - strokeInset, width: width + 2 * strokeInset, height: height + 2 * strokeInset,
    graphicKind: primitive.kind, data: primitive.kind === "rect" && rx > 0 ? { cornerRadiusPx: rx * factor } : {} };
}

export function shapeBounds(shape: Shape, matrix: Matrix): Bounds {
  if (shape.primitive?.kind === "ellipse") {
    const { box, rx, ry } = shape.primitive;
    const center = point(matrix, box.x + rx, box.y + ry);
    const dx = Math.hypot(matrix[0] * rx, matrix[2] * ry);
    const dy = Math.hypot(matrix[1] * rx, matrix[3] * ry);
    return { x: center.x - dx, y: center.y - dy, width: 2 * dx, height: 2 * dy };
  }
  return pathBounds(transformPath(shape.path, matrix));
}
