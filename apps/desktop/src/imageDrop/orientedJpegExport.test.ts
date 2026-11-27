// @vitest-environment jsdom
/**
 * A portrait phone photo (EXIF orientation 6) dropped and then drawn everywhere a picture is drawn:
 * the canvas, SVG export, PDF export, raster export (and Copy as PNG, which is the same path), Copy,
 * CDXML and copy-paste. Wherever pixels come out, they are rendered for real (resvg) and the photo's
 * four quadrants must be where an upright photo has them. The canvas draws the stored SVG picture;
 * every export draws the JPEG itself (`export-engine/jpegPicture.ts`), so each orientation is also
 * checked for canvas/export parity.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import type { ChemDraftDocument, GraphicObject } from "@chemdraft/chem-core";
import { documentStyleSvg, orientedJpegSize, readJpegPicture, readRasterHeaderSize, type JpegOrientation } from "@chemdraft/export-engine";
import {
  createPhase4Document, createSelectionClipboardPayload, exportPhase4Cdxml, exportPhase4Pdf, exportPhase4Svg, openNativeDocument,
  parseSelectionClipboardPayload, pasteSelectionClipboardPayload, serializeSelectionClipboardPayload
} from "../documentWorkflow";
import { graphicArtTransformPreviewSvgDataUrl } from "../MainWindow";
import { rasterizeSvgNative } from "../nativeRasterExport";
import { prepareRasterPictures, type PicturePixelDecoder } from "../rasterPictureDecode";
import { selectionClipboardImageItems } from "../selectionClipboard";
import { embeddedBitmapPictureStep } from "../svgPicture/rasterEmbeddedBitmaps";
import { insertDroppedImages } from "./insertDroppedImages";
import { QUADRANT_COLORS, exifSegment, quadrantJpeg, withSegmentsAfterSoi, type Quadrant } from "./jpegTestImages";
import { prepareDroppedImage } from "./prepareDroppedImage";
import type { DroppedImageDecoders } from "./rasterDecode";

const native = vi.hoisted(() => ({ invoke: vi.fn(), rasterized: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: native.invoke }));
// The webview rasteriser (jsdom has no canvas) is resvg here, so its output is real pixels.
vi.mock("../svgPicture/svgPictureRaster", () => ({ rasterizeSvgPicture: native.rasterized }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

/** The fixture's stored corners a b / c d, upright for orientation 6: c a / d b. */
const UPRIGHT: [Quadrant, Quadrant, Quadrant, Quadrant] = ["c", "a", "d", "b"];

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * How a browser draws an `<image>` whose href is an SVG picture: that SVG's content in a nested
 * viewport over the image's box. resvg draws no bitmap inside a nested SVG image (usvg refuses images
 * in a sub-SVG; the app's native raster export rasterises such pictures first for the same reason),
 * so SVG pictures are inlined before rendering a canvas glyph or an exported page.
 */
function inlinePictureSvgs(svg: string): string {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  for (const image of Array.from(document.getElementsByTagNameNS(SVG_NS, "image"))) {
    const match = /^data:image\/svg\+xml;base64,(.*)$/.exec(image.getAttribute("href") ?? "");
    if (!match) continue;
    const picture = new DOMParser().parseFromString(atob(match[1]!), "image/svg+xml").documentElement;
    const nested = document.createElementNS(SVG_NS, "svg");
    for (const name of ["x", "y", "width", "height", "preserveAspectRatio"]) {
      const value = image.getAttribute(name);
      if (value !== null) nested.setAttribute(name, value);
    }
    nested.setAttribute("viewBox", picture.getAttribute("viewBox")!);
    for (const child of Array.from(picture.childNodes)) nested.appendChild(document.importNode(child, true));
    const transform = image.getAttribute("transform");
    if (transform) {
      const group = document.createElementNS(SVG_NS, "g");
      group.setAttribute("transform", transform);
      group.appendChild(nested);
      image.replaceWith(group);
    } else image.replaceWith(nested);
  }
  return new XMLSerializer().serializeToString(document);
}

