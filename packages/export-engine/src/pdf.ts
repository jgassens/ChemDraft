import {
  CSS_PX_PER_INCH,
  type ChemDraftDocument
} from "@chemdraft/chem-core";
import { jsPDF } from "jspdf";
import * as svg2pdfModule from "svg2pdf.js";
import { getExportFormatDescriptor } from "./formats";
import type { BinaryExportResult } from "./results";
import { exportDocumentToSvg } from "./svg";

const svg2pdf = resolveSvg2pdf(svg2pdfModule);

export interface PdfExportOptions {
  pageIndex?: number;
  domParser?: DOMParser;
  compress?: boolean;
  includePageGuides?: boolean;
  outputWidth?: number;
  outputHeight?: number;
  /** Resolve text to vector paths with the host's fonts before PDF conversion. */
  outlineSvgText?: (svg: string) => Promise<string>;
}

export async function exportDocumentToPdf(
  document: ChemDraftDocument,
  options: PdfExportOptions = {}
): Promise<BinaryExportResult> {
  for (const dimension of [options.outputWidth, options.outputHeight]) {
    if (dimension !== undefined && (!Number.isFinite(dimension) || dimension <= 0)) {
      throw new Error("Cannot export PDF: output dimensions must be finite positive numbers.");
    }
  }
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
  const svg = options.outlineSvgText
    ? await options.outlineSvgText(svgResult.contents)
    : svgResult.contents;
  const svgElement = parseSvgElement(svg, options.domParser);
  const widthPt = cssPxToPdfPt(options.outputWidth ?? page.width);
  const heightPt = cssPxToPdfPt(options.outputHeight ?? page.height);
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

function resolveSvg2pdf(module: typeof svg2pdfModule): typeof svg2pdfModule.svg2pdf {
  if (typeof module.svg2pdf === "function") {
    return module.svg2pdf;
  }

  const defaultExport = (module as typeof module & { default?: unknown }).default;
  if (typeof defaultExport === "function") {
    return defaultExport as typeof svg2pdfModule.svg2pdf;
  }

  if (
    typeof defaultExport === "object" &&
    defaultExport !== null &&
    "svg2pdf" in defaultExport &&
    typeof defaultExport.svg2pdf === "function"
  ) {
    return defaultExport.svg2pdf as typeof svg2pdfModule.svg2pdf;
  }

  throw new Error("Cannot export PDF: svg2pdf.js did not provide an svg2pdf function.");
}
