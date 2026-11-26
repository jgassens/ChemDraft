import type { GraphicObject, GraphicPaint } from "@chemdraft/chem-core";
import { determinant, diagonal, length, numbers, similarityScale, type Matrix, type Size } from "./geometry";
import type { ReportLoss } from "./types";

const defaults = {
  fill: "#000000", stroke: "none", color: "#000000", "fill-opacity": "1", "stroke-opacity": "1",
  "fill-rule": "nonzero", "stroke-width": "1", "stroke-linecap": "butt", "stroke-linejoin": "miter",
  "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-dashoffset": "0", visibility: "visible",
  "font-family": "serif", "font-size": "16", "font-weight": "400", "font-style": "normal",
  "text-anchor": "start", "text-decoration": "none", "letter-spacing": "normal",
  "clip-rule": "nonzero", "color-interpolation": "sRGB", "paint-order": "normal",
  "marker-start": "none", "marker-mid": "none", "marker-end": "none"
};
export type Presentation = typeof defaults;
export const defaultPresentation: Presentation = defaults;

const individual = new Set([
  "opacity", "display", "clip-path", "mask", "filter", "transform", "vector-effect", "overflow",
  "stop-color", "stop-opacity"
]);

export const isPresentation = (name: string): boolean => Object.hasOwn(defaults, name) || individual.has(name);
export type Declarations = ReadonlyMap<string, string>;
export const property = (element: Element, css: Declarations, name: string): string | undefined =>
  css.get(name) ?? element.getAttribute(name)?.trim();

export function inheritedProperty(element: Element, name: string, initial: string, report: ReportLoss): string {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const value = property(current, inlineStyle(current, report), name)?.toLowerCase();
    if (value === "initial") return initial;
    if (value !== undefined && value !== "inherit" && value !== "unset") return value;
  }
  return initial;
}

export function* elementChildren(element: Element): IterableIterator<Element> {
  // Indexed access to live HTMLCollections can rescan siblings in XML DOMs.
  for (let child = element.firstElementChild; child; child = child.nextElementSibling) yield child;
}

