// @vitest-environment jsdom
/**
 * A dropped JPEG kept as its own bytes travels as a one-element SVG picture. The canvas draws that SVG;
 * SVG and PDF export read the JPEG back out and draw it themselves (see `jpegPicture.ts`).
 */
import { describe, expect, it, vi } from "vitest";
import { createEmptyDocument, createImageGraphicObject, type ChemDraftDocument } from "@chemdraft/chem-core";
import {
  jpegOrientationMatrix, jpegPicturePlacement, jpegPictureSvg, orientedJpegSize, readJpegPicture, readJpegPictureSvg,
  type JpegOrientation
} from "./jpegPicture";
import { exportDocumentToPdf, pdfEmbeddableJpegFrame } from "./pdf";
import { documentStyleSvg, exportDocumentToSvg } from "./svg";

const ORIENTATIONS: JpegOrientation[] = [1, 2, 3, 4, 5, 6, 7, 8];

const segment = (marker: number, payload: readonly number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];

interface JpegShape {
  width: number;
  height: number;
  frame?: number;
  precision?: number;
  components?: number;
  /** Write the Huffman table before the frame, as some encoders do. */
  tablesFirst?: boolean;
  /** Start with the frame (no quantisation table before it). */
  frameFirst?: boolean;
  fill?: boolean;
}

/** A structurally complete JPEG (it decodes to nothing; the PDF writer reads only its structure). */
function jpeg(shape: JpegShape): Uint8Array {
  const { width, height, frame = 0xc0, precision = 8, components = 3 } = shape;
  const sof = segment(frame, [precision, height >> 8, height & 0xff, width >> 8, width & 0xff, components,
    ...Array.from({ length: components }, (_, index) => [index + 1, 0x11, 0]).flat()]);
  const dqt = segment(0xdb, [0x00, ...Array.from({ length: 64 }, () => 1)]);
  const dht = segment(0xc4, [0x00, 0, 1, ...Array.from({ length: 14 }, () => 0), 0]);
  const sos = segment(0xda, [components, ...Array.from({ length: components }, (_, index) => [index + 1, 0]).flat(), 0, 0x3f, 0]);
  const body = shape.frameFirst ? [...sof, ...dqt, ...dht] : shape.tablesFirst ? [...dqt, ...dht, ...sof] : [...dqt, ...sof, ...dht];
  return new Uint8Array([0xff, 0xd8, ...(shape.fill ? [0xff] : []), ...body, ...sos, 0x12, 0x34, 0x56, 0xff, 0xd9]);
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A document holding the kept-JPEG picture of `bytes` (stored `width` × `height`) at `orientation`. */
function keptJpegDocument(bytes: Uint8Array, width: number, height: number, orientation: JpegOrientation): ChemDraftDocument {
  const document = createEmptyDocument();
  const svg = jpegPictureSvg(base64(bytes), width, height, orientation);
  document.pages[0]!.objects = [createImageGraphicObject({ id: "photo", mimeType: "image/svg+xml",
    dataBase64: Buffer.from(svg).toString("base64"), center: { x: 300, y: 300 } })];
  return document;
}

describe("the kept-JPEG SVG picture", () => {
  it("reads back exactly what it writes, for every orientation", () => {
    const data = base64(jpeg({ width: 30, height: 20 }));
    for (const orientation of ORIENTATIONS) {
      expect(readJpegPictureSvg(jpegPictureSvg(data, 30, 20, orientation))).toEqual({ jpegBase64: data, width: 30, height: 20, orientation });
      const svg = jpegPictureSvg(data, 30, 20, orientation);
      expect(readJpegPicture({ mimeType: "image/svg+xml", dataBase64: Buffer.from(svg).toString("base64") })?.orientation).toBe(orientation);
    }
  });

  it("is nothing but that form: any other SVG picture is left an SVG picture", () => {
    const data = base64(jpeg({ width: 30, height: 20 }));
    const kept = jpegPictureSvg(data, 30, 20, 6);
    for (const other of [
      kept.replace('preserveAspectRatio="none"', 'preserveAspectRatio="none" opacity="0.5"'),
      kept.replace("matrix(0 1 -1 0 20 0)", "matrix(0 1 -1 0 21 0)"),
      kept.replace('viewBox="0 0 20 30"', 'viewBox="0 0 20 31"'),
      kept.replace('width="20" height="30"', 'width="30" height="20"'),
      kept.replace("data:image/jpeg", "data:image/png"),
      kept.replace("</svg>", "<rect/></svg>"),
      jpegPictureSvg(`${data}"/><script>alert(1)</script><image href="x`, 30, 20, 1),
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect width="2" height="1"/></svg>'
    ]) {
      expect(readJpegPictureSvg(other), other.slice(0, 200)).toBeUndefined();
      expect(readJpegPicture({ mimeType: "image/svg+xml", dataBase64: Buffer.from(other).toString("base64") })).toBeUndefined();
    }
    expect(readJpegPicture({ mimeType: "image/png", dataBase64: Buffer.from(kept).toString("base64") })).toBeUndefined();
    expect(readJpegPicture({ mimeType: "image/svg+xml", dataBase64: "not base64!" })).toBeUndefined();
  });

  it("places the stored box so its corners land where the orientation map puts them, about the frame's centre", () => {
    const frame = { x: 100, y: 50, width: 40, height: 60 };
    for (const orientation of ORIENTATIONS) {
      const stored = orientation >= 5 ? { width: 60, height: 40 } : { width: 40, height: 60 };
      const { box, matrix } = jpegPicturePlacement(frame, orientation);
      expect([box.width, box.height]).toEqual([stored.width, stored.height]);
      expect([box.x + box.width / 2, box.y + box.height / 2]).toEqual([120, 80]);
      const reference = jpegOrientationMatrix(stored.width, stored.height, orientation) ?? [1, 0, 0, 1, 0, 0];
      const m = matrix ?? [1, 0, 0, 1, 0, 0];
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const local = [u * stored.width, v * stored.height] as const;
        const expected = [reference[0] * local[0] + reference[2] * local[1] + reference[4] + frame.x,
          reference[1] * local[0] + reference[3] * local[1] + reference[5] + frame.y];
        const point = [box.x + local[0], box.y + local[1]] as const;
        const actual = [m[0] * point[0] + m[2] * point[1] + m[4], m[1] * point[0] + m[3] * point[1] + m[5]];
        expect(actual, `orientation ${orientation}, corner ${u} ${v}`).toEqual(expected);
      }
      expect(orientedJpegSize(stored.width, stored.height, orientation)).toEqual({ width: 40, height: 60 });
    }
  });
});