/** Renders `svg` to `width` × `height` pixels with resvg, as a PNG and as RGBA. */
function render(svg: string, width?: number) {
  const image = new Resvg(svg, width ? { fitTo: { mode: "width", value: width } } : {}).render();
  return { png: new Uint8Array(image.asPng()), width: image.width, height: image.height, rgba: image.pixels };
}

/** The colours at the four corners of the box `x, y, width, height` of a rendering, inset by a sixth. */
function corners(rendered: { width: number; rgba: Uint8Array }, box: { x: number; y: number; width: number; height: number }) {
  const at = (fx: number, fy: number) => {
    const x = Math.round(box.x + box.width * fx);
    const y = Math.round(box.y + box.height * fy);
    return Array.from(rendered.rgba.subarray((y * rendered.width + x) * 4, (y * rendered.width + x) * 4 + 3));
  };
  return [at(1 / 6, 1 / 6), at(5 / 6, 1 / 6), at(1 / 6, 5 / 6), at(5 / 6, 5 / 6)];
}

function expectUpright(colors: number[][], label: string) {
  for (const [index, color] of colors.entries()) {
    const expected = QUADRANT_COLORS[UPRIGHT[index]!];
    for (const [channel, value] of color.entries()) {
      expect(Math.abs(value - expected[channel]!), `${label}: corner ${index} is ${color}, expected ${expected}`).toBeLessThan(48);
    }
  }
}

const pictures = (document: ChemDraftDocument) =>
  document.pages[0]!.objects.filter((object): object is GraphicObject => object.type === "graphic" && object.graphicKind === "image");

async function droppedPortrait(orientation: JpegOrientation = 6): Promise<{ document: ChemDraftDocument; picture: GraphicObject }> {
  const phonePhoto = withSegmentsAfterSoi(quadrantJpeg(), exifSegment(orientation));
  const decoders: DroppedImageDecoders = {
    rasterToPng: async () => { throw new Error("a JPEG is never converted"); },
    rasterToJpeg: async () => { throw new Error("the photo is under the side cap"); },
    decodeCheck: async () => ({ width: 64, height: 32 })
  };
  const result = await prepareDroppedImage("portrait.jpg", phonePhoto, decoders);
  if (!result.ok) throw new Error(result.reason);
  const document = insertDroppedImages(createPhase4Document("Portrait"), [result.image], { x: 300, y: 300 }).document;
  const [picture] = pictures(document);
  // The stored picture is 64 × 32; upright it is 32 × 64 (orientations 5-8), and the frame follows.
  const upright = orientedJpegSize(64, 32, orientation);
  expect([picture!.width, picture!.height]).toEqual([upright.width, upright.height]);
  return { document, picture: picture! };
}

type Matrix = [number, number, number, number, number, number];
type Point = [number, number];
const apply = (m: Matrix, [x, y]: Point): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const multiply = (m: Matrix, n: Matrix): Matrix =>
  [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

/** The exported `<image>` of the picture: its box, transform and href. */
function exportedImage(svg: string) {
  const image = new DOMParser().parseFromString(svg, "image/svg+xml").getElementsByTagNameNS(SVG_NS, "image")[0]!;
  const number = (name: string) => Number(image.getAttribute(name));
  const transform = /^matrix\(([^)]*)\)$/.exec(image.getAttribute("transform") ?? "");
  return {
    box: { x: number("x"), y: number("y"), width: number("width"), height: number("height") },
    matrix: (transform ? transform[1]!.split(" ").map(Number) : [1, 0, 0, 1, 0, 0]) as Matrix,
    href: image.getAttribute("href")!
  };
}

/** Where SVG export draws the stored picture's top-left, top-right and bottom-left corners, in page units. */
function svgStoredCorners(svg: string): Point[] {
  const { box, matrix } = exportedImage(svg);
  return ([[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height]] as Point[]).map(point => apply(matrix, point));
}

/**
 * The images an uncompressed PDF draws: each `Do` with the matrix it is drawn under (every `cm` on
 * the graphics-state stack, PDF points, y up), and the XObject's dictionary and stream.
 */
