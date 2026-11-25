import type { GraphicObject, Point } from "@chemdraft/chem-core";
import { planNativeArtBooleanOperation, svgPathSamplePoints } from "../index";
import { boxForPoints, corners, localPathData, parsePath, pathBounds, polygonPath, transformPath, translate, type Bounds, type Path } from "./geometry";
import { isLinearPath, isSimpleClosedPath } from "./shapes";

const maxClipSegments = 512;

export interface PreparedClip {
  path: Path;
  bounds: Bounds;
  boundary: Bounds[];
  vertices: Point[];
  sampled?: Path;
}

export function prepareClip(path: Path): PreparedClip | undefined {
  if (!isSimpleClosedPath(path) || path.length > maxClipSegments) return;
  const boundary: Bounds[] = [];
  const vertices: Point[] = [];
  const start = { x: Number(path[0][1]), y: Number(path[0][2]) };
  let last = start;
  for (const segment of path) {
    const [command, ...args] = segment;
    if (command === "M") continue;
    const end = command === "Z" ? start : { x: args.at(-2)!, y: args.at(-1)! };
    vertices.push(end);
    if (segment[0] === "A") {
      boundary.push(pathBounds([["M", last.x, last.y], segment]));
    } else {
      const points = [last, end];
      for (let i = 0; i < args.length - 2; i += 2) points.push({ x: args[i], y: args[i + 1] });
      // Bézier curves and their chords both lie in their control point hull.
      boundary.push(boxForPoints(points));
    }
    last = end;
  }
  return { path, boundary, vertices, bounds: boxForPoints(boundary.flatMap(corners)) };
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width
    && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

export function clipRelation(clip: PreparedClip, bounds: Bounds): "inside" | "outside" | "boundary" {
  if (!overlaps(clip.bounds, bounds)) return "outside";
  if (clip.boundary.some(segment => overlaps(segment, bounds))) return "boundary";
  // A box disjoint from the boundary also misses the regions between each
  // curve and its chord. Winding against the chords is therefore sufficient.
  let winding = 0;
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  for (let i = 0; i < clip.vertices.length; i++) {
    const a = clip.vertices[i], b = clip.vertices[(i + 1) % clip.vertices.length];
    if ((a.y > y) === (b.y > y)) continue;
    const crossing = a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y);
    if (crossing > x) winding += b.y > a.y ? 1 : -1;
  }
  return winding === 0 ? "outside" : "inside";
}

function sampleRing(path: Path): Path {
  if (isLinearPath(path)) return path;
  let previous = { x: Number(path[0][1]), y: Number(path[0][2]) };
  const points = [previous];
  for (const segment of path.slice(1, -1)) {
    const end = { x: Number(segment.at(-2)), y: Number(segment.at(-1)) };
    if (segment[0] !== "L" && segment[0] !== "Z") {
      const part: Path = [["M", previous.x, previous.y], segment];
      const sampled = svgPathSamplePoints(localPathData(part, { x: 0, y: 0, width: 0, height: 0 }));
      points.push(...sampled.slice(1, -1));
    }
    points.push(end);
    previous = end;
    if (points.length >= maxClipSegments) return [];
  }
  return polygonPath(points, true);
}

export function intersectPaths(first: Path, clip: PreparedClip): Path | undefined {
  if (!isSimpleClosedPath(first) || first.length > maxClipSegments) return;
  const second = clip.sampled ??= sampleRing(clip.path);
  const ring = sampleRing(first);
  if (!ring.length || !second.length) return;
  const object = (id: string, path: Path): GraphicObject => {
    const bounds = pathBounds(path);
    return { ...bounds, id, type: "graphic", graphicKind: "path", rotation: 0, style: {},
      data: { pathD: localPathData(path, bounds) } };
  };
  try {
    const plan = planNativeArtBooleanOperation([object("source", ring), object("clip", second)], "intersect");
    if (plan.skippedInputs.length) return;
    const path: Path = [];
    for (const result of plan.resultPaths) {
      const parsed = parsePath(result.pathD);
      if (!parsed) return;
      path.push(...transformPath(parsed, translate(result.bounds.x, result.bounds.y)));
    }
    return path;
  } catch {
    // An invalid ring or a numerical failure leaves the clip unconverted.
    return;
  }
}
