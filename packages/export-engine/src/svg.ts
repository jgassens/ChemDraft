import {
  CSS_PX_PER_INCH,
  pageLayoutSvgSize,
  type ChemDraftDocument
} from "@chemdraft/chem-core";
import {
  DocumentStyleScale,
  documentStylePointBounds,
  planPageSvgRender,
  type PageSvgAttributeValue,
  type PageSvgFragment
} from "@chemdraft/layout-engine";
import type { ExportWarning } from "./results";

export interface SvgExportOptions {
  pageIndex?: number;
  includePageGuides?: boolean;
  includeWarnings?: boolean;
  /**
   * Page background fill. Defaults to opaque white; pass `"transparent"` to omit the
   * background rect entirely so downstream raster/PNG export can preserve transparency.
   */
  background?: string;
  /** Explicit dimensions without outputUnit are pixels; all objects scale with the page. */
  outputWidth?: number;
  outputHeight?: number;
  /** Units for explicitly requested dimensions; omitted sizes retain page-layout units. */
  outputUnit?: "mm" | "in";
}

export interface SvgExportResult {
  format: "svg";
  contents: string;
  warnings: ExportWarning[];
}

/** Give cropped native SVG geometry its natural physical size, with one user unit = one pt.
 * Pictures keep their physical frame while their centres follow the document-style layout.
 */
export function documentStyleSvg(svg: string, bounds: { x: number; y: number; width: number; height: number }) {
  const scale = DocumentStyleScale.pointsPerUnit;
  // The rest of the figure uses the document bond scale. Pictures retain 96 units/inch.
  let pictureBounds = { ...bounds };
  const resized = svg.replace(/<image\b[^>]*\bdata-chemdraft-picture-frame="([^"]*)"[^>]*>/g, (tag, value: string) => {
    const [x, y, width, height, rotation] = value.split(" ").map(Number);
    if (![x, y, width, height, rotation].every(Number.isFinite)) return tag;
    const frame = physicalPictureFrame({ x, y, width, height }, scale);
    // A crop computed in native units may be too small after the physical-size correction.
    const radians = rotation * Math.PI / 180;
    const halfWidth = (Math.abs(Math.cos(radians)) * frame.width + Math.abs(Math.sin(radians)) * frame.height) / 2;
    const halfHeight = (Math.abs(Math.sin(radians)) * frame.width + Math.abs(Math.cos(radians)) * frame.height) / 2;
    const cx = x + width / 2, cy = y + height / 2;
    const margin = DocumentStyleScale.marginPt / scale;
    const left = Math.min(pictureBounds.x, cx - halfWidth - margin);
    const top = Math.min(pictureBounds.y, cy - halfHeight - margin);
    pictureBounds = { x: left, y: top,
      width: Math.max(pictureBounds.x + pictureBounds.width, cx + halfWidth + margin) - left,
      height: Math.max(pictureBounds.y + pictureBounds.height, cy + halfHeight + margin) - top };
    return Object.entries(frame).reduce((result, [key, dimension]) =>
      result.replace(new RegExp(`\\b${key}="[^"]*"`), `${key}="${dimension}"`), tag);
  });
  const viewBox = documentStylePointBounds(pictureBounds);
  const number = (value: number) => Number(value.toFixed(6)).toString();
  const expanded = Object.entries(bounds).some(([key, value]) => pictureBounds[key as keyof typeof bounds] !== value);
  const withBackground = expanded ? resized.replace(/(<svg\b[^>]*>\s*)<rect\b([^>]*fill="#ffffff"[^>]*)\/>/,
    (tag, root: string, attrs: string) => attrs.includes("data-object-id") ? tag
      : `${root}<rect x="${pictureBounds.x}" y="${pictureBounds.y}" width="${pictureBounds.width}" height="${pictureBounds.height}" fill="#ffffff" />`) : resized;
  const contents = withBackground.replace(/<svg\b[^>]*>/, (root) => root
    .replace(/\bwidth="[^"]*"/, `width="${number(viewBox.width)}pt"`)
    .replace(/\bheight="[^"]*"/, `height="${number(viewBox.height)}pt"`)
    .replace(/\bviewBox="[^"]*"/, `viewBox="${Object.values(viewBox).map(number).join(" ")}"`)
    + `\n<g transform="scale(${scale})">`).replace(/<\/svg>\s*$/, "</g>\n</svg>");
  return { svg: contents, viewBox };
}

