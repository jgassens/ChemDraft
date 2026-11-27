/**
 * A dropped JPEG kept as its own encoded bytes, never re-encoded.
 *
 * The document stores pictures as PNG or SVG (`ImageObjectData.mimeType`), and 1.2.2 opens nothing
 * else, so the JPEG travels inside a one-element SVG (`export-engine/jpegPicture.ts`), which the canvas
 * draws as it is. SVG and PDF export, raster export and copy draw the JPEG itself, read back out of it.
 * The scan data stays byte for byte the camera's: a 1.7 MB photo is stored as about 3 MB, where its PNG
 * re-encode took 9.35 MB. A JPEG longer than 4096 px is scaled down and re-encoded once, on drop
 * (`prepareDroppedImage.ts`).
 *
 * EXIF orientation is applied by the SVG itself, never by a decoder. The metadata segments (APP1,
 * which holds Exif and XMP, and APP13, Photoshop and IPTC) are removed, so no renderer can rotate the
 * picture a second time or ignore the tag, and the `<image>` carries the matching transform: a portrait
 * phone photo is upright everywhere it is drawn. Removing them also keeps the photo's location and
 * camera details out of the document, as the PNG re-encode did. Every other segment (JFIF, the ICC
 * colour profile, Adobe's colour transform, tables, the frame and the scan) is kept as it is.
 */

import type { JpegOrientation } from "@chemdraft/export-engine";

// The SVG form itself (writer, reader, orientation maps) lives in export-engine, which reads it back.
export {
  jpegOrientationMatrix, jpegPictureSvg, jpegPictureSvgLength, orientedJpegSize, type JpegOrientation
} from "@chemdraft/export-engine";

export interface KeepableJpeg {
  /** The file without its metadata segments; the very array it came in when it had none. */
  bytes: Uint8Array;
  /** From the first Exif segment, or 1 when there is none. */
  orientation: JpegOrientation;
  /** Whether any metadata segment was removed. */
  strippedMetadata: boolean;
}

/** A JPEG read up to its first scan, and whether its image data from there on is complete. */
export interface JpegStructure extends KeepableJpeg {
  /**
   * Whether every scan's entropy-coded data runs to a marker (restart markers in order), every
   * segment after it lies inside the file, and the file ends with EOI. A truncated or damaged file
   * fails this even when a lenient decoder draws something from it (grey or smeared rows): its bytes
   * must not be kept as they are.
   */
  complete: boolean;
}

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP1 = 0xe1;
const APP13 = 0xed;
const TEM = 0x01;
/** Start-of-frame markers, as `readJpegHeaderSize` reads them. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
const ORIENTATION_TAG = 0x0112;
const TIFF_SHORT = 3;

/**
 * The orientation tag of one APP1 segment's payload (after its length), or undefined when the
 * segment is not Exif or the tag is absent or out of range.
 */
function exifOrientation(payload: Uint8Array): JpegOrientation | undefined {
  if (payload.length < EXIF_HEADER.length + 8 || EXIF_HEADER.some((byte, index) => payload[index] !== byte)) return undefined;
  const tiff = payload.subarray(EXIF_HEADER.length);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = String.fromCharCode(tiff[0]!, tiff[1]!);
  if (order !== "II" && order !== "MM") return undefined;
  const little = order === "II";
  if (view.getUint16(2, little) !== 42) return undefined;
  const ifd = view.getUint32(4, little);
  if (ifd < 8 || ifd + 2 > tiff.length) return undefined;
  const count = view.getUint16(ifd, little);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > tiff.length) return undefined;
    if (view.getUint16(entry, little) !== ORIENTATION_TAG) continue;
    if (view.getUint16(entry + 2, little) !== TIFF_SHORT || view.getUint32(entry + 4, little) < 1) return undefined;
    const value = view.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value as JpegOrientation : undefined;
  }
  return undefined;
}

/**
 * The JPEG without its metadata segments, with its EXIF orientation, when it can be kept as it is:
 * its structure is complete up to the first scan (a frame header, then a scan) and its image data is
 * complete to the end-of-image marker (`JpegStructure.complete`). Undefined otherwise: such a file
 * takes the PNG conversion route, where the webview's decoder says why it fails.
 */
