/**
 * A dropped JPEG kept as its own encoded bytes, never re-encoded.
 *
 * The document stores pictures as PNG or SVG (`ImageObjectData.mimeType`), so the JPEG travels inside
 * a one-element SVG: an SVG picture that embeds a bitmap, which the canvas, SVG and PDF export, raster
 * export and copy already draw (`svgPicture/rasterEmbeddedBitmaps.ts`). The scan data stays byte for
 * byte the camera's: a 1.7 MB photo is stored as about 3 MB, where its PNG re-encode took 9.35 MB.
 *
 * EXIF orientation is applied by the SVG itself, never by a decoder. The metadata segments (APP1,
 * which holds Exif and XMP, and APP13, Photoshop and IPTC) are removed, so no renderer can rotate the
 * picture a second time or ignore the tag, and the `<image>` carries the matching transform: a portrait
 * phone photo is upright everywhere it is drawn. Removing them also keeps the photo's location and
 * camera details out of the document, as the PNG re-encode did. Every other segment (JFIF, the ICC
 * colour profile, Adobe's colour transform, tables, the frame and the scan) is kept as it is.
 */

/** EXIF orientation: 1 upright; 2-4 mirrored or turned; 5-8 also swap width and height. */
export type JpegOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface KeepableJpeg {
  /** The file without its metadata segments; the very array it came in when it had none. */
  bytes: Uint8Array;
  /** From the first Exif segment, or 1 when there is none. */
  orientation: JpegOrientation;
  /** Whether any metadata segment was removed. */
  strippedMetadata: boolean;
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
 * The JPEG without its metadata segments, with its EXIF orientation, when its structure is complete
 * up to the first scan: a frame header, then a scan. Undefined otherwise (a header without image
 * data, a segment running past the end): such a file is left to the webview's decoder on the PNG
 * conversion route, which says why it fails. Nothing after the scan begins is read or changed.
 */
export function readKeepableJpeg(bytes: Uint8Array): KeepableJpeg | undefined {
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
      return { bytes: withoutRanges(bytes, removed), orientation: orientation ?? 1, strippedMetadata: removed.length > 0 };
    }
    if (marker === APP1 || marker === APP13) {
      if (marker === APP1 && orientation === undefined) orientation = exifOrientation(bytes.subarray(offset + 2, segmentEnd));
      removed.push([segmentStart, segmentEnd]);
    }
    offset = segmentEnd;
  }
  return undefined;
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

/** The upright size of a picture stored at `width` × `height` with `orientation`. */
export function orientedJpegSize(width: number, height: number, orientation: JpegOrientation): { width: number; height: number } {
  return orientation >= 5 ? { width: height, height: width } : { width, height };
}

/**
 * The affine map `[a, b, c, d, e, f]` (SVG `matrix()`, canvas `setTransform`) that draws a picture
 * stored at `width` × `height` upright in its oriented box; undefined for orientation 1.
 */
export function jpegOrientationMatrix(width: number, height: number, orientation: JpegOrientation): [number, number, number, number, number, number] | undefined {
  switch (orientation) {
    case 1: return undefined;
    case 2: return [-1, 0, 0, 1, width, 0];
    case 3: return [-1, 0, 0, -1, width, height];
    case 4: return [1, 0, 0, -1, 0, height];
    case 5: return [0, 1, 1, 0, 0, 0];
    case 6: return [0, 1, -1, 0, height, 0];
    case 7: return [0, -1, -1, 0, height, width];
    case 8: return [0, -1, 1, 0, 0, width];
  }
}

/**
 * The SVG picture that shows `jpegBase64` (stored `width` × `height` pixels) upright, sized one pixel
 * per page unit like any picture without a density. Written in the form the SVG sanitizer leaves
 * unchanged, so storing it needs no sanitizing pass (`jpegPicture.test.ts` holds it to that).
 */
export function jpegPictureSvg(jpegBase64: string, width: number, height: number, orientation: JpegOrientation): string {
  const size = orientedJpegSize(width, height, orientation);
  const matrix = jpegOrientationMatrix(width, height, orientation);
  const transform = matrix ? ` transform="matrix(${matrix.join(" ")})"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">`
    + `<image width="${width}" height="${height}" preserveAspectRatio="none"${transform} href="data:image/jpeg;base64,${jpegBase64}"/></svg>`;
}

/** Characters `jpegPictureSvg` writes for a JPEG of `byteLength` bytes, without building it. */
export function jpegPictureSvgLength(byteLength: number, width: number, height: number, orientation: JpegOrientation): number {
  return jpegPictureSvg("", width, height, orientation).length + Math.ceil(byteLength / 3) * 4;
}
