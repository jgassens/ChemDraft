import { describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_OBJECT_BYTES, createEmptyDocument, type GraphicObject } from "@chemdraft/chem-core";
import { MAX_SVG_SOURCE_CHARS } from "@chemdraft/export-engine";
import { insertDroppedImages } from "./insertDroppedImages";
import { jpegPictureSvg, readKeepableJpeg } from "./jpegPicture";
import {
  CONVERTED_PICTURE_MAX_SIDE, KEPT_JPEG_MAX_SIDE, bytesToBase64, prepareDroppedImage, type PreparedDroppedImage
} from "./prepareDroppedImage";
import type { DecodeCheck, DroppedImageDecoders, RasterToJpeg, RasterToPng } from "./rasterDecode";
import { scanStart, syntheticJpeg } from "./jpegTestImages";
import { gifHeader, pngBytes } from "./testFixtures";

const fromBase64 = (base64: string) => Uint8Array.from(atob(base64), char => char.charCodeAt(0));

function decoders(decodeCheck?: DecodeCheck, rasterToPng?: RasterToPng, rasterToJpeg?: RasterToJpeg): DroppedImageDecoders & {
  rasterToPng: ReturnType<typeof vi.fn>; rasterToJpeg: ReturnType<typeof vi.fn>; decodeCheck: ReturnType<typeof vi.fn>;
} {
  return {
    rasterToPng: vi.fn(rasterToPng ?? (async () => ({ png: pngBytes(), width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, downscaled: false }))),
    rasterToJpeg: vi.fn(rasterToJpeg ?? (async () => { throw new Error("not scaled in this test"); })),
    decodeCheck: vi.fn(decodeCheck ?? (async () => ({ width: 1, height: 1 })))
  };
}

async function prepared(name: string, bytes: Uint8Array, decode = decoders()): Promise<PreparedDroppedImage> {
  const result = await prepareDroppedImage(name, bytes, decode);
  if (!result.ok) throw new Error(result.reason);
  return result.image;
}

/** The JPEG bytes an SVG picture made from a dropped JPEG embeds. */
function embeddedJpeg(image: PreparedDroppedImage): Uint8Array {
  const svg = atob(image.dataBase64);
  const match = /href="data:image\/jpeg;base64,([^"]+)"/.exec(svg);
  if (!match) throw new Error("no embedded JPEG");
  return fromBase64(match[1]!);
}

