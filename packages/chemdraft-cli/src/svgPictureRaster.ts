import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
import { apngFirstFrame, readSvgInfo, type ChemDraftDocument } from "@chemdraft/chem-core";
import {
  parseSvgLength, pictureSizeLimitError, sanitizeSvgPicture, type ExportWarning, type SanitizedSvg
} from "@chemdraft/export-engine";
import type { SvgPictureRasterRequest } from "@chemdraft/export-engine/pdf";

/**
 * The headless `rasterizeSvgPicture` hook for PDF export, and the picture flattening for PNG export: the
 * same stretched-to-frame drawing the canvas does, rendered by resvg. The picture is untrusted, and
 * @resvg/resvg-js 2.6 has no switch for its default resolver (no resolver, resourcesDir or
 * resolve-nothing option; `imagesToResolve()` stays empty even for a path it then reads), so resvg would
 * read a path that an `href` names. Nothing reaches resvg until the shared SVG safety check
 * (`@chemdraft/export-engine`, the one the desktop drop uses) has read it: under its refusing policy a
 * picture that refers to anything outside itself is not drawn at all, bitmaps are checked by their
 * bytes and sizes before any Resvg is built, and what resvg draws is the serialisation of what was
 * checked. Every pixmap resvg is asked for is bounded on both sides and in total, whatever the picture's
 * own size or aspect: the picture's size is read and checked before any Resvg is built, and its root is
 * given the exact pixel size to render at.
 */

/** Every pixmap resvg draws here, the intermediate render and the stretch to the frame, stays within this a side. */
const MAX_RENDER_SIDE = 8192;
/** PNG flattening: the longest side of one flattened picture. */
export const FLATTEN_MAX_SIDE = 8192;
/** PNG flattening: decoded pixels of every flattened picture in one export together. */
export const FLATTEN_MAX_PIXELS = 64 * 1024 * 1024;
/** A picture the remaining budget would shrink below this longest side is not drawn; as in the PDF export. */
const FLATTEN_MIN_SIDE = 64;
const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_DATA = /^\s*data:image\/svg\+xml[;,]/i;

interface Xml { parser: DOMParser; serializer: XMLSerializer }
let xmlTools: Promise<Xml> | undefined;
/** jsdom's XML parser, as the PDF export uses; its own window, so no globals are touched. */
export function xml(): Promise<Xml> {
  xmlTools ??= import("jsdom").then(({ JSDOM }) => {
    const { window } = new JSDOM("<!doctype html><html><body></body></html>");
    return { parser: new window.DOMParser() as unknown as DOMParser, serializer: new window.XMLSerializer() as unknown as XMLSerializer };
  });
  return xmlTools;
}

/** The shared safety check, refusing what reaches outside the picture; throws with the reason. */
export async function sanitizeSvgForResvg(source: string): Promise<SanitizedSvg> {
  const { parser, serializer } = await xml();
  const result = sanitizeSvgPicture(source, { domParser: parser, xmlSerializer: serializer, outsideReferences: "refuse" });
  if (!result.ok) throw new Error(result.error.replace(/\.$/, ""));
  return result;
}

export async function rasterizeSvgPictureWithResvg(request: SvgPictureRasterRequest): Promise<Uint8Array> {
  const { pixelWidth, pixelHeight } = request;
  if (pixmapSizeError(pixelWidth, pixelHeight)) throw new Error(`the requested raster size ${pixelWidth} x ${pixelHeight} is not usable`);
  const { svg } = await sanitizeSvgForResvg(request.svg);
  // resvg-js does not draw an image nested inside an SVG that is itself nested as an image, so render the
  // picture directly, at its own aspect and large enough to cover the frame on both axes...
  const rendered = renderBounded(await sizedSvg(svg, pixelWidth, pixelHeight));
  // ...then stretch that to the frame (preserveAspectRatio="none"), as the canvas does.
  const href = `data:image/png;base64,${Buffer.from(rendered).toString("base64")}`;
  const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}" viewBox="0 0 ${pixelWidth} ${pixelHeight}">` +
    `<image x="0" y="0" width="${pixelWidth}" height="${pixelHeight}" preserveAspectRatio="none" href="${href}"/></svg>`;
  return new Uint8Array(renderBounded(wrapper));
}

