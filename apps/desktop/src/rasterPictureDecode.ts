/**
 * PNG and JPEG pictures for native raster export (PNG, JPEG, BMP, GIF, TIFF, Copy as PNG, plugin renders).
 *
 * The native renderer has no bitmap decoder, by design: pictures are decoded HERE, by the webview's
 * own image decoder (WKWebView on macOS, WebView2 on Windows), and Rust receives straight-alpha
 * RGBA8 pixels it checks by length alone (`export.rs`). Each decoded picture's `<image>` keeps its
 * frame, transform and z-order in the SVG; only its href becomes a blank SVG of the picture's pixel
 * size, tagged with an id, so usvg still places it and native code draws the supplied pixels there.
 * The blank SVG holds one invisible path carrying the same id: usvg drops the `<image>`'s id on a
 * copy made through `<use>` or `<feImage>`, but parses each copy's href afresh, so the copy still
 * names its picture and Rust can report exactly which pictures have copies it could not draw.
 *
 * SVG pictures that embed a bitmap become PNGs here: `svgPicture/rasterEmbeddedBitmaps.ts` rasterises
 * each one as this pass reaches it (`beforeDecode`), so they take the same path and the same budget.
 * Pure-vector SVG pictures draw natively. A dropped JPEG kept as its own bytes reaches this pass as a
 * JPEG `<image>` (SVG export unwraps it, `export-engine/jpegPicture.ts`) and is decoded like a PNG;
 * the transform that turns it upright stays on its `<image>`.
 *
 * Limits, enforced before decoding and re-checked in Rust: 16384 px a side, 256 MiB of decoded
 * pixels (width × height × 4) across one export call, and 1024 pictures per call. A picture over a
 * limit, or one that fails to decode, is not drawn; Rust reports it with a warning naming the reason.
 * Pictures past the 1024th are neither decoded nor sent: their href becomes a marked empty SVG that
 * Rust counts for its warning.
 *
 * Memory: pictures are processed one at a time; each ImageBitmap and canvas is released as soon as
 * its pixels are read back, and each picture's RGBA is dropped once it is base64-encoded.
 */

import { readRasterHeaderSize } from "@chemdraft/export-engine";

export const RasterPictureMaxSidePx = 16384;
export const RasterPictureDecodedBudgetBytes = 256 * 1024 * 1024;
/** Pictures sent per export call; `MAX_PICTURES` in `export/pictures.rs` is the same. */
export const RasterPictureMaxCount = 1024;
/** The stand-in for a picture past the count limit; `OVER_COUNT_HREF` in Rust is the same string. */
export const RasterPictureOverCountHref =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='1'%20height='1'%20data-chemdraft-omitted='count'/%3E";
const RasterPictureIdPrefix = "chemdraft-raster-picture-";

const SvgNamespace = "http://www.w3.org/2000/svg";
const XlinkNamespace = "http://www.w3.org/1999/xlink";
const BitmapDataUri = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/i;
const PngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Signature (8) + IHDR length and type (8) + width and height (8): 24 bytes, 32 base64 characters.
const PngSizeHeaderBase64Length = 32;

export type RasterPictureRefusal = "tooLarge" | "overBudget" | "decodeFailed";

/** One picture as `rasterize_svg` receives it: decoded pixels, or why the webview refused it. */
export type NativeRasterPicture =
  | { id: string; width: number; height: number; rgbaBase64: string }
  | { id: string; refused: RasterPictureRefusal };

/** Straight (not premultiplied) RGBA8, row-major, as `getImageData` returns it. */
export interface DecodedPicturePixels {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
}

export type PictureMimeType = "image/png" | "image/jpeg";

export type PicturePixelDecoder = (bytes: Uint8Array<ArrayBuffer>, mimeType: PictureMimeType) => Promise<DecodedPicturePixels>;

/**
 * Runs on each `<image>` this call may still take, in drawing order, before it is read, with the
 * decoded bytes still unspent; it may replace the href with a PNG of at most that many decoded
 * bytes (`svgPicture/rasterEmbeddedBitmaps.ts` does, for SVG pictures that embed a bitmap). It
 * resolves `true` when it took the picture on for rasterising, whether or not that succeeded: such a
 * picture holds one of the `RasterPictureMaxCount` slots either way, so failures cannot run unbounded.
 */
export type RasterPicturePreStep = (image: Element, remainingBytes: number) => Promise<boolean | void>;

export interface PrepareRasterPicturesOptions {
  /** Defaults to the webview's own decoder, `decodePngPixels`. */
  decode?: PicturePixelDecoder;
  /** Decoded bytes allowed across this call; defaults to `RasterPictureDecodedBudgetBytes`. */
  budgetBytes?: number;
  beforeDecode?: RasterPicturePreStep;
}

export interface PreparedRasterPictures {
  svg: string;
  pictures: NativeRasterPicture[];
}

/**
 * The blank SVG that stands in for picture `id`'s PNG: the picture's pixel size and one invisible
 * path with the picture's id. `placeholder_href` in `export/pictures.rs` builds the same string.
 */
