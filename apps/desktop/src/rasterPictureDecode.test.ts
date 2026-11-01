// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bytesToBase64,
  decodePngPixels,
  prepareRasterPictures,
  RasterPictureDecodedBudgetBytes,
  RasterPictureMaxCount,
  RasterPictureMaxSidePx,
  RasterPictureOverCountHref,
  rasterPicturePlaceholderHref,
  readPngSize
} from "./rasterPictureDecode";
import { picturePngBase64 } from "./testSupport/imageFixture";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

/** A PNG signature and IHDR declaring `width` × `height`: enough for the size check, nothing more. */
function pngHeader(width: number, height: number): string {
  const header = new Uint8Array(33);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(header.buffer).setUint32(16, width);
  new DataView(header.buffer).setUint32(20, height);
  return bytesToBase64(header);
}

const pngImage = (base64: string, attributes = "") =>
  `<image x="1" y="2" width="30" height="40" preserveAspectRatio="none" ${attributes} href="data:image/png;base64,${base64}"/>`;
const page = (...images: string[]) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100">${images.join("")}</svg>`;

/** Stands in for the webview decoder: one colour at the size the PNG declares. */
const solidDecoder = (rgba = [10, 20, 30, 255]) => vi.fn(async (png: Uint8Array<ArrayBuffer>) => {
  const { width, height } = readPngSize(png)!;
  return { width, height, rgba: new Uint8ClampedArray(width * height * 4).map((_, index) => rgba[index % 4]) };
});

function images(svg: string) {
  return Array.from(new DOMParser().parseFromString(svg, "image/svg+xml").getElementsByTagName("image"));
}

