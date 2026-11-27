import { readPngInfo } from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import { apngFirstFrameHref, FLATTEN_MAX_PIXELS, FLATTEN_MAX_SIDE, renderBounded, xml } from "./svgPictureRaster";

/**
 * Ordinary raster (PNG) pictures in a headless PNG export. resvg decodes every picture the exported SVG
 * embeds at the picture's own pixel size, and one picture may decode to 256 MiB, so all of them together are
 * held to one decoded-pixel budget, the same 64 Mi pixels the SVG picture flattening allows. Over budget,
 * the largest pictures are downsampled first (aspect kept, never below the size the output draws them at
 * while that fits) until all of them fit, and one warning names every picture downsampled and its new size:
 * pictures are shrunk, never failed or left out. An animated PNG is drawn at its first animation frame.
 */

/** Decoded pixels of every ordinary raster picture in one headless PNG export together. */
export const RASTER_PICTURE_MAX_PIXELS = FLATTEN_MAX_PIXELS;
/** A downsampled picture is at most this many pixels on a side, the resvg pixmap bound. */
export const RASTER_PICTURE_MAX_SIDE = FLATTEN_MAX_SIDE;

const SVG_NS = "http://www.w3.org/2000/svg";
const PNG_HREF = /^\s*data:image\/png;base64,/i;

export interface RasterPictureSize {
  /** The picture's own pixel size. */
  pixelWidth: number;
  pixelHeight: number;
  /** The size the output draws it at, in output pixels. */
  drawnWidth: number;
  drawnHeight: number;
}

/**
 * The pixel size each picture is drawn from so all of them together stay within `budgetPixels`: its own
 * size when everything fits. Otherwise a cap on pixels per picture is lowered until the total fits, so
 * the largest pictures shrink first; no picture goes below what covers its drawn size unless even those
 * sizes do not fit together, and then the cap applies to every picture alike. The cap is the largest whole
 * number of pixels whose sized total fits. A shrunk picture keeps its aspect (to whole pixels), is the
 * largest such size within its cap, at most `maxSide` on a side and at least one pixel; when even one pixel
 * each does not fit, every picture is one pixel.
 */
export function rasterPictureBudget(pictures: readonly RasterPictureSize[], budgetPixels = RASTER_PICTURE_MAX_PIXELS,
  maxSide = RASTER_PICTURE_MAX_SIDE): { pixelWidth: number; pixelHeight: number }[] {
  const own = pictures.map(({ pixelWidth, pixelHeight }) => ({ pixelWidth, pixelHeight }));
  if (own.reduce((total, size) => total + size.pixelWidth * size.pixelHeight, 0) <= budgetPixels) return own;
  // The pixels that cover a picture's drawn frame at its own aspect, never more than its own.
  const floors = pictures.map((picture) => {
    const cover = Math.min(1, Math.max(picture.drawnWidth / picture.pixelWidth, picture.drawnHeight / picture.pixelHeight));
    return Number.isFinite(cover) && cover > 0 ? picture.pixelWidth * picture.pixelHeight * cover * cover : 0;
  });
  // A picture with its longer side `long` pixels, the shorter one in proportion (whole pixels, at least one).
  const withLongSide = (picture: RasterPictureSize, long: number) => {
    const wide = picture.pixelWidth >= picture.pixelHeight;
    const short = Math.max(1, Math.floor((wide ? picture.pixelHeight : picture.pixelWidth) * long / (wide ? picture.pixelWidth : picture.pixelHeight)));
    return wide ? { pixelWidth: long, pixelHeight: short } : { pixelWidth: short, pixelHeight: long };
  };
  const sized = (cap: number, keepFloors: boolean) => pictures.map((picture, index) => {
    const pixels = picture.pixelWidth * picture.pixelHeight;
    const allowed = Math.min(pixels, Math.max(cap, keepFloors ? floors[index]! : 0));
    if (allowed >= pixels) return own[index]!;
    // The longest longer side, at least one pixel, whose size stays within `allowed`; the size only grows with it.
    let low = 1, high = Math.max(1, Math.min(Math.max(picture.pixelWidth, picture.pixelHeight), maxSide));
    while (low < high) {
      const middle = low + Math.ceil((high - low) / 2);
      const size = withLongSide(picture, middle);
      if (size.pixelWidth * size.pixelHeight <= allowed) low = middle;
      else high = middle - 1;
    }
    return withLongSide(picture, low);
  });
  const total = (sizes: readonly { pixelWidth: number; pixelHeight: number }[]) =>
    sizes.reduce((sum, size) => sum + size.pixelWidth * size.pixelHeight, 0);
  const keepFloors = total(sized(0, true)) <= budgetPixels;
  // The largest whole-pixel cap that fits; the total only grows with the cap, and at the largest picture's own
  // pixels it is every picture's own size, which does not fit.
  let low = 0, high = Math.max(...pictures.map((picture) => picture.pixelWidth * picture.pixelHeight));
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    if (total(sized(middle, keepFloors)) <= budgetPixels) low = middle;
    else high = middle - 1;
  }
  return sized(low, keepFloors);
}

