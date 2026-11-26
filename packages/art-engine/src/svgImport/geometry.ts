import type { GraphicObject, Point } from "@chemdraft/chem-core";
import { getPathBBox, isValidPath, normalizePath } from "svg-path-commander/util";

export type Matrix = readonly [number, number, number, number, number, number];
export type Bounds = Pick<GraphicObject, "x" | "y" | "width" | "height">;
export type Path = ReturnType<typeof normalizePath>[number][];
export type Size = Pick<Bounds, "width" | "height">;

export const identity: Matrix = [1, 0, 0, 1, 0, 0];
export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export const scale = (x: number, y: number): Matrix => [x, 0, 0, y, 0, 0];
export const rotate = (degrees: number): Matrix => {
  const radians = (degrees % 360) * Math.PI / 180;
  const sin = Math.sin(radians), cos = Math.cos(radians);
  return [cos, sin, -sin, cos, 0, 0];
};
export const determinant = ([a, b, c, d]: Matrix): number => a * d - b * c;
export function inverse([a, b, c, d, e, f]: Matrix): Matrix {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
export const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1e-12, Math.abs(a), Math.abs(b));
export const nearZero = (value: number, reference: number): boolean => Math.abs(value) <= 1e-9 * reference;

export function compose([a, b, c, d, e, f]: Matrix, [g, h, i, j, k, l]: Matrix): Matrix {
  return [
    a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j,
    a * k + c * l + e, b * k + d * l + f
  ];
}

