import {
  CSS_PX_PER_INCH,
  GraphicObjectSchema,
  decodeBase64Bytes,
  validatePngImage,
  type ChemDraftDocument,
  type GraphicObject
} from "@chemdraft/chem-core";
import { GState, jsPDF } from "jspdf";
import { planNativeArtVisual } from "@chemdraft/layout-engine";
import * as svg2pdfModule from "svg2pdf.js";
import { getExportFormatDescriptor } from "./formats";
import type { BinaryExportResult, ExportWarning } from "./results";
import { ensureSvgFontsLoaded, exportDocumentToSvg } from "./svg";
import { jpegPicturePlacement, pdfEmbeddableJpegFrame, readJpegPicture, type JpegOrientation } from "./jpegPicture";
import { preparePdfFonts } from "./pdfFonts";
import { preparePdfHaloPaint } from "./pdfHaloPaint";
import { ensureHandwritingFontLoaded, handwritingFontFaceCss } from "./handwritingFont";

export { pdfEmbeddableJpegFrame } from "./jpegPicture";

const svg2pdf = resolveSvg2pdf(svg2pdfModule);
const SVG_MARKUP_LIMIT_BYTES = 256 * 1024 * 1024;

/** SVG pictures are drawn at 300 dpi of their drawn size, bounded per picture and per document. */
export const SVG_PICTURE_RASTER_DPI = 300;
export const SVG_PICTURE_MAX_RASTER_SIDE = 4096;
export const SVG_PICTURE_MAX_RASTER_PIXELS = 96 * 1024 * 1024;
const SVG_PICTURE_MIN_RASTER_SIDE = 64;

/** One SVG picture to rasterise: the source markup, its frame in page units, and the PNG size to produce. */
export interface SvgPictureRasterRequest {
  svg: string;
  /** Frame size in page units (96 per inch); the picture is stretched to it, as on the canvas. */
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
}

/** Rasterises one SVG picture to PNG bytes, or throws with the reason. Injected: this package has no rasteriser. */
export type SvgPictureRasterizer = (picture: SvgPictureRasterRequest) => Promise<Uint8Array>;

export interface PdfExportOptions {
  directElectronMarkEditing?: boolean;
  pageIndex?: number;
  domParser?: DOMParser;
  compress?: boolean;
  includePageGuides?: boolean;
  outputWidth?: number;
  outputHeight?: number;
  /** Draws SVG pictures; without it (or when it throws) each one is skipped with a warning. */
  rasterizeSvgPicture?: SvgPictureRasterizer;
}