function pdfImageDraws(bytes: Uint8Array): Array<{ matrix: Matrix; dictionary: string; stream: Buffer }> {
  const text = Buffer.from(bytes).toString("latin1");
  const objects = new Map([...text.matchAll(/(\d+) 0 obj\n?([\s\S]*?)endobj/g)].map(match => [Number(match[1]), match[2]!]));
  const streamOf = (object: string) => {
    const start = object.indexOf("stream") + "stream".length + (object[object.indexOf("stream") + 6] === "\r" ? 2 : 1);
    return Buffer.from(object.slice(start, start + Number(/\/Length (\d+)/.exec(object)![1])), "latin1");
  };
  const names = new Map([...text.matchAll(/\/(I\d+) (\d+) 0 R/g)].map(match => [match[1]!, Number(match[2])]));
  const draws: Array<{ matrix: Matrix; dictionary: string; stream: Buffer }> = [];
  for (const object of objects.values()) {
    if (!object.includes("stream") || object.includes("/Subtype /Image") || object.includes("/Subtype/Image")) continue;
    const content = streamOf(object).toString("latin1");
    const stack: Matrix[] = [];
    let current: Matrix = [1, 0, 0, 1, 0, 0];
    for (const token of content.matchAll(/(?:^|\s)(q|Q)(?=\s|$)|((?:-?[\d.]+\s+){6})cm|\/(I\d+)\s+Do/g)) {
      if (token[1] === "q") stack.push(current);
      else if (token[1] === "Q") current = stack.pop()!;
      else if (token[2]) current = multiply(current, token[2].trim().split(/\s+/).map(Number) as Matrix);
      else if (token[3]) {
        const image = objects.get(names.get(token[3])!)!;
        draws.push({ matrix: current, dictionary: image.slice(0, image.indexOf("stream")), stream: streamOf(image) });
      }
    }
  }
  return draws;
}

/**
 * Where a PDF draws the stored picture's top-left, top-right and bottom-left corners, in page units
 * (y down). An image's first row is the top of its unit square: stored top-left is (0, 1).
 */
function pdfStoredCorners(matrix: Matrix, page: { height: number }): Point[] {
  const pt = 72 / 96;
  return ([[0, 1], [1, 1], [0, 0]] as Point[]).map(point => {
    const [x, y] = apply(matrix, point);
    return [x / pt, (page.height * pt - y) / pt];
  });
}

const expectPoints = (actual: Point[], expected: Point[], label: string) => actual.forEach((point, index) => {
  expect(point[0], `${label}: point ${index} x`).toBeCloseTo(expected[index]![0], 3);
  expect(point[1], `${label}: point ${index} y`).toBeCloseTo(expected[index]![1], 3);
});

/** The webview's decoder, played by resvg: a JPEG's own pixels at its stored size. */
const resvgDecode: PicturePixelDecoder = async (bytes, mimeType) => {
  const size = readRasterHeaderSize(mimeType === "image/jpeg" ? "jpeg" : "png", bytes)!;
  const rendered = render(`<svg xmlns="${SVG_NS}" width="${size.width}" height="${size.height}"><image width="${size.width}" height="${size.height}" `
    + `href="data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}"/></svg>`);
  return { width: rendered.width, height: rendered.height, rgba: rendered.rgba };
};

/** What the native renderer does with prepared pictures: draws each one's pixels where usvg places its `<image>`. */
async function drawPreparedPictures(svg: string, decode: PicturePixelDecoder, pixels: Map<string, Uint8Array>): Promise<string> {
  const prepared = await prepareRasterPictures(svg, { decode });
  const document = new DOMParser().parseFromString(prepared.svg, "image/svg+xml");
  for (const picture of prepared.pictures) {
    expect("refused" in picture, `picture ${picture.id} was refused`).toBe(false);
    const image = document.getElementById(picture.id)!;
    image.setAttribute("href", `data:image/png;base64,${Buffer.from(pixels.get(picture.id)!).toString("base64")}`);
  }
  return new XMLSerializer().serializeToString(document);
}