export function point([a, b, c, d, e, f]: Matrix, x: number, y: number): Point {
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

export function about(matrix: Matrix, x: number, y: number): Matrix {
  return compose(translate(x, y), compose(matrix, translate(-x, -y)));
}

export function similarityScale([a, b, c, d]: Matrix): number | undefined {
  const first = Math.hypot(a, b), second = Math.hypot(c, d);
  return first > 0 && near(first, second) && nearZero(a * c + b * d, first * second) ? first : undefined;
}

export function maxScale([a, b, c, d]: Matrix): number {
  const xx = a * a + c * c, yy = b * b + d * d, xy = a * b + c * d;
  return Math.sqrt((xx + yy + Math.hypot(xx - yy, 2 * xy)) / 2);
}

const numberPattern = "[+-]?(?:[0-9]+\\.?[0-9]*|\\.[0-9]+)(?:e[+-]?[0-9]+)?";
const listToken = new RegExp(`\\s*,?\\s*(${numberPattern})`, "iy");

export function numbers(value: string): number[] | undefined {
  const input = value.trim();
  if (!input) return [];
  if (input.startsWith(",")) return;
  const result = [];
  let position = 0;
  while (position < input.length) {
    listToken.lastIndex = position;
    const match = listToken.exec(input);
    if (!match) return;
    const number = Number(match[1]);
    if (!Number.isFinite(number)) return;
    result.push(number);
    position = listToken.lastIndex;
  }
  return result;
}

const lengthPattern = new RegExp(`^(${numberPattern})(%|px|in|cm|mm|q|pt|pc|em)?$`, "i");
const absoluteUnits: Record<string, number> = { "": 1, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4,
  q: 96 / 101.6, pt: 96 / 72, pc: 16 };

export function length(value: string, percentageBasis: number, em?: number): number | undefined {
  const match = lengthPattern.exec(value.trim());
  if (!match) return;
  const unit = (match[2] ?? "").toLowerCase();
  const factor = unit === "%" ? percentageBasis / 100 : unit === "em" ? em : absoluteUnits[unit];
  const resolved = Number(match[1]) * (factor ?? NaN);
  return Number.isFinite(resolved) ? resolved : undefined;
}

export const diagonal = (viewport: Size): number => Math.hypot(viewport.width, viewport.height) / Math.SQRT2;

export function parseTransform(input: string | undefined): Matrix | undefined {
  let result = identity;
  let rest = input?.trim() ?? "";
  if (rest === "none") return result;
  while (rest) {
    const match = /^([a-zA-Z]+)\s*\(([^()]*)\)/.exec(rest);
    if (!match) return;
    const args = numbers(match[2]);
    if (!args) return;
    const matrix = transformFunction(match[1], args);
    if (!matrix) return;
    result = compose(result, matrix);
    rest = rest.slice(match[0].length).replace(/^\s*,?\s*/, "");
  }
  return result.every(Number.isFinite) ? result : undefined;
}

function transformFunction(name: string, args: number[]): Matrix | undefined {
  const [first, second, third] = args;
  switch (name) {
    case "matrix": return args.length === 6 ? args as unknown as Matrix : undefined;
    case "translate": return args.length === 1 || args.length === 2 ? translate(first, second ?? 0) : undefined;
    case "scale": return args.length === 1 || args.length === 2 ? scale(first, second ?? first) : undefined;
    case "rotate": return args.length === 1 ? rotate(first)
      : args.length === 3 ? about(rotate(first), second, third) : undefined;
    case "skewX": return args.length === 1 ? [1, 0, Math.tan(first * Math.PI / 180), 1, 0, 0] : undefined;
    case "skewY": return args.length === 1 ? [1, Math.tan(first * Math.PI / 180), 0, 1, 0, 0] : undefined;
  }
}

export function readViewBox(value: string): Bounds | undefined {
  const box = numbers(value);
  if (box?.length === 4 && box[2] > 0 && box[3] > 0) return { x: box[0], y: box[1], width: box[2], height: box[3] };
}

export function viewportMatrix(box: Bounds, viewport: Size, value: string): Matrix | undefined {
  const align = /^\s*(?:defer\s+)?(none|x(Min|Mid|Max)Y(Min|Mid|Max))(?:\s+(meet|slice))?\s*$/.exec(value);
  if (!align) return;
  const sx = viewport.width / box.width, sy = viewport.height / box.height;
  if (align[1] === "none") return [sx, 0, 0, sy, -box.x * sx, -box.y * sy];
  const factor = align[4] === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
  const offset: Record<string, number> = { Min: 0, Mid: 0.5, Max: 1 };
  return [factor, 0, 0, factor,
    offset[align[2]] * (viewport.width - box.width * factor) - box.x * factor,
    offset[align[3]] * (viewport.height - box.height * factor) - box.y * factor];
}

export function boxForPoints(points: readonly Point[]): Bounds {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) {
    x = Math.min(x, p.x);
    y = Math.min(y, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { x, y, width: right - x, height: bottom - y };
}

export function corners(box: Bounds): Point[] {
  const { x, y, width, height } = box;
  return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
}

export function validBounds({ x, y, width, height }: Bounds): boolean {
  return width >= 0 && height >= 0 && [x, y, x + width, y + height].every(Number.isFinite);
}

export function polygonPath(points: readonly Point[], close: boolean): Path {
  const path: Path = points.map(({ x, y }, index) => [index ? "L" : "M", x, y]);
  if (close) path.push(["Z"]);
  return path;
}

export function parsePath(data: string): Path | undefined {
  try {
    if (isValidPath(data)) return normalizePath(data);
  } catch {
    // The path library rejects malformed data by throwing.
  }
}

export function pathBounds(path: Path): Bounds {
  if (!path.length) return { x: 0, y: 0, width: 0, height: 0 };
  const { x, y, width, height } = getPathBBox(path as ReturnType<typeof normalizePath>);
  return { x, y, width, height };
}

/** The transformed ellipse is B times the unit circle. The principal axes of B Bᵀ
 * give its radii and axis angle. A reflection reverses the arc's sweep. */
function transformArc(segment: Extract<Path[number], ["A", ...number[]]>, matrix: Matrix): Path[number] {
  const [, rx, ry, angle, largeArc, sweep, x, y] = segment;
  const end = point(matrix, x, y);
  if (rx === 0 || ry === 0) return ["L", end.x, end.y];
  const [a, b, c, d] = compose(matrix, compose(rotate(angle), scale(rx, ry)));
  const xx = a * a + c * c, yy = b * b + d * d, xy = a * b + c * d;
  const major = Math.sqrt((xx + yy + Math.hypot(xx - yy, 2 * xy)) / 2);
  const minor = Math.abs(a * d - b * c) / major;
  const tilt = Math.atan2(2 * xy, xx - yy) * 90 / Math.PI;
  return ["A", major, minor, tilt, largeArc, determinant(matrix) < 0 ? (sweep === 0 ? 1 : 0) : sweep, end.x, end.y];
}

export function transformPath(path: Path, matrix: Matrix): Path {
  return path.map(segment => {
    const [command, ...coordinates] = segment;
    if (command === "Z") return segment;
    if (command === "A") return transformArc(segment, matrix);
    const mapped: number[] = [];
    for (let i = 0; i < coordinates.length; i += 2) {
      const p = point(matrix, coordinates[i], coordinates[i + 1]);
      mapped.push(p.x, p.y);
    }
    return [command, ...mapped] as Path[number];
  });
}

export function localPathData(path: Path, bounds: Bounds): string {
  return path.map(segment => {
    if (segment[0] === "Z") return "Z";
    const [command, ...values] = segment;
    for (let i = command === "A" ? 5 : 0; i < values.length; i += 2) {
      values[i] -= bounds.x;
      values[i + 1] -= bounds.y;
    }
    return command + values.join(" ");
  }).join(" ");
}
