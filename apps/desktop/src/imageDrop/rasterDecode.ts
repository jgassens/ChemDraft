/**
 * JPEG, GIF and WebP are decoded by the webview and re-encoded as PNG through a canvas, so the
 * document keeps its one raster type. Only the first frame of an animation is kept, and EXIF
 * orientation is applied by the decoder. Callers check the header size first: nothing over the pixel
 * caps reaches the decoder, and the decoder's own size is checked again before a canvas is made.
 * PNG and SVG, and the bitmaps an SVG embeds, are only decoded (`DecodeCheck`) and their own bytes are
 * kept. A decode that resolves does not prove the pixels: WebKit decodes a PNG whose image data is
 * damaged and draws it blank or partly black, so PNG image data is checked first (`pngIntegrity.ts`).
 * Every wait (decode, encode) ends at the file's deadline (`DecodeOptions`).
 */

import { pictureSizeLimitError as dropPixelLimitError } from "@chemdraft/export-engine";

export interface RasterPngResult {
  png: Uint8Array;
  width: number;
  height: number;
  /** The decoded size before any downscaling, after EXIF orientation. */
  sourceWidth: number;
  sourceHeight: number;
  downscaled: boolean;
}

/**
 * The deadline for one file, from `prepareDroppedImages`. An aborted decode or encode rejects with
 * the signal's reason; anything that arrives after that (a bitmap) is released, never used.
 */
export interface DecodeOptions {
  signal?: AbortSignal;
}

/** Injected so tests (and hosts without a canvas) can supply their own decoder. */
export type RasterToPng = (bytes: Uint8Array, mimeType: string, maxPngBytes: number, options?: DecodeOptions) => Promise<RasterPngResult>;

/**
 * Decode without re-encoding, to check the webview can open the picture: resolves to the decoded
 * pixel size (0 × 0 for an SVG without an intrinsic size), rejects when it cannot be decoded. For a
 * PNG this is not proof of its pixels (see `pngIntegrity.ts`).
 */
export type DecodeCheck = (bytes: Uint8Array, mimeType: DecodeCheckMimeType, options?: DecodeOptions) => Promise<{ width: number; height: number }>;
/** A dropped PNG or SVG, or a bitmap an SVG embeds. */
export type DecodeCheckMimeType = "image/png" | "image/svg+xml" | "image/jpeg" | "image/gif" | "image/webp";

export interface DroppedImageDecoders {
  rasterToPng: RasterToPng;
  decodeCheck: DecodeCheck;
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("decoding it was stopped.");
}

/**
 * `promise`, unless `signal` aborts first: then it rejects with the reason at once, and a value the
 * promise still delivers later is handed to `release` (a late bitmap is closed, not leaked).
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined, release?: (value: T) => void): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) release?.(value);
      else resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

const DOWNSCALE_STEP = 0.75;
const MIN_DOWNSCALED_SIDE = 16;

/**
 * Encode at full size, then smaller in fixed steps until the PNG fits `maxBytes`. An encoder that
 * returns nothing (a canvas over the engine's own limit) counts as too large.
 */
export async function encodeWithDownscale(
  source: { width: number; height: number },
  maxBytes: number,
  encodeAt: (width: number, height: number) => Promise<Uint8Array | undefined>,
  signal?: AbortSignal
): Promise<RasterPngResult> {
  let width = source.width;
  let height = source.height;
  for (let step = 0; ; step += 1) {
    if (signal?.aborted) throw abortReason(signal);
    const png = await encodeAt(width, height);
    if (png && png.length <= maxBytes) {
      return { png, width, height, sourceWidth: source.width, sourceHeight: source.height, downscaled: step > 0 };
    }
    width = Math.max(1, Math.floor(width * DOWNSCALE_STEP));
    height = Math.max(1, Math.floor(height * DOWNSCALE_STEP));
    if (Math.max(width, height) < MIN_DOWNSCALED_SIDE) {
      throw new Error("it is still too large as PNG after scaling it down.");
    }
  }
}

interface DecodedSource {
  width: number;
  height: number;
  source: CanvasImageSource;
  release: () => void;
}

async function decodeBlob(blob: Blob, signal?: AbortSignal): Promise<DecodedSource> {
  if (signal?.aborted) throw abortReason(signal);
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await untilAborted(createImageBitmap(blob, { imageOrientation: "from-image" }), signal, late => late.close());
      return { width: bitmap.width, height: bitmap.height, source: bitmap, release: () => bitmap.close() };
    } catch (error) {
      if (signal?.aborted) throw error;
      // Older engines reject the options bag or the type; the image element below decodes it.
    }
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  const release = () => { image.removeAttribute("src"); URL.revokeObjectURL(url); };
  image.decoding = "async";
  image.src = url;
  try {
    await untilAborted(image.decode(), signal);
  } catch (error) {
    release();
    if (signal?.aborted) throw error;
    throw new Error("the webview could not decode it.");
  }
  return { width: image.naturalWidth, height: image.naturalHeight, source: image, release };
}

async function drawToPng(source: CanvasImageSource, width: number, height: number, signal?: AbortSignal): Promise<Uint8Array | undefined> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height);
    // An encoder that never calls back would hold every later drop: the deadline ends the wait.
    const blob = await untilAborted(new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png")), signal);
    return blob ? new Uint8Array(await untilAborted(blob.arrayBuffer(), signal)) : undefined;
  } catch (error) {
    // Past the deadline is not "too large": no smaller attempt follows.
    if (signal?.aborted) throw error;
    return undefined;
  } finally {
    // Release the backing store now rather than at garbage collection.
    canvas.width = 0;
    canvas.height = 0;
  }
}

export const browserRasterToPng: RasterToPng = async (bytes, mimeType, maxPngBytes, options = {}) => {
  const { signal } = options;
  const decoded = await decodeBlob(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }), signal);
  try {
    if (!(decoded.width > 0 && decoded.height > 0)) throw new Error("the webview could not decode it.");
    // The decoder's own size, not the header's, decides the canvas: refuse it before allocating one.
    const limit = dropPixelLimitError(decoded.width, decoded.height);
    if (limit) throw new Error(limit);
    return await encodeWithDownscale(decoded, maxPngBytes, (width, height) => drawToPng(decoded.source, width, height, signal), signal);
  } finally {
    decoded.release();
  }
};

export const browserDecodeCheck: DecodeCheck = async (bytes, mimeType, options = {}) => {
  const decoded = await decodeBlob(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }), options.signal);
  decoded.release();
  return { width: decoded.width, height: decoded.height };
};

export const browserImageDecoders: DroppedImageDecoders = { rasterToPng: browserRasterToPng, decodeCheck: browserDecodeCheck };