describe("a dropped picture keeps its own encoded bytes", () => {
  it("PNG stays PNG, byte for byte", async () => {
    const png = pngBytes();
    const decode = decoders();
    const image = await prepared("a.png", png, decode);
    expect(image).toMatchObject({ mimeType: "image/png", notes: [] });
    expect(fromBase64(image.dataBase64)).toEqual(png);
    expect(decode.rasterToPng).not.toHaveBeenCalled();
  });

  it("JPEG stays JPEG: the scan is the camera's, nothing is re-encoded, and the webview decodes exactly what is stored", async () => {
    const jpeg = syntheticJpeg({ width: 3264, height: 2448, orientation: 6, xmp: true, icc: true, scanBytes: 50_000 });
    const decode = decoders(async () => ({ width: 3264, height: 2448 }));
    const image = await prepared("IMG_0896.JPG", jpeg, decode);
    expect(image).toMatchObject({ name: "IMG_0896.JPG", mimeType: "image/svg+xml", notes: [] });
    expect(image.naturalSize).toBeUndefined();
    expect(decode.rasterToPng).not.toHaveBeenCalled();
    const stored = embeddedJpeg(image);
    expect(decode.decodeCheck).toHaveBeenCalledExactlyOnceWith(stored, "image/jpeg", {});
    // Only the metadata went: the scan (from its marker to the end of the file) is identical.
    expect(stored.subarray(scanStart(stored))).toEqual(jpeg.subarray(scanStart(jpeg)));
    expect(stored).toEqual(readKeepableJpeg(jpeg)!.bytes);
    expect(new TextDecoder("latin1").decode(stored)).not.toMatch(/Exif|GPSLatitude/);
    expect(atob(image.dataBase64)).toBe(jpegPictureSvg(bytesToBase64(stored), 3264, 2448, 6));
    // About 4/3 of the file (base64 inside base64 is 16/9 as stored text), where a PNG re-encode of a
    // photo is several times the JPEG.
    expect(image.dataBase64.length).toBeLessThan(jpeg.length * 1.8 + 1000);
  });

  it.each([[1, 3264, 2448], [3, 3264, 2448], [6, 2448, 3264], [8, 2448, 3264]] as const)(
    "orientation %i lands upright: %i × %i page units", async (orientation, width, height) => {
      const jpeg = syntheticJpeg({ width: 3264, height: 2448, orientation });
      const image = await prepared("photo.jpg", jpeg);
      const document = insertDroppedImages(createEmptyDocument({ title: "Drop" }), [image], { x: 0, y: 0 }).document;
      const picture = document.pages[0]!.objects[0] as GraphicObject;
      expect([picture.data.image!.pixelWidth, picture.data.image!.pixelHeight]).toEqual([width, height]);
      // Shrunk to the page's margin box, keeping the upright aspect.
      expect(picture.width / picture.height).toBeCloseTo(width / height, 6);
      const transform = /transform="matrix\(([^)]*)\)"/.exec(atob(picture.data.image!.dataBase64))?.[1];
      expect(transform).toBe({ 1: undefined, 3: "-1 0 0 -1 3264 2448", 6: "0 1 -1 0 2448 0", 8: "0 -1 1 0 0 3264" }[orientation]);
    });

  it("refuses a JPEG the webview cannot decode, without converting it", async () => {
    const decode = decoders(async () => { throw new Error("the webview could not decode it."); });
    expect(await prepareDroppedImage("bad.jpg", syntheticJpeg({ width: 8, height: 8 }), decode))
      .toEqual({ ok: false, reason: "the JPEG could not be decoded: the webview could not decode it." });
    expect(decode.rasterToPng).not.toHaveBeenCalled();
    const blank = decoders(async () => ({ width: 0, height: 0 }));
    expect(await prepareDroppedImage("blank.jpg", syntheticJpeg({ width: 8, height: 8 }), blank))
      .toEqual({ ok: false, reason: "the JPEG could not be decoded: the webview could not decode it." });
  });

  it("converts a JPEG too large to keep whole, without its metadata and turned upright by the canvas, and says if it shrank", async () => {
    const scanBytes = Math.ceil((MAX_SVG_SOURCE_CHARS * 3) / 4) + 10;
    // At the side cap, so it is kept, not scaled down: but it is too many bytes for an SVG picture.
    const jpeg = syntheticJpeg({ width: 4096, height: 3000, orientation: 6, scanBytes });
    const raster: RasterToPng = async () => ({ png: pngBytes(), width: 2250, height: 3072, sourceWidth: 3000, sourceHeight: 4096,
      downscaled: true, limitedBy: "bytes" });
    const decode = decoders(undefined, raster);
    const image = await prepared("huge.jpg", jpeg, decode);
    expect(decode.decodeCheck).not.toHaveBeenCalled();
    expect(decode.rasterToPng).toHaveBeenCalledExactlyOnceWith(expect.any(Uint8Array), "image/jpeg", MAX_IMAGE_OBJECT_BYTES,
      { maxSide: CONVERTED_PICTURE_MAX_SIDE, orientation: 6 });
    // Compared as buffers: a matcher's element-by-element walk over 15 MB takes minutes.
    const sent = decode.rasterToPng.mock.calls[0]![0] as Uint8Array;
    expect(Buffer.from(sent).equals(Buffer.from(readKeepableJpeg(jpeg)!.bytes))).toBe(true);
    expect(sent.length).toBeLessThan(jpeg.length);
    expect(decode.rasterToJpeg).not.toHaveBeenCalled();
    expect(image).toMatchObject({ mimeType: "image/png", naturalSize: { width: 3000, height: 4096 } });
    expect(image.notes).toEqual([expect.stringMatching(/^stored at 2250 × 3072 pixels \(from 3000 × 4096\) to fit the .+ picture limit$/)]);
  });

  it("caps a GIF or WebP converted to PNG at the side limit, keeps its drawn size, and says so", async () => {
    const raster: RasterToPng = async () => ({ png: pngBytes(), width: 4096, height: 2048, sourceWidth: 8000, sourceHeight: 4000,
      downscaled: true, limitedBy: "side" });
    const decode = decoders(undefined, raster);
    const image = await prepared("wide.gif", gifHeader(8000, 4000), decode);
    expect(decode.rasterToPng).toHaveBeenCalledWith(expect.any(Uint8Array), "image/gif", MAX_IMAGE_OBJECT_BYTES, { maxSide: 4096 });
    expect(image).toMatchObject({ mimeType: "image/png", naturalSize: { width: 8000, height: 4000 },
      notes: ["stored at 4096 × 2048 pixels (from 8000 × 4000), the most a picture converted to PNG keeps"] });
    // Under the cap nothing is said, and the drawn size comes from the stored pixels.
    const small = await prepared("small.gif", gifHeader(8, 8));
    expect(small.notes).toEqual([]);
    expect(small.naturalSize).toBeUndefined();
  });
});