const PNG_DATA = /^\s*data:image\/png;base64,([A-Za-z0-9+/=\s]*)$/i;

/**
 * The `href` to draw for a PNG data URI, from the shared `apngFirstFrame`: an animated PNG's first animation
 * frame, or the default image alone of one whose first frame can't be read; undefined to keep `href` as it is
 * (a still PNG, a default image that is the first frame, or not a PNG data URI). `warning` says why an
 * animated PNG's default image is drawn instead of its first frame.
 */
export function apngFirstFrameHref(href: string): { href?: string; warning?: string } {
  const base64 = PNG_DATA.exec(href)?.[1];
  if (base64 === undefined) return {};
  const bytes = new Uint8Array(Buffer.from(base64.replace(/\s+/g, ""), "base64"));
  const frame = apngFirstFrame(bytes);
  return { ...(frame.bytes !== bytes ? { href: `data:image/png;base64,${Buffer.from(frame.bytes).toString("base64")}` } : {}),
    ...(frame.warning ? { warning: frame.warning } : {}) };
}

/** Why a pixmap of this size is not drawn, or undefined: at most `MAX_RENDER_SIDE` a side and within the shared decoded limit. */
function pixmapSizeError(width: number, height: number): string | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return `it is ${width} × ${height} pixels`;
  if (width > MAX_RENDER_SIDE || height > MAX_RENDER_SIDE) return `it is ${width} × ${height} pixels; the limit is ${MAX_RENDER_SIDE} pixels on a side`;
  return pictureSizeLimitError(width, height)?.replace(/\.$/, "");
}

/** Render an SVG whose root size is the pixmap wanted, refusing before the pixmap exists if that size is out of bounds. */
export function renderBounded(svg: string, options?: ResvgRenderOptions): Buffer {
  const resvg = new Resvg(svg, options);
  const width = Math.ceil(resvg.width), height = Math.ceil(resvg.height);
  const error = pixmapSizeError(width, height);
  if (error) throw new Error(`the picture would render too large: ${error}`);
  return resvg.render().asPng();
}

/**
 * The sanitised picture with its root sized to the exact pixmap to draw: its intrinsic aspect, covering
 * `pixelWidth` x `pixelHeight` where the side limit allows, at most `MAX_RENDER_SIDE` on either side (a side
 * the aspect makes thinner than a pixel is drawn one pixel wide). The intrinsic size is the one the drop and
 * the desktop rasteriser read; a root width or height that is zero, negative or not finite, or an intrinsic
 * size the paste caps refuse, is refused. The root's viewBox is kept; one with no viewBox gets one from its
 * intrinsic size, so resizing it scales rather than crops.
 */
async function sizedSvg(svg: string, pixelWidth: number, pixelHeight: number): Promise<string> {
  const { parser, serializer } = await xml();
  const parsed = parser.parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.localName !== "svg" || parsed.getElementsByTagName("parsererror").length) throw new Error("the SVG could not be read");
  for (const name of ["width", "height"]) {
    const value = root.getAttribute(name);
    const length = value === null ? undefined : parseSvgLength(value);
    if (length && !(Number.isFinite(length.value) && length.value > 0)) throw new Error(`the SVG's ${name} "${value}" is not a usable size`);
  }
  const info = readSvgInfo(svg);
  const width = info?.physicalSize?.width ?? NaN, height = info?.physicalSize?.height ?? NaN;
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) throw new Error("the SVG's size can't be read");
  const limit = pictureSizeLimitError(info!.pixelWidth, info!.pixelHeight);
  if (limit) throw new Error(limit.replace(/\.$/, ""));
  const scale = Math.min(Math.max(pixelWidth / width, pixelHeight / height), MAX_RENDER_SIDE / Math.max(width, height));
  const renderSide = (side: number) => Math.min(MAX_RENDER_SIDE, Math.max(1, Math.round(side * scale)));
  // An embedded animated PNG is drawn at its first animation frame, as native pictures are.
  for (const image of Array.from(parsed.getElementsByTagNameNS(SVG_NS, "image"))) {
    for (const attribute of Array.from(image.attributes)) {
      if (attribute.localName !== "href") continue;
      const frame = apngFirstFrameHref(attribute.value);
      if (frame.href) attribute.value = frame.href;
    }
  }
  if (!root.hasAttribute("viewBox")) root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  root.setAttribute("width", String(renderSide(width)));
  root.setAttribute("height", String(renderSide(height)));
  return serializer.serializeToString(parsed);
}

