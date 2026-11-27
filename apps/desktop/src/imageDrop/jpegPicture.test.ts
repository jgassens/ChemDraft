// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import { readSvgInfo } from "@chemdraft/chem-core";
import { sanitizeSvgPicture } from "@chemdraft/export-engine";
import {
  jpegOrientationMatrix, jpegPictureSvg, jpegPictureSvgLength, orientedJpegSize, readJpegStructure, readKeepableJpeg,
  type JpegOrientation
} from "./jpegPicture";
import { bytesToBase64 } from "./prepareDroppedImage";
import {
  QUADRANT_COLORS, exifSegment, iccSegment, photoshopSegment, quadrantJpeg, scanStart, syntheticJpeg, withSegmentsAfterSoi,
  xmpSegment, type Quadrant
} from "./jpegTestImages";

const ORIENTATIONS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const ascii = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

/**
 * What each corner of the upright picture shows, read from the EXIF definition of each value (where
 * the stored 0th row and 0th column belong), for a stored picture whose corners are a b / c d.
 */
const UPRIGHT_CORNERS: Record<JpegOrientation, [Quadrant, Quadrant, Quadrant, Quadrant]> = {
  1: ["a", "b", "c", "d"], // 0th row top, 0th column left
  2: ["b", "a", "d", "c"], // 0th row top, 0th column right
  3: ["d", "c", "b", "a"], // 0th row bottom, 0th column right
  4: ["c", "d", "a", "b"], // 0th row bottom, 0th column left
  5: ["a", "c", "b", "d"], // 0th row left, 0th column top
  6: ["c", "a", "d", "b"], // 0th row right, 0th column top
  7: ["d", "b", "c", "a"], // 0th row right, 0th column bottom
  8: ["b", "d", "a", "c"] // 0th row left, 0th column bottom
};

