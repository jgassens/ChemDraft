/** JPEGs for the dropped-picture tests: a real one to render, and synthetic ones of any size. Tests only. */

import { readFileSync } from "node:fs";
import type { JpegOrientation } from "./jpegPicture";

/**
 * A real 64 × 32 JPEG (macOS `sips`, quality 95) of four flat quadrants: top left red, top right
 * green, bottom left blue, bottom right yellow. It carries an Exif segment without an orientation tag.
 */
export function quadrantJpeg(): Uint8Array {
  // From the repository root, where vitest runs; a jsdom module's own URL is not a file path.
  return new Uint8Array(readFileSync("apps/desktop/src/imageDrop/fixtures/quadrants-64x32.jpg"));
}

export const QUADRANT_COLORS = { a: [220, 20, 20], b: [20, 200, 20], c: [20, 20, 220], d: [230, 220, 20] } as const;
export type Quadrant = keyof typeof QUADRANT_COLORS;

const segment = (marker: number, payload: readonly number[]) =>
  [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];

/** An Exif APP1 segment whose first IFD holds `orientation` (and a stand-in GPS pointer, like a phone's). */
export function exifSegment(orientation: number, byteOrder: "II" | "MM" = "MM"): number[] {
  const little = byteOrder === "II";
  const u16 = (value: number) => little ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff];
  const u32 = (value: number) => little
    ? [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24]
    : [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  // Header (8), entry count (2), three entries (36), next-IFD offset (4): the strings start at 50.
  const entries = [
    // Make: ASCII, "Phone\0" at 50.
    [...u16(0x010f), ...u16(2), ...u32(6), ...u32(50)],
    [...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0],
    // GPSInfo IFD pointer: an empty IFD at 56.
    [...u16(0x8825), ...u16(4), ...u32(1), ...u32(56)]
  ];
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(entries.length), ...entries.flat(), ...u32(0),
    ...new TextEncoder().encode("Phone\0"), ...u16(0)];
  return segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]);
}

/** `jpeg` with `segments` inserted right after its start-of-image marker. */
export function withSegmentsAfterSoi(jpeg: Uint8Array, ...segments: number[][]): Uint8Array {
  return new Uint8Array([...jpeg.subarray(0, 2), ...segments.flat(), ...jpeg.subarray(2)]);
}

export function xmpSegment(text = "<x:xmpmeta><exif:GPSLatitude>32,59.1N</exif:GPSLatitude></x:xmpmeta>"): number[] {
  return segment(0xe1, [...new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0"), ...new TextEncoder().encode(text)]);
}

export function iccSegment(): number[] {
  return segment(0xe2, [...new TextEncoder().encode("ICC_PROFILE\0"), 1, 1, ...Array.from({ length: 32 }, (_, index) => index)]);
}

export function photoshopSegment(): number[] {
  return segment(0xed, [...new TextEncoder().encode("Photoshop 3.0\0"), 0x38, 0x42, 0x49, 0x4d, 4, 4, 0, 0, 0, 0, 0, 0]);
}

export interface SyntheticJpegOptions {
  width: number;
  height: number;
  orientation?: JpegOrientation;
  byteOrder?: "II" | "MM";
  /** Bytes of entropy-coded data after the scan header: incompressible, like a photo's. */
  scanBytes?: number;
  xmp?: boolean;
  icc?: boolean;
  /** Four components (CMYK, as Photoshop writes for print) instead of three. */
  cmyk?: boolean;
}

/**
 * A structurally complete baseline JPEG (markers, tables, frame, one scan) whose scan is pseudo-random
 * bytes with no 0xFF, so it never ends early. It does not decode to a picture: the tests' decoders
 * are stand-ins, and the point is its structure and its size.
 */
export function syntheticJpeg(options: SyntheticJpegOptions): Uint8Array {
  const { width, height } = options;
  const app0 = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00]);
  const dqt = segment(0xdb, [0x00, ...Array.from({ length: 64 }, () => 1)]);
  const components = options.cmyk ? 4 : 3;
  const sof = segment(0xc0, [0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, components, 1, 0x22, 0,
    ...Array.from({ length: components - 1 }, (_, index) => [index + 2, 0x11, 0]).flat()]);
  const dht = segment(0xc4, [0x00, 0, 1, ...Array.from({ length: 14 }, () => 0), 0]);
  const sos = segment(0xda, [components, ...Array.from({ length: components }, (_, index) => [index + 1, 0x00]).flat(), 0x00, 0x3f, 0x00]);
  const head = [0xff, 0xd8, ...app0,
    ...(options.orientation !== undefined ? exifSegment(options.orientation, options.byteOrder) : []),
    ...(options.xmp ? xmpSegment() : []), ...(options.icc ? iccSegment() : []), ...dqt, ...sof, ...dht, ...sos];
  const scanBytes = options.scanBytes ?? 64;
  const out = new Uint8Array(head.length + scanBytes + 2);
  out.set(head);
  let state = 0x2545f491;
  for (let index = 0; index < scanBytes; index += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    out[head.length + index] = (state >>> 0) % 0xff;
  }
  out.set([0xff, 0xd9], head.length + scanBytes);
  return out;
}

/** Where the scan (its SOS marker) begins in `jpeg`, found marker by marker. */
export function scanStart(jpeg: Uint8Array): number {
  let offset = 2;
  while (offset + 4 <= jpeg.length) {
    while (jpeg[offset] === 0xff && jpeg[offset + 1] === 0xff) offset += 1;
    if (jpeg[offset + 1] === 0xda) return offset;
    offset += 2 + ((jpeg[offset + 2]! << 8) | jpeg[offset + 3]!);
  }
  throw new Error("no scan");
}
