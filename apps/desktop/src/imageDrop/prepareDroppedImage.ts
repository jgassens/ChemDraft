import {
  MAX_IMAGE_OBJECT_BYTES, isSvgImageSource, readPngInfo, validatePngImage, validateSvgImage, type ImageObjectData
} from "@chemdraft/chem-core";
import {
  MAX_SVG_SOURCE_CHARS, SVG_PICTURE_FORMAT_LABEL, pdfEmbeddableJpegFrame, pictureSizeLimitError as dropPixelLimitError,
  readRasterHeaderSize, sanitizeSvgPicture, sniffBinaryImageFormat, type EmbeddedSvgBitmap, type SniffedImageFormat
} from "@chemdraft/export-engine";
import { formatDropBytes, rewordPictureError } from "./dropFiles";
import {
  jpegPictureSvg, jpegPictureSvgLength, readJpegStructure, readKeepableJpeg, type JpegOrientation, type KeepableJpeg
} from "./jpegPicture";
import { pngImageDataError } from "./pngIntegrity";
import type { DecodeOptions, DroppedImageDecoders, RasterPngResult } from "./rasterDecode";
import { decodeSvgBytes, encodeSvgText } from "./svgText";

/** A picture ready to become a native image object; built at commit time, not here. */
export interface PreparedDroppedImage {
  name: string;
  mimeType: ImageObjectData["mimeType"];
  dataBase64: string;
  /** Natural drawn size in page units when it differs from what the stored pixels give (downscaled). */
  naturalSize?: { width: number; height: number };
  /** Short status notes, e.g. "scaled down to 4000 × 3000 pixels". */
  notes: string[];
}

export type PrepareDroppedImageResult =
  | { ok: true; image: PreparedDroppedImage }
  | { ok: false; reason: string };

const REFUSED_CONTENT: Partial<Record<SniffedImageFormat, string>> = {
  bmp: "BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first.",
  tiff: "BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first.",
  ico: "icon files can't be dropped as pictures; save it as PNG first.",
  heic: "HEIC/HEIF pictures can't be dropped yet; save it as PNG or JPEG first.",
  avif: "AVIF pictures can't be dropped yet; save it as PNG or JPEG first.",
  pdf: "PDF files can't be placed as pictures; export the page as PNG or SVG first.",
  svgz: "compressed SVG (.svgz) can't be dropped; save it as plain SVG first."
};