export function rasterPicturePlaceholderHref(width: number, height: number, id: string): string {
  return `data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='${width}'%20height='${height}'%3E%3Cpath%20id='${id}'%20d='M0%200H1V1H0Z'%20fill='none'/%3E%3C/svg%3E`;
}

/** Width and height from a PNG's IHDR chunk, or undefined when the bytes do not start like a PNG. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || PngSignature.some((byte, index) => bytes[index] !== byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdr = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (view.getUint32(8) !== 13 || ihdr !== "IHDR") return undefined;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Decodes the SVG's top-level PNG and JPEG pictures for one native raster export. Pictures nested
 * inside SVG pictures, other bitmap types, and `<image>` elements that already carry an id or more
 * than one href are left untouched, so Rust keeps its general omitted-picture warning for them.
 *
 * One ledger: a picture is charged its decoded bytes only once it has decoded, and `beforeDecode`
 * sizes each SVG picture against what is truly left at that point in drawing order.
 */
export async function prepareRasterPictures(
  svg: string,
  { decode = decodePngPixels, budgetBytes = RasterPictureDecodedBudgetBytes, beforeDecode }: PrepareRasterPicturesOptions = {}
): Promise<PreparedRasterPictures> {
  if (!/data:image\/(?:png|jpeg);base64,/i.test(svg) && !(beforeDecode && /data:image\/svg\+xml/i.test(svg))) return { svg, pictures: [] };
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (parsed.getElementsByTagName("parsererror").length > 0) return { svg, pictures: [] };

  const prefix = unusedIdPrefix(svg);
  const pictures: NativeRasterPicture[] = [];
  let remainingBytes = budgetBytes;
  // Slots held by SVG pictures the pre-step took on but that did not become a PNG (rasterising failed).
  let failedSlots = 0;
  // Whether any href was rewritten: an over-count stand-in can come before any picture is sent.
  let rewritten = false;
  for (const image of Array.from(parsed.getElementsByTagNameNS(SvgNamespace, "image"))) {
    const admitted = beforeDecode && pictures.length + failedSlots < RasterPictureMaxCount
      ? (await beforeDecode(image, remainingBytes)) === true : false;
    const href = bitmapHref(image);
    if (!href) {
      if (admitted) failedSlots += 1;
      continue;
    }
    if (pictures.length + failedSlots >= RasterPictureMaxCount) {
      // Counted before decoding: past the limit nothing is decoded or sent.
      href.attribute.value = RasterPictureOverCountHref;
      rewritten = true;
      continue;
    }
    const id = `${prefix}${pictures.length}`;
    // One picture at a time: its RGBA exists only inside encodeWithinLimits.
    const outcome = await encodeWithinLimits(href.base64, href.mimeType, remainingBytes, decode);
    if ("refused" in outcome) {
      pictures.push({ id, refused: outcome.refused });
      href.attribute.value = rasterPicturePlaceholderHref(1, 1, id);
    } else {
      remainingBytes -= outcome.width * outcome.height * 4;
      pictures.push({ id, ...outcome });
      href.attribute.value = rasterPicturePlaceholderHref(outcome.width, outcome.height, id);
    }
    image.setAttribute("id", id);
    rewritten = true;
  }
  if (!rewritten) return { svg, pictures };
  return { svg: new XMLSerializer().serializeToString(parsed), pictures };
}

/** Read the size from the first base64 characters, before decoding anything else. */
function pngSizeOfBase64(base64: string): { width: number; height: number } | undefined {
  return base64.length % 4 === 0 ? readPngSize(base64ToBytes(base64.slice(0, PngSizeHeaderBase64Length))) : undefined;
}

/**
 * The picture's bytes, once its header says what it may cost: a PNG's size is in its first bytes,
 * read before anything else is decoded; a JPEG's frame header can follow tables and a colour profile,
 * so the JPEG is decoded from base64 first (still not into pixels).
 */
function pictureHeader(base64: string, mimeType: PictureMimeType):
  { size: { width: number; height: number }; bytes: () => Uint8Array<ArrayBuffer> } | undefined {
  if (mimeType === "image/png") {
    const size = pngSizeOfBase64(base64);
    return size && { size, bytes: () => base64ToBytes(base64) };
  }
  if (base64.length % 4 !== 0) return undefined;
  const bytes = base64ToBytes(base64);
  const size = readRasterHeaderSize("jpeg", bytes);
  return size && { size, bytes: () => bytes };
}