/**
 * resvg-js draws PNG, JPEG and GIF bitmaps only: a WebP an SVG picture embeds is left out. One warning
 * per such picture on the rendered (first) page, so the loss is never silent. Only a picture that was
 * drawn gets it: one the check refused, or that the export could not draw (`exportWarnings`, the
 * export's own warnings, already say it "was not drawn"), gets that warning alone. An embedded animated
 * PNG whose first frame can't be read gets a warning too: its default image is drawn instead.
 */
export async function headlessSvgPictureWarnings(
  document: ChemDraftDocument, format: "png" | "pdf", exportWarnings: readonly ExportWarning[]
): Promise<ExportWarning[]> {
  const notDrawn = `export.${format}.svg_picture_not_drawn`;
  const undrawn = new Set(exportWarnings.filter((warning) => warning.code === notDrawn).map((warning) => warning.objectId));
  const warnings: ExportWarning[] = [];
  for (const object of document.pages[0]?.objects ?? []) {
    const image = object.type === "graphic" ? object.data.image : undefined;
    if (!image || image.mimeType !== "image/svg+xml" || undrawn.has(object.id)) continue;
    let sanitized: SanitizedSvg;
    try {
      sanitized = await sanitizeSvgForResvg(Buffer.from(image.dataBase64, "base64").toString("utf8"));
    } catch {
      continue;
    }
    for (const bitmap of sanitized.embeddedBitmaps) {
      const warning = bitmap.format === "png" ? apngFirstFrame(bitmap.bytes).warning : undefined;
      if (warning) warnings.push({ code: `export.${format}.svg_picture_apng_default_image`, severity: "warning", objectId: object.id,
        message: `${format.toUpperCase()} export: SVG picture ${object.id}: ${warning}` });
    }
    if (!sanitized.embeddedBitmaps.some((bitmap) => bitmap.format === "webp")) continue;
    warnings.push({ code: `export.${format}.svg_picture_bitmap_not_drawn`, severity: "warning", objectId: object.id,
      message: `${format.toUpperCase()} export: SVG picture ${object.id} embeds a WebP bitmap, which headless export can't draw; the rest of the picture is drawn.` });
  }
  return warnings;
}

/** The id of the exported object an element belongs to: its nearest `data-object-id` ancestor. */
function owningObjectId(element: Element): string | undefined {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const id = node.getAttribute("data-object-id");
    if (id) return id;
  }
  return undefined;
}

/**
 * Replace every nested SVG picture in an exported document SVG with the PNG the headless rasteriser makes
 * of it. resvg draws no bitmap inside an SVG nested as an image, and it must never be handed the nested
 * source at all. Each picture is rasterised at the size the output draws it (`pixelsPerUnit`: output pixels
 * per user unit of the SVG), at most `FLATTEN_MAX_SIDE` a side, and all of them together within
 * `FLATTEN_MAX_PIXELS`: later pictures are shrunk to what is left, not failed. A picture that is refused,
 * fails or gets too few pixels is removed with a warning naming its object, not allowed to fail the PNG.
 */
