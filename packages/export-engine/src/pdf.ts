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

  const widthPt = cssPxToPdfPt(options.outputWidth ?? page.width);
  const heightPt = cssPxToPdfPt(options.outputHeight ?? page.height);
  if (Math.max(widthPt, heightPt) > 14400) {
    throw new Error("Cannot export PDF: physical page size exceeds 14400 points (200 inches) per side. Reduce the pixel dimensions or increase DPI.");
  }

  const descriptor = getExportFormatDescriptor("pdf");
  const svgResult = exportDocumentToSvg(document, {
    pageIndex,
    includePageGuides: options.includePageGuides
  });
  const svgElement = parseSvgElement(svgResult.contents, options.domParser);
  const pictures = new Map(page.objects.filter((object) => object.type === "graphic" && object.graphicKind === "image" && object.data.image)
    .map((object) => [object.id, object]));
  const warnings = svgResult.warnings.map((warning) => warning.code === "export.svg.picture_missing_data"
    ? { ...warning, code: "export.pdf.picture_missing_data", message: `PDF export: picture ${warning.objectId} has no picture data and was not drawn` }
    : warning);

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
    const render = (element: Element) => svg2pdf(element, pdf, {
      x: 0, y: 0, width: widthPt, height: heightPt, loadExternalStyleSheets: false
    });
    if (pictures.size === 0) {
      await render(svgElement);
    } else {
      // Render contiguous runs in order so pictures retain their stacking relative to other objects.
      // svg2pdf's raster image loader relies on a browser Image and silently skips load failures;
      // jsPDF can embed the PNG bytes directly, including in headless exports.
      const children = [...svgElement.children];
      let run: Element[] = [];
      const flush = async () => {
        if (!run.length) return;
        const part = svgElement.cloneNode(false) as Element;
        for (const child of children) if (child.tagName === "defs" || run.includes(child)) part.appendChild(child.cloneNode(true));
        await render(part);
        run = [];
      };
      for (const child of children) {
        const picture = pictures.get(child.getAttribute("data-object-id") ?? "");
        if (!picture || picture.type !== "graphic" || !picture.data.image) {
          if (child.tagName !== "defs") run.push(child);
          continue;
        }
        await flush();
        if (picture.data.image.mimeType === "image/svg+xml") {
          warnings.push({ code: "export.pdf.svg_picture_not_drawn", severity: "warning", objectId: picture.id,
            message: `PDF export: SVG picture ${picture.id} was not drawn; paste it as PNG or export SVG` });
          continue;
        }
        const scale = Math.min(widthPt / page.width, heightPt / page.height);
        const offsetX = (widthPt - page.width * scale) / 2;
        const offsetY = (heightPt - page.height * scale) / 2;
        const radians = picture.rotation * Math.PI / 180;
        const cos = Math.cos(radians), sin = Math.sin(radians);
        const cx = picture.x + picture.width / 2, cy = picture.y + picture.height / 2;
        pdf.advancedAPI();
        pdf.saveGraphicsState();
        pdf.setCurrentTransformationMatrix(pdf.Matrix(scale * cos, scale * sin, -scale * sin, scale * cos,
          offsetX + scale * (cx - cos * cx + sin * cy), offsetY + scale * (cy - sin * cx - cos * cy)));
        pdf.addImage(`data:image/png;base64,${picture.data.image.dataBase64}`, "PNG", picture.x, picture.y, picture.width, picture.height);
        pdf.restoreGraphicsState();
        pdf.compatAPI();
      }
      await flush();
    }
  } finally {
    releaseHaloPaint();
    releaseFonts();
  }

  return {
    format: "pdf",
    kind: "binary",
    bytes: new Uint8Array(pdf.output("arraybuffer")),
    mimeType: descriptor.mimeType,
    extension: descriptor.extensions[0] ?? "pdf",
    warnings
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