describe("raster picture decoding", () => {
  it("reads PNG sizes from the IHDR and rejects anything else", () => {
    expect(readPngSize(bytesOf(picturePngBase64))).toEqual({ width: 144, height: 72 });
    expect(readPngSize(bytesOf(pngHeader(16385, 3)))).toEqual({ width: 16385, height: 3 });
    expect(readPngSize(bytesOf(pngHeader(0, 3)))).toBeUndefined();
    expect(readPngSize(bytesOf(picturePngBase64).subarray(0, 23))).toBeUndefined();
    expect(readPngSize(bytesOf(btoa("GIF89a......................")))).toBeUndefined();
  });

  it("decodes each top-level PNG picture into RGBA pixels and leaves an empty stand-in in its place", async () => {
    const decode = solidDecoder();
    const svg = page(
      pngImage(picturePngBase64, 'data-chemdraft-picture-frame="1 2 30 40 0"'),
      '<image width="5" height="5" href="data:image/svg+xml;base64,PHN2Zy8+"/>',
      '<image width="5" height="5" href="data:image/jpeg;base64,/9j/4AAQ"/>',
      `<image width="5" height="5" xlink:href="data:image/png;base64,${pngHeader(2, 1)}"/>`
    );
    const prepared = await prepareRasterPictures(svg, { decode });
    expect(decode).toHaveBeenCalledTimes(2);
    expect([...decode.mock.calls[0][0]]).toEqual([...bytesOf(picturePngBase64)]);
    expect(prepared.pictures.map(({ id }) => id)).toEqual(["chemdraft-raster-picture-0", "chemdraft-raster-picture-1"]);
    expect(prepared.pictures[0]).toMatchObject({ width: 144, height: 72 });
    const pixels = bytesOf((prepared.pictures[0] as { rgbaBase64: string }).rgbaBase64);
    expect(pixels).toHaveLength(144 * 72 * 4);
    expect([...pixels.subarray(-4)]).toEqual([10, 20, 30, 255]);
    expect(prepared.svg).not.toContain(picturePngBase64);

    const [picture, svgPicture, jpegPicture, xlinkPicture] = images(prepared.svg);
    expect(picture.getAttribute("id")).toBe("chemdraft-raster-picture-0");
    expect(picture.getAttribute("href")).toBe(rasterPicturePlaceholderHref(144, 72, "chemdraft-raster-picture-0"));
    for (const name of ["x", "y", "width", "height", "preserveAspectRatio", "data-chemdraft-picture-frame"]) {
      expect(picture.getAttribute(name)).toBe(images(svg)[0].getAttribute(name));
    }
    // SVG pictures already draw natively; other bitmaps keep Rust's omitted-picture warning.
    expect(svgPicture.outerHTML).toBe(images(svg)[1].outerHTML);
    expect(jpegPicture.outerHTML).toBe(images(svg)[2].outerHTML);
    expect(xlinkPicture.getAttributeNS("http://www.w3.org/1999/xlink", "href"))
      .toBe(rasterPicturePlaceholderHref(2, 1, "chemdraft-raster-picture-1"));
  });

  it("refuses a picture over 16384 px a side before decoding it", async () => {
    expect(RasterPictureMaxSidePx).toBe(16384);
    const decode = solidDecoder();
    const prepared = await prepareRasterPictures(page(pngImage(pngHeader(16385, 1)), pngImage(pngHeader(1, 16384))), { decode });
    expect(prepared.pictures).toEqual([
      { id: "chemdraft-raster-picture-0", refused: "tooLarge" },
      expect.objectContaining({ id: "chemdraft-raster-picture-1", width: 1, height: 16384 })
    ]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(images(prepared.svg)[0].getAttribute("href")).toBe(rasterPicturePlaceholderHref(1, 1, "chemdraft-raster-picture-0"));
  });

  it("keeps a running budget of decoded bytes across one export, 256 MiB by default", async () => {
    expect(RasterPictureDecodedBudgetBytes).toBe(256 * 1024 * 1024);
    const decode = solidDecoder();
    // 8192 × 8193 × 4 bytes is just over 256 MiB, so it is refused without being decoded.
    const overDefault = await prepareRasterPictures(page(pngImage(pngHeader(8192, 8193))), { decode });
    expect(overDefault.pictures).toEqual([{ id: "chemdraft-raster-picture-0", refused: "overBudget" }]);
    expect(decode).not.toHaveBeenCalled();

    // 64 + 64 bytes fit a 150-byte budget, a third 64 does not, and a later 16 still does.
    const svg = page(pngImage(pngHeader(4, 4)), pngImage(pngHeader(4, 4)), pngImage(pngHeader(4, 4)), pngImage(pngHeader(2, 2)));
    for (let call = 0; call < 2; call += 1) {
      const prepared = await prepareRasterPictures(svg, { decode, budgetBytes: 150 });
      expect(prepared.pictures.map((picture) => "refused" in picture ? picture.refused : picture.width))
        .toEqual([4, 4, "overBudget", 2]);
    }
  });

  it("reports pictures that fail to decode, and does not charge them to the budget", async () => {
    const failing = vi.fn(async (png: Uint8Array<ArrayBuffer>) => {
      const { width, height } = readPngSize(png)!;
      if (width === 3) throw new Error("corrupt image data");
      // A decoder that disagrees with the IHDR is not trusted.
      if (width === 5) return { width: 5, height: 6, rgba: new Uint8ClampedArray(5 * 6 * 4) };
      return { width, height, rgba: new Uint8ClampedArray(width * height * 4) };
    });
    // 36 and 100 bytes both fit a 100-byte budget only if failed decodes are not charged.
    const prepared = await prepareRasterPictures(page(
      pngImage(pngHeader(3, 3)), pngImage(pngHeader(5, 5)), pngImage("AAAA"), pngImage(`${pngHeader(4, 4)}A`), pngImage(pngHeader(4, 4))
    ), { decode: failing, budgetBytes: 100 });
    expect(prepared.pictures.map((picture) => "refused" in picture ? picture.refused : picture.width))
      .toEqual(["decodeFailed", "decodeFailed", "decodeFailed", "decodeFailed", 4]);
    expect(failing).toHaveBeenCalledTimes(3);
    expect(images(prepared.svg).slice(0, 4).map((image) => image.getAttribute("href")))
      .toEqual([0, 1, 2, 3].map((index) => rasterPicturePlaceholderHref(1, 1, `chemdraft-raster-picture-${index}`)));
  });

  it("sends at most 1024 pictures and leaves the rest undecoded behind a marked stand-in", async () => {
    expect(RasterPictureMaxCount).toBe(1024);
    const decode = solidDecoder();
    // The first is refused, which still counts toward the limit.
    const svg = page(pngImage(pngHeader(16385, 1)), ...Array.from({ length: RasterPictureMaxCount + 1 }, () => pngImage(pngHeader(1, 1))));
    const prepared = await prepareRasterPictures(svg, { decode });
    expect(prepared.pictures).toHaveLength(RasterPictureMaxCount);
    expect(prepared.pictures[0]).toEqual({ id: "chemdraft-raster-picture-0", refused: "tooLarge" });
    expect(decode).toHaveBeenCalledTimes(RasterPictureMaxCount - 1);
    const written = images(prepared.svg);
    expect(written.slice(0, RasterPictureMaxCount).every((image) => image.hasAttribute("id"))).toBe(true);
    for (const image of written.slice(RasterPictureMaxCount)) {
      expect(image.hasAttribute("id")).toBe(false);
      expect(image.getAttribute("href")).toBe(RasterPictureOverCountHref);
    }
    expect(written.slice(RasterPictureMaxCount)).toHaveLength(2);
    expect(RasterPictureOverCountHref).not.toBe(rasterPicturePlaceholderHref(1, 1, "chemdraft-raster-picture-0"));
  });

  it("leaves SVGs it cannot rewrite unambiguously untouched", async () => {
    const decode = solidDecoder();
    for (const svg of [
      page(pngImage(pngHeader(2, 2), 'id="logo"')),
      page(pngImage(pngHeader(2, 2), `xlink:href="data:image/png;base64,${pngHeader(2, 2)}"`)),
      page('<image href="data:image/gif;base64,R0lGODlh"/>'),
      `<svg xmlns="http://www.w3.org/2000/svg">${pngImage(pngHeader(2, 2))}`,
      page()
    ]) {
      expect(await prepareRasterPictures(svg, { decode })).toEqual({ svg, pictures: [] });
    }
    expect(decode).not.toHaveBeenCalled();
  });

  it("picks an id prefix the SVG does not already use", async () => {
    const svg = page('<g id="chemdraft-raster-picture-0"/>', pngImage(pngHeader(2, 2)));
    const prepared = await prepareRasterPictures(svg, { decode: solidDecoder() });
    expect(prepared.pictures.map(({ id }) => id)).toEqual(["chemdraft-raster-picture-1-0"]);
    expect(images(prepared.svg)[0].getAttribute("id")).toBe("chemdraft-raster-picture-1-0");
    expect(images(prepared.svg)[0].getAttribute("href")).toBe(rasterPicturePlaceholderHref(2, 2, "chemdraft-raster-picture-1-0"));
  });

  it("gives each stand-in a blank SVG of its picture's size whose one invisible path carries the picture's id", async () => {
    // Rust's `placeholder_href(144, 72, "chemdraft-raster-picture-0")` is pinned to the same string.
    expect(rasterPicturePlaceholderHref(144, 72, "chemdraft-raster-picture-0")).toBe(
      "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='144'%20height='72'%3E%3Cpath%20id='chemdraft-raster-picture-0'%20d='M0%200H1V1H0Z'%20fill='none'/%3E%3C/svg%3E"
    );
    // Two pictures of the same size still get different stand-ins, one per picture.
    const prepared = await prepareRasterPictures(page(pngImage(pngHeader(3, 2)), pngImage(pngHeader(3, 2))), { decode: solidDecoder() });
    const hrefs = images(prepared.svg).map((image) => image.getAttribute("href")!);
    expect(new Set(hrefs).size).toBe(2);
    hrefs.forEach((href, index) => {
      const id = `chemdraft-raster-picture-${index}`;
      expect(images(prepared.svg)[index].getAttribute("id")).toBe(id);
      const standIn = new DOMParser().parseFromString(decodeURIComponent(href.slice(href.indexOf(",") + 1)), "image/svg+xml");
      const root = standIn.documentElement;
      expect([root.namespaceURI, root.getAttribute("width"), root.getAttribute("height")]).toEqual([
        "http://www.w3.org/2000/svg", "3", "2"
      ]);
      expect(Array.from(root.children).map((child) => [child.localName, child.getAttribute("id"), child.getAttribute("fill")]))
        .toEqual([["path", id, "none"]]);
      expect(root.children[0].hasAttribute("stroke")).toBe(false);
    });
  });

  it("decodes with the webview's createImageBitmap and reads straight RGBA back from a canvas", async () => {
    const bitmap = { width: 2, height: 1, close: vi.fn() };
    const createImageBitmap = vi.fn(async (_blob: Blob) => bitmap);
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) =>
        ({ data: new Uint8ClampedArray(width * height * 4).fill(7) }))
    };
    const canvases: { width: number; height: number }[] = [];
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    vi.stubGlobal("OffscreenCanvas", class {
      constructor(public width: number, public height: number) { canvases.push(this); }
      getContext(kind: string) { return kind === "2d" ? context : null; }
    });
    const png = bytesOf(pngHeader(2, 1));
    const pixels = await decodePngPixels(png);
    expect(pixels).toEqual({ width: 2, height: 1, rgba: new Uint8ClampedArray(8).fill(7) });
    const blob = createImageBitmap.mock.calls[0][0];
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(context.getImageData).toHaveBeenCalledWith(0, 0, 2, 1);
    expect(bitmap.close).toHaveBeenCalled();
    expect(canvases).toEqual([expect.objectContaining({ width: 0, height: 0 })]);

    // A canvas that cannot be created still releases the decoded bitmap.
    bitmap.close.mockClear();
    vi.stubGlobal("OffscreenCanvas", class {
      constructor() { throw new RangeError("canvas too large"); }
    });
    await expect(decodePngPixels(png)).rejects.toThrow("canvas too large");
    expect(bitmap.close).toHaveBeenCalledTimes(1);

    // Without OffscreenCanvas the document's canvas is used.
    vi.stubGlobal("OffscreenCanvas", undefined);
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    await expect(decodePngPixels(png)).resolves.toMatchObject({ width: 2, height: 1 });
    expect(getContext).toHaveBeenCalledWith("2d", { willReadFrequently: true });
  });

  it("encodes RGBA as standard base64 across chunk boundaries, with or without Uint8Array.toBase64", () => {
    const bytes = Uint8Array.from({ length: 3 * 8192 * 2 + 5 }, (_, index) => (index * 31) % 256);
    const expected = Buffer.from(bytes).toString("base64");
    expect(bytesToBase64(bytes)).toBe(expected);
    expect(bytesToBase64(new Uint8ClampedArray(bytes.buffer))).toBe(expected);
    const prototype = Uint8Array.prototype as { toBase64?: unknown };
    const native = Object.getOwnPropertyDescriptor(prototype, "toBase64");
    Object.defineProperty(prototype, "toBase64", { value: undefined, configurable: true, writable: true });
    try {
      expect(bytesToBase64(bytes)).toBe(expected);
      expect(bytesToBase64(new Uint8ClampedArray(bytes.buffer))).toBe(expected);
      for (let length = 0; length <= 7; length += 1) {
        expect(bytesToBase64(bytes.subarray(0, length))).toBe(Buffer.from(bytes.subarray(0, length)).toString("base64"));
      }
    } finally {
      if (native) Object.defineProperty(prototype, "toBase64", native);
      else delete prototype.toBase64;
    }
  });
});