/**
 * Draw every PNG picture in an exported document SVG at its first animation frame and within the
 * aggregate budget, downsampling with resvg where needed. `pixelsPerUnit`: output pixels per user unit of
 * the SVG. Returns the SVG unchanged (the same string) when nothing needs to change. Run it before
 * `flattenSvgPictures`, whose own budget covers the SVG pictures.
 */
export async function fitRasterPictures(svg: string, pixelsPerUnit: number, warnings: ExportWarning[],
  budgetPixels = RASTER_PICTURE_MAX_PIXELS): Promise<string> {
  if (!/data:image\/png;base64,/i.test(svg)) return svg;
  const { parser, serializer } = await xml();
  const parsed = parser.parseFromString(svg, "image/svg+xml");
  if (parsed.getElementsByTagName("parsererror").length) throw new Error("the exported SVG could not be read to draw its pictures");
  const pictures: { id: string; href: Attr; size: RasterPictureSize }[] = [];
  let changed = false;
  const frames = new Map<string, ReturnType<typeof apngFirstFrameHref>>();
  for (const image of Array.from(parsed.getElementsByTagNameNS(SVG_NS, "image"))) {
    const hrefs = Array.from(image.attributes).filter((attribute) => attribute.localName === "href");
    if (hrefs.length !== 1 || !PNG_HREF.test(hrefs[0]!.value)) continue;
    const href = hrefs[0]!;
    const id = image.parentElement?.getAttribute("data-object-id") ?? "";
    // Each picture's data is read once, however many images draw it.
    let frame = frames.get(href.value);
    if (!frame) { frame = apngFirstFrameHref(href.value); frames.set(href.value, frame); }
    if (frame.href) { href.value = frame.href; changed = true; }
    if (frame.warning) warnings.push({ code: "export.png.apng_default_image", severity: "warning", ...(id ? { objectId: id } : {}),
      message: `PNG export: picture${id ? ` ${id}` : ""}: ${frame.warning}` });
    const info = readPngInfo(frame.bytes ?? new Uint8Array(Buffer.from(href.value.replace(PNG_HREF, ""), "base64")));
    if (!info) continue;
    const drawnWidth = Number(image.getAttribute("width")) * pixelsPerUnit, drawnHeight = Number(image.getAttribute("height")) * pixelsPerUnit;
    pictures.push({ id, href, size: { pixelWidth: info.pixelWidth, pixelHeight: info.pixelHeight,
      drawnWidth: Number.isFinite(drawnWidth) ? drawnWidth : 0, drawnHeight: Number.isFinite(drawnHeight) ? drawnHeight : 0 } });
  }
  const sizes = rasterPictureBudget(pictures.map((picture) => picture.size), budgetPixels);
  const shrunk: string[] = [];
  const done = new Map<string, string>();
  for (const [index, picture] of pictures.entries()) {
    const { pixelWidth, pixelHeight } = sizes[index]!;
    if (pixelWidth === picture.size.pixelWidth && pixelHeight === picture.size.pixelHeight) continue;
    const key = `${pixelWidth}x${pixelHeight}:${picture.href.value}`;
    let href = done.get(key);
    if (!href) {
      // Stretch the whole picture onto the smaller pixmap; its aspect is already the picture's own.
      const wrapper = `<svg xmlns="${SVG_NS}" width="${pixelWidth}" height="${pixelHeight}" viewBox="0 0 ${pixelWidth} ${pixelHeight}">` +
        `<image x="0" y="0" width="${pixelWidth}" height="${pixelHeight}" preserveAspectRatio="none" href="${picture.href.value}"/></svg>`;
      try {
        href = `data:image/png;base64,${renderBounded(wrapper, { font: { loadSystemFonts: false } }).toString("base64")}`;
      } catch (error) {
        throw new Error(`picture ${picture.id || "(unnamed)"} could not be downsampled to fit the picture budget: ${error instanceof Error ? error.message : String(error)}`);
      }
      done.set(key, href);
    }
    picture.href.value = href;
    changed = true;
    shrunk.push(`picture ${picture.id || "(unnamed)"} from ${picture.size.pixelWidth} x ${picture.size.pixelHeight} to ${pixelWidth} x ${pixelHeight} pixels`);
  }
  if (shrunk.length) warnings.push({ code: "export.png.pictures_downsampled", severity: "warning",
    message: `PNG export: ${shrunk.length === 1 ? "1 picture was" : `${shrunk.length} pictures were`} downsampled so all pictures fit the ` +
      `${budgetPixels / (1024 * 1024)} Mi-pixel picture budget: ${shrunk.join("; ")}.` });
  return changed ? serializer.serializeToString(parsed) : svg;
}