export function readKeepableJpeg(bytes: Uint8Array): KeepableJpeg | undefined {
  const structure = readJpegStructure(bytes);
  return structure?.complete
    ? { bytes: structure.bytes, orientation: structure.orientation, strippedMetadata: structure.strippedMetadata }
    : undefined;
}

/**
 * The JPEG without its metadata segments and with its EXIF orientation, when its structure is
 * complete up to the first scan: a frame header, then a scan. Undefined otherwise (a header without
 * image data, a segment running past the end). From the first scan on, the file is only checked
 * (`complete`), never changed.
 */
export function readJpegStructure(bytes: Uint8Array): JpegStructure | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return undefined;
  const removed: Array<[number, number]> = [];
  let orientation: JpegOrientation | undefined;
  let frame = false;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const segmentStart = offset;
    // Fill bytes may pad any marker.
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === TEM || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === EOI || marker === SOI || marker === 0x00) return undefined;
    if (offset + 2 > bytes.length) return undefined;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > bytes.length) return undefined;
    if (SOF.has(marker)) frame = true;
    if (marker === SOS) {
      if (!frame) return undefined;
      return {
        bytes: withoutRanges(bytes, removed), orientation: orientation ?? 1, strippedMetadata: removed.length > 0,
        complete: imageDataComplete(bytes, segmentEnd)
      };
    }
    if (marker === APP1 || marker === APP13) {
      if (marker === APP1 && orientation === undefined) orientation = exifOrientation(bytes.subarray(offset + 2, segmentEnd));
      removed.push([segmentStart, segmentEnd]);
    }
    offset = segmentEnd;
  }
  return undefined;
}

/**
 * Whether the image data from the end of the first scan header (`offset`) is complete: each scan's
 * entropy-coded data runs to a marker, where a 0xFF byte is data only when stuffed (0xFF00) and
 * restart markers RST0-RST7 come in order from RST0 in every scan; every segment between scans
 * (tables, restart interval, comments, the next scan's header) lies inside the file; and the data
 * ends at EOI. Bytes after EOI are not image data and are not judged.
 */
function imageDataComplete(bytes: Uint8Array, offset: number): boolean {
  let expectedRestart = 0;
  // Entropy-coded data: find the marker that ends it.
  for (;;) {
    const next = bytes.indexOf(0xff, offset);
    if (next < 0) return false;
    let at = next + 1;
    while (at < bytes.length && bytes[at] === 0xff) at += 1;
    if (at >= bytes.length) return false;
    const code = bytes[at]!;
    offset = at + 1;
    if (code === 0x00) continue;
    if (code >= 0xd0 && code <= 0xd7) {
      if (code - 0xd0 !== expectedRestart) return false;
      expectedRestart = (expectedRestart + 1) & 7;
      continue;
    }
    // A marker: the end of the image, or segments up to the next scan.
    let marker = code;
    for (;;) {
      if (marker === EOI) return true;
      if (marker === SOI || marker === TEM || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) return false;
      if (offset + 2 > bytes.length) return false;
      const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
      if (length < 2 || offset + length > bytes.length) return false;
      offset += length;
      if (marker === SOS) break;
      if (offset >= bytes.length || bytes[offset] !== 0xff) return false;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return false;
      marker = bytes[offset]!;
      offset += 1;
    }
    expectedRestart = 0;
  }
}

function withoutRanges(bytes: Uint8Array, ranges: ReadonlyArray<[number, number]>): Uint8Array {
  if (!ranges.length) return bytes;
  const removedBytes = ranges.reduce((total, [start, end]) => total + end - start, 0);
  const out = new Uint8Array(bytes.length - removedBytes);
  let written = 0;
  let from = 0;
  for (const [start, end] of ranges) {
    out.set(bytes.subarray(from, start), written);
    written += start - from;
    from = end;
  }
  out.set(bytes.subarray(from), written);
  return out;
}