export async function flattenSvgPictures(svg: string, pixelsPerUnit: number, warnings: ExportWarning[], budgetPixels = FLATTEN_MAX_PIXELS): Promise<string> {
  if (!/data:image\/svg\+xml/i.test(svg)) return svg;
  const { parser, serializer } = await xml();
  const parsed = parser.parseFromString(svg, "image/svg+xml");
  if (parsed.getElementsByTagName("parsererror").length) throw new Error("the exported SVG could not be read to draw its pictures");
  const done = new Map<string, Promise<string>>();
  let remainingPixels = budgetPixels;
  for (const image of Array.from(parsed.getElementsByTagNameNS(SVG_NS, "image"))) {
    const hrefs = Array.from(image.attributes).filter((attribute) => attribute.localName === "href");
    if (!hrefs.some((attribute) => SVG_DATA.test(attribute.value))) continue;
    const id = owningObjectId(image);
    let charged = 0;
    try {
      const base64 = hrefs.length === 1 ? /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]*)$/i.exec(hrefs[0]!.value)?.[1] : undefined;
      const width = Number(image.getAttribute("width")), height = Number(image.getAttribute("height"));
      let pixelWidth = width * pixelsPerUnit, pixelHeight = height * pixelsPerUnit;
      // A frame of 1e309 reads as Infinity, and one Infinity or NaN here would poison the budget of every later picture.
      if (base64 === undefined || !(width > 0) || !(height > 0) || !(Number.isFinite(pixelWidth) && pixelWidth > 0)
        || !(Number.isFinite(pixelHeight) && pixelHeight > 0)) throw new Error("the picture's data or frame can't be read");
      const fitSide = Math.min(1, FLATTEN_MAX_SIDE / Math.max(pixelWidth, pixelHeight));
      pixelWidth *= fitSide;
      pixelHeight *= fitSide;
      const fitBudget = Math.min(1, Math.sqrt(Math.max(remainingPixels, 0) / (pixelWidth * pixelHeight)));
      pixelWidth = Math.min(FLATTEN_MAX_SIDE, Math.max(1, Math.floor(pixelWidth * fitBudget)));
      pixelHeight = Math.min(FLATTEN_MAX_SIDE, Math.max(1, Math.floor(pixelHeight * fitBudget)));
      // A short side raised to its one-pixel minimum leaves the long side only what the budget has left.
      if (pixelWidth * pixelHeight > remainingPixels) {
        if (pixelWidth <= pixelHeight) pixelHeight = Math.floor(remainingPixels / pixelWidth);
        else pixelWidth = Math.floor(remainingPixels / pixelHeight);
      }
      if (pixelWidth < 1 || pixelHeight < 1 || (fitBudget < 1 && Math.max(pixelWidth, pixelHeight) < FLATTEN_MIN_SIDE)) {
        throw new Error("the document has too many SVG pictures to draw within the memory limit");
      }
      // The final PNG decodes every picture on its own, so each one is charged, shared raster or not.
      charged = pixelWidth * pixelHeight;
      remainingPixels -= charged;
      const key = `${pixelWidth}x${pixelHeight}:${base64}`;
      let png = done.get(key);
      if (!png) {
        png = rasterizeSvgPictureWithResvg({ svg: Buffer.from(base64, "base64").toString("utf8"), width, height, pixelWidth, pixelHeight })
          .then((bytes) => Buffer.from(bytes).toString("base64"));
        done.set(key, png);
      }
      hrefs[0]!.value = `data:image/png;base64,${await png}`;
    } catch (error) {
      // Nothing is drawn for it, so it costs nothing.
      remainingPixels += charged;
      image.remove();
      warnings.push({ code: "export.png.svg_picture_not_drawn", severity: "warning", ...(id ? { objectId: id } : {}),
        message: `PNG export: SVG picture${id ? ` ${id}` : ""} was not drawn: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return serializer.serializeToString(parsed);
}
