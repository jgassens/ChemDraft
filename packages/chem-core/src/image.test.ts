import { describe, expect, it } from "vitest";
import {
  createEmptyDocument, createImageGraphicObject, deserializeDocument, DOCUMENT_STYLE_UNITS_PER_PT,
  GraphicObjectSchema, MAX_IMAGE_OBJECT_BYTES, readPngInfo, readSvgInfo, serializeDocument, validateDocument
} from "./index";

function png(width: number, height: number, density?: { x: number; y: number; unit?: number }): Uint8Array {
  // Metadata-only PNG fixture: CRCs are irrelevant to the header reader (it does not decode PNG).
  const bytes = new Uint8Array(33 + (density ? 21 : 0) + 12);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  let end = 33;
  if (density) {
    view.setUint32(33, 9);
    bytes.set(new TextEncoder().encode("pHYs"), 37);
    view.setUint32(41, density.x);
    view.setUint32(45, density.y);
    bytes[49] = density.unit ?? 1;
    end += 21;
  }
  bytes.set(new TextEncoder().encode("IEND"), end + 4);
  return bytes;
}

const options = {
  id: "g12", mimeType: "image/png" as const, center: { x: 400, y: 300 },
  dataBase64: Buffer.from(png(144, 72)).toString("base64")
};

