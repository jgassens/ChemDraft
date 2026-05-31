import {
  pageLayoutSvgSize,
  type ChemDraftDocument,
  type DocumentObject,
  type MoleculeObject,
  type TextObject
} from "@chemdraft/chem-core";

export type ExportFormat = "svg" | "png" | "pdf" | "mol" | "sdf" | "smiles" | "rxn" | "cdxml";

export interface ExportWarning {
  code: string;
  message: string;
  objectId?: string;
}

export interface SvgExportOptions {
  pageIndex?: number;
  includeWarnings?: boolean;
}

export interface SvgExportResult {
  format: "svg";
  contents: string;
  warnings: ExportWarning[];
}

export function exportDocumentToSvg(document: ChemDraftDocument, options: SvgExportOptions = {}): SvgExportResult {
  const pageIndex = options.pageIndex ?? 0;
  const page = document.pages[pageIndex];
  const warnings: ExportWarning[] = [];

  if (!page) {
    throw new Error(`Cannot export SVG: page index ${pageIndex} does not exist.`);
  }

  const svgSize = pageLayoutSvgSize(page.layout);
  const body = page.objects.map((object) => renderObject(object, warnings)).join("\n  ");
  const warningMarkup =
    options.includeWarnings === true && warnings.length > 0
      ? `\n  <metadata data-chemdraft-warnings="${escapeXml(JSON.stringify(warnings))}" />`
      : "";

  return {
    format: "svg",
    contents: [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${svgSize.width}" height="${svgSize.height}" viewBox="0 0 ${page.width} ${page.height}" role="img" aria-label="${escapeXml(document.title)}">`,
      `  <rect width="${page.width}" height="${page.height}" fill="#ffffff" />`,
      `  <rect x="${page.margin.left}" y="${page.margin.top}" width="${page.width - page.margin.left - page.margin.right}" height="${page.height - page.margin.top - page.margin.bottom}" fill="none" stroke="#9fc9bd" stroke-width="1" opacity="0.5" />`,
      body ? `  ${body}` : "",
      warningMarkup,
      "</svg>"
    ]
      .filter(Boolean)
      .join("\n"),
    warnings
  };
}

function renderObject(object: DocumentObject, warnings: ExportWarning[]): string {
  switch (object.type) {
    case "molecule":
      return renderMoleculeObject(object);
    case "text":
      return renderTextObject(object);
    case "plus":
      return renderCenteredText(object, "+", "24", "700");
    case "reaction-arrow":
      return renderLineObject(object, object.arrowKind);
    case "graphic":
      return renderGraphicObject(object, warnings);
    default:
      warnings.push({
        code: "export.svg.object_fallback",
        message: `SVG export used a labeled fallback for object type "${object.type}".`,
        objectId: object.id
      });
      return renderFallbackObject(object);
  }
}

function renderMoleculeObject(object: MoleculeObject): string {
  const label = object.structureFormat === "smiles" ? object.structure : `${object.structureFormat} object`;
  const formula = object.chemistry?.warnings.length ? "warnings" : (object.chemistry ? "validated" : "adapter-backed");
  return [
    `<g data-object-id="${escapeXml(object.id)}" data-object-type="molecule" transform="${rotationTransform(object)}">`,
    `  <rect x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" rx="4" fill="#ffffff" stroke="#2f3b42" stroke-width="1.5" />`,
    `  <text x="${object.x + 12}" y="${object.y + 34}" font-family="Arial, sans-serif" font-size="22" fill="#172026">${escapeXml(label)}</text>`,
    `  <text x="${object.x + 12}" y="${object.y + object.height - 16}" font-family="Arial, sans-serif" font-size="11" fill="#52616b">${escapeXml(formula)}</text>`,
    "</g>"
  ].join("\n  ");
}

function renderTextObject(object: TextObject): string {
  return `<text data-object-id="${escapeXml(object.id)}" data-object-type="text" x="${object.x}" y="${object.y}" font-family="Arial, sans-serif" font-size="14" fill="#172026" transform="${rotationTransform(object)}">${escapeXml(object.text)}</text>`;
}

function renderGraphicObject(object: Extract<DocumentObject, { type: "graphic" }>, warnings: ExportWarning[]): string {
  if (object.graphicKind === "rect") {
    return `<rect data-object-id="${escapeXml(object.id)}" data-object-type="graphic" x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" fill="none" stroke="#2f3b42" stroke-width="1.5" transform="${rotationTransform(object)}" />`;
  }

  warnings.push({
    code: "export.svg.graphic_fallback",
    message: `SVG export used a labeled fallback for graphic kind "${object.graphicKind}".`,
    objectId: object.id
  });
  return renderFallbackObject(object);
}

function renderLineObject(object: DocumentObject, label: string): string {
  const startX = object.x;
  const startY = object.y + object.height / 2;
  const endX = object.x + object.width;
  const endY = startY;
  return [
    `<g data-object-id="${escapeXml(object.id)}" data-object-type="${escapeXml(object.type)}" transform="${rotationTransform(object)}">`,
    `  <line x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}" stroke="#172026" stroke-width="1.5" />`,
    `  <text x="${object.x}" y="${object.y - 6}" font-family="Arial, sans-serif" font-size="10" fill="#52616b">${escapeXml(label)}</text>`,
    "</g>"
  ].join("\n  ");
}

function renderFallbackObject(object: DocumentObject): string {
  return [
    `<g data-object-id="${escapeXml(object.id)}" data-object-type="${escapeXml(object.type)}" transform="${rotationTransform(object)}">`,
    `  <rect x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" rx="4" fill="#ffffff" stroke="#69757d" stroke-width="1" />`,
    `  <text x="${object.x + 8}" y="${object.y + 20}" font-family="Arial, sans-serif" font-size="11" fill="#52616b">${escapeXml(object.type)}</text>`,
    "</g>"
  ].join("\n  ");
}

function renderCenteredText(object: DocumentObject, label: string, fontSize: string, fontWeight: string): string {
  return `<text data-object-id="${escapeXml(object.id)}" data-object-type="${escapeXml(object.type)}" x="${object.x + object.width / 2}" y="${object.y + object.height / 2}" dominant-baseline="middle" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" fill="#172026" transform="${rotationTransform(object)}">${escapeXml(label)}</text>`;
}

function rotationTransform(object: DocumentObject): string {
  if (object.rotation === 0) {
    return "";
  }

  return `rotate(${object.rotation} ${object.x + object.width / 2} ${object.y + object.height / 2})`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