export function exportDocumentToSvg(document: ChemDraftDocument, options: SvgExportOptions = {}): SvgExportResult {
  for (const dimension of [options.outputWidth, options.outputHeight]) {
    if (dimension !== undefined && (!Number.isFinite(dimension) || dimension <= 0)) {
      throw new Error("Cannot export SVG: output dimensions must be finite positive numbers.");
    }
  }
  const pageIndex = options.pageIndex ?? 0;
  const page = document.pages[pageIndex];

  if (!page) {
    throw new Error(`Cannot export SVG: page index ${pageIndex} does not exist.`);
  }

  const svgSize = pageLayoutSvgSize(page.layout);
  const outputWidth = options.outputWidth === undefined ? svgSize.width : `${options.outputWidth}${options.outputUnit ?? ""}`;
  const outputHeight = options.outputHeight === undefined ? svgSize.height : `${options.outputHeight}${options.outputUnit ?? ""}`;
  const pixelOutput = options.outputUnit === undefined && (options.outputWidth !== undefined || options.outputHeight !== undefined);
  const pointsPerUnit = Math.min(svgLengthInPoints(outputWidth) / page.width, svgLengthInPoints(outputHeight) / page.height);
  const missingPictures = page.objects.filter((object) => object.type === "graphic" && object.graphicKind === "image" && !object.data.image && object.data.imageHref === undefined);
  const missingIds = new Set(missingPictures.map((object) => object.id));
  const plan = planPageSvgRender({ ...page, objects: page.objects.filter((object) => !missingIds.has(object.id)) });
  const images = new Map(page.objects.filter((object) => object.type === "graphic" && object.graphicKind === "image" && object.data.image)
    .map((object) => [object.id, object]));
  const renderedImages = new Set<string>();
  const body = plan.fragments.map((fragment) => {
    const image = fragment.kind === "element" ? images.get(String(fragment.attrs["data-object-id"])) : undefined;
    if (!image || fragment.kind !== "element" || image.type !== "graphic" || !image.data.image) return serializeSvgFragment(fragment, 2);
    if (renderedImages.has(image.id)) return "";
    renderedImages.add(image.id);
    // Raster sampling and previews scale the whole page, including picture frames.
    const frame = pixelOutput ? { x: image.x, y: image.y, width: image.width, height: image.height }
      : physicalPictureFrame(image, pointsPerUnit);
    return serializeSvgFragment({ ...fragment, tag: "g", children: [{ kind: "element", key: `image-${image.id}`, tag: "image", attrs: {
      ...Object.fromEntries(Object.entries(frame).map(([key, value]) => [key, String(value)])),
      // Keep the native frame so later document-style conversion cannot rescale the picture twice.
      "data-chemdraft-picture-frame": `${image.x} ${image.y} ${image.width} ${image.height} ${image.rotation}`,
      preserveAspectRatio: "none", href: `data:${image.data.image.mimeType};base64,${image.data.image.dataBase64}`
    }, children: [] }] }, 2);
  }).join("\n");
  const warnings = plan.warnings.filter((warning) => !(warning.code === "export.svg.graphic_fallback" && warning.objectId && images.has(warning.objectId))).map<ExportWarning>((warning) => ({
    code: warning.code,
    message: warning.message,
    severity: "warning",
    objectId: warning.objectId
  }));
  warnings.push(...missingPictures.map((picture): ExportWarning => ({
    code: "export.svg.picture_missing_data", severity: "warning", objectId: picture.id,
    message: `SVG export: picture ${picture.id} has no picture data and was not drawn`
  })));
  const warningMarkup =
    options.includeWarnings === true && warnings.length > 0
      ? `\n  <metadata data-chemdraft-warnings="${escapeXml(JSON.stringify(warnings))}" />`
      : "";
  const pageGuideMarkup = options.includePageGuides === true
    ? `  <rect x="${page.margin.left}" y="${page.margin.top}" width="${page.width - page.margin.left - page.margin.right}" height="${page.height - page.margin.top - page.margin.bottom}" fill="none" stroke="#9fc9bd" stroke-width="1" opacity="0.5" data-chemdraft-page-guide="margin" />`
    : "";
  const background = options.background ?? "#ffffff";
  const backgroundMarkup = background === "transparent"
    ? ""
    : `  <rect width="${page.width}" height="${page.height}" fill="${escapeXml(background)}" />`;

  return {
    format: "svg",
    contents: [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${page.width} ${page.height}" role="img" aria-label="${escapeXml(document.title)}">`,
      backgroundMarkup,
      pageGuideMarkup,
      body,
      warningMarkup,
      "</svg>"
    ]
      .filter(Boolean)
      .join("\n"),
    warnings
  };
}