/** Reads declaration lists while keeping separators inside quoted values and functions. */
export function inlineStyle(element: Element, report: ReportLoss): Declarations {
  const source = element.getAttribute("style")?.replace(/\/\*[\s\S]*?\*\//g, "") ?? "";
  const css = new Map<string, string>();
  const important = new Set<string>();
  let start = 0, depth = 0, quote = "";
  for (let i = 0; i <= source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (i === source.length || (char === ";" && depth === 0)) {
      const declaration = source.slice(start, i).trim();
      start = i + 1;
      if (!declaration) continue;
      const colon = declaration.indexOf(":");
      if (colon < 1 || depth !== 0) {
        report("svgImport.unsupported_attribute", "Malformed inline style declaration");
        continue;
      }
      const name = declaration.slice(0, colon).trim().toLowerCase();
      const raw = declaration.slice(colon + 1).trim();
      const priority = /!\s*important$/i.test(raw);
      if (priority || !important.has(name)) css.set(name, raw.replace(/\s*!\s*important$/i, ""));
      if (priority) important.add(name);
    }
  }
  if (quote || depth !== 0) report("svgImport.unsupported_attribute", "Malformed inline style declaration");
  return css;
}

export function inheritPresentation(element: Element, css: Declarations, parent: Presentation, report: ReportLoss): Presentation {
  const computed = { ...parent };
  for (const name of Object.keys(defaults) as (keyof Presentation)[]) {
    const value = property(element, css, name);
    if (value === undefined || value === "inherit" || value === "unset") continue;
    if (value === "initial") computed[name] = defaults[name];
    else if (name === "font-size") {
      const size = length(value, Number(parent[name]), Number(parent[name]));
      if (size !== undefined && size >= 0) computed[name] = String(size);
      else report("svgImport.text_style_not_kept", "Unsupported font-size");
    } else computed[name] = value;
  }
  if (computed.color.toLowerCase() === "currentcolor") computed.color = parent.color;
  return computed;
}

export function opacity(value: string | undefined, propertyName: string, report: ReportLoss): number {
  if (value === undefined || value === "initial" || value === "unset") return 1;
  const values = numbers(value.endsWith("%") ? value.slice(0, -1) : value);
  if (values?.length !== 1) {
    report("svgImport.unsupported_attribute", `Unsupported ${propertyName}`);
    return 1;
  }
  return clampUnit(values[0] / (value.endsWith("%") ? 100 : 1));
}

export const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

export function reference(value: string): { id: string; fallback: string } | undefined {
  const match = /^url\(\s*(["']?)#([^"'()\s]+)\1\s*\)\s*(.*)$/i.exec(value);
  if (match) return { id: match[2], fallback: match[3] };
}

export function href(element: Element): string | undefined {
  return element.getAttribute("href") ?? element.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? undefined;
}

export type CanonicalColor = (color: string) => string | undefined;

/** Normalize CSS paint through a detached declaration owned by the injected XML DOM. */
export function colorParser(document: Document): CanonicalColor {
  const style = document.createElementNS("http://www.w3.org/1999/xhtml", "span") as HTMLElement;
  const cache = new Map<string, string | undefined>();
  return color => {
    if (cache.has(color)) return cache.get(color);
    style.style.color = "";
    style.style.color = color;
    const resolved = style.style.color || undefined;
    cache.set(color, resolved);
    return resolved;
  };
}

export function solidColor(value: string, currentColor: string, canonicalColor: CanonicalColor):
  { color: string; alpha: number } | undefined {
  const color = (value.toLowerCase() === "currentcolor" ? currentColor : value).trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color)?.[1];
  if (hex) {
    const full = hex.length < 5 ? Array.from(hex, digit => digit + digit).join("") : hex;
    return { color: "#" + full.slice(0, 6).toLowerCase(), alpha: full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1 };
  }
  if (color.toLowerCase() === "transparent") return { color: "#000000", alpha: 0 };
  if (color.toLowerCase() !== "none" && !/^(?:initial|inherit|unset|revert|revert-layer|currentcolor|context-fill|context-stroke)$/i.test(color)
    && (/^[a-z]+$/i.test(color) || /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([%./,+a-z0-9\s-]+\)$/i.test(color))) {
    const resolved = canonicalColor(color);
    if (!resolved) return;
    const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(resolved);
    if (rgb && rgb.slice(1, 4).every(channel => Number(channel) <= 255)) {
      return { color: "#" + rgb.slice(1, 4).map(channel => Number(channel).toString(16).padStart(2, "0")).join(""),
        alpha: rgb[4] === undefined ? 1 : Number(rgb[4]) };
    }
    return { color: resolved, alpha: 1 };
  }
}

export function strokeWidth(style: Presentation, viewport: Size, report: ReportLoss): number {
  const width = length(style["stroke-width"], diagonal(viewport), Number(style["font-size"]));
  if (width === undefined || width < 0) {
    report("svgImport.unsupported_attribute", "Unsupported stroke-width");
    return 1;
  }
  return width;
}

function dashArray(value: string, viewport: Size, em: number): number[] | undefined {
  if (value === "none") return [];
  const parts = value.trim().split(/\s*,\s*|\s+/);
  const lengths = parts.map(part => length(part, diagonal(viewport), em));
  if (lengths.some(item => item === undefined || item < 0)) return;
  const resolved = lengths as number[];
  return resolved.some(item => item > 0) ? resolved : [];
}

/** The scalar pen is exact under a similarity. For a simple undashed butt line
 * the transformed perpendicular width is exact if its cap remains perpendicular. */
export function transformedStrokeScale(matrix: Matrix, lineDirection: { x: number; y: number } | undefined,
  style: Presentation, report: ReportLoss): { width: number; dash: number } {
  const uniform = similarityScale(matrix);
  if (uniform !== undefined) return { width: uniform, dash: uniform };
  if (lineDirection) {
    const { x, y } = lineDirection;
    const [a, b, c, d] = matrix;
    const tx = a * x + c * y, ty = b * x + d * y;
    const nx = -a * y + c * x, ny = -b * y + d * x;
    const tangent = Math.hypot(tx, ty);
    if (tangent > 0) {
      if (style["stroke-linecap"] !== "butt" || Math.abs(tx * nx + ty * ny) > 1e-9 * tangent * Math.hypot(nx, ny)) {
        report("svgImport.stroke_transform_approximated", "Non-uniform transform on stroke caps");
      }
      const dash = tangent / Math.hypot(x, y);
      return { width: Math.abs(determinant(matrix)) / dash, dash };
    }
  }
  report("svgImport.stroke_transform_approximated", "Non-uniform transform on a scalar stroke");
  const scale = Math.sqrt(Math.abs(determinant(matrix)));
  return { width: scale, dash: scale };
}

export function strokeStyle(style: Presentation, viewport: Size, width: number, scale: { width: number; dash: number },
  report: ReportLoss): GraphicObject["style"] {
  const cap = style["stroke-linecap"], join = style["stroke-linejoin"];
  const miter = numbers(style["stroke-miterlimit"]);
  const dash = dashArray(style["stroke-dasharray"], viewport, Number(style["font-size"]))?.map(item => item * scale.dash);
  if (cap !== "butt" && cap !== "round" && cap !== "square") report("svgImport.unsupported_attribute", "Unsupported stroke-linecap");
  if (join !== "miter" && join !== "round" && join !== "bevel") report("svgImport.unsupported_attribute", "Unsupported stroke-linejoin");
  if (miter?.length !== 1 || miter[0] < 1) report("svgImport.unsupported_attribute", "Unsupported stroke-miterlimit");
  if (!dash || !dash.every(Number.isFinite)) report("svgImport.unsupported_attribute", "Unsupported stroke-dasharray");
  const dashOffset = length(style["stroke-dashoffset"], diagonal(viewport), Number(style["font-size"]));
  if (dash?.length && dashOffset !== 0) report("svgImport.unsupported_attribute", "Stroke dash offset");
  return {
    strokeWidth: width * scale.width,
    strokeLineCap: cap === "round" || cap === "square" ? cap : "butt",
    strokeLineJoin: join === "round" || join === "bevel" ? join : "miter",
    strokeMiterLimit: miter?.length === 1 && miter[0] >= 1 ? miter[0] : 4,
    ...(dash?.length && dash.every(Number.isFinite) ? { strokeDasharray: dash.join(" ") } : {})
  };
}

export function graphicPaintStyle(target: "fill" | "stroke", paint: GraphicPaint | undefined, alpha: number): GraphicObject["style"] {
  if (!paint || paint.kind === "none") {
    return target === "fill" ? { fillPaint: { kind: "none" } } : { strokePaint: { kind: "none" }, strokeOpacity: 0 };
  }
  if (paint.kind === "solid") {
    const opacity = alpha * (paint.opacity ?? 1);
    return target === "fill" ? { fillColor: paint.color, fillOpacity: opacity } : { strokeColor: paint.color, strokeOpacity: opacity };
  }
  return target === "fill" ? { fillPaint: paint, fillOpacity: alpha } : { strokePaint: paint, strokeOpacity: alpha };
}
