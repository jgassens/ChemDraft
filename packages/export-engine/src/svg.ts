import {
  pageLayoutSvgSize,
  type ChemDraftDocument
} from "@chemdraft/chem-core";
import {
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
}

export interface SvgExportResult {
  format: "svg";
  contents: string;
  warnings: ExportWarning[];
}

export function exportDocumentToSvg(document: ChemDraftDocument, options: SvgExportOptions = {}): SvgExportResult {
  const pageIndex = options.pageIndex ?? 0;
  const page = document.pages[pageIndex];

  if (!page) {
    throw new Error(`Cannot export SVG: page index ${pageIndex} does not exist.`);
  }

  const svgSize = pageLayoutSvgSize(page.layout);
  const plan = planPageSvgRender(page);
  const body = plan.fragments.map((fragment) => serializeSvgFragment(fragment, 2)).join("\n");
  const warnings = plan.warnings.map<ExportWarning>((warning) => ({
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
      `<svg xmlns="http://www.w3.org/2000/svg" width="${svgSize.width}" height="${svgSize.height}" viewBox="0 0 ${page.width} ${page.height}" role="img" aria-label="${escapeXml(document.title)}">`,
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

function serializeSvgFragment(fragment: PageSvgFragment, indent: number): string {
  const pad = " ".repeat(indent);
  if (fragment.kind === "text") {
    return `${pad}${escapeXml(fragment.text)}`;
  }

  if (shouldSkipExportFragment(fragment)) {
    return "";
  }

  const attrs = serializeSvgAttributes(fragment.attrs);
  const children = fragment.children
    .map((child) => serializeSvgFragment(child, indent + 2))
    .filter((child) => child.length > 0);
  if (fragment.children.length === 0) {
    return `${pad}<${fragment.tag}${attrs} />`;
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
    className === "native-crossing-hit-target";
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