function physicalPictureFrame(frame: { x: number; y: number; width: number; height: number }, pointsPerUnit: number) {
  const scale = (72 / CSS_PX_PER_INCH) / pointsPerUnit;
  const width = frame.width * scale, height = frame.height * scale;
  return { x: frame.x + (frame.width - width) / 2, y: frame.y + (frame.height - height) / 2, width, height };
}

function svgLengthInPoints(length: string | number): number {
  const value = parseFloat(String(length));
  if (String(length).endsWith("in")) return value * 72;
  if (String(length).endsWith("mm")) return value / 25.4 * 72;
  return value / CSS_PX_PER_INCH * 72;
}

function serializeSvgFragment(fragment: PageSvgFragment, indent: number, insideText = false): string {
  const pad = " ".repeat(indent);
  if (fragment.kind === "text") {
    return `${pad}${escapeXml(fragment.text)}`;
  }

  if (shouldSkipExportFragment(fragment)) {
    return "";
  }

  const attrs = serializeSvgAttributes(fragment.attrs);
  // SVG treats formatting whitespace inside text as visible content. Keep the entire
  // text subtree inline (including nested tspans), just as the canvas's DOM plan does.
  const inline = insideText || fragment.tag === "text" || fragment.tag === "tspan";
  const children = fragment.children
    .map((child) => serializeSvgFragment(child, inline ? 0 : indent + 2, inline))
    .filter((child) => child.length > 0);
  if (fragment.children.length === 0) {
    return `${pad}<${fragment.tag}${attrs} />`;
  }

  if (inline) {
    return `${pad}<${fragment.tag}${attrs}>${children.join("")}</${fragment.tag}>`;
  }

  if (fragment.children.every((child) => child.kind === "text")) {
    return `${pad}<${fragment.tag}${attrs}>${fragment.children.map((child) => child.kind === "text" ? escapeXml(child.text) : "").join("")}</${fragment.tag}>`;
  }

  return [
    `${pad}<${fragment.tag}${attrs}>`,
    ...children,
    `${pad}</${fragment.tag}>`
  ].join("\n");
}

function serializeSvgAttributes(attrs: Record<string, PageSvgAttributeValue>): string {
  const serialized = Object.entries(attrs)
    .flatMap(([key, value]) => {
      if (key === "class" || value === undefined || value === false || value === "") {
        return [];
      }
      if (value === true) {
        return [key];
      }
      return [`${key}="${escapeXml(svgAttributeValue(value))}"`];
    });

  return serialized.length > 0 ? ` ${serialized.join(" ")}` : "";
}

function shouldSkipExportFragment(fragment: PageSvgFragment): boolean {
  if (fragment.kind === "text") {
    return false;
  }

  const className = String(fragment.attrs.class ?? "");
  return className === "native-bond-hit-target" ||
    className === "native-bond-hover-decorator" ||
    className === "native-atom-hit-target" ||
    className === "native-crossing-hit-target" ||
    className === "native-molecule-ring-hit-target";
}

function svgAttributeValue(value: Exclude<PageSvgAttributeValue, undefined>): string {
  if (typeof value === "number") {
    return Number(value.toFixed(3)).toString();
  }

  return String(value);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
