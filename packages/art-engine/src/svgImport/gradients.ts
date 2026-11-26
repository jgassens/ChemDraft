import type { GraphicGradientStop, GraphicPaint, Point } from "@chemdraft/chem-core";
import {
  compose, determinant, diagonal, length, parseTransform, point, scale, similarityScale, translate,
  type Bounds, type Matrix, type Size
} from "./geometry";
import { clampUnit, elementChildren, href, inheritedProperty, inlineStyle, opacity, property, reference, solidColor, type CanonicalColor } from "./presentation";
import { SVG_IMPORT_MAX_REFERENCE_DEPTH, type ReportLoss } from "./types";

const gradientTags = new Set(["linearGradient", "radialGradient"]);
const coordinateKeys = new Set(["x1", "y1", "x2", "y2", "cx", "cy", "r", "fx", "fy", "fr"]);
type PaintContext = {
  sourceBox: Bounds;
  targetBox: Bounds;
  matrix: Matrix;
  viewport: Size;
  byId: ReadonlyMap<string, Element>;
  canonicalColor: CanonicalColor;
  countExpanded: (count: number) => void;
  report: ReportLoss;
};

export function readPaint(value: string, currentColor: string, context: PaintContext): GraphicPaint | undefined {
  if (value.toLowerCase() === "none") return;
  const color = solidColor(value, currentColor, context.canonicalColor);
  if (color) return { kind: "solid", color: color.color, opacity: color.alpha };
  const link = reference(value);
  const target = link && context.byId.get(link.id);
  if (target && gradientTags.has(target.localName)) {
    const gradient = readGradient(target, context);
    if (gradient) return gradient;
  } else if (target?.localName === "pattern") {
    context.report("svgImport.pattern_fill_not_kept", "SVG pattern paint");
  } else context.report("svgImport.paint_not_kept", "Unresolved or unsupported paint");
  const fallback = link && solidColor(link.fallback, currentColor, context.canonicalColor);
  return fallback ? { kind: "solid", color: fallback.color, opacity: fallback.alpha } : undefined;
}

function gradientChain(first: Element, { byId, report }: PaintContext): Element[] | undefined {
  const chain: Element[] = [];
  let current = first;
  while (true) {
    if (chain.includes(current)) {
      report("svgImport.reference_cycle", "Cyclic gradient reference");
      return;
    }
    if (chain.length >= SVG_IMPORT_MAX_REFERENCE_DEPTH) {
      report("svgImport.reference_depth", "Gradient reference depth exceeded");
      return;
    }
    chain.push(current);
    const link = href(current);
    if (link === undefined) return chain;
    const target = link.startsWith("#") && byId.get(link.slice(1));
    if (!target || !gradientTags.has(target.localName)) {
      report("svgImport.reference_not_kept", "Unresolved gradient reference");
      return chain;
    }
    current = target;
  }
}

function stopColorContext(stop: Element, report: ReportLoss): string {
  for (let element: Element | null = stop; element; element = element.parentElement) {
    const color = property(element, inlineStyle(element, report), "color");
    if (color === "initial") break;
    if (color && !["inherit", "unset", "currentcolor"].includes(color.toLowerCase())) return color;
  }
  return "#000000";
}

function gradientStops(chain: Element[], { canonicalColor, countExpanded, report }: PaintContext): GraphicGradientStop[] {
  let previous = 0;
  let stops: Element[] = [];
  for (const gradient of chain) {
    stops = [...elementChildren(gradient)].filter(child => child.localName === "stop");
    if (stops.length) break;
  }
  countExpanded(stops.length);
  return stops.map(element => {
    const css = inlineStyle(element, report);
    for (const name of new Set([...css.keys(), ...element.getAttributeNames()])) {
      if (!["id", "class", "style", "offset", "color", "stop-color", "stop-opacity"].includes(name)) {
        report("svgImport.gradient_not_kept", `Unsupported gradient stop property ${name}`);
      }
    }
    if (element.children.length) report("svgImport.gradient_not_kept", "Unsupported gradient stop children");
    const offset = Math.max(previous, opacity(property(element, css, "offset") ?? "0", "stop offset", report));
    previous = offset;
    const rawColor = property(element, css, "stop-color") ?? "#000000";
    const color = solidColor(rawColor, stopColorContext(element, report), canonicalColor);
    if (!color) report("svgImport.gradient_not_kept", "Unsupported stop color");
    return {
      offset, color: color?.color ?? "#000000",
      opacity: opacity(property(element, css, "stop-opacity"), "stop-opacity", report) * (color?.alpha ?? 1)
    };
  });
}