/** Decodes one picture within the limits and returns its pixels as base64, or why it was refused. */
async function encodeWithinLimits(
  base64: string,
  mimeType: PictureMimeType,
  remainingBytes: number,
  decode: PicturePixelDecoder
): Promise<{ width: number; height: number; rgbaBase64: string } | { refused: RasterPictureRefusal }> {
  try {
    const header = pictureHeader(base64, mimeType);
    if (!header) return { refused: "decodeFailed" };
    const { size } = header;
    if (size.width > RasterPictureMaxSidePx || size.height > RasterPictureMaxSidePx) return { refused: "tooLarge" };
    if (size.width * size.height * 4 > remainingBytes) return { refused: "overBudget" };
    const { width, height, rgba } = await decode(header.bytes(), mimeType);
    // A decoder that disagrees with the header (or returns the wrong amount of data) is not trusted.
    // A JPEG may come out turned by its own EXIF orientation, which browsers apply to an SVG `<image>`
    // too (the kept JPEGs ChemDraft writes carry none); its sides are then swapped.
    const matches = (width === size.width && height === size.height) ||
      (mimeType === "image/jpeg" && width === size.height && height === size.width);
    if (!matches || rgba.length !== width * height * 4) return { refused: "decodeFailed" };
    // Nothing keeps the RGBA once this returns, so it can be collected before the next picture.
    return { width, height, rgbaBase64: bytesToBase64(rgba) };
  } catch {
    return { refused: "decodeFailed" };
  }
}

/** The PNG or JPEG data URI of an `<image>` with exactly one href (in any namespace usvg reads) and no id. */
function bitmapHref(image: Element): { attribute: Attr; base64: string; mimeType: PictureMimeType } | undefined {
  if (image.hasAttribute("id")) return undefined;
  const hrefs = Array.from(image.attributes).filter((attribute) => attribute.localName === "href");
  const [attribute] = hrefs;
  if (hrefs.length !== 1 || ![null, SvgNamespace, XlinkNamespace].includes(attribute.namespaceURI)) return undefined;
  const match = BitmapDataUri.exec(attribute.value);
  return match ? { attribute, base64: match[2], mimeType: match[1].toLowerCase() as PictureMimeType } : undefined;
}

/** An id prefix no existing text in the SVG contains, so generated ids cannot collide. */
function unusedIdPrefix(svg: string): string {
  if (!svg.includes(RasterPictureIdPrefix)) return RasterPictureIdPrefix;
  let index = 1;
  while (svg.includes(`${RasterPictureIdPrefix}${index}-`)) index += 1;
  return `${RasterPictureIdPrefix}${index}-`;
}

/** Decodes one PNG or JPEG with the webview's image decoder and reads it back as straight-alpha RGBA8. */
export async function decodePngPixels(bytes: Uint8Array<ArrayBuffer>, mimeType: PictureMimeType = "image/png"): Promise<DecodedPicturePixels> {
  const source = await loadPicture(new Blob([bytes], { type: mimeType }));
  let canvas: OffscreenCanvas | HTMLCanvasElement | undefined;
  try {
    let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (typeof OffscreenCanvas === "function") {
      canvas = new OffscreenCanvas(source.width, source.height);
      context = canvas.getContext("2d", { willReadFrequently: true });
    } else {
      canvas = Object.assign(document.createElement("canvas"), { width: source.width, height: source.height });
      context = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!context) throw new Error("No 2D canvas is available to decode the picture.");
    context.drawImage(source.image, 0, 0);
    const { data } = context.getImageData(0, 0, source.width, source.height);
    return { width: source.width, height: source.height, rgba: data };
  } finally {
    // Runs as soon as the pixels are read back (or anything above throws): the bitmap and the
    // canvas backing store are released now rather than at garbage collection.
    source.release();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

async function loadPicture(blob: Blob): Promise<{
  image: CanvasImageSource; width: number; height: number; release: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { image, width: image.naturalWidth, height: image.naturalHeight, release: () => undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const fromBase64 = (Uint8Array as { fromBase64?: (value: string) => Uint8Array<ArrayBuffer> }).fromBase64;
  if (typeof fromBase64 === "function") return fromBase64(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const Base64Alphabet = Uint8Array.from(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", (char) => char.charCodeAt(0)
);
const Base64Pad = 0x3d;

/**
 * Standard padded base64. Uses the engine's `Uint8Array.prototype.toBase64` when present; otherwise
 * encodes in one pass into a single ASCII buffer that becomes the string, with no chunk strings.
 */
export function bytesToBase64(bytes: Uint8Array | Uint8ClampedArray): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const toBase64 = (view as { toBase64?: () => string }).toBase64;
  if (typeof toBase64 === "function") return toBase64.call(view);
  const ascii = new Uint8Array(Math.ceil(view.length / 3) * 4);
  let out = 0;
  let index = 0;
  for (; index + 2 < view.length; index += 3) {
    const triple = (view[index] << 16) | (view[index + 1] << 8) | view[index + 2];
    ascii[out++] = Base64Alphabet[triple >>> 18];
    ascii[out++] = Base64Alphabet[(triple >>> 12) & 63];
    ascii[out++] = Base64Alphabet[(triple >>> 6) & 63];
    ascii[out++] = Base64Alphabet[triple & 63];
  }
  if (index < view.length) {
    const hasSecond = index + 1 < view.length;
    const triple = (view[index] << 16) | (hasSecond ? view[index + 1] << 8 : 0);
    ascii[out++] = Base64Alphabet[triple >>> 18];
    ascii[out++] = Base64Alphabet[(triple >>> 12) & 63];
    ascii[out++] = hasSecond ? Base64Alphabet[(triple >>> 6) & 63] : Base64Pad;
    ascii[out++] = Base64Pad;
  }
  return new TextDecoder().decode(ascii);
}
