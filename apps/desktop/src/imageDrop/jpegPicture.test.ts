// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import { readSvgInfo } from "@chemdraft/chem-core";
import { sanitizeSvgPicture } from "@chemdraft/export-engine";
import {
  jpegOrientationMatrix, jpegPictureSvg, jpegPictureSvgLength, orientedJpegSize, readKeepableJpeg, type JpegOrientation
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
