// @vitest-environment jsdom
/**
 * A portrait phone photo (EXIF orientation 6) dropped and then drawn everywhere a picture is drawn:
 * the canvas, SVG export, PDF export, raster export (and Copy as PNG, which is the same path), CDXML
 * and copy-paste. Wherever pixels come out, they are rendered for real (resvg) and the photo's four
 * quadrants must be where an upright photo has them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import type { ChemDraftDocument, GraphicObject } from "@chemdraft/chem-core";
import {
  createPhase4Document, createSelectionClipboardPayload, exportPhase4Cdxml, exportPhase4Pdf, exportPhase4Svg, openNativeDocument,
  parseSelectionClipboardPayload, pasteSelectionClipboardPayload, serializeSelectionClipboardPayload
} from "../documentWorkflow";
import { graphicArtTransformPreviewSvgDataUrl } from "../MainWindow";
import { rasterizeSvgNative } from "../nativeRasterExport";
import { readPngSize } from "../rasterPictureDecode";
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

async function droppedPortrait(): Promise<{ document: ChemDraftDocument; picture: GraphicObject }> {
  const phonePhoto = withSegmentsAfterSoi(quadrantJpeg(), exifSegment(6));
  const decoders: DroppedImageDecoders = {
    rasterToPng: async () => { throw new Error("a JPEG is never converted"); },
    decodeCheck: async () => ({ width: 64, height: 32 })
  };
  const result = await prepareDroppedImage("portrait.jpg", phonePhoto, decoders);
  if (!result.ok) throw new Error(result.reason);
  const document = insertDroppedImages(createPhase4Document("Portrait"), [result.image], { x: 300, y: 300 }).document;
  const [picture] = pictures(document);
  // The stored picture is 64 × 32; upright it is 32 × 64, and the frame follows.
  expect([picture!.width, picture!.height]).toEqual([32, 64]);
  return { document, picture: picture! };
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

  it("in SVG export", async () => {
    const { document, picture } = await droppedPortrait();
    const page = document.pages[0]!;
    const svg = (await exportPhase4Svg(document, { outputWidth: page.width, outputHeight: page.height })).contents;
    expect(svg).toContain(`href="data:image/svg+xml;base64,${picture.data.image!.dataBase64}"`);
    const scale = 2;
    const rendered = render(inlinePictureSvgs(svg), page.width * scale);
    expectUpright(corners(rendered, { x: picture.x * scale, y: picture.y * scale, width: picture.width * scale, height: picture.height * scale }),
      "SVG export");
  });

  it("in PDF export: the webview rasterises the picture's SVG, transform and all", async () => {
    const { document, picture } = await droppedPortrait();
    const requests: Array<{ svg: string; width: number; height: number; pixelWidth: number; pixelHeight: number }> = [];
    const pdf = await exportPhase4Pdf(document, { compress: false, rasterizeSvgPicture: async request => {
      requests.push(request);
      return render(request.svg, request.pixelWidth).png;
    } });
    expect(pdf.warnings).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ svg: atob(picture.data.image!.dataBase64), width: 32, height: 64 });
    expect(requests[0]!.pixelHeight).toBeGreaterThan(requests[0]!.pixelWidth);
    const raster = render(requests[0]!.svg, requests[0]!.pixelWidth);
    expectUpright(corners(raster, { x: 0, y: 0, width: raster.width, height: raster.height }), "PDF raster");
  });

  it("in PNG export and Copy as PNG: the picture is rasterised upright before the native renderer gets pixels", async () => {
    const { document, picture } = await droppedPortrait();
    native.rasterized.mockImplementation(async (request: { svg: string; pixelWidth: number }) => render(request.svg, request.pixelWidth).png);
    vi.stubGlobal("createImageBitmap", vi.fn(async (blob: Blob) => ({ ...readPngSize(new Uint8Array(await blob.arrayBuffer()))!, close: vi.fn() })));
    vi.stubGlobal("OffscreenCanvas", class {
      constructor(public width: number, public height: number) {}
      getContext() {
        return { drawImage: vi.fn(), getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) };
      }
    });
    native.invoke.mockResolvedValue({ bytes: [1], width: 1, height: 1, warnings: [] });
    const page = document.pages[0]!;
    const svg = (await exportPhase4Svg(document, { outputWidth: page.width, outputHeight: page.height })).contents;
    await rasterizeSvgNative(svg, "png", { scale: 2 });
    expect(native.rasterized).toHaveBeenCalledTimes(1);
    const request = native.rasterized.mock.calls[0]![0] as { svg: string; pixelWidth: number; pixelHeight: number };
    expect(request.svg).toBe(atob(picture.data.image!.dataBase64));
    expect([request.pixelWidth, request.pixelHeight]).toEqual([64, 128]);
    const raster = render(request.svg, request.pixelWidth);
    expectUpright(corners(raster, { x: 0, y: 0, width: raster.width, height: raster.height }), "raster export");
    const [, { request: sent }] = native.invoke.mock.calls.at(-1)!;
    expect(sent.pictures).toHaveLength(1);
    expect([sent.pictures[0].width, sent.pictures[0].height]).toEqual([64, 128]);
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