const RASTER_MIME = { jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;
const FORMAT_LABEL = { jpeg: "JPEG", gif: "GIF", webp: "WebP" } as const;

export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Whether PDF export can embed these JPEG bytes as they are (`pdfEmbeddableJpegFrame`), at `size`.
 * A kept JPEG it cannot embed (CMYK, arithmetic or 12-bit, a frame jsPDF's walk misses) would need its
 * SVG rasterised, which the headless CLI cannot do: such a JPEG is converted to PNG instead.
 */
function pdfEmbeddable(bytes: Uint8Array, size: { width: number; height: number }): boolean {
  const frame = pdfEmbeddableJpegFrame(bytes);
  return frame !== undefined && frame.width === size.width && frame.height === size.height;
}

function payloadSizeError(bytes: number): string | undefined {
  return bytes > MAX_IMAGE_OBJECT_BYTES
    ? `it is ${formatDropBytes(bytes)} as stored; the picture limit is ${formatDropBytes(MAX_IMAGE_OBJECT_BYTES)}.`
    : undefined;
}

/**
 * The longest side a picture converted to PNG keeps (GIF, WebP, a JPEG that cannot be kept whole).
 * Its pixels are being re-encoded anyway; a larger one is stored at this size, drawn at its original
 * size, and the status says so. PNG and SVG pictures are kept as their own bytes and never resized.
 */
export const CONVERTED_PICTURE_MAX_SIDE = 4096;

/**
 * The longest side a kept JPEG has. A larger one (a camera's full-resolution photo) is redrawn
 * upright at this size and encoded as JPEG again at `KEPT_JPEG_QUALITY`, still inside the kept-JPEG
 * SVG picture; it is drawn at its original size, and the status says "scaled down to 4096 px". One at
 * or under it keeps its own bytes.
 */
export const KEPT_JPEG_MAX_SIDE = 4096;
export const KEPT_JPEG_QUALITY = 0.9;

/**
 * The status note for a JPEG whose image data is cut short or damaged (`JpegStructure.complete`):
 * a lenient decoder still draws it, with grey or smeared rows, so it is converted to PNG as the
 * webview decodes it rather than kept as it is, and the status says so.
 */
export const INCOMPLETE_JPEG_NOTE = "its image data is cut short or damaged, so it was converted to PNG as decoded; part of it may be missing";

/** The status note for a PNG conversion stored smaller than its source, or undefined at full size. */
function downscaleNote(encoded: RasterPngResult): string | undefined {
  if (!encoded.downscaled) return undefined;
  const sizes = `stored at ${encoded.width} × ${encoded.height} pixels (from ${encoded.sourceWidth} × ${encoded.sourceHeight})`;
  return encoded.limitedBy === "side"
    ? `${sizes}, the most a picture converted to PNG keeps`
    : `${sizes} to fit the ${formatDropBytes(MAX_IMAGE_OBJECT_BYTES)} picture limit`;
}

/**
 * A JPEG kept as its own bytes, inside an SVG picture that turns it upright (`jpegPicture.ts`), once
 * the webview has decoded exactly the bytes that are stored. Undefined when it is too large to store
 * whole: the PNG conversion route takes it, scaled down, and says so.
 */
async function keptJpegPicture(
  name: string,
  jpeg: KeepableJpeg,
  size: { width: number; height: number },
  decoders: DroppedImageDecoders,
  options: DecodeOptions
): Promise<PrepareDroppedImageResult | undefined> {
  const svgLength = jpegPictureSvgLength(jpeg.bytes.length, size.width, size.height, jpeg.orientation);
  if (svgLength > MAX_SVG_SOURCE_CHARS || svgLength > MAX_IMAGE_OBJECT_BYTES) return undefined;
  let decoded;
  try {
    decoded = await decoders.decodeCheck(jpeg.bytes, "image/jpeg", options);
  } catch (error) {
    return { ok: false, reason: `the JPEG could not be decoded: ${errorText(error)}` };
  }
  if (!(decoded.width > 0 && decoded.height > 0)) return { ok: false, reason: "the JPEG could not be decoded: the webview could not decode it." };
  const decodedLimit = dropPixelLimitError(decoded.width, decoded.height);
  if (decodedLimit) return { ok: false, reason: decodedLimit };
  const svg = jpegPictureSvg(bytesToBase64(jpeg.bytes), size.width, size.height, jpeg.orientation);
  const validated = validateSvgImage(svg);
  if (validated.error) return { ok: false, reason: rewordPictureError(validated.error) };
  // The SVG is ASCII (markup and base64), so it is its own UTF-8.
  return { ok: true, image: { name, mimeType: "image/svg+xml", dataBase64: btoa(svg), notes: [] } };
}

/**
 * A JPEG longer than `KEPT_JPEG_MAX_SIDE` on a side, redrawn upright at that size and encoded as JPEG
 * again, inside the kept-JPEG SVG picture (orientation 1: the pixels are upright). Undefined when the
 * result is still too large to store whole: the PNG conversion route takes it, as it takes a kept
 * JPEG of that size.
 */
async function scaledJpegPicture(
  name: string,
  jpeg: KeepableJpeg,
  decoders: DroppedImageDecoders,
  options: DecodeOptions
): Promise<PrepareDroppedImageResult | undefined> {
  let encoded;
  try {
    encoded = await decoders.rasterToJpeg(jpeg.bytes, { ...options, maxSide: KEPT_JPEG_MAX_SIDE, quality: KEPT_JPEG_QUALITY, orientation: jpeg.orientation });
  } catch (error) {
    return { ok: false, reason: `the JPEG could not be scaled down: ${errorText(error)}` };
  }
  const decodedLimit = dropPixelLimitError(encoded.sourceWidth, encoded.sourceHeight);
  if (decodedLimit) return { ok: false, reason: decodedLimit };
  // The encoder's own JPEG, read like a dropped one: its frame must be the size it reports, upright.
  const scaled = readKeepableJpeg(encoded.jpeg);
  const size = scaled && readRasterHeaderSize("jpeg", scaled.bytes);
  if (!scaled || !size || size.width !== encoded.width || size.height !== encoded.height ||
    Math.max(size.width, size.height) > KEPT_JPEG_MAX_SIDE) {
    return { ok: false, reason: "the JPEG could not be scaled down: the webview's JPEG is not readable." };
  }
  // A webview JPEG PDF export could not embed as it is: the PNG conversion route takes the original.
  if (!pdfEmbeddable(scaled.bytes, size)) return undefined;
  const svgLength = jpegPictureSvgLength(scaled.bytes.length, size.width, size.height, 1);
  if (svgLength > MAX_SVG_SOURCE_CHARS || svgLength > MAX_IMAGE_OBJECT_BYTES) return undefined;
  const svg = jpegPictureSvg(bytesToBase64(scaled.bytes), size.width, size.height, 1);
  const validated = validateSvgImage(svg);
  if (validated.error) return { ok: false, reason: rewordPictureError(validated.error) };
  return {
    ok: true,
    image: {
      name, mimeType: "image/svg+xml", dataBase64: btoa(svg),
      // Fewer stored pixels, same drawn size: one page unit per original pixel, as a PNG conversion.
      naturalSize: { width: encoded.sourceWidth, height: encoded.sourceHeight },
      notes: [`scaled down to ${KEPT_JPEG_MAX_SIDE} px (from ${encoded.sourceWidth} × ${encoded.sourceHeight} pixels)`]
    }
  };
}

/** Decode one bitmap an SVG embeds, under the file's deadline; the reason it fails, if it does. */
async function embeddedBitmapDecodeError(bitmap: EmbeddedSvgBitmap, decoders: DroppedImageDecoders, options: DecodeOptions): Promise<string | undefined> {
  const label = SVG_PICTURE_FORMAT_LABEL[bitmap.format];
  // The webview draws a PNG whose image data is damaged (blank or partly black): check it first.
  if (bitmap.format === "png") {
    const damaged = await pngImageDataError(bitmap.bytes, options);
    if (damaged) return `an embedded ${label} picture could not be decoded: ${damaged}`;
  }
  let decoded;
  try {
    decoded = await decoders.decodeCheck(bitmap.bytes, bitmap.mimeType, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return `an embedded ${label} picture could not be decoded: ${errorText(error)}`;
  }
  if (!(decoded.width > 0 && decoded.height > 0)) return `an embedded ${label} picture could not be decoded: the webview could not decode it.`;
  const limit = dropPixelLimitError(decoded.width, decoded.height);
  return limit ? `an embedded picture ${limit.replace(/^it /, "")}` : undefined;
}

/**
 * Recognise a dropped picture by its bytes and turn it into PNG or sanitized SVG. A PNG is kept byte
 * for byte once its image data has been checked (`pngIntegrity.ts`) and the webview has decoded it;
 * a JPEG keeps its own encoded bytes inside an SVG picture that applies its EXIF orientation
 * (`jpegPicture.ts`), or past `KEPT_JPEG_MAX_SIDE` is scaled down and re-encoded inside it; a JPEG
 * PDF export could not embed as it is (CMYK), GIF and WebP are converted to PNG; an SVG is kept once
 * the webview has drawn the sanitized text.
 * Every decoder call carries `options.signal`, the file's deadline. Every refusal is a reason without
 * the file name; the caller names the file.
 */
export async function prepareDroppedImage(
  name: string,
  bytes: Uint8Array,
  decoders: DroppedImageDecoders,
  options: DecodeOptions = {}
): Promise<PrepareDroppedImageResult> {
  const format = sniffBinaryImageFormat(bytes);
  const refused = format && REFUSED_CONTENT[format];
  if (refused) return { ok: false, reason: refused };

  if (format === "png") {
    const info = readPngInfo(bytes);
    const limit = info && dropPixelLimitError(info.pixelWidth, info.pixelHeight);
    if (limit) return { ok: false, reason: limit };
    const result = validatePngImage(bytes);
    if (result.error) return { ok: false, reason: rewordPictureError(result.error) };
    const sizeError = payloadSizeError(bytes.length);
    if (sizeError) return { ok: false, reason: sizeError };
    // Chunk framing is not pixels, and the webview decodes damaged image data without complaint (an
    // invisible or half-black picture): the image data itself is checked here, then decoded.
    const damaged = await pngImageDataError(bytes, options);
    if (damaged) return { ok: false, reason: `the PNG could not be decoded: ${damaged}` };
    let decoded;
    try {
      decoded = await decoders.decodeCheck(bytes, "image/png", options);
    } catch (error) {
      return { ok: false, reason: `the PNG could not be decoded: ${errorText(error)}` };
    }
    if (!(decoded.width > 0 && decoded.height > 0)) return { ok: false, reason: "the PNG could not be decoded: the webview could not decode it." };
    const decodedLimit = dropPixelLimitError(decoded.width, decoded.height);
    if (decodedLimit) return { ok: false, reason: decodedLimit };
    return { ok: true, image: { name, mimeType: "image/png", dataBase64: bytesToBase64(bytes), notes: [] } };
  }

  if (format === "jpeg" || format === "gif" || format === "webp") {
    const header = readRasterHeaderSize(format, bytes);
    if (!header) return { ok: false, reason: `the ${FORMAT_LABEL[format]} header is damaged or truncated, so its size can't be read.` };
    const limit = dropPixelLimitError(header.width, header.height);
    if (limit) return { ok: false, reason: limit };
    let source = bytes;
    let orientation: JpegOrientation | undefined;
    const notes: string[] = [];
    if (format === "jpeg") {
      // A JPEG that stops before its image data is left to the webview's decoder below, as before.
      const jpeg = readJpegStructure(bytes);
      if (jpeg?.complete) {
        // Kept only when every export, the headless PDF one included, can draw it (`pdfEmbeddable`); a
        // JPEG scaled down is re-encoded by the webview, so its source may be CMYK.
        const kept = Math.max(header.width, header.height) > KEPT_JPEG_MAX_SIDE
          ? await scaledJpegPicture(name, jpeg, decoders, options)
          : pdfEmbeddable(jpeg.bytes, header) ? await keptJpegPicture(name, jpeg, header, decoders, options) : undefined;
        if (kept) return kept;
      }
      if (jpeg) {
        // Too large to keep whole, not embeddable in PDF as it is (CMYK), or its image data is
        // incomplete (never stored as it is): converted, with the canvas turning it upright.
        source = jpeg.bytes;
        orientation = jpeg.orientation;
        if (!jpeg.complete) notes.push(INCOMPLETE_JPEG_NOTE);
      }
    }
    let encoded;
    try {
      encoded = await decoders.rasterToPng(source, RASTER_MIME[format], MAX_IMAGE_OBJECT_BYTES,
        { ...options, maxSide: CONVERTED_PICTURE_MAX_SIDE, ...(orientation ? { orientation } : {}) });
    } catch (error) {
      return { ok: false, reason: `the ${FORMAT_LABEL[format]} could not be converted: ${errorText(error)}` };
    }
    const decodedLimit = dropPixelLimitError(encoded.sourceWidth, encoded.sourceHeight);
    if (decodedLimit) return { ok: false, reason: decodedLimit };
    const result = validatePngImage(encoded.png);
    if (result.error) return { ok: false, reason: `the converted picture is invalid: ${rewordPictureError(result.error)}` };
    let naturalSize: PreparedDroppedImage["naturalSize"];
    const note = downscaleNote(encoded);
    if (note) {
      // Fewer stored pixels, same drawn size: one page unit per original pixel (the 96 dpi default).
      naturalSize = { width: encoded.sourceWidth, height: encoded.sourceHeight };
      notes.push(note);
    }
    return {
      ok: true,
      image: { name, mimeType: "image/png", dataBase64: bytesToBase64(encoded.png), ...(naturalSize ? { naturalSize } : {}), notes }
    };
  }

  const decoded = decodeSvgBytes(bytes);
  if ("error" in decoded) return { ok: false, reason: decoded.error };
  if (!isSvgImageSource(decoded.text)) {
    return { ok: false, reason: "its contents are not a PNG, JPEG, GIF, WebP or SVG picture." };
  }
  const sanitized = sanitizeSvgPicture(decoded.text);
  if (!sanitized.ok) return { ok: false, reason: sanitized.error };
  // The headers were checked; each bitmap must also decode, or the picture would draw without it.
  for (const bitmap of sanitized.embeddedBitmaps) {
    const failure = await embeddedBitmapDecodeError(bitmap, decoders, options);
    if (failure) return { ok: false, reason: failure };
  }
  const validated = validateSvgImage(sanitized.svg);
  if (validated.error) return { ok: false, reason: rewordPictureError(validated.error) };
  const svgBytes = encodeSvgText(sanitized.svg);
  const sizeError = payloadSizeError(svgBytes.length);
  if (sizeError) return { ok: false, reason: sizeError };
  try {
    await decoders.decodeCheck(svgBytes, "image/svg+xml", options);
  } catch (error) {
    return { ok: false, reason: `the SVG could not be drawn: ${errorText(error)}` };
  }
  const notes = [
    ...(sanitized.removedExternal ? ["external content was removed"] : []),
    ...(sanitized.removedActive ? ["scripts and animation were removed"] : [])
  ];
  return { ok: true, image: { name, mimeType: "image/svg+xml", dataBase64: bytesToBase64(svgBytes), notes } };
}
