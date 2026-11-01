/**
 * PNG pictures for native raster export (PNG, JPEG, BMP, GIF, TIFF, Copy as PNG, plugin renders).
 *
 * The native renderer has no bitmap decoder, by design: pictures are decoded HERE, by the webview's
 * own image decoder (WKWebView on macOS, WebView2 on Windows), and Rust receives straight-alpha
 * RGBA8 pixels it checks by length alone (`export.rs`). Each decoded picture's `<image>` keeps its
 * frame, transform and z-order in the SVG; only its href becomes an empty SVG of the picture's pixel
 * size, tagged with an id, so usvg still places it and native code draws the supplied pixels there.
 *
 * Limits, enforced before decoding and re-checked in Rust: 16384 px a side, and 256 MiB of decoded
 * pixels (width × height × 4) across one export call. A picture over a limit, or one that fails to
 * decode, is not drawn; Rust reports it with a warning naming the reason.
 */

export const RasterPictureMaxSidePx = 16384;
export const RasterPictureDecodedBudgetBytes = 256 * 1024 * 1024;
const RasterPictureIdPrefix = "chemdraft-raster-picture-";

const SvgNamespace = "http://www.w3.org/2000/svg";
const XlinkNamespace = "http://www.w3.org/1999/xlink";
const PngDataUri = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/i;
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

export type PicturePixelDecoder = (png: Uint8Array<ArrayBuffer>) => Promise<DecodedPicturePixels>;

export interface PrepareRasterPicturesOptions {
  /** Defaults to the webview's own decoder, `decodePngPixels`. */
  decode?: PicturePixelDecoder;
  /** Decoded bytes allowed across this call; defaults to `RasterPictureDecodedBudgetBytes`. */
  budgetBytes?: number;
}

export interface PreparedRasterPictures {
  svg: string;
  pictures: NativeRasterPicture[];
}