describe("SVG export of a kept JPEG", () => {
  it("writes the JPEG itself with its transform, and leaves every other SVG picture as it was", () => {
    const bytes = jpeg({ width: 30, height: 20 });
    const document = keptJpegDocument(bytes, 30, 20, 6);
    const picture = document.pages[0]!.objects[0]!;
    const svg = exportDocumentToSvg(document, { outputWidth: document.pages[0]!.width, outputHeight: document.pages[0]!.height }).contents;
    expect(svg).toContain(`href="data:image/jpeg;base64,${base64(bytes)}"`);
    expect(svg).not.toContain("data:image/svg+xml");
    const cx = picture.x + picture.width / 2, cy = picture.y + picture.height / 2;
    expect(svg).toContain(`<image x="${cx - 15}" y="${cy - 10}" width="30" height="20" transform="matrix(0 1 -1 0 ${cx + cy} ${cy - cx})"`);
    // Upright as stored: no transform at all.
    const upright = exportDocumentToSvg(keptJpegDocument(bytes, 30, 20, 1)).contents;
    expect(upright).toContain(`href="data:image/jpeg;base64,${base64(bytes)}"`);
    expect(upright).not.toContain("transform=\"matrix");

    const plain = createEmptyDocument();
    const vector = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect width="2" height="1" fill="red"/></svg>';
    plain.pages[0]!.objects = [createImageGraphicObject({ id: "vector", mimeType: "image/svg+xml",
      dataBase64: Buffer.from(vector).toString("base64"), center: { x: 100, y: 100 } })];
    expect(exportDocumentToSvg(plain).contents).toContain(`href="data:image/svg+xml;base64,${Buffer.from(vector).toString("base64")}"`);
  });

  it("keeps a quarter-turned JPEG's swapped box through the document-style resize", () => {
    const document = keptJpegDocument(jpeg({ width: 30, height: 20 }), 30, 20, 6);
    const picture = document.pages[0]!.objects[0]!;
    const svg = exportDocumentToSvg(document, { outputWidth: document.pages[0]!.width, outputHeight: document.pages[0]!.height }).contents;
    const styled = documentStyleSvg(svg, { x: picture.x, y: picture.y, width: picture.width, height: picture.height }).svg;
    const tag = /<image\b[^>]*>/.exec(styled)![0];
    const number = (name: string) => Number(new RegExp(`\\b${name}="([^"]*)"`).exec(tag)![1]);
    // Wider than tall, like the stored picture, and centred where the picture is.
    expect(number("width")).toBeGreaterThan(number("height"));
    expect(number("width") / number("height")).toBeCloseTo(30 / 20, 6);
    expect(number("x") + number("width") / 2).toBeCloseTo(picture.x + picture.width / 2, 6);
    expect(number("y") + number("height") / 2).toBeCloseTo(picture.y + picture.height / 2, 6);
    expect(tag).toContain('transform="matrix(0 1 -1 0 ');
  });
});

