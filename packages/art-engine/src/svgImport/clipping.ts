import type { GraphicObject, Point } from "@chemdraft/chem-core";
import Flatten from "@flatten-js/core";
import { planNativeArtBooleanOperation, svgPathSamplePoints } from "../index";
import { boxForPoints, corners, localPathData, parsePath, pathBounds, polygonPath, transformPath, translate,
  validBounds, type Bounds, type Path } from "./geometry";
import { isLinearPath, isSimpleClosedPath } from "./shapes";

const maxClipSegments = 512;
// Compare painted area in page units squared, using the native boolean tool's
// minimum polygon area as the tolerance for surviving intersections.
const clipAreaTolerance = 0.01;

export interface PreparedClip {
  path: Path;
  bounds: Bounds;
  boundary: Bounds[];
  vertices: Point[];
  sampled?: Path;
}

export function prepareClip(path: Path): PreparedClip | undefined {
  if (!isSimpleClosedPath(path) || path.length > maxClipSegments
    || path.some(segment => segment.slice(1).some(value => !Number.isFinite(value)))) return;
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
  if (!boundary.every(validBounds)) return;
  const bounds = boxForPoints(boundary.flatMap(corners));
  if (validBounds(bounds)) return { path, boundary, vertices, bounds };
}

function overlaps(a: Bounds, b: Bounds, margin: number): boolean {
  return a.x - (b.x + b.width) <= margin && b.x - (a.x + a.width) <= margin
    && a.y - (b.y + b.height) <= margin && b.y - (a.y + a.height) <= margin;
}

export function clipRelation(clip: PreparedClip, bounds: Bounds): "inside" | "outside" | "boundary" {
  if (!validBounds(bounds)) return "boundary";
  // Only rule out intersection when the unrounded bounds are separated by
  // more than a floating-point margin at the scale of the coordinates.
  const margin = 32 * Number.EPSILON * Math.max(1, ...Object.values(bounds).map(Math.abs),
    ...Object.values(clip.bounds).map(Math.abs));
  if (!overlaps(clip.bounds, bounds, margin)) return "outside";
  if (clip.boundary.some(segment => overlaps(segment, bounds, margin))) return "boundary";
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

export function intersectPaths(first: Path, clip: PreparedClip): { path: Path; roundingLoss: boolean } | undefined {
  if (!isSimpleClosedPath(first) || first.length > maxClipSegments) return;
  const second = clip.sampled ??= sampleRing(clip.path);
  const ring = sampleRing(first);
  if (!ring.length || !second.length) return;
  const object = (id: string, path: Path): GraphicObject => {
    const bounds = pathBounds(path);
    return { ...bounds, id, type: "graphic", graphicKind: "path", rotation: 0, style: {},
      data: { pathD: localPathData(path, bounds) } };
  };
  const path: Path = [];
  try {
    const plan = planNativeArtBooleanOperation([object("source", ring), object("clip", second)], "intersect");
    if (plan.skippedInputs.length) return;
    for (const result of plan.resultPaths) {
      const parsed = parsePath(result.pathD);
      if (!parsed) return;
      path.push(...transformPath(parsed, translate(result.bounds.x, result.bounds.y)));
    }
  } catch {
    // An invalid ring or a numerical failure leaves the clip unconverted.
    return;
  }
  // A numerically empty result can mean that a sliver was filtered out.
  return { path, roundingLoss: !path.length || intersectionAreaChanged(ring, second, path) };
}

function intersectionAreaChanged(first: Path, second: Path, output: Path): boolean {
  // Evaluate the sampled input rings before the native tool rounds and
  // simplifies them. Translate all rings together to reduce cancellation.
  const [, x, y] = first[0];
  const ring = (path: Path) => path.map(([, px, py]) => new Flatten.Point(Number(px) - Number(x), Number(py) - Number(y)));
  const polygon = (path: Path) => new Flatten.Polygon(ring(path.slice(0, -1)));
  try {
    const subject = polygon(first), boundary = polygon(second);
    if (!subject.isValid() || !boundary.isValid()) return true;
    const reference = Flatten.BooleanOperations.intersect(subject, boundary);
    const actual = new Flatten.Polygon();
    let start = 0;
    for (let index = 0; index < output.length; index++) {
      if (output[index][0] !== "Z") continue;
      actual.addFace(ring(output.slice(start, index)));
      start = index + 1;
    }
    if (start !== output.length || reference.faces.size !== actual.faces.size) return true;
    // Compare ink coverage so an equal-area shift cannot hide a lost strip.
    const sharedArea = Flatten.BooleanOperations.intersect(reference, actual).area();
    const changedArea = Math.max(reference.area(), actual.area()) - sharedArea;
    return !Number.isFinite(changedArea) || Math.abs(changedArea) > clipAreaTolerance;
  } catch {
    // Keep the computed result and report that its coverage could not be verified.
    return true;
  }
}