function lastStop(stops: GraphicGradientStop[]): GraphicPaint {
  const last = stops[stops.length - 1];
  return last ? { kind: "solid", color: last.color, opacity: last.opacity } : { kind: "none" };
}

function readGradient(element: Element, context: PaintContext): GraphicPaint | undefined {
  const { report, sourceBox, targetBox, viewport } = context;
  const chain = gradientChain(element, context);
  if (!chain) return;
  const styles = chain.map(gradient => inlineStyle(gradient, report));
  const field = (key: string): string | undefined => {
    for (let i = 0; i < chain.length; i++) {
      if (!coordinateKeys.has(key) || chain[i].localName === element.localName) {
        const value = property(chain[i], styles[i], key);
        if (value !== undefined) return value;
      }
    }
  };
  const stops = gradientStops(chain, context);
  if (stops.length < 2) return lastStop(stops);
  const unsupported = (detail: string): undefined => { report("svgImport.gradient_not_kept", detail); };
  if (chain.some(gradient => [...elementChildren(gradient)]
    .some(child => !["stop", "title", "desc", "metadata"].includes(child.localName)))) {
    report("svgImport.gradient_not_kept", "Unsupported gradient children");
  }
  if ((field("spreadMethod") ?? "pad") !== "pad") return unsupported("Gradient spread method");
  // Interpolation belongs to the directly referenced gradient. The href chain
  // supplies gradient attributes and stops, while CSS inherits through the DOM.
  const interpolation = inheritedProperty(element, "color-interpolation", "srgb", report);
  if (interpolation === "linearrgb") report("svgImport.gradient_not_kept", "Linear RGB gradient interpolation rendered as sRGB");
  else if (interpolation !== "srgb") {
    report("svgImport.gradient_not_kept", "Unsupported gradient color-interpolation");
  }
  const units = field("gradientUnits") ?? "objectBoundingBox";
  if (units !== "objectBoundingBox" && units !== "userSpaceOnUse") return unsupported("Unsupported gradientUnits");
  const objectUnits = units === "objectBoundingBox";
  if (objectUnits && (sourceBox.width === 0 || sourceBox.height === 0)) return { kind: "none" };
  const transform = parseTransform(field("gradientTransform"));
  if (!transform) return unsupported("Unsupported gradientTransform");
  const boxMatrix = objectUnits ? compose(translate(sourceBox.x, sourceBox.y), scale(sourceBox.width, sourceBox.height)) : undefined;
  const matrix = compose(context.matrix, boxMatrix ? compose(boxMatrix, transform) : transform);
  if (!matrix.every(Number.isFinite) || determinant(matrix) === 0) return unsupported("Singular gradient transform");
  const basis = objectUnits ? { width: 1, height: 1 } : viewport;
  const coordinate = (key: string, fallback: string, basis: number): number => {
    const value = field(key) ?? fallback;
    if (objectUnits && !/^[+\-.e\d]+%?$/i.test(value)) return NaN;
    return length(value, basis) ?? NaN;
  };
  const x = (key: string, fallback: string) => coordinate(key, fallback, basis.width);
  const y = (key: string, fallback: string) => coordinate(key, fallback, basis.height);
  const radiusBasis = objectUnits ? 1 : diagonal(basis);
  if (element.localName === "linearGradient") {
    const first = { x: x("x1", "0%"), y: y("y1", "0%") };
    const second = { x: x("x2", "100%"), y: y("y2", "0%") };
    if (![first.x, first.y, second.x, second.y].every(Number.isFinite)) return unsupported("Unsupported linear gradient coordinates");
    if (first.x === second.x && first.y === second.y) return lastStop(stops);
    const line = linearGradientLine(matrix, first, second, targetBox);
    return line ? { kind: "linear-gradient", units: "object", stops, ...line }
      : unsupported("Linear gradient endpoints lie outside the native shape frame");
  }
  const cx = x("cx", "50%"), cy = y("cy", "50%");
  const fx = x("fx", field("cx") ?? "50%"), fy = y("fy", field("cy") ?? "50%");
  const r = coordinate("r", "50%", radiusBasis), fr = coordinate("fr", "0", radiusBasis);
  if (![cx, cy, fx, fy, r, fr].every(Number.isFinite) || r < 0) return unsupported("Unsupported radial gradient coordinates");
  if (r === 0) return lastStop(stops);
  if (fr !== 0) return unsupported("Radial gradient start radius");
  const factor = similarityScale(matrix);
  if (factor === undefined) return unsupported("Elliptical or skewed radial gradient");
  const center = normalizedPoint(point(matrix, cx, cy), targetBox);
  const focus = normalizedPoint(point(matrix, fx, fy), targetBox);
  if (!center || !focus) return unsupported("Radial gradient center or focus lies outside the native shape frame");
  const radius = r * factor / Math.max(targetBox.width, targetBox.height, 1);
  if (!Number.isFinite(radius)) return unsupported("Non-finite transformed radial gradient radius");
  return {
    kind: "radial-gradient", units: "object", stops,
    cx: center.x, cy: center.y, fx: focus.x, fy: focus.y,
    r: radius
  };
}

