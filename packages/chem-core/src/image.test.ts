import { describe, expect, it } from "vitest";
import {
  createEmptyDocument, createImageGraphicObject, deserializeDocument,
  GraphicObjectSchema, isSvgImageSource, MAX_IMAGE_OBJECT_BYTES, readPngInfo, readSvgInfo, serializeDocument, validateDocument
} from "./index";

function png(width: number, height: number, density?: { x: number; y: number; unit?: number }): Uint8Array {
  // CRCs and compressed bytes are not interpreted by the chunk reader.
  const bytes = new Uint8Array(33 + (density ? 21 : 0) + 13 + 12);
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
  view.setUint32(end, 1);
  bytes.set(new TextEncoder().encode("IDAT"), end + 4);
  bytes[end + 8] = 1;
  end += 13;
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

  it("places an undensitized PNG at 96 dpi (one pixel per page unit) with the ordinary rectangle frame", () => {
    const object = createImageGraphicObject(options);
    expect(object.width).toBe(144);
    expect(object.height).toBe(72);
    expect(object.x + object.width / 2).toBe(400);
    expect(object.y + object.height / 2).toBe(300);
    expect(object).toMatchObject({ type: "graphic", graphicKind: "image", rotation: 0,
      data: { image: { mimeType: "image/png", pixelWidth: 144, pixelHeight: 72 } } });
  });

  it("accepts PNG allocation padding after IEND through creation and native loading", () => {
    const bytes = Buffer.concat([png(144, 72), Buffer.from([0, 255, 1, 2, 3])]);
    expect(readPngInfo(bytes)).toEqual({ pixelWidth: 144, pixelHeight: 72 });
    const object = createImageGraphicObject({ ...options, dataBase64: bytes.toString("base64") });
    const document = createEmptyDocument();
    document.pages[0].objects.push(object);
    expect(deserializeDocument(serializeDocument(document))).toEqual(document);
  });

  it("enforces image structure and actual and declared pixel limits when loading a document", () => {
    const object = createImageGraphicObject(options);
    const cases = [
      { dataBase64: "AAAA", reason: "the PNG has invalid structure." },
      { dataBase64: Buffer.from(png(10, 10).subarray(0, 33)).toString("base64"), reason: "the PNG has no image data." },
      { dataBase64: Buffer.from(png(20000, 20000)).toString("base64"), reason: "it is 20000 x 20000 pixels; the limit is 16384 pixels on a side." },
      { dataBase64: Buffer.from(png(9000, 9000)).toString("base64"), reason: "it is 9000 x 9000 pixels; the decoded limit is 256 MiB." },
      { pixelWidth: 20000, reason: "it is 20000 x 72 pixels; the limit is 16384 pixels on a side." }
    ];
    for (const { reason, ...image } of cases) {
      const invalidObject = { ...object, data: { image: { ...object.data.image, ...image } } };
      expect(() => GraphicObjectSchema.parse(invalidObject)).toThrow(`Image object g12: ${reason}`);
      const document = createEmptyDocument();
      const saved = { ...document, pages: [{ ...document.pages[0], objects: [invalidObject] }] };
      expect(() => deserializeDocument(JSON.stringify(saved))).toThrow(`Image object g12: ${reason}`);
    }
  });

  it("preserves SVG payloads on load without rechecking their roots or pixel limits", () => {
    const object = createImageGraphicObject(options);
    for (const source of ["<svg ", "<other/>", '<svg width="20000" height="20000"/>',
      '<s:svg xmlns:s="http://www.w3.org/2000/svg" width="10" height="10"/>']) {
      const savedObject = { ...object, data: { image: { ...object.data.image!,
        mimeType: "image/svg+xml" as const, dataBase64: Buffer.from(source).toString("base64"),
        pixelWidth: 20000, pixelHeight: 20000 } } };
      expect(GraphicObjectSchema.parse(savedObject)).toEqual(savedObject);
      const document = createEmptyDocument();
      document.pages[0].objects.push(savedObject);
      expect(deserializeDocument(serializeDocument(document))).toEqual(document);
    }
  });

  it.each([
    '<s:svg xmlns:s="http://www.w3.org/2000/svg" width="10" height="10"/>',
    '<drawing:svg xmlns:drawing="http://www.w3.org/2000/svg" width="10" height="10"><drawing:svg/></drawing:svg>'
  ])("accepts a complete namespace-prefixed SVG at paste time: %s", (source) => {
    expect(isSvgImageSource(source)).toBe(true);
    expect(readSvgInfo(source)).toEqual({ pixelWidth: 10, pixelHeight: 10, physicalSize: { width: 10, height: 10 } });
    expect(createImageGraphicObject({ ...options, mimeType: "image/svg+xml",
      dataBase64: Buffer.from(source).toString("base64") }).data.image)
      .toMatchObject({ pixelWidth: 10, pixelHeight: 10 });
  });

  it("refuses incomplete SVG roots even with explicit dimensions", () => {
    for (const source of ["<svg ", "<svg>", '<svg width="10"', "<svg><svg></svg>",
      "<svg><!-- </svg> -->", "<svg><![CDATA[</svg>]]>", '<svg><text title="</svg>"/>',
      "<s:svg ", "<s:svg>", "<s:svg></svg>", "<s:svg></other:svg>",
      "<s:svg><!-- </s:svg> -->", '<s:svg><text title="</s:svg>"/>']) {
      expect(readSvgInfo(source)).toBeUndefined();
      expect(() => createImageGraphicObject({ ...options, mimeType: "image/svg+xml", pixelWidth: 10,
        pixelHeight: 10, dataBase64: Buffer.from(source).toString("base64") }))
        .toThrow("Couldn't paste the picture: the SVG is incomplete.");
    }
    for (const source of ["<svg/>", "<svg></svg>", "<svg><svg/></svg>", "<svg><svg></svg></svg>"]) {
      expect(readSvgInfo(source)).toEqual({ pixelWidth: 300, pixelHeight: 150, physicalSize: { width: 300, height: 150 } });
    }
  });

  it("refuses missing image data, malformed chunks, and excessive decoded dimensions", () => {
    const noData = png(10, 10).subarray(0, 33);
    expect(readPngInfo(noData)).toBeUndefined();
    expect(() => createImageGraphicObject({ ...options, pixelWidth: 10, pixelHeight: 10,
      dataBase64: Buffer.from(noData).toString("base64") })).toThrow("Couldn't paste the picture: the PNG has no image data.");
    const huge = png(40000, 20000);
    expect(() => createImageGraphicObject({ ...options, pixelWidth: 1, pixelHeight: 1,
      dataBase64: Buffer.from(huge).toString("base64") })).toThrow("Couldn't paste the picture: it is 40000 x 20000 pixels; the limit is 16384 pixels on a side.");
    expect(() => createImageGraphicObject({ ...options, dataBase64: Buffer.from(png(9000, 9000)).toString("base64") })).toThrow("decoded limit is 256 MiB");
    expect(readPngInfo(png(10, 10).subarray(0, 50))).toBeUndefined();
    expect(readPngInfo(png(10, 10))).toEqual({ pixelWidth: 10, pixelHeight: 10 });
  });

  it("uses independent physical densities from pHYs, or explicit native metadata", () => {
    const object = createImageGraphicObject({ ...options,
      dataBase64: Buffer.from(png(600, 300, { x: 11811, y: 5906 })).toString("base64") });
    expect(object.width).toBeCloseTo(600 / (11811 * 0.0254) * 96);
    expect(object.height).toBeCloseTo(300 / (5906 * 0.0254) * 96);
    const override = createImageGraphicObject({ ...options,
      pixelWidth: 600, pixelHeight: 300, pixelsPerMeter: { x: 10000, y: 20000 } });
    expect(override.width).toBeCloseTo(600 / 254 * 96);
    expect(override.height).toBeCloseTo(300 / 508 * 96);
  });

  it("uses 96 page units per inch for a 288 × 144 PNG at 144 dpi", () => {
    const object = createImageGraphicObject({ ...options,
      dataBase64: Buffer.from(png(288, 144, { x: 5669, y: 5669 })).toString("base64") });
    // Integer pHYs values quantize 144 dpi to 143.993 dpi (less than 0.01 page unit).
    expect(object.width).toBeCloseTo(192, 1);
    expect(object.height).toBeCloseTo(96, 1);
    expect(object.x + object.width / 2).toBe(400);
    expect(object.y + object.height / 2).toBe(300);
  });

  it.each([
    ['width="144px" height="72px"', 144, 72],
    ['width="144pt" height="72pt"', 192, 96],
    ['width="2in" height="1in"', 192, 96],
    ['width="50.8mm" height="25.4mm"', 192, 96],
    ["width='5.08cm' height='2.54cm'", 192, 96],
    ['viewBox="10 20 240 120"', 240, 120],
    ['width="144" viewBox="0 0 2 1"', 144, 72],
    ['height="72" viewBox="0,0,2,1"', 144, 72],
    ["", 300, 150]
  ])("derives SVG size from %s", (attributes, pixelWidth, pixelHeight) => {
    const source = `<svg ${attributes}><rect width="999" height="999"/></svg>`;
    expect(readSvgInfo(source)).toEqual({ pixelWidth, pixelHeight, physicalSize: { width: pixelWidth, height: pixelHeight } });
    const object = createImageGraphicObject({ ...options, mimeType: "image/svg+xml",
      dataBase64: Buffer.from(source).toString("base64") });
    expect(object.width).toBe(pixelWidth);
    expect(object.height).toBe(pixelHeight);
  });

  it("keeps fractional SVG physical dimensions separate from integer pixel metadata through paste and save", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="1pt" height="2pt"/>';
    const info = readSvgInfo(source)!;
    expect(info).toEqual({ pixelWidth: 1, pixelHeight: 3, physicalSize: { width: 96 / 72, height: 192 / 72 } });
    const object = createImageGraphicObject({ ...options, mimeType: "image/svg+xml",
      dataBase64: Buffer.from(source).toString("base64"), pixelWidth: info.pixelWidth, pixelHeight: info.pixelHeight });
    expect(object.data.image).toMatchObject({ pixelWidth: 1, pixelHeight: 3 });
    expect(object.width).toBeCloseTo(1.333333, 3);
    expect(object.height).toBeCloseTo(2.666667, 3);
    expect(object.width / object.height).toBeCloseTo(0.5, 12);
    expect(object.x + object.width / 2).toBe(options.center.x);
    expect(object.y + object.height / 2).toBe(options.center.y);
    const document = createEmptyDocument();
    document.pages[0]!.objects = [object];
    expect(deserializeDocument(serializeDocument(document)).pages[0]!.objects[0]).toEqual(object);
  });

  it("accepts picture-less graphics and validates image payloads when present", () => {
    const object = createImageGraphicObject(options);
    const pictureless = { ...object, data: {} };
    expect(GraphicObjectSchema.parse(pictureless)).toEqual(pictureless);
    const document = createEmptyDocument();
    document.pages[0].objects.push(pictureless);
    expect(deserializeDocument(JSON.stringify(document))).toEqual(document);
    for (const dataBase64 of ["", "!!", "A", "AA=A", "a===", "data:image/png;base64,AAAA"]) {
      for (const mimeType of ["image/png", "image/svg+xml"]) {
        expect(() => GraphicObjectSchema.parse({ ...object,
          data: { image: { ...object.data.image, mimeType, dataBase64 } } })).toThrow("Image object g12 has invalid base64 image data");
      }
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
    const bytes = Buffer.alloc(MAX_IMAGE_OBJECT_BYTES);
    bytes.set(png(144, 72));
    const dataBase64 = bytes.toString("base64");
    expect(GraphicObjectSchema.safeParse({ ...object, data: { image: { ...object.data.image, dataBase64 } } }).success).toBe(true);
    expect(GraphicObjectSchema.safeParse({ ...object, data: { image: {
      ...object.data.image, mimeType: "image/svg+xml", dataBase64
    } } }).success).toBe(true);
    const document = createEmptyDocument();
    const oversizedDataBase64 = Buffer.alloc(Math.round(31.2 * 1024 * 1024)).toString("base64");
    document.pages[0].objects.push({ ...object, data: { image: { ...object.data.image!,
      dataBase64: oversizedDataBase64 } } });
    const result = validateDocument(document);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContainEqual({
      path: "pages.0.objects.0.data.image.dataBase64", message: "Image object g12 is 31.2 MB; the limit is 25 MB."
    });
    expect(() => GraphicObjectSchema.parse({ ...object, data: { image: {
      ...object.data.image, mimeType: "image/svg+xml", dataBase64: oversizedDataBase64
    } } })).toThrow("Image object g12 is 31.2 MB; the limit is 25 MB.");
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