describe("a dropped JPEG longer than 4096 px", () => {
  /** A camera photo: 6000 × 4000 stored, EXIF orientation 6 (4000 × 6000 upright). */
  const photo = () => syntheticJpeg({ width: 6000, height: 4000, orientation: 6, scanBytes: 20_000 });
  /** What the webview's encoder returns for it: upright, 2731 × 4096, a JPEG of its own. */
  const reencoded = syntheticJpeg({ width: 2731, height: 4096, scanBytes: 5_000 });
  const scale: RasterToJpeg = async () => ({ jpeg: reencoded, width: 2731, height: 4096, sourceWidth: 4000, sourceHeight: 6000 });

  it("is scaled down to 4096 px upright, re-encoded as JPEG in the kept-JPEG SVG picture, drawn at its own size, and says so", async () => {
    const decode = decoders(undefined, undefined, scale);
    const jpeg = photo();
    const image = await prepared("camera.jpg", jpeg, decode);
    expect(KEPT_JPEG_MAX_SIDE).toBe(4096);
    expect(decode.rasterToJpeg).toHaveBeenCalledExactlyOnceWith(readKeepableJpeg(jpeg)!.bytes, { maxSide: 4096, quality: 0.9, orientation: 6 });
    expect(decode.rasterToPng).not.toHaveBeenCalled();
    expect(decode.decodeCheck).not.toHaveBeenCalled();
    // The same wrapper a kept JPEG has, upright (no transform), around the encoder's bytes.
    expect(image).toEqual({
      name: "camera.jpg", mimeType: "image/svg+xml", dataBase64: btoa(jpegPictureSvg(bytesToBase64(reencoded), 2731, 4096, 1)),
      naturalSize: { width: 4000, height: 6000 }, notes: ["scaled down to 4096 px (from 4000 × 6000 pixels)"]
    });
    expect(embeddedJpeg(image)).toEqual(reencoded);
    // Inserted, it keeps the photo's upright aspect (the page fit shrinks it further).
    const [object] = insertDroppedImages(createEmptyDocument({ title: "Photo" }), [image], { x: 300, y: 300 }).document.pages[0]!.objects as GraphicObject[];
    expect(object!.data.image).toMatchObject({ mimeType: "image/svg+xml", pixelWidth: 2731, pixelHeight: 4096 });
    expect(object!.height / object!.width).toBeCloseTo(6000 / 4000, 2);
  });

  it("is kept byte for byte at exactly 4096 px", async () => {
    const decode = decoders(async () => ({ width: 4096, height: 3000 }), undefined, scale);
    const jpeg = syntheticJpeg({ width: 4096, height: 3000, scanBytes: 2_000 });
    const image = await prepared("edge.jpg", jpeg, decode);
    expect(decode.rasterToJpeg).not.toHaveBeenCalled();
    expect(embeddedJpeg(image)).toEqual(jpeg);
    expect(image.notes).toEqual([]);
  });

  it("is refused by name when the webview cannot scale it, or returns a JPEG of another size", async () => {
    const failing = decoders(undefined, undefined, async () => { throw new Error("the webview could not decode it."); });
    expect(await prepareDroppedImage("camera.jpg", photo(), failing))
      .toEqual({ ok: false, reason: "the JPEG could not be scaled down: the webview could not decode it." });
    const wrongSize = decoders(undefined, undefined, async () => ({ jpeg: reencoded, width: 4096, height: 2731, sourceWidth: 4000, sourceHeight: 6000 }));
    expect(await prepareDroppedImage("camera.jpg", photo(), wrongSize))
      .toEqual({ ok: false, reason: "the JPEG could not be scaled down: the webview's JPEG is not readable." });
  });
});