describe("embedded picture graphics", () => {
  it("reads IHDR and pHYs using the Uint8Array's actual offset", () => {
    const bytes = png(300, 150, { x: 11811, y: 5906 });
    const padded = new Uint8Array(bytes.length + 10);
    padded.set(bytes, 5);
    expect(readPngInfo(padded.subarray(5, -5))).toEqual({
      pixelWidth: 300, pixelHeight: 150, pixelsPerMeter: { x: 11811, y: 5906 }
    });
    expect(readPngInfo(png(300, 150, { x: 10, y: 20, unit: 0 }))).toEqual({ pixelWidth: 300, pixelHeight: 150 });
    expect(readPngInfo(png(300, 150, { x: 0, y: 20 }))).not.toHaveProperty("pixelsPerMeter");
    expect(readPngInfo(bytes.subarray(0, 45))).toBeUndefined();
    expect(readPngInfo(png(0, 100))).toBeUndefined();
    expect(readPngInfo(new Uint8Array(33))).toBeUndefined();
  });

  it("places an undensitized PNG at 72 dpi with the ordinary rectangle frame", () => {
    const object = createImageGraphicObject(options);
    expect(object.width).toBeCloseTo(144 * DOCUMENT_STYLE_UNITS_PER_PT);
    expect(object.height).toBeCloseTo(72 * DOCUMENT_STYLE_UNITS_PER_PT);
    expect(object.x + object.width / 2).toBe(400);
    expect(object.y + object.height / 2).toBe(300);
    expect(object).toMatchObject({ type: "graphic", graphicKind: "image", rotation: 0,
      data: { image: { mimeType: "image/png", pixelWidth: 144, pixelHeight: 72 } } });
  });

  it("uses independent physical densities from pHYs, or explicit native metadata", () => {
    const object = createImageGraphicObject({ ...options,
      dataBase64: Buffer.from(png(600, 300, { x: 11811, y: 5906 })).toString("base64") });
    expect(object.width).toBeCloseTo(600 / (11811 * 0.0254) * 72 * DOCUMENT_STYLE_UNITS_PER_PT);
    expect(object.height).toBeCloseTo(300 / (5906 * 0.0254) * 72 * DOCUMENT_STYLE_UNITS_PER_PT);
    const override = createImageGraphicObject({ ...options,
      pixelWidth: 600, pixelHeight: 300, pixelsPerMeter: { x: 10000, y: 20000 } });
    expect(override.width).toBeCloseTo(600 / 254 * 72 * DOCUMENT_STYLE_UNITS_PER_PT);
    expect(override.height).toBeCloseTo(300 / 508 * 72 * DOCUMENT_STYLE_UNITS_PER_PT);
  });

  it.each([
    ['width="144px" height="72px"', 144, 72],
    ['width="144pt" height="72pt"', 144, 72],
    ['width="2in" height="1in"', 144, 72],
    ['width="50.8mm" height="25.4mm"', 144, 72],
    ["width='5.08cm' height='2.54cm'", 144, 72],
    ['viewBox="10 20 240 120"', 240, 120],
    ['width="144" viewBox="0 0 2 1"', 144, 72],
    ['height="72" viewBox="0,0,2,1"', 144, 72],
    ["", 300, 150]
  ])("derives SVG size from %s", (attributes, pixelWidth, pixelHeight) => {
    const source = `<svg ${attributes}><rect width="999" height="999"/></svg>`;
    expect(readSvgInfo(source)).toEqual({ pixelWidth, pixelHeight });
    const object = createImageGraphicObject({ ...options, mimeType: "image/svg+xml",
      dataBase64: Buffer.from(source).toString("base64") });
    expect(object.width).toBeCloseTo(pixelWidth * DOCUMENT_STYLE_UNITS_PER_PT);
    expect(object.height).toBeCloseTo(pixelHeight * DOCUMENT_STYLE_UNITS_PER_PT);
  });

  it("requires the image payload, decodable base64, positive integer dimensions and strict keys", () => {
    const object = createImageGraphicObject(options);
    expect(() => GraphicObjectSchema.parse({ ...object, data: {} })).toThrow("Image object g12 has no picture data (data.image or data.imageHref).");
    for (const dataBase64 of ["", "!!", "A", "AA=A", "a===", "data:image/png;base64,AAAA"]) {
      expect(() => GraphicObjectSchema.parse({ ...object,
        data: { image: { ...object.data.image, dataBase64 } } })).toThrow("Image object g12 has invalid base64 image data");
    }
    for (const field of [{ pixelWidth: 0 }, { pixelHeight: 1.5 }, { mimeType: "image/jpeg" },
      { pixelsPerMeter: { x: -1, y: 2 } }, { extra: true }]) {
      expect(GraphicObjectSchema.safeParse({ ...object, data: { image: { ...object.data.image, ...field } } }).success).toBe(false);
    }
    expect(GraphicObjectSchema.safeParse({ ...object, graphicKind: "rect", data: {} }).success).toBe(true);
  });

  it("accepts older imageHref graphics standalone and through native document loading", () => {
    const object = { ...createImageGraphicObject(options), data: {
      imageHref: "data:image/png;base64,AAAA", imageMimeType: "image/png"
    } };
    expect(GraphicObjectSchema.parse(object)).toEqual(object);
    const document = createEmptyDocument();
    document.pages[0].objects.push(object);
    expect(deserializeDocument(JSON.stringify(document))).toEqual(document);
  });

  it("accepts the exact decoded cap and gives object-specific over-cap errors through native validation", () => {
    expect(MAX_IMAGE_OBJECT_BYTES).toBe(25 * 1024 * 1024);
    const object = createImageGraphicObject(options);
    const dataBase64 = Buffer.alloc(MAX_IMAGE_OBJECT_BYTES).toString("base64");
    expect(GraphicObjectSchema.safeParse({ ...object, data: { image: { ...object.data.image, dataBase64 } } }).success).toBe(true);
    const document = createEmptyDocument();
    document.pages[0].objects.push({ ...object, data: { image: { ...object.data.image!,
      dataBase64: Buffer.alloc(Math.round(31.2 * 1024 * 1024)).toString("base64") } } });
    const result = validateDocument(document);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContainEqual({
      path: "pages.0.objects.0.data.image.dataBase64", message: "Image object g12 is 31.2 MB; the limit is 25 MB."
    });
    expect(() => createImageGraphicObject({ ...options, dataBase64: "!" })).toThrow("invalid base64");
  });

  it("preserves PNG and SVG bytes, metadata and frame exactly through native save/load", () => {
    const document = createEmptyDocument();
    const source = '<?xml version="1.0"?>\r\n<svg width="72pt" height="36pt"><text>δ &amp; Δ</text></svg>';
    document.pages[0].objects.push(createImageGraphicObject({ ...options,
      dataBase64: Buffer.from(png(300, 150, { x: 11811, y: 11811 })).toString("base64") }),
    createImageGraphicObject({ ...options, id: "svg", mimeType: "image/svg+xml", dataBase64: Buffer.from(source).toString("base64") }));
    expect(deserializeDocument(serializeDocument(document))).toEqual(document);
    expect(document.schema).toBe("chemdraft.document.v1");
  });
});