describe("PDF export of a kept JPEG", () => {
  it("embeds the JPEG's own bytes (DCTDecode), not a raster of its SVG", async () => {
    const bytes = jpeg({ width: 30, height: 20 });
    const rasterize = vi.fn();
    const pdf = await exportDocumentToPdf(keptJpegDocument(bytes, 30, 20, 6), { compress: false, rasterizeSvgPicture: rasterize });
    expect(pdf.warnings).toEqual([]);
    expect(rasterize).not.toHaveBeenCalled();
    const text = Buffer.from(pdf.bytes).toString("latin1");
    expect(text).toMatch(/\/Filter\s*\/DCTDecode/);
    expect(text).toContain(Buffer.from(bytes).toString("latin1"));
    // A turned picture is placed by a matrix whose linear part is the quarter turn.
    expect(text).toMatch(/\n0\.? 1\.? -1\.? 0\.? [\d.-]+ [\d.-]+ cm\n/);
  });

  it.each<[string, JpegShape]>([
    ["CMYK", { width: 30, height: 20, components: 4 }],
    ["a Huffman table before the frame", { width: 30, height: 20, tablesFirst: true }],
    ["the frame as the first segment", { width: 30, height: 20, frameFirst: true }],
    ["fill bytes", { width: 30, height: 20, fill: true }],
    ["arithmetic coding", { width: 30, height: 20, frame: 0xc9 }],
    ["lossless coding", { width: 30, height: 20, frame: 0xc3 }],
    ["12-bit samples", { width: 30, height: 20, precision: 12 }]
  ])("rasterises the picture's SVG instead when the JPEG has %s", async (_label, shape) => {
    const bytes = jpeg(shape);
    expect(pdfEmbeddableJpegFrame(bytes)).toBeUndefined();
    const rasterize = vi.fn(async () => { throw new Error("no rasteriser in this test"); });
    const pdf = await exportDocumentToPdf(keptJpegDocument(bytes, 30, 20, 1), { compress: false, rasterizeSvgPicture: rasterize });
    expect(rasterize).toHaveBeenCalledTimes(1);
    expect(pdf.warnings.map(warning => warning.code)).toEqual(["export.pdf.svg_picture_not_drawn"]);
    expect(Buffer.from(pdf.bytes).toString("latin1")).not.toContain("DCTDecode");
  });

  it("embeds baseline and progressive greyscale and colour JPEGs", () => {
    for (const shape of [{ width: 30, height: 20 }, { width: 7, height: 9, components: 1 }, { width: 30, height: 20, frame: 0xc2 },
      { width: 30, height: 20, frame: 0xc1 }]) {
      expect(pdfEmbeddableJpegFrame(jpeg(shape))).toEqual({ width: shape.width, height: shape.height });
    }
    expect(pdfEmbeddableJpegFrame(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
  });
});
