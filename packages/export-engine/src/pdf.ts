import {
  CSS_PX_PER_INCH,
  type ChemDraftDocument,
  type GraphicObject
} from "@chemdraft/chem-core";
import { jsPDF } from "jspdf";
import * as svg2pdfModule from "svg2pdf.js";
import { getExportFormatDescriptor } from "./formats";
import type { BinaryExportResult, ExportWarning } from "./results";
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

export interface SvgToPdfOptions {
  outputWidth: number;
  outputHeight: number;
  domParser?: DOMParser;
  compress?: boolean;
  pictures?: ReadonlyMap<string, GraphicObject>;
  /** Source page dimensions, required when pictures need physical-size placement. */
  pageSize?: { width: number; height: number };
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
  const pictures = new Map(page.objects.filter((object): object is GraphicObject =>
    object.type === "graphic" && object.graphicKind === "image" && !!object.data.image)
    .map((object) => [object.id, object]));
  const { bytes, warnings: pictureWarnings } = await exportSvgToPdf(svgResult.contents, {
    outputWidth: options.outputWidth ?? page.width,
    outputHeight: options.outputHeight ?? page.height,
    domParser: options.domParser,
    compress: options.compress,
    pictures,
    pageSize: page
  });
  const warnings = svgResult.warnings.map((warning) => warning.code === "export.svg.picture_missing_data"
    ? { ...warning, code: "export.pdf.picture_missing_data", message: `PDF export: picture ${warning.objectId} has no picture data and was not drawn` }
    : warning);

  return {
    format: "pdf",
    kind: "binary",
    bytes,
    mimeType: descriptor.mimeType,
    extension: descriptor.extensions[0] ?? "pdf",
    warnings: [...warnings, ...pictureWarnings]
  };
}

export async function exportSvgToPdf(
  svgMarkup: string,
  options: SvgToPdfOptions
): Promise<{ bytes: Uint8Array; warnings: ExportWarning[] }> {
  if (![options.outputWidth, options.outputHeight].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Cannot export PDF: output dimensions must be finite positive numbers.");
  }
  const widthPt = cssPxToPdfPt(options.outputWidth);
  const heightPt = cssPxToPdfPt(options.outputHeight);
  if (Math.max(widthPt, heightPt) > 14400) {
    throw new Error("Cannot export PDF: physical page size exceeds 14400 points (200 inches) per side. Reduce the pixel dimensions or increase DPI.");
  }
  const pictures = options.pictures ?? new Map<string, GraphicObject>();
  const page = options.pageSize;
  if (pictures.size > 0 && (!page || ![page.width, page.height].every((value) => Number.isFinite(value) && value > 0))) {
    throw new Error("Cannot export PDF: pictures require finite positive source page dimensions.");
  }
  const svgElement = parseSvgElement(svgMarkup, options.domParser, pictures);
  const warnings: ExportWarning[] = [];

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
    if (pictures.size === 0 || !page) {
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
        const pictureScale = cssPxToPdfPt(1) / scale;
        const width = picture.width * pictureScale;
        const height = picture.height * pictureScale;
        pdf.advancedAPI();
        pdf.saveGraphicsState();
        pdf.setCurrentTransformationMatrix(pdf.Matrix(scale * cos, scale * sin, -scale * sin, scale * cos,
          offsetX + scale * (cx - cos * cx + sin * cy), offsetY + scale * (cy - sin * cx - cos * cy)));
        pdf.addImage(`data:image/png;base64,${picture.data.image.dataBase64}`, "PNG",
          picture.x + (picture.width - width) / 2, picture.y + (picture.height - height) / 2, width, height);
        pdf.restoreGraphicsState();
        pdf.compatAPI();
      }
      await flush();
    }
  } finally {
    releaseHaloPaint();
    releaseFonts();
  }

  return { bytes: new Uint8Array(pdf.output("arraybuffer")), warnings };
}

function cssPxToPdfPt(value: number): number {
  return value / CSS_PX_PER_INCH * 72;
}

function parseSvgElement(svg: string, domParser: DOMParser | undefined, pictures: ReadonlyMap<string, GraphicObject>): Element {
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
            !(element.localName === "image" && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(attribute.value)) &&
            !isMappedSvgPicture(element, attribute.value, parsed.documentElement, pictures)) {
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

/** These images are skipped with a warning by the picture renderer, never handed to svg2pdf. */
function isMappedSvgPicture(element: Element, href: string, svgRoot: Element, pictures: ReadonlyMap<string, GraphicObject>): boolean {
  if (element.localName !== "image" || element.parentElement?.parentElement !== svgRoot) return false;
  const object = pictures.get(element.parentElement?.getAttribute("data-object-id") ?? "");
  const image = object?.data.image;
  return image?.mimeType === "image/svg+xml" && href === `data:image/svg+xml;base64,${image.dataBase64}`;
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
