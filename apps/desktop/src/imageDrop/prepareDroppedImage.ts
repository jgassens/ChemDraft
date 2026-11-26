import {
  MAX_IMAGE_OBJECT_BYTES, isSvgImageSource, readPngInfo, validatePngImage, validateSvgImage, type ImageObjectData
} from "@chemdraft/chem-core";
import {
  SVG_PICTURE_FORMAT_LABEL, pictureSizeLimitError as dropPixelLimitError, readRasterHeaderSize, sanitizeSvgPicture,
  sniffBinaryImageFormat, type EmbeddedSvgBitmap, type SniffedImageFormat
} from "@chemdraft/export-engine";
import { formatDropBytes, rewordPictureError } from "./dropFiles";
import { pngImageDataError } from "./pngIntegrity";
import type { DecodeOptions, DroppedImageDecoders } from "./rasterDecode";
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

function payloadSizeError(bytes: number): string | undefined {
  return bytes > MAX_IMAGE_OBJECT_BYTES
    ? `it is ${formatDropBytes(bytes)} as stored; the picture limit is ${formatDropBytes(MAX_IMAGE_OBJECT_BYTES)}.`
    : undefined;
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
 * an SVG once the webview has drawn the sanitized text.
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
    let encoded;
    try {
      encoded = await decoders.rasterToPng(bytes, RASTER_MIME[format], MAX_IMAGE_OBJECT_BYTES, options);
    } catch (error) {
      return { ok: false, reason: `the ${FORMAT_LABEL[format]} could not be converted: ${errorText(error)}` };
    }
    const decodedLimit = dropPixelLimitError(encoded.sourceWidth, encoded.sourceHeight);
    if (decodedLimit) return { ok: false, reason: decodedLimit };
    const result = validatePngImage(encoded.png);
    if (result.error) return { ok: false, reason: `the converted picture is invalid: ${rewordPictureError(result.error)}` };
    const notes: string[] = [];
    let naturalSize: PreparedDroppedImage["naturalSize"];
    if (encoded.downscaled) {
      // Fewer stored pixels, same drawn size: one page unit per original pixel (the 96 dpi default).
      naturalSize = { width: encoded.sourceWidth, height: encoded.sourceHeight };
      notes.push(`stored at ${encoded.width} × ${encoded.height} pixels (from ${encoded.sourceWidth} × ${encoded.sourceHeight}) to fit the ${formatDropBytes(MAX_IMAGE_OBJECT_BYTES)} picture limit`);
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