function normalizedPoint(p: Point, box: Bounds): Point | undefined {
  const unit = (value: number, origin: number, span: number) => span === 0
    ? Math.abs(value - origin) < 1e-8 ? 0 : NaN
    : (value - origin) / span;
  const x = unit(p.x, box.x, box.width), y = unit(p.y, box.y, box.height);
  if ([x, y].every(value => value >= -1e-8 && value <= 1 + 1e-8)) return { x: clampUnit(x), y: clampUnit(y) };
}

/** The gradient value is a linear scalar field. Its normal transforms by the
 * inverse transpose, so transforming the two endpoints as points is insufficient. */
function linearGradientLine(matrix: Matrix, first: Point, second: Point, box: Bounds) {
  const [a, b, c, d] = matrix;
  const dx = second.x - first.x, dy = second.y - first.y, det = determinant(matrix);
  const nx = (d * dx - b * dy) / det, ny = (-c * dx + a * dy) / det;
  const magnitude = Math.hypot(nx, ny);
  const distance = (dx * dx + dy * dy) / magnitude;
  const ux = nx / magnitude, uy = ny / magnitude;
  const start = point(matrix, first.x, first.y);
  const end = { x: start.x + ux * distance, y: start.y + uy * distance };
  // Sliding both endpoints along an isocolor line leaves the scalar field unchanged.
  let lower = -Infinity, upper = Infinity;
  for (const p of [start, end]) {
    for (const [axis, shift, min, max] of [[p.x, -uy, box.x, box.x + box.width],
      [p.y, ux, box.y, box.y + box.height]]) {
      if (Math.abs(shift) < 1e-12) {
        if (axis < min - 1e-8 || axis > max + 1e-8) return;
      } else {
        const first = (min - axis) / shift, last = (max - axis) / shift;
        lower = Math.max(lower, Math.min(first, last));
        upper = Math.min(upper, Math.max(first, last));
      }
    }
  }
  if (lower > upper + 1e-8) return;
  const shift = Math.max(lower, Math.min(0, upper));
  const shifted = (p: Point) => normalizedPoint({ x: p.x - uy * shift, y: p.y + ux * shift }, box);
  const from = shifted(start), to = shifted(end);
  if (from && to) return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
}