/** The empty SVG that stands in for a picture's PNG; `export.rs` builds the same string. */
export function rasterPicturePlaceholderHref(width: number, height: number): string {
  return `data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='${width}'%20height='${height}'/%3E`;
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
 * Decodes the SVG's top-level PNG pictures for one native raster export. Pictures nested inside SVG
 * pictures, other bitmap types, and `<image>` elements that already carry an id or more than one
 * href are left untouched, so Rust keeps its general omitted-picture warning for them.
 */
export async function prepareRasterPictures(
  svg: string,
  { decode = decodePngPixels, budgetBytes = RasterPictureDecodedBudgetBytes }: PrepareRasterPicturesOptions = {}
): Promise<PreparedRasterPictures> {
  if (!/data:image\/png;base64,/i.test(svg)) return { svg, pictures: [] };
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (parsed.getElementsByTagName("parsererror").length > 0) return { svg, pictures: [] };

  const prefix = unusedIdPrefix(svg);
  const pictures: NativeRasterPicture[] = [];
  let remainingBytes = budgetBytes;
  for (const image of Array.from(parsed.getElementsByTagNameNS(SvgNamespace, "image"))) {
    const href = pngHref(image);
    if (!href) continue;
    const id = `${prefix}${pictures.length}`;
    const outcome = await decodeWithinLimits(href.base64, remainingBytes, decode);
    if ("refused" in outcome) {
      pictures.push({ id, refused: outcome.refused });
      href.attribute.value = rasterPicturePlaceholderHref(1, 1);
    } else {
      remainingBytes -= outcome.width * outcome.height * 4;
      pictures.push({ id, width: outcome.width, height: outcome.height, rgbaBase64: bytesToBase64(outcome.rgba) });
      href.attribute.value = rasterPicturePlaceholderHref(outcome.width, outcome.height);
    }
    image.setAttribute("id", id);
  }
  if (pictures.length === 0) return { svg, pictures };
  return { svg: new XMLSerializer().serializeToString(parsed), pictures };
}

async function decodeWithinLimits(
  base64: string,
  remainingBytes: number,
  decode: PicturePixelDecoder
): Promise<DecodedPicturePixels | { refused: RasterPictureRefusal }> {
  try {
    // Read the size from the first base64 characters, before decoding anything else.
    const size = base64.length % 4 === 0 ? readPngSize(base64ToBytes(base64.slice(0, PngSizeHeaderBase64Length))) : undefined;
    if (!size) return { refused: "decodeFailed" };
    if (size.width > RasterPictureMaxSidePx || size.height > RasterPictureMaxSidePx) return { refused: "tooLarge" };
    if (size.width * size.height * 4 > remainingBytes) return { refused: "overBudget" };
    const pixels = await decode(base64ToBytes(base64));
    // A decoder that disagrees with the IHDR (or returns the wrong amount of data) is not trusted.
    if (pixels.width !== size.width || pixels.height !== size.height
      || pixels.rgba.length !== size.width * size.height * 4) return { refused: "decodeFailed" };
    return pixels;
  } catch {
    return { refused: "decodeFailed" };
  }
}

/** The PNG data URI of an `<image>` with exactly one href (in any namespace usvg reads) and no id. */
function pngHref(image: Element): { attribute: Attr; base64: string } | undefined {
  if (image.hasAttribute("id")) return undefined;
  const hrefs = Array.from(image.attributes).filter((attribute) => attribute.localName === "href");
  const [attribute] = hrefs;
  if (hrefs.length !== 1 || ![null, SvgNamespace, XlinkNamespace].includes(attribute.namespaceURI)) return undefined;
  const match = PngDataUri.exec(attribute.value);
  return match ? { attribute, base64: match[1] } : undefined;
}

/** An id prefix no existing text in the SVG contains, so generated ids cannot collide. */
function unusedIdPrefix(svg: string): string {
  if (!svg.includes(RasterPictureIdPrefix)) return RasterPictureIdPrefix;
  let index = 1;
  while (svg.includes(`${RasterPictureIdPrefix}${index}-`)) index += 1;
  return `${RasterPictureIdPrefix}${index}-`;
}

/** Decodes one PNG with the webview's image decoder and reads it back as straight-alpha RGBA8. */
export async function decodePngPixels(png: Uint8Array<ArrayBuffer>): Promise<DecodedPicturePixels> {
  const source = await loadPicture(new Blob([png], { type: "image/png" }));
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (typeof OffscreenCanvas === "function") {
    canvas = new OffscreenCanvas(source.width, source.height);
    context = canvas.getContext("2d", { willReadFrequently: true });
  } else {
    canvas = Object.assign(document.createElement("canvas"), { width: source.width, height: source.height });
    context = canvas.getContext("2d", { willReadFrequently: true });
  }
  try {
    if (!context) throw new Error("No 2D canvas is available to decode the picture.");
    context.drawImage(source.image, 0, 0);
    const { data } = context.getImageData(0, 0, source.width, source.height);
    return { width: source.width, height: source.height, rgba: data };
  } finally {
    source.release();
    // Release the canvas backing store now rather than at garbage collection.
    canvas.width = 0;
    canvas.height = 0;
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

// A multiple of 3 bytes, so each chunk encodes without padding; and few enough arguments for
// String.fromCharCode.apply in every engine (JavaScriptCore caps arguments at 65536).
const Base64ChunkBytes = 3 * 8192;

export function bytesToBase64(bytes: Uint8Array | Uint8ClampedArray): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const toBase64 = (view as { toBase64?: () => string }).toBase64;
  if (typeof toBase64 === "function") return toBase64.call(view);
  const parts: string[] = [];
  for (let offset = 0; offset < view.length; offset += Base64ChunkBytes) {
    // apply takes any array-like, so the typed array is passed without copying it to an Array.
    parts.push(btoa(String.fromCharCode.apply(null, view.subarray(offset, offset + Base64ChunkBytes) as unknown as number[])));
  }
  return parts.join("");
}
