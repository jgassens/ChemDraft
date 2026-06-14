import {
  CSS_PX_PER_INCH,
  type ChemDraftDocument
} from "@chemdraft/chem-core";
import { jsPDF } from "jspdf";
import { svg2pdf } from "svg2pdf.js";
import { getExportFormatDescriptor } from "./formats";
import type { BinaryExportResult } from "./results";
import { exportDocumentToSvg } from "./svg";

export interface PdfExportOptions {
  pageIndex?: number;
  domParser?: DOMParser;
  compress?: boolean;
  includePageGuides?: boolean;
}

export async function exportDocumentToPdf(
  document: ChemDraftDocument,
  options: PdfExportOptions = {}
): Promise<BinaryExportResult> {
  const pageIndex = options.pageIndex ?? 0;
  const page = document.pages[pageIndex];

  if (!page) {
    throw new Error(`Cannot export PDF: page index ${pageIndex} does not exist.`);
  }

  const descriptor = getExportFormatDescriptor("pdf");
  const svgResult = exportDocumentToSvg(document, {
    pageIndex,
    includePageGuides: options.includePageGuides
  });
  const svgElement = parseSvgElement(svgResult.contents, options.domParser);
  const widthPt = cssPxToPdfPt(page.width);
  const heightPt = cssPxToPdfPt(page.height);
  const pdf = new jsPDF({
    orientation: widthPt >= heightPt ? "landscape" : "portrait",
    unit: "pt",
    format: [widthPt, heightPt],
    compress: options.compress ?? true
  });

  await svg2pdf(svgElement, pdf, {
    x: 0,
    y: 0,
    width: widthPt,
    height: heightPt,
    loadExternalStyleSheets: false
  });

  return {
    format: "pdf",
    kind: "binary",
    bytes: new Uint8Array(pdf.output("arraybuffer")),
    mimeType: descriptor.mimeType,
    extension: descriptor.extensions[0] ?? "pdf",
    warnings: svgResult.warnings
  };
}

function cssPxToPdfPt(value: number): number {
  return value / CSS_PX_PER_INCH * 72;
}

function parseSvgElement(svg: string, domParser: DOMParser | undefined): Element {
  const parser = domParser ?? createDomParser();
  const parsed = parser.parseFromString(svg, "image/svg+xml");
  const parserError = parsed.getElementsByTagName("parsererror")[0];

  if (parserError) {
    throw new Error("Cannot export PDF: generated SVG could not be parsed.");
  }

  if (parsed.documentElement.tagName.toLowerCase() !== "svg") {
    throw new Error("Cannot export PDF: generated SVG root is not an SVG element.");
  }

  return parsed.documentElement;
}

function createDomParser(): DOMParser {
  const DomParserConstructor = globalThis.DOMParser;
  if (!DomParserConstructor) {
    throw new Error("Cannot export PDF: DOMParser is not available in this environment.");
  }
  return new DomParserConstructor();
}