export interface SvgToPdfOptions {
  outputWidth: number;
  outputHeight: number;
  domParser?: DOMParser;
  compress?: boolean;
  pictures?: ReadonlyMap<string, GraphicObject>;
  /** Source page dimensions, required when pictures need physical-size placement. */
  pageSize?: { width: number; height: number };
  rasterizeSvgPicture?: SvgPictureRasterizer;
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
  await ensureSvgFontsLoaded(document, { pageIndex });
  const svgResult = exportDocumentToSvg(document, {
    directElectronMarkEditing: options.directElectronMarkEditing,
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
    pageSize: page,
    rasterizeSvgPicture: options.rasterizeSvgPicture
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
  // Incoming SVG may embed the reviewed face; validate against its exact bytes.
  if (svgMarkup.includes("@font-face") && svgMarkup.includes("Patrick Hand")) await ensureHandwritingFontLoaded();
  const svgElement = parseSvgElement(svgMarkup, options.domParser, pictures);
  const warnings: ExportWarning[] = [];

  const pdf = new jsPDF({
    orientation: widthPt >= heightPt ? "landscape" : "portrait",
    unit: "pt",
    format: [widthPt, heightPt],
    compress: options.compress ?? true
  });

  const releaseFonts = await preparePdfFonts(svgElement, pdf, face => warnings.push({
    code: "export.pdf.patrick_hand_face_unavailable", severity: "warning",
    message: `Patrick Hand ${face === "bolditalic" ? "bold italic" : face} is unavailable; PDF uses the regular face.`
  }));
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
      const rasterCache = new Map<string, Promise<Uint8Array>>();
      const rasterBudget = { pixels: 0 };
      let run: Element[] = [];
      const flush = async () => {
        if (!run.length) return;
        const part = svgElement.cloneNode(false) as Element;
        for (const child of children) if (child.tagName === "defs" || run.includes(child)) part.appendChild(child.cloneNode(true));
        await render(part);
        run = [];
      };
      for (const [childIndex, child] of children.entries()) {
        const picture = pictures.get(child.getAttribute("data-object-id") ?? "");
        if (!picture || picture.type !== "graphic" || !picture.data.image) {
          if (child.tagName !== "defs") run.push(child);
          continue;
        }
        await flush();
        // A kept JPEG is embedded as its own bytes (DCTDecode), turned upright by the placement below.
        const jpeg = pdfJpegPicture(picture.data.image);
        let png: Uint8Array | string = `data:image/png;base64,${picture.data.image.dataBase64}`;
        if (!jpeg && picture.data.image.mimeType === "image/svg+xml") {
          const raster = await rasterizeSvgPicture(picture, options.rasterizeSvgPicture, rasterCache, rasterBudget);
          if ("warning" in raster) { warnings.push(raster.warning); continue; }
          png = raster.png;
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
        const opacity = planNativeArtVisual(picture).opacity;
        if (opacity !== 1) pdf.setGState(new GState({ opacity }));
        pdf.setCurrentTransformationMatrix(pdf.Matrix(scale * cos, scale * sin, -scale * sin, scale * cos,
          offsetX + scale * (cx - cos * cx + sin * cy), offsetY + scale * (cy - sin * cx - cos * cy)));
        const frame = { x: picture.x + (picture.width - width) / 2, y: picture.y + (picture.height - height) / 2, width, height };
        try {
          if (jpeg) {
            // The same placement SVG export writes: the stored box, turned about the frame's centre.
            const placement = jpegPicturePlacement(frame, jpeg.orientation);
            if (placement.matrix) pdf.setCurrentTransformationMatrix(pdf.Matrix(...placement.matrix));
            // An explicit alias, by position: jsPDF's own alias hashes only the first half of the bytes,
            // so two JPEGs alike in that half would otherwise share one image.
            pdf.addImage(jpeg.bytes, "JPEG", placement.box.x, placement.box.y, placement.box.width, placement.box.height,
              `chemdraft-jpeg-${childIndex}`);
          } else {
            pdf.addImage(png, "PNG", frame.x, frame.y, frame.width, frame.height);
          }
        } catch (error) {
          // A PNG jsPDF cannot embed (a bad rasteriser result, or a native PNG with a corrupt data chunk)
          // costs that one picture, not the export.
          warnings.push(jpeg || typeof png === "string"
            ? { code: "export.pdf.picture_not_drawn", severity: "warning", objectId: picture.id,
              message: `PDF export: picture ${picture.id} was not drawn: the ${jpeg ? "JPEG" : "PNG"} could not be embedded (${errorReason(error)})` }
            : svgPictureNotDrawn(picture.id, `the rasterised PNG could not be embedded (${errorReason(error)})`));
        }
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

type SvgPictureRaster = { png: Uint8Array } | { warning: ExportWarning };

/**
 * A kept JPEG picture (`jpegPicture.ts`) whose bytes the PDF can carry as they are, or undefined:
 * such a picture (a malformed inner payload included) is then rasterised like any other SVG picture.
 */
function pdfJpegPicture(image: { mimeType: string; dataBase64: string }): { bytes: Uint8Array; orientation: JpegOrientation } | undefined {
  const jpeg = readJpegPicture(image);
  if (!jpeg) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Bytes(jpeg.jpegBase64);
  } catch {
    return undefined;
  }
  const frame = pdfEmbeddableJpegFrame(bytes);
  return frame && frame.width === jpeg.width && frame.height === jpeg.height ? { bytes, orientation: jpeg.orientation } : undefined;
}

function svgPictureNotDrawn(id: string, reason: string): ExportWarning {
  return { code: "export.pdf.svg_picture_not_drawn", severity: "warning", objectId: id,
    message: `PDF export: SVG picture ${id} was not drawn: ${reason}` };
}

function errorReason(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Pixel size for an SVG picture: 300 dpi of its drawn size, never below the picture's own pixel size,
 * at most 4096 on the long side. Aspect follows the frame, which is how the canvas stretches it.
 */
export function svgPictureRasterSize(picture: { width: number; height: number }, own: { pixelWidth: number; pixelHeight: number }):
  { pixelWidth: number; pixelHeight: number } {
  const perUnit = SVG_PICTURE_RASTER_DPI / CSS_PX_PER_INCH;
  let width = Math.max(picture.width * perUnit, own.pixelWidth);
  let height = Math.max(picture.height * perUnit, own.pixelHeight);
  const shrink = Math.min(1, SVG_PICTURE_MAX_RASTER_SIDE / Math.max(width, height));
  width *= shrink;
  height *= shrink;
  return { pixelWidth: Math.max(1, Math.round(width)), pixelHeight: Math.max(1, Math.round(height)) };
}

async function rasterizeSvgPicture(
  picture: GraphicObject,
  rasterize: SvgPictureRasterizer | undefined,
  cache: Map<string, Promise<Uint8Array>>,
  budget: { pixels: number }
): Promise<SvgPictureRaster> {
  const image = picture.data.image!;
  if (!rasterize) {
    return { warning: svgPictureNotDrawn(picture.id, "no SVG rasteriser is available in this export; export SVG or PNG to keep the picture") };
  }
  let { pixelWidth, pixelHeight } = svgPictureRasterSize(picture, image);
  // Identical pictures at the same size share one raster and one PDF image.
  const key = `${picture.width}x${picture.height}@${pixelWidth}x${pixelHeight}:${image.dataBase64}`;
  let pending = cache.get(key);
  if (!pending) {
    // A document of many pictures shares one pixel budget; later pictures get fewer pixels, not an error.
    const remaining = SVG_PICTURE_MAX_RASTER_PIXELS - budget.pixels;
    const wanted = pixelWidth * pixelHeight;
    if (wanted > remaining) {
      const shrink = Math.sqrt(Math.max(remaining, 0) / wanted);
      if (Math.max(pixelWidth, pixelHeight) * shrink < SVG_PICTURE_MIN_RASTER_SIDE) {
        return { warning: svgPictureNotDrawn(picture.id, "the document has too many SVG pictures to rasterise within the memory limit") };
      }
      pixelWidth = Math.max(1, Math.floor(pixelWidth * shrink));
      pixelHeight = Math.max(1, Math.floor(pixelHeight * shrink));
    }
    const reserved = pixelWidth * pixelHeight;
    budget.pixels += reserved;
    const size = { pixelWidth, pixelHeight };
    const render = async () => {
      const bytes = decodeBase64Bytes(image.dataBase64);
      const result = await rasterize({ svg: new TextDecoder().decode(bytes), width: picture.width, height: picture.height, ...size });
      if (!ArrayBuffer.isView(result)) throw new Error("the rasteriser did not return PNG bytes");
      const png = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
      const { info, error } = validatePngImage(png);
      if (error) throw new Error(`the rasteriser returned an invalid PNG (${error.replace(/^Couldn't paste the picture: /, "")})`);
      if (Math.max(info!.pixelWidth, info!.pixelHeight) > SVG_PICTURE_MAX_RASTER_SIDE) {
        throw new Error(`the rasteriser returned a ${info!.pixelWidth} x ${info!.pixelHeight} PNG; the limit is ${SVG_PICTURE_MAX_RASTER_SIDE} pixels on a side`);
      }
      return png;
    };
    // A picture that fails to rasterise gives its pixels back, once: later duplicates reuse this
    // rejected promise and so never refund again.
    pending = render().catch((error: unknown) => {
      budget.pixels -= reserved;
      throw error;
    });
    cache.set(key, pending);
  }
  try {
    return { png: await pending };
  } catch (error) {
    return { warning: svgPictureNotDrawn(picture.id, errorReason(error)) };
  }
}

function cssPxToPdfPt(value: number): number {
  return value / CSS_PX_PER_INCH * 72;
}

function parseSvgElement(svg: string, domParser: DOMParser | undefined, pictures: ReadonlyMap<string, GraphicObject>): Element {
  const pictureHrefs = new Map<string, string>();
  let pictureByteAllowance = 0;
  for (const [id, picture] of pictures) {
    const result = GraphicObjectSchema.safeParse(picture);
    if (!result.success) throw new Error(`Cannot export PDF: ${result.error.issues[0]!.message}`);
    const image = result.data.graphicKind === "image" ? result.data.data.image : undefined;
    if (!image) continue;
    // SVG export writes a kept JPEG as the JPEG itself.
    const jpeg = readJpegPicture(image);
    const href = jpeg ? `data:image/jpeg;base64,${jpeg.jpegBase64}` : `data:${image.mimeType};base64,${image.dataBase64}`;
    pictureHrefs.set(id, href);
    pictureByteAllowance += href.length;
  }
  // Bound parser input by markup plus validated pictures. Only references actually belonging
  // to those pictures are deducted from the markup budget after parsing.
  let markupBytes = assertBoundedSvg(svg, pictureByteAllowance);
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
    if (++nodes > 1_000_000 || depth > 256) throw new Error("Cannot export PDF: SVG complexity limit exceeded.");
    if (node.nodeType === 1) {
      const element = node as Element;
      if (["a", "script", "foreignobject", "use"].includes(element.localName.toLowerCase())) {
        throw new Error("Cannot export PDF: active SVG content is not allowed.");
      }
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.localName.toLowerCase();
        if (name === "href" && isMappedPictureHref(element, attribute.value, parsed.documentElement, pictureHrefs)) {
          // Picture data URIs are ASCII; all surrounding SVG syntax still counts as markup.
          markupBytes -= attribute.value.length;
        }
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
      if (element.localName === "style") {
        const css = element.textContent ?? "";
        assertLocalSvgCss(css);
        // preparePdfFonts registers this face in jsPDF and browser measurement APIs.
        // svg2pdf need not parse its @font-face (nor access CSSStyleSheet in headless DOMs).
        const bundledCss = handwritingFontFaceCss();
        if (bundledCss && css.includes(bundledCss)) {
          element.textContent = css.split(bundledCss).join("");
          if (!element.textContent.trim()) element.remove();
        }
      }
    }
    for (let child = node.lastChild; child; child = child.previousSibling) pending.push({ node: child, depth: depth + 1 });
  }

  if (markupBytes > SVG_MARKUP_LIMIT_BYTES) throw new Error("Cannot export PDF: SVG exceeds 256 MB.");
  return parsed.documentElement;
}

function isMappedPictureHref(element: Element, href: string, svgRoot: Element, pictureHrefs: ReadonlyMap<string, string>): boolean {
  if (element.localName !== "image" || element.parentElement?.parentElement !== svgRoot) return false;
  return pictureHrefs.get(element.parentElement.getAttribute("data-object-id") ?? "") === href;
}

/** These images are skipped with a warning by the picture renderer, never handed to svg2pdf. */
function isMappedSvgPicture(element: Element, href: string, svgRoot: Element, pictures: ReadonlyMap<string, GraphicObject>): boolean {
  if (element.localName !== "image" || element.parentElement?.parentElement !== svgRoot) return false;
  const object = pictures.get(element.parentElement?.getAttribute("data-object-id") ?? "");
  const image = object?.data.image;
  return image?.mimeType === "image/svg+xml" && href === `data:image/svg+xml;base64,${image.dataBase64}`;
}

function assertLocalSvgCss(value: string): void {
  // Recognize only the exact bundled face, never arbitrary data URLs or external fonts.
  const bundledCss = handwritingFontFaceCss();
  const localCss = bundledCss ? value.split(bundledCss).join("") : value;
  const decoded = localCss.replace(/\\(?:\r\n|[\n\r\f])|\\([0-9a-f]{1,6})[ \t\r\n\f]?|\\([\s\S])/gi,
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

function assertBoundedSvg(svg: string, pictureByteAllowance: number): number {
  const limit = SVG_MARKUP_LIMIT_BYTES + pictureByteAllowance;
  if (typeof svg !== "string" || svg.length > limit) throw new Error("Cannot export PDF: SVG exceeds 256 MB.");
  let bytes = 0;
  for (const character of svg) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > limit) throw new Error("Cannot export PDF: SVG exceeds 256 MB.");
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
      if (nodes > 1_000_000 || depth > 256) throw new Error("Cannot export PDF: SVG complexity limit exceeded.");
      if (source[offset - 1] === "/") depth -= 1;
    }
    if (depth < 0) throw new Error("Cannot export PDF: generated SVG could not be parsed.");
  }
  if (depth !== 0) throw new Error("Cannot export PDF: generated SVG could not be parsed.");
  return bytes;
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