describe("readKeepableJpeg", () => {
  it("reads the orientation in either byte order and removes the metadata, keeping everything else byte for byte", () => {
    for (const byteOrder of ["II", "MM"] as const) {
      for (const orientation of ORIENTATIONS) {
        const jpeg = syntheticJpeg({ width: 40, height: 30, orientation, byteOrder, xmp: true, icc: true, scanBytes: 500 });
        const kept = readKeepableJpeg(jpeg)!;
        expect(kept.orientation).toBe(orientation);
        expect(kept.strippedMetadata).toBe(true);
        expect(ascii(kept.bytes)).not.toMatch(/Exif|xap|GPSLatitude|Phone/);
        // JFIF, the colour profile, the tables and the frame stay; the scan is untouched to the last byte.
        expect(ascii(kept.bytes)).toContain("JFIF");
        expect(ascii(kept.bytes)).toContain("ICC_PROFILE");
        expect(kept.bytes.subarray(scanStart(kept.bytes))).toEqual(jpeg.subarray(scanStart(jpeg)));
        expect(kept.bytes.length).toBe(jpeg.length - exifSegment(orientation, byteOrder).length - xmpSegment().length);
      }
    }
  });

  it("keeps the very array when there is nothing to remove, and reads orientation 1 when the tag is absent", () => {
    const plain = syntheticJpeg({ width: 8, height: 8 });
    expect(readKeepableJpeg(plain)).toEqual({ bytes: plain, orientation: 1, strippedMetadata: false });
    expect(readKeepableJpeg(plain)!.bytes).toBe(plain);
    // The real fixture carries Exif without an orientation tag.
    const real = readKeepableJpeg(quadrantJpeg())!;
    expect(real.orientation).toBe(1);
    expect(real.strippedMetadata).toBe(true);
  });

  it("takes the first Exif segment's orientation, ignores values outside 1-8, and removes Photoshop data too", () => {
    const base = syntheticJpeg({ width: 8, height: 8 });
    expect(readKeepableJpeg(withSegmentsAfterSoi(base, exifSegment(6), exifSegment(3)))!.orientation).toBe(6);
    expect(readKeepableJpeg(withSegmentsAfterSoi(base, exifSegment(9)))!.orientation).toBe(1);
    expect(readKeepableJpeg(withSegmentsAfterSoi(base, exifSegment(0)))!.orientation).toBe(1);
    const photoshop = readKeepableJpeg(withSegmentsAfterSoi(base, photoshopSegment(), iccSegment()))!;
    expect(ascii(photoshop.bytes)).not.toContain("Photoshop");
    expect(ascii(photoshop.bytes)).toContain("ICC_PROFILE");
  });

  it("refuses a file without a frame and a scan, or whose segment runs past the end", () => {
    // A header alone, as the older drop tests use: left to the PNG conversion route.
    const headerOnly = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 8, 0, 8, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
    expect(readKeepableJpeg(headerOnly)).toBeUndefined();
    const jpeg = syntheticJpeg({ width: 8, height: 8, orientation: 6 });
    expect(readKeepableJpeg(jpeg.subarray(0, 30))).toBeUndefined();
    expect(readKeepableJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
    // A scan before any frame header.
    const sos = scanStart(jpeg);
    const noFrame = new Uint8Array([0xff, 0xd8, ...jpeg.subarray(sos)]);
    expect(readKeepableJpeg(noFrame)).toBeUndefined();
  });
});

describe("JPEG image data completeness", () => {
  /** `jpeg` with `inserted` placed `at` bytes into its scan data (which holds no 0xFF of its own). */
  const intoScan = (jpeg: Uint8Array, at: number, ...inserted: number[]) => {
    const sos = scanStart(jpeg);
    const dataStart = sos + 2 + ((jpeg[sos + 2]! << 8) | jpeg[sos + 3]!);
    return new Uint8Array([...jpeg.subarray(0, dataStart + at), ...inserted, ...jpeg.subarray(dataStart + at)]);
  };

  it("keeps a JPEG whose scans run to EOI: stuffed bytes, restarts in order, a second scan, bytes after EOI", () => {
    const jpeg = syntheticJpeg({ width: 16, height: 16, scanBytes: 300 });
    expect(readJpegStructure(jpeg)!.complete).toBe(true);
    expect(readKeepableJpeg(intoScan(jpeg, 10, 0xff, 0x00))).toBeDefined();
    expect(readKeepableJpeg(intoScan(jpeg, 10, 0xff, 0xd0, 0xff, 0xd1, 0xff, 0xff, 0xd2))).toBeDefined();
    // Restarts count RST0-RST7 then wrap, and start again at RST0 in every scan.
    const restarts = Array.from({ length: 10 }, (_, index) => [0xff, 0xd0 + (index & 7)]).flat();
    expect(readKeepableJpeg(intoScan(jpeg, 10, ...restarts))).toBeDefined();
    // A progressive file: a table segment and a second scan between the first scan and EOI.
    const dht = [0xff, 0xc4, 0x00, 0x14, 0x10, 0, 1, ...Array.from({ length: 14 }, () => 0), 0];
    const secondScan = [...dht, 0xff, 0xda, 0x00, 0x08, 0x01, 1, 0x00, 0x00, 0x3f, 0x00, 0x11, 0x22, 0xff, 0xd0, 0x33];
    expect(readKeepableJpeg(intoScan(jpeg, 300, 0xff, 0xd0, ...secondScan))).toBeDefined();
    // Data after EOI (a phone's appended preview) is not image data.
    expect(readKeepableJpeg(new Uint8Array([...jpeg, 0x00, 0x11, 0xff, 0x22]))).toBeDefined();
  });

  it("removes metadata between the scans of a progressive JPEG and anything after EOI, keeping the scans and ICC", () => {
    const jpeg = syntheticJpeg({ width: 16, height: 16, icc: true, scanBytes: 300 });
    const dht = [0xff, 0xc4, 0x00, 0x14, 0x10, 0, 1, ...Array.from({ length: 14 }, () => 0), 0];
    const secondScan = [0xff, 0xda, 0x00, 0x08, 0x01, 1, 0x00, 0x00, 0x3f, 0x00, 0x11, 0x22, 0xff, 0xd0, 0x33];
    // Exif (with its GPS pointer) and XMP location, Photoshop/IPTC, and an ICC profile between the scans,
    // the Exif behind fill bytes; then a phone's appended trailer after EOI.
    const between = [...dht, 0xff, ...exifSegment(3), ...xmpSegment(), ...photoshopSegment(), ...iccSegment()];
    const trailer = [...new TextEncoder().encode("GPSLatitude trailer"), 0xff, 0xd8, 0xff, 0xe1, 0x00, 0x04, 0x45, 0x78];
    const progressive = new Uint8Array([...intoScan(jpeg, 300, ...between, ...secondScan), ...trailer]);
    const kept = readKeepableJpeg(progressive)!;
    expect(kept).toBeDefined();
    expect(kept.strippedMetadata).toBe(true);
    // Orientation is read only from the segments before the first scan, as decoders do.
    expect(kept.orientation).toBe(1);
    expect(ascii(kept.bytes)).not.toMatch(/Exif|xap|GPSLatitude|Phone|Photoshop|trailer/);
    const expected = new Uint8Array([...intoScan(jpeg, 300, ...dht, ...iccSegment(), ...secondScan)]);
    expect(Array.from(kept.bytes)).toEqual(Array.from(expected));
    expect(Array.from(kept.bytes.subarray(-2))).toEqual([0xff, 0xd9]);
    expect(readJpegStructure(kept.bytes)!.complete).toBe(true);
    // Only bytes after EOI: dropped, and that alone counts as stripped.
    const trailing = readKeepableJpeg(new Uint8Array([...jpeg, ...trailer]))!;
    expect(Array.from(trailing.bytes)).toEqual(Array.from(jpeg));
    expect(trailing.strippedMetadata).toBe(true);
  });

  it("refuses to keep a truncated JPEG, reading its structure for the conversion route", () => {
    const jpeg = syntheticJpeg({ width: 16, height: 16, orientation: 6, xmp: true, scanBytes: 300 });
    const truncated = jpeg.subarray(0, jpeg.length - 120);
    expect(readKeepableJpeg(truncated)).toBeUndefined();
    const structure = readJpegStructure(truncated)!;
    expect(structure).toMatchObject({ complete: false, orientation: 6, strippedMetadata: true });
    expect(ascii(structure.bytes)).not.toMatch(/Exif|GPSLatitude/);
    // The real fixture, cut short halfway through its scan or just before its last byte.
    const real = quadrantJpeg();
    expect(readJpegStructure(real)!.complete).toBe(true);
    expect(readJpegStructure(real.subarray(0, Math.ceil((scanStart(real) + 20 + real.length) / 2)))!.complete).toBe(false);
    expect(readJpegStructure(real.subarray(0, real.length - 1))!.complete).toBe(false);
  });

  it("refuses to keep a JPEG without its EOI marker", () => {
    const jpeg = syntheticJpeg({ width: 16, height: 16, scanBytes: 300 });
    expect(Array.from(jpeg.subarray(-2))).toEqual([0xff, 0xd9]);
    const missingEoi = jpeg.subarray(0, jpeg.length - 2);
    expect(readKeepableJpeg(missingEoi)).toBeUndefined();
    expect(readJpegStructure(missingEoi)).toMatchObject({ complete: false, bytes: missingEoi });
    // A lone 0xFF where EOI belongs, and data that ends at a restart marker, are cut short too.
    expect(readJpegStructure(new Uint8Array([...missingEoi, 0xff]))!.complete).toBe(false);
    expect(readJpegStructure(new Uint8Array([...missingEoi, 0xff, 0xd0]))!.complete).toBe(false);
  });

  it("refuses damaged image data: restarts out of order, a stray SOI, a segment past the end", () => {
    const jpeg = syntheticJpeg({ width: 16, height: 16, scanBytes: 300 });
    // RST1 where RST0 belongs: a restart interval was lost.
    expect(readJpegStructure(intoScan(jpeg, 10, 0xff, 0xd1))!.complete).toBe(false);
    expect(readJpegStructure(intoScan(jpeg, 10, 0xff, 0xd0, 0xff, 0xd0))!.complete).toBe(false);
    expect(readJpegStructure(intoScan(jpeg, 10, 0xff, 0xd8))!.complete).toBe(false);
    // A table segment after the scan whose length runs past the end of the file.
    expect(readJpegStructure(intoScan(jpeg, 300, 0xff, 0xc4, 0x40, 0x00))!.complete).toBe(false);
    // Junk between segments after the scan.
    expect(readJpegStructure(intoScan(jpeg, 300, 0xff, 0xfe, 0x00, 0x03, 0x41, 0x42))!.complete).toBe(false);
  });
});

describe("jpegPictureSvg", () => {
  it("sizes the SVG upright, one page unit per pixel", () => {
    expect(orientedJpegSize(3264, 2448, 6)).toEqual({ width: 2448, height: 3264 });
    expect(orientedJpegSize(3264, 2448, 3)).toEqual({ width: 3264, height: 2448 });
    for (const orientation of ORIENTATIONS) {
      const svg = jpegPictureSvg("AAAA", 3264, 2448, orientation);
      const upright = orientedJpegSize(3264, 2448, orientation);
      expect(readSvgInfo(svg)).toMatchObject({ pixelWidth: upright.width, pixelHeight: upright.height, physicalSize: upright });
      expect(svg.length).toBe(jpegPictureSvgLength(3, 3264, 2448, orientation));
      expect(svg.includes("transform=")).toBe(orientation !== 1);
    }
  });

  it("maps each stored corner to where EXIF puts it", () => {
    const apply = (orientation: JpegOrientation, x: number, y: number) => {
      const [a, b, c, d, e, f] = jpegOrientationMatrix(4, 2, orientation) ?? [1, 0, 0, 1, 0, 0];
      return [a * x + c * y + e, b * x + d * y + f];
    };
    // Stored top-left corner (0, 0) of a 4 × 2 picture.
    expect(ORIENTATIONS.map(orientation => apply(orientation, 0, 0))).toEqual([
      [0, 0], [4, 0], [4, 2], [0, 2], [0, 0], [2, 0], [2, 4], [0, 4]
    ]);
  });

  it("is already in the sanitizer's own form, for every orientation", () => {
    const base64 = bytesToBase64(readKeepableJpeg(quadrantJpeg())!.bytes);
    for (const orientation of ORIENTATIONS) {
      const svg = jpegPictureSvg(base64, 64, 32, orientation);
      const sanitized = sanitizeSvgPicture(svg);
      if (!sanitized.ok) throw new Error(sanitized.error);
      expect(sanitized.svg).toBe(svg);
      expect(sanitized.removedActive || sanitized.removedExternal).toBe(false);
      expect(sanitized.embeddedBitmaps.map(bitmap => [bitmap.format, bitmap.width, bitmap.height])).toEqual([["jpeg", 64, 32]]);
    }
  });

  it("draws a real JPEG upright for every orientation (resvg, the renderer the CLI uses)", () => {
    const original = quadrantJpeg();
    for (const orientation of ORIENTATIONS) {
      // The photo as a phone writes it: the stored pixels plus a tag saying how to turn them.
      const kept = readKeepableJpeg(withSegmentsAfterSoi(original, exifSegment(orientation)))!;
      expect(kept.orientation).toBe(orientation);
      const svg = jpegPictureSvg(bytesToBase64(kept.bytes), 64, 32, orientation);
      const rendered = new Resvg(svg).render();
      const upright = orientedJpegSize(64, 32, orientation);
      expect([rendered.width, rendered.height]).toEqual([upright.width, upright.height]);
      const pixel = (x: number, y: number) => Array.from(rendered.pixels.subarray((y * rendered.width + x) * 4, (y * rendered.width + x) * 4 + 3));
      const inset = 6;
      const corners = [pixel(inset, inset), pixel(upright.width - inset, inset), pixel(inset, upright.height - inset),
        pixel(upright.width - inset, upright.height - inset)];
      const expected = UPRIGHT_CORNERS[orientation].map(quadrant => QUADRANT_COLORS[quadrant]);
      for (const [index, color] of corners.entries()) {
        for (const [channel, value] of color.entries()) {
          expect(Math.abs(value - expected[index]![channel]!), `orientation ${orientation}, corner ${index}`).toBeLessThan(40);
        }
      }
    }
  });
});