describe("a dropped portrait JPEG is upright wherever it is drawn", () => {
  it("on the canvas: the glyph draws the picture's own SVG stretched over its frame", async () => {
    const { picture } = await droppedPortrait();
    const glyph = graphicArtTransformPreviewSvgDataUrl(picture)!;
    expect(glyph.imageUrl).toBe(`data:image/svg+xml;base64,${picture.data.image!.dataBase64}`);
    // GraphicGlyph's markup: `viewBox 0 0 width height`, the picture stretched over it.
    const canvasSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${glyph.width}" height="${glyph.height}" viewBox="0 0 ${glyph.width} ${glyph.height}">`
      + `<image href="${glyph.imageUrl}" x="0" y="0" width="${glyph.width}" height="${glyph.height}" preserveAspectRatio="none"/></svg>`;
    const rendered = render(inlinePictureSvgs(canvasSvg), 64);
    expectUpright(corners(rendered, { x: 0, y: 0, width: rendered.width, height: rendered.height }), "canvas");
  });

  it("in SVG export: the JPEG itself, turned upright by its own transform, which resvg draws as it is", async () => {
    const { document, picture } = await droppedPortrait();
    const page = document.pages[0]!;
    const svg = (await exportPhase4Svg(document, { outputWidth: page.width, outputHeight: page.height })).contents;
    const jpeg = readJpegPicture(picture.data.image!)!;
    expect(svg).toContain(`href="data:image/jpeg;base64,${jpeg.jpegBase64}"`);
    expect(svg).not.toContain("data:image/svg+xml");
    // The stored 64 × 32 box, centred on the 32 × 64 frame and turned a quarter about its centre.
    const cx = picture.x + 16, cy = picture.y + 32;
    expect(exportedImage(svg)).toMatchObject({ box: { x: cx - 32, y: cy - 16, width: 64, height: 32 }, matrix: [0, 1, -1, 0, cx + cy, cy - cx] });
    const scale = 2;
    const rendered = render(svg, page.width * scale);
    expectUpright(corners(rendered, { x: picture.x * scale, y: picture.y * scale, width: picture.width * scale, height: picture.height * scale }),
      "SVG export");
  });

  it("in document-style SVG (the CLI's): the frame is resized about its centre and the turned box follows it", async () => {
    const { document, picture } = await droppedPortrait();
    const page = document.pages[0]!;
    const svg = (await exportPhase4Svg(document, { outputWidth: page.width, outputHeight: page.height })).contents;
    const styled = documentStyleSvg(svg, { x: picture.x - 4, y: picture.y - 4, width: picture.width + 8, height: picture.height + 8 });
    const { box, matrix } = exportedImage(styled.svg);
    // The physical frame keeps 96 units an inch, so its sides are the same here; it stays a portrait.
    const drawn = [apply(matrix, [box.x, box.y]), apply(matrix, [box.x + box.width, box.y + box.height])];
    const frame = { x: Math.min(drawn[0]![0], drawn[1]![0]), y: Math.min(drawn[0]![1], drawn[1]![1]),
      width: Math.abs(drawn[1]![0] - drawn[0]![0]), height: Math.abs(drawn[1]![1] - drawn[0]![1]) };
    expect(frame.height).toBeGreaterThan(frame.width);
    expect(frame.x + frame.width / 2).toBeCloseTo(picture.x + picture.width / 2, 6);
    expect(frame.y + frame.height / 2).toBeCloseTo(picture.y + picture.height / 2, 6);
    const scale = Number(/scale\(([\d.]+)\)/.exec(styled.svg)![1]);
    const rendered = render(styled.svg, Math.round(styled.viewBox.width * 4));
    const perPt = rendered.width / styled.viewBox.width;
    expectUpright(corners(rendered, { x: (frame.x * scale - styled.viewBox.x) * perPt, y: (frame.y * scale - styled.viewBox.y) * perPt,
      width: frame.width * scale * perPt, height: frame.height * scale * perPt }), "document-style SVG");
  });

  it("in PDF export: the JPEG's own bytes (DCTDecode), placed upright by the matrix, with no rasteriser", async () => {
    const { document, picture } = await droppedPortrait();
    const rasterize = vi.fn();
    const pdf = await exportPhase4Pdf(document, { compress: false, rasterizeSvgPicture: rasterize });
    expect(pdf.warnings).toEqual([]);
    expect(rasterize).not.toHaveBeenCalled();
    const draws = pdfImageDraws(pdf.bytes);
    expect(draws).toHaveLength(1);
    const [draw] = draws;
    expect(draw!.dictionary).toMatch(/\/Filter\s*\/DCTDecode/);
    expect(draw!.dictionary).toMatch(/\/Width 64\b/);
    expect(draw!.dictionary).toMatch(/\/Height 32\b/);
    expect(draw!.stream.equals(Buffer.from(readJpegPicture(picture.data.image!)!.jpegBase64, "base64"))).toBe(true);
    // An upright orientation-6 photo has its stored top-left at the frame's top right, its stored top
    // right at the bottom right, and its stored bottom left at the top left.
    const { x, y, width, height } = picture;
    expectPoints(pdfStoredCorners(draw!.matrix, document.pages[0]!), [[x + width, y], [x + width, y + height], [x, y]], "PDF");
  });

  it("in PNG export and Copy as PNG: the webview decodes the JPEG, and the native renderer draws its pixels upright", async () => {
    const { document, picture } = await droppedPortrait();
    const page = document.pages[0]!;
    const svg = (await exportPhase4Svg(document, { outputWidth: page.width, outputHeight: page.height })).contents;
    // The app's own pass, with resvg standing in for the webview's decoder and for Rust's drawing.
    const pixels = new Map<string, Uint8Array>();
    const decode: PicturePixelDecoder = async (bytes, mimeType) => {
      expect(mimeType).toBe("image/jpeg");
      const decoded = await resvgDecode(bytes, mimeType);
      const id = `chemdraft-raster-picture-${pixels.size}`;
      pixels.set(id, render(`<svg xmlns="${SVG_NS}" width="${decoded.width}" height="${decoded.height}"><image width="${decoded.width}" height="${decoded.height}" `
        + `href="data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}"/></svg>`).png);
      return decoded;
    };
    const drawn = await drawPreparedPictures(svg, decode, pixels);
    expect(pixels.size).toBe(1);
    const scale = 2;
    const rendered = render(drawn, page.width * scale);
    expectUpright(corners(rendered, { x: picture.x * scale, y: picture.y * scale, width: picture.width * scale, height: picture.height * scale }),
      "raster export");

    // Through rasterizeSvgNative itself: the JPEG goes to Rust as pixels at its stored size, never through the SVG rasteriser.
    vi.stubGlobal("createImageBitmap", vi.fn(async (blob: Blob) => {
      expect(blob.type).toBe("image/jpeg");
      return { ...readRasterHeaderSize("jpeg", new Uint8Array(await blob.arrayBuffer()))!, close: vi.fn() };
    }));
    vi.stubGlobal("OffscreenCanvas", class {
      constructor(public width: number, public height: number) {}
      getContext() {
        return { drawImage: vi.fn(), getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) };
      }
    });
    native.invoke.mockResolvedValue({ bytes: [1], width: 1, height: 1, warnings: [] });
    await rasterizeSvgNative(svg, "png", { scale: 2 });
    expect(native.rasterized).not.toHaveBeenCalled();
    const [, { request: sent }] = native.invoke.mock.calls.at(-1)!;
    expect(sent.pictures).toEqual([expect.objectContaining({ width: 64, height: 32, rgbaBase64: expect.any(String) })]);
    expect(sent.svg).toMatch(/<image [^>]*transform="matrix\(0 1 -1 0 /);
  });

  it("on the clipboard after Copy: PNG pixels, the SVG flavour's JPEG and the PDF's own JPEG", async () => {
    const { document, picture } = await droppedPortrait();
    vi.stubGlobal("createImageBitmap", vi.fn(async (blob: Blob) =>
      ({ ...readRasterHeaderSize("jpeg", new Uint8Array(await blob.arrayBuffer()))!, close: vi.fn() })));
    vi.stubGlobal("OffscreenCanvas", class {
      constructor(public width: number, public height: number) {}
      getContext() {
        return { drawImage: vi.fn(), getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) };
      }
    });
    const blank = render(`<svg xmlns="${SVG_NS}" width="2" height="2"/>`);
    native.invoke.mockResolvedValue({ bytes: Array.from(blank.png), width: 2, height: 2, warnings: [] });
    const payload = createSelectionClipboardPayload(document)!;
    const prepared = await selectionClipboardImageItems(document, payload, "macos");
    expect(prepared.warnings).toEqual([]);
    // The PNG flavour: Rust gets the photo's pixels, not a picture it would have to skip.
    const [, { request: sent }] = native.invoke.mock.calls.at(-1)!;
    expect(sent.pictures).toEqual([expect.objectContaining({ width: 64, height: 32, rgbaBase64: expect.any(String) })]);
    const jpeg = readJpegPicture(picture.data.image!)!;
    const svg = prepared.items.find(item => item.type === "image/svg+xml");
    expect(svg && "text" in svg && svg.text).toContain(`href="data:image/jpeg;base64,${jpeg.jpegBase64}"`);
    const pdf = prepared.items.find(item => item.type === "application/pdf");
    if (!pdf || !("bytes" in pdf)) throw new Error("no PDF flavour");
    expect(Buffer.from(pdf.bytes).toString("latin1")).toMatch(/\/DCTDecode/);
  });

  it("through CDXML export and copy-paste, which carry the picture's SVG unchanged", async () => {
    const { document, picture } = await droppedPortrait();
    const reopened = openNativeDocument(exportPhase4Cdxml(document).contents).document!;
    expect(pictures(reopened)).toEqual([picture]);
    const payload = parseSelectionClipboardPayload(serializeSelectionClipboardPayload(createSelectionClipboardPayload(document)!))!;
    const [pasted] = pictures(pasteSelectionClipboardPayload(createPhase4Document("Paste"), payload, { x: 200, y: 200 }));
    expect(pasted!.data).toEqual(picture.data);
    expect([pasted!.width, pasted!.height]).toEqual([32, 64]);
  });
});

