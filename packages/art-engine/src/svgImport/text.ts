import type { TextObject } from "@chemdraft/chem-core";
import { determinant, length, point, rotate, similarityScale, validBounds, type Matrix, type Size } from "./geometry";
import { elementChildren, opacity, property, solidColor, type CanonicalColor, type Declarations, type Presentation } from "./presentation";
import type { ReportLoss } from "./types";

export const textAttributes = ["x", "y", "dx", "dy", "rotate", "textLength", "lengthAdjust", "xml:space"];
const textMetadata = new Set(["title", "desc", "metadata"]);
export const hasTextChildren = (element: Element): boolean =>
  [...elementChildren(element)].some(child => !textMetadata.has(child.localName));

export function readText(
  element: Element, css: Declarations, style: Presentation, matrix: Matrix, viewport: Size, objectOpacity: number,
  canonicalColor: CanonicalColor, countText: (count: number) => void, report: ReportLoss
): Omit<TextObject, "id"> | undefined {
  const baseSize = Number(style["font-size"]);
  if (baseSize === 0) {
    if (hasTextChildren(element)) {
      report("svgImport.text_style_not_kept", "Text children may override inherited zero font size");
    }
    return;
  }
  let raw = "";
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 3 || node.nodeType === 4 || (node.nodeType === 1
      && !textMetadata.has((node as Element).localName))) {
      const part = node.textContent ?? "";
      countText(part.length);
      raw += part;
    }
  }
  const preserve = closestSpace(element) === "preserve";
  const text = preserve ? raw.replace(/[\t\r\n]/g, " ") : raw.replace(/[ \t\r\n]+/g, " ").trim();
  if (!text) return;
  if (hasTextChildren(element)) {
    report("svgImport.text_style_not_kept", "Text child positioning and styling");
  }
  if (preserve && /^ | $| {2,}/.test(text)) report("svgImport.text_style_not_kept", "Preserved SVG whitespace");
  if (property(element, css, "textLength") !== undefined || property(element, css, "rotate") !== undefined) {
    report("svgImport.text_style_not_kept", "SVG text length or per-glyph rotation");
  }
  const scale = similarityScale(matrix);
  if (scale === undefined || determinant(matrix) <= 0) {
    report("svgImport.text_not_kept", "Sheared, reflected or non-uniformly scaled text");
    return;
  }
  const fontSizePx = baseSize * scale;
  const coordinate = (name: string, basis: number): number =>
    length(property(element, css, name) ?? "0", basis, baseSize) ?? NaN;
  const origin = point(matrix, coordinate("x", viewport.width) + coordinate("dx", viewport.width),
    coordinate("y", viewport.height) + coordinate("dy", viewport.height));
  if (![origin.x, origin.y, fontSizePx].every(Number.isFinite)) {
    report("svgImport.text_not_kept", "Unsupported SVG text coordinates");
    return;
  }
  const anchor = style["text-anchor"];
  if (!["start", "middle", "end"].includes(anchor)) report("svgImport.text_style_not_kept", "Unsupported text-anchor");
  const textAlign = anchor === "middle" ? "center" : anchor === "end" ? "right" : "left";
  const alignment = anchor === "middle" ? 0.5 : anchor === "end" ? 1 : 0;
  const fill = solidColor(style.fill, style.color, canonicalColor);
  if (style.stroke !== "none") report("svgImport.text_style_not_kept", "Text stroke");
  if (!fill) {
    if (style.fill === "none" && style.stroke === "none") return;
    report("svgImport.text_style_not_kept", "Unsupported text fill");
  }
  const alpha = objectOpacity * opacity(style["fill-opacity"], "fill-opacity", report) * (fill?.alpha ?? 1);
  const color = textColor(fill?.color ?? "#000000", alpha, report);
  const weight = style["font-weight"];
  const fontWeight = weight === "normal" ? 400 : weight === "bold" ? 700 : Number(weight);
  if (!Number.isFinite(fontWeight) || fontWeight < 1 || fontWeight > 1000) {
    report("svgImport.text_style_not_kept", "Unsupported font-weight");
  }
  const fontStyle = style["font-style"];
  const textDecoration = style["text-decoration"];
  if (!["normal", "italic", "oblique"].includes(fontStyle)) report("svgImport.text_style_not_kept", "Unsupported font-style");
  if (!["none", "underline", "line-through", "overline"].includes(textDecoration)) {
    report("svgImport.text_style_not_kept", "Unsupported text-decoration");
  }
  const spacing = style["letter-spacing"] === "normal" ? 0 : length(style["letter-spacing"], baseSize, baseSize);
  if (spacing === undefined) report("svgImport.text_style_not_kept", "Unsupported letter-spacing");
  const letterSpacingPx = (spacing ?? 0) * scale;
  // The editable box is estimated to place its anchor. It does not bound glyph ink.
  let characters = 0;
  for (const _ of text) characters++;
  const width = Math.max(fontSizePx, characters * (fontSizePx * 0.6 + letterSpacingPx));
  const height = fontSizePx * 1.2;
  const rotation = Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI;
  const anchorOffset = point(rotate(rotation), (alignment - 0.5) * width, fontSizePx - height / 2);
  const bounds = { width, height, x: origin.x - anchorOffset.x - width / 2, y: origin.y - anchorOffset.y - height / 2 };
  if (!validBounds(bounds) || !Number.isFinite(letterSpacingPx) || fontSizePx <= 0) {
    report("svgImport.text_not_kept", "Unusable editable text frame");
    return;
  }
  return {
    ...bounds, type: "text", text, spans: [], rotation,
    style: { color, fontFamily: style["font-family"], fontSizePx, textAlign, letterSpacingPx,
      fontWeight: Number.isFinite(fontWeight) && fontWeight > 0 ? fontWeight : 400, fontStyle, textDecoration }
  };
}

function closestSpace(element: Element): string | null {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const space = current.getAttributeNS("http://www.w3.org/XML/1998/namespace", "space");
    if (space !== null) return space;
  }
  return null;
}

function textColor(color: string, alpha: number, report: ReportLoss): string {
  if (alpha === 1) return color;
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    const channels = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
    return `rgba(${channels.join(",")},${alpha})`;
  }
  report("svgImport.text_style_not_kept", "Text opacity on a non-hex color");
  return color;
}
