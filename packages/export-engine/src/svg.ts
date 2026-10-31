import {
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
 * The supplied SVG already contains its cropped background; scale it with all other content.
 */
export function documentStyleSvg(svg: string, bounds: { x: number; y: number; width: number; height: number }) {
  const scale = DocumentStyleScale.pointsPerUnit;
  const viewBox = documentStylePointBounds(bounds);
  const number = (value: number) => Number(value.toFixed(6)).toString();
  const contents = svg.replace(/<svg\b[^>]*>/, (root) => root
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
  const plan = planPageSvgRender(page);
  const images = new Map(page.objects.filter((object) => object.type === "graphic" && object.graphicKind === "image" && object.data.image)
    .map((object) => [object.id, object]));
  const renderedImages = new Set<string>();
  const body = plan.fragments.map((fragment) => {
    const image = fragment.kind === "element" ? images.get(String(fragment.attrs["data-object-id"])) : undefined;
    if (!image || fragment.kind !== "element" || image.type !== "graphic" || !image.data.image) return serializeSvgFragment(fragment, 2);
    if (renderedImages.has(image.id)) return "";
    renderedImages.add(image.id);
    return serializeSvgFragment({ ...fragment, tag: "g", children: [{ kind: "element", key: `image-${image.id}`, tag: "image", attrs: {
      x: String(image.x), y: String(image.y), width: String(image.width), height: String(image.height),
      preserveAspectRatio: "none", href: `data:${image.data.image.mimeType};base64,${image.data.image.dataBase64}`
    }, children: [] }] }, 2);
  }).join("\n");
  const warnings = plan.warnings.filter((warning) => !(warning.code === "export.svg.graphic_fallback" && warning.objectId && images.has(warning.objectId))).map<ExportWarning>((warning) => ({
    code: warning.code,
    message: warning.message,
    severity: "warning",
    objectId: warning.objectId
  }));
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
