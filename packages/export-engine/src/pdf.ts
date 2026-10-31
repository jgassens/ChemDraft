import {
  CSS_PX_PER_INCH,
  type ChemDraftDocument
} from "@chemdraft/chem-core";
import { jsPDF } from "jspdf";
import * as svg2pdfModule from "svg2pdf.js";
import { getExportFormatDescriptor } from "./formats";
import type { BinaryExportResult } from "./results";
import { exportDocumentToSvg } from "./svg";
import { preparePdfFonts } from "./pdfFonts";
import { preparePdfHaloPaint } from "./pdfHaloPaint";

const svg2pdf = resolveSvg2pdf(svg2pdfModule);

export interface PdfExportOptions {
  pageIndex?: number;
  domParser?: DOMParser;
  compress?: boolean;
  includePageGuides?: boolean;
  outputWidth?: number;
  outputHeight?: number;
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
  const { bytes } = await exportSvgToPdf(svgResult.contents, {
    outputWidth: options.outputWidth ?? page.width,
    outputHeight: options.outputHeight ?? page.height,
    domParser: options.domParser,
    compress: options.compress
  });

  return {
    format: "pdf",
    kind: "binary",
    bytes,
    mimeType: descriptor.mimeType,
    extension: descriptor.extensions[0] ?? "pdf",
    warnings: svgResult.warnings
  };
}

export async function exportSvgToPdf(
  svgMarkup: string,
  options: { outputWidth: number; outputHeight: number; domParser?: DOMParser; compress?: boolean }
): Promise<{ bytes: Uint8Array }> {
  if (![options.outputWidth, options.outputHeight].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Cannot export PDF: output dimensions must be finite positive numbers.");
  }
  const widthPt = cssPxToPdfPt(options.outputWidth);
  const heightPt = cssPxToPdfPt(options.outputHeight);
  if (Math.max(widthPt, heightPt) > 14400) {
    throw new Error("Cannot export PDF: physical page size exceeds 14400 points (200 inches) per side. Reduce the pixel dimensions or increase DPI.");
  }
  const svgElement = parseSvgElement(svgMarkup, options.domParser);

  const pdf = new jsPDF({
    orientation: widthPt >= heightPt ? "landscape" : "portrait",
    unit: "pt",
    format: [widthPt, heightPt],
    compress: options.compress ?? true
  });

  const releaseFonts = await preparePdfFonts(svgElement, pdf);
  let releaseHaloPaint = () => {};
  try {
    releaseHaloPaint = await preparePdfHaloPaint(svgElement, pdf, svg2pdf, widthPt, heightPt);
    await svg2pdf(svgElement, pdf, {
      x: 0,
      y: 0,
      width: widthPt,
      height: heightPt,
      loadExternalStyleSheets: false
    });
  } finally {
    releaseHaloPaint();
    releaseFonts();
  }

  return { bytes: new Uint8Array(pdf.output("arraybuffer")) };
}

function cssPxToPdfPt(value: number): number {
  return value / CSS_PX_PER_INCH * 72;
}

function parseSvgElement(svg: string, domParser: DOMParser | undefined): Element {
  assertBoundedSvg(svg);
  const parser = domParser ?? createDomParser();
  const parsed = parser.parseFromString(svg, "image/svg+xml");
  const parserError = parsed.getElementsByTagName("parsererror")[0];

  if (parserError) {
    throw new Error("Cannot export PDF: generated SVG could not be parsed.");
  }

  if (parsed.documentElement.tagName.toLowerCase() !== "svg") {
    throw new Error("Cannot export PDF: generated SVG root is not an SVG element.");
  }

  const pending: { node: Node; depth: number }[] = [{ node: parsed.documentElement, depth: 1 }];
  let nodes = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++nodes > 100000 || depth > 64) throw new Error("Cannot export PDF: SVG complexity limit exceeded.");
    if (node.nodeType === 1) {
      const element = node as Element;
      if (["a", "script", "foreignobject", "use"].includes(element.localName.toLowerCase())) {
        throw new Error("Cannot export PDF: active SVG content is not allowed.");
      }
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.localName.toLowerCase();
        if (name.startsWith("on") || attribute.name.toLowerCase() === "xml:base") {
          throw new Error("Cannot export PDF: active SVG attributes are not allowed.");
        }
        if (name === "href" && !/^#[A-Za-z_][\w.-]*$/.test(attribute.value) &&
            !(element.localName === "image" && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(attribute.value))) {
          throw new Error("Cannot export PDF: external SVG references are not allowed.");
        }
        if (name === "style" || ["fill", "stroke", "filter", "clip-path", "mask", "marker-start", "marker-mid", "marker-end"].includes(name)) {
          assertLocalSvgCss(attribute.value);
        }
      }
      if (element.localName === "style") assertLocalSvgCss(element.textContent ?? "");
    }
    for (let child = node.lastChild; child; child = child.previousSibling) pending.push({ node: child, depth: depth + 1 });
  }

  return parsed.documentElement;
}

function assertLocalSvgCss(value: string): void {
  const decoded = value.replace(/\\(?:\r\n|[\n\r\f])|\\([0-9a-f]{1,6})[ \t\r\n\f]?|\\([\s\S])/gi,
    (_match, hex: string | undefined, character: string | undefined) => {
      if (!hex) return character ?? "";
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
    }).replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@import\b/i.test(decoded) ||
      /url\s*\(/i.test(decoded.replace(/url\(\s*(["']?)#[A-Za-z_][\w.-]*\1\s*\)/gi, ""))) {
    throw new Error("Cannot export PDF: external SVG styles are not allowed.");
  }
}

function assertBoundedSvg(svg: string): void {
  const limit = 20 * 1024 * 1024;
  if (typeof svg !== "string" || svg.length > limit) throw new Error("Cannot export PDF: SVG exceeds 20 MB.");
  let bytes = 0;
  for (const character of svg) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > limit) throw new Error("Cannot export PDF: SVG exceeds 20 MB.");
  }
  // Reject entities and stylesheet instructions before the XML parser can process them.
  const source = svg.replace(/^<\?xml version="1\.0" encoding="UTF-8"\?>\s*/, "");
  if (/<!|<\?/.test(source)) throw new Error("Cannot export PDF: SVG declarations are not allowed.");
  let nodes = 0;
  let depth = 0;
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source[offset] !== "<") continue;
    const start = offset;
    let quote = "";
    for (offset += 1; offset < source.length; offset += 1) {
      if (quote) {
        if (source[offset] === quote) quote = "";
      } else if (source[offset] === '"' || source[offset] === "'") quote = source[offset];
      else if (source[offset] === ">") break;
    }
    if (offset === source.length) throw new Error("Cannot export PDF: generated SVG could not be parsed.");
    if (source[start + 1] === "/") depth -= 1;
    else {
      nodes += 1;
      depth += 1;
      if (nodes > 100000 || depth > 64) throw new Error("Cannot export PDF: SVG complexity limit exceeded.");
      if (source[offset - 1] === "/") depth -= 1;
    }
    if (depth < 0) throw new Error("Cannot export PDF: generated SVG could not be parsed.");
  }
  if (depth !== 0) throw new Error("Cannot export PDF: generated SVG could not be parsed.");
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
