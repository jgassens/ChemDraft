import { MAX_IMAGE_OBJECT_BYTES } from "./imageBytes";
import { imagePixelLimitError } from "./imageInfo";
import { buildPngChunk, concatBytes, hasPngSignature, PNG_SIGNATURE, pngChunkAt, pngCrc32, type PngChunk } from "./png";

const u32 = (data: Uint8Array, offset: number) =>
  ((data[offset]! << 24) >>> 0) + (data[offset + 1]! << 16) + (data[offset + 2]! << 8) + data[offset + 3]!;

/** Chunks walked in one file before an animated PNG is refused as out of bounds. */
export const APNG_MAX_CHUNKS = 100_000;
/** The largest animated PNG whose first frame is rebuilt: the picture payload limit. */
export const APNG_MAX_BYTES = MAX_IMAGE_OBJECT_BYTES;
/** Ancillary chunks before the image data that describe how its pixels read; copied into the rebuilt PNG. */
const APNG_COPIED_CHUNKS = new Set(["PLTE", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP"]);

/** Whether a chunk's stored CRC matches its type and data. */
const crcMatches = (bytes: Uint8Array, chunk: PngChunk) => u32(bytes, chunk.end - 4) === pngCrc32(bytes.subarray(chunk.offset + 4, chunk.end - 4));

export interface ApngFirstFrameResult {
  /** The PNG to draw: the input object itself unless a first frame was rebuilt. */
  bytes: Uint8Array;
  /**
   * `static`: not an animated PNG (or not a PNG this helper reads), unchanged. `default-image`: the default
   * image is the first animation frame, unchanged. `first-frame`: rebuilt from the first frame's data.
   * `fallback`: an animated PNG whose first frame can't be read: its default image alone, the input without
   * its acTL, fcTL and fdAT chunks (some decoders refuse a malformed animation outright), or the input
   * unchanged when even that can't be framed within the bounds.
   */
  frame: "static" | "default-image" | "first-frame" | "fallback";
  /** Why the first frame couldn't be read; set only for `fallback`. */
  warning?: string;
}

/**
 * The first animation frame of an animated PNG (APNG: acTL, fcTL, fdAT), as a static PNG, without decoding
 * pixels. A PNG without an acTL before its image data, or one this can't frame, is returned unchanged
 * (`static`). When the first fcTL precedes IDAT, the default image is frame 0 and the input is returned
 * unchanged (`default-image`). Otherwise frame 0 is the first fcTL's fdAT data: it must start at 0,0 and
 * cover the whole canvas (so, blended over a transparent canvas, it alone is the picture), and the result is
 * IHDR (with frame 0's size), the colour chunks that apply (PLTE, tRNS, gAMA, cHRM, sRGB, iCCP), frame 0's
 * data as IDAT and IEND, with fresh CRCs. An animated PNG out of spec or out of bounds, including one where a
 * chunk this relies on or copies (IHDR, acTL, the colour chunks, frame 0's fcTL and fdAT) fails its CRC, comes
 * back as its default image with a warning (`fallback`), so the export draws that rather than failing.
 */
export function apngFirstFrame(bytes: Uint8Array): ApngFirstFrameResult {
  const unchanged: ApngFirstFrameResult = { bytes, frame: "static" };
  if (!hasPngSignature(bytes)) return unchanged;
  const header = pngChunkAt(bytes, 8);
  if (!header || header.type !== "IHDR" || header.length !== 13) return unchanged;
  // An acTL counts only before the first IDAT; a plain PNG is read only that far.
  let offset = header.end, chunks = 1;
  let animation: PngChunk | undefined;
  for (;;) {
    const chunk = pngChunkAt(bytes, offset);
    if (!chunk || chunk.type === "IDAT" || chunk.type === "IEND" || ++chunks > APNG_MAX_CHUNKS) return unchanged;
    offset = chunk.end;
    if (chunk.type === "acTL") { animation = chunk; break; }
  }
  const fallback = (reason: string): ApngFirstFrameResult =>
    ({ bytes: withoutAnimation(bytes) ?? bytes, frame: "fallback", warning: `the animated PNG's first frame can't be read (${reason}); its default image is drawn instead.` });
  if (bytes.length > APNG_MAX_BYTES) return fallback(`it is larger than ${APNG_MAX_BYTES / (1024 * 1024)} MB`);
  if (animation.length !== 8 || u32(animation.data, 0) === 0) return fallback("its animation control chunk is malformed");
  // Every chunk this relies on or copies must pass its CRC: copied as they are, a damaged colour chunk can make
  // a decoder draw the rebuilt picture wrongly (resvg draws it transparent) with no warning.
  const damaged = (chunk: PngChunk) => fallback(`its ${chunk.type} chunk fails its CRC check`);
  if (!crcMatches(bytes, header)) return damaged(header);
  if (!crcMatches(bytes, animation)) return damaged(animation);

  const canvasWidth = u32(header.data, 0), canvasHeight = u32(header.data, 4);
  const copied: Uint8Array[] = [];
  let sawAnimation = false, sawImageData = false, ended = false;
  let control: PngChunk | undefined;
  let controlBeforeImageData = false;
  const frameData: Uint8Array[] = [];
  let nextSequence = 0;
  let frameDone = false;
  for (offset = header.end, chunks = 1; !ended;) {
    const chunk = pngChunkAt(bytes, offset);
    if (!chunk) return fallback("its chunks are damaged");
    if (++chunks > APNG_MAX_CHUNKS) return fallback(`it has more than ${APNG_MAX_CHUNKS} chunks`);
    offset = chunk.end;
    switch (chunk.type) {
      case "IHDR": return fallback("it has a second header");
      case "acTL":
        if (sawAnimation) return fallback("it has a second animation control chunk");
        sawAnimation = true;
        break;
      case "IEND": ended = true; break;
      case "IDAT":
        sawImageData = true;
        if (control && !controlBeforeImageData) return fallback("image data follows the first frame control chunk");
        break;
      case "fcTL":
        if (!control) {
          control = chunk;
          controlBeforeImageData = !sawImageData;
          if (chunk.length !== 26) return fallback("its first frame control chunk is malformed");
          if (!crcMatches(bytes, chunk)) return damaged(chunk);
          // Sequence numbers run over fcTL and fdAT alike from 0, so the first fcTL is 0 and frame 0's data 1, 2, ...
          if (u32(chunk.data, 0) !== 0) return fallback("its first frame control chunk is not sequence number 0");
          nextSequence = 1;
        } else {
          frameDone = true;
        }
        break;
      case "fdAT":
        if (!control || controlBeforeImageData || frameDone) break;
        if (chunk.length < 4) return fallback("a frame data chunk is malformed");
        if (!crcMatches(bytes, chunk)) return damaged(chunk);
        if (u32(chunk.data, 0) !== nextSequence) return fallback("its frame data chunks are out of sequence");
        nextSequence += 1;
        if (chunk.length > 4) frameData.push(chunk.data.subarray(4));
        break;
      default:
        if (APNG_COPIED_CHUNKS.has(chunk.type) && !sawImageData) {
          if (!crcMatches(bytes, chunk)) return damaged(chunk);
          copied.push(bytes.subarray(chunk.offset, chunk.end));
        }
    }
  }
  if (!sawImageData) return fallback("it has no image data");
  if (!control) return fallback("it has no frame control chunk");
  // The default image is frame 0: drawing it as a static PNG already draws the first frame.
  if (controlBeforeImageData) return { bytes, frame: "default-image" };
  const frame = control.data;
  const width = u32(frame, 4), height = u32(frame, 8), x = u32(frame, 12), y = u32(frame, 16);
  if (x !== 0 || y !== 0 || width !== canvasWidth || height !== canvasHeight) {
    return fallback(`its first frame is ${width} x ${height} pixels at ${x},${y}, not the whole ${canvasWidth} x ${canvasHeight} canvas`);
  }
  if (frame[24]! > 2 || frame[25]! > 1) return fallback("its first frame control chunk is malformed");
  if (imagePixelLimitError(width, height)) return fallback(`its first frame is ${width} x ${height} pixels`);
  if (!frameData.length) return fallback("its first frame has no data");

  const ihdr = header.data.slice();
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  return {
    frame: "first-frame",
    bytes: concatBytes([
      Uint8Array.from(PNG_SIGNATURE), buildPngChunk("IHDR", ihdr), ...copied,
      ...frameData.map((data) => buildPngChunk("IDAT", data)), buildPngChunk("IEND", new Uint8Array(0))
    ])
  };
}

const ANIMATION_CHUNKS = new Set(["acTL", "fcTL", "fdAT"]);

/** The default image alone: every chunk up to IEND but acTL, fcTL and fdAT; undefined when that can't be framed within the bounds. */
function withoutAnimation(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.length > APNG_MAX_BYTES) return undefined;
  const parts = [bytes.subarray(0, 8)];
  for (let offset = 8, chunks = 0; ++chunks <= APNG_MAX_CHUNKS;) {
    const chunk = pngChunkAt(bytes, offset);
    if (!chunk) return undefined;
    if (!ANIMATION_CHUNKS.has(chunk.type)) parts.push(bytes.subarray(chunk.offset, chunk.end));
    if (chunk.type === "IEND") return concatBytes(parts);
    offset = chunk.end;
  }
  return undefined;
}