describe("canvas/export parity for every EXIF orientation", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)("orientation %i: the canvas, SVG export and PDF export draw the same picture", async orientation => {
    const { document, picture } = await droppedPortrait(orientation);
    const page = document.pages[0]!;
    // The canvas: the stored SVG picture over its frame.
    const glyph = graphicArtTransformPreviewSvgDataUrl(picture)!;
    const canvasSvg = `<svg xmlns="${SVG_NS}" width="${glyph.width}" height="${glyph.height}" viewBox="0 0 ${glyph.width} ${glyph.height}">`
      + `<image href="${glyph.imageUrl}" x="0" y="0" width="${glyph.width}" height="${glyph.height}" preserveAspectRatio="none"/></svg>`;
    const canvas = render(inlinePictureSvgs(canvasSvg), glyph.width * 2);
    const canvasCorners = corners(canvas, { x: 0, y: 0, width: canvas.width, height: canvas.height });
    // SVG export, drawn by resvg as it is.
    const svg = (await exportPhase4Svg(document, { outputWidth: page.width, outputHeight: page.height })).contents;
    expect(exportedImage(svg).href.startsWith("data:image/jpeg;base64,")).toBe(true);
    const exported = render(svg, page.width * 2);
    const exportedCorners = corners(exported, { x: picture.x * 2, y: picture.y * 2, width: picture.width * 2, height: picture.height * 2 });
    for (const [index, color] of exportedCorners.entries()) {
      for (const [channel, value] of color.entries()) {
        expect(Math.abs(value - canvasCorners[index]![channel]!), `corner ${index}: export ${color}, canvas ${canvasCorners[index]}`).toBeLessThan(48);
      }
    }
    // PDF export places the stored picture exactly where SVG export does.
    const pdf = await exportPhase4Pdf(document, { compress: false, rasterizeSvgPicture: vi.fn() });
    const [draw] = pdfImageDraws(pdf.bytes);
    expect(draw!.dictionary).toMatch(/\/DCTDecode/);
    expectPoints(pdfStoredCorners(draw!.matrix, page), svgStoredCorners(svg), `orientation ${orientation}`);
  });
});
