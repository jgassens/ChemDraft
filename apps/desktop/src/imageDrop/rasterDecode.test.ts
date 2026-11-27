// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { browserDecodeCheck, browserRasterToJpeg, browserRasterToPng, encodeWithDownscale, scaledToSide, untilAborted } from "./rasterDecode";

describe("encodeWithDownscale", () => {
  it("keeps full size when the PNG fits", async () => {
    const sizes: Array<[number, number]> = [];
    const result = await encodeWithDownscale({ width: 400, height: 300 }, 1000, async (width, height) => {
      sizes.push([width, height]);
      return new Uint8Array(10);
    });
    expect(sizes).toEqual([[400, 300]]);
    expect(result).toMatchObject({ width: 400, height: 300, sourceWidth: 400, sourceHeight: 300, downscaled: false });
  });

  it("steps down until the PNG fits, treating a refused canvas as too large", async () => {
    const sizes: Array<[number, number]> = [];
    const result = await encodeWithDownscale({ width: 4000, height: 3000 }, 1_000_000, async (width, height) => {
      sizes.push([width, height]);
      if (width > 3000) return undefined;
      return new Uint8Array(width * height / 4);
    });
    expect(sizes).toEqual([[4000, 3000], [3000, 2250], [2250, 1687]]);
    expect(result).toMatchObject({ width: 2250, height: 1687, sourceWidth: 4000, sourceHeight: 3000, downscaled: true });
  });

  it("starts at the side cap, and says which limit made it smaller", async () => {
    const sizes: Array<[number, number]> = [];
    const capped = await encodeWithDownscale({ width: 8000, height: 4000 }, 1_000_000, async (width, height) => {
      sizes.push([width, height]);
      return new Uint8Array(10);
    }, undefined, 4096);
    expect(sizes).toEqual([[4096, 2048]]);
    expect(capped).toMatchObject({ width: 4096, height: 2048, sourceWidth: 8000, sourceHeight: 4000, downscaled: true, limitedBy: "side" });
    const stepped = await encodeWithDownscale({ width: 8000, height: 4000 }, 1_000_000, async (width, height) =>
      new Uint8Array(width * height / 4), undefined, 4096);
    expect(stepped).toMatchObject({ width: 2304, height: 1152, downscaled: true, limitedBy: "bytes" });
    const under = await encodeWithDownscale({ width: 400, height: 300 }, 1000, async () => new Uint8Array(1), undefined, 4096);
    expect(under.downscaled).toBe(false);
    expect(under.limitedBy).toBeUndefined();
  });

  it("gives up rather than shrinking to nothing", async () => {
    await expect(encodeWithDownscale({ width: 64, height: 64 }, 0, async () => new Uint8Array(1)))
      .rejects.toThrow("it is still too large as PNG after scaling it down.");
  });
});

describe("browser decoding under a deadline", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const bitmap = (width: number, height: number) => ({ width, height, close: vi.fn() });
  const deadline = () => {
    const controller = new AbortController();
    return { controller, expire: () => controller.abort(new Error("reading it took longer than 30 seconds.")) };
  };

  it("rejects at the deadline and closes a bitmap that arrives late", async () => {
    let deliver!: (value: ReturnType<typeof bitmap>) => void;
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise(resolve => { deliver = resolve; })));
    const { controller, expire } = deadline();
    const pending = browserRasterToPng(new Uint8Array([1]), "image/jpeg", 1000, { signal: controller.signal });
    expire();
    await expect(pending).rejects.toThrow("reading it took longer than 30 seconds.");
    const late = bitmap(10, 10);
    deliver(late);
    await Promise.resolve();
    expect(late.close).toHaveBeenCalledTimes(1);
  });

  it("checks the decoder's own size against the caps before making a canvas", async () => {
    const big = bitmap(16_385, 2);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => big));
    const createElement = vi.spyOn(document, "createElement");
    await expect(browserRasterToPng(new Uint8Array([1]), "image/gif", 1000))
      .rejects.toThrow("it is 16385 × 2 pixels; the limit is 16384 pixels on a side.");
    expect(createElement).not.toHaveBeenCalledWith("canvas");
    expect(big.close).toHaveBeenCalled();
  });

  it("ends an encoder that never calls back, without trying smaller sizes", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap(40, 30)));
    const context = { drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(() => {});
    const { controller, expire } = deadline();
    const pending = browserRasterToPng(new Uint8Array([1]), "image/webp", 1000, { signal: controller.signal });
    await vi.waitFor(() => expect(toBlob).toHaveBeenCalledTimes(1));
    expire();
    await expect(pending).rejects.toThrow("reading it took longer than 30 seconds.");
    expect(toBlob).toHaveBeenCalledTimes(1);
  });

  it("ends an image decode that never settles and releases its object URL", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: () => "blob:x", revokeObjectURL: revoke }));
    // jsdom has no decode(): stand in one that never settles.
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => new Promise(() => {}) });
    const { controller, expire } = deadline();
    const pending = browserDecodeCheck(new Uint8Array([1]), "image/svg+xml", { signal: controller.signal });
    expire();
    await expect(pending).rejects.toThrow("reading it took longer than 30 seconds.");
    expect(revoke).toHaveBeenCalledWith("blob:x");
    Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  });

  it("turns a JPEG upright on the canvas from the orientation passed in, whatever the decoder does with EXIF", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap(300, 200)));
    const context = { drawImage: vi.fn(), setTransform: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const canvases: Array<[number, number]> = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback) {
      canvases.push([this.width, this.height]);
      callback(new Blob([new Uint8Array(4)]));
    });
    const result = await browserRasterToPng(new Uint8Array([1]), "image/jpeg", 1000, { orientation: 6 });
    // Stored 300 × 200, upright 200 × 300: the canvas is upright and the picture is drawn turned into it.
    expect(canvases).toEqual([[200, 300]]);
    expect(context.setTransform).toHaveBeenCalledExactlyOnceWith(0, 1, -1, 0, 200, 0);
    expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 300, 200);
    expect(result).toMatchObject({ width: 200, height: 300, sourceWidth: 200, sourceHeight: 300, downscaled: false });
    // Orientation 1 draws as before, without a transform.
    context.setTransform.mockClear();
    await browserRasterToPng(new Uint8Array([1]), "image/gif", 1000);
    expect(context.setTransform).not.toHaveBeenCalled();
  });

  it("scales a large JPEG down to the side cap upright and encodes it as JPEG at the quality asked", async () => {
    const decoded = bitmap(6000, 4000);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => decoded));
    const context = { drawImage: vi.fn(), setTransform: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const encodes: Array<[number, number, string | undefined, unknown]> = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback,
      type?: string, quality?: unknown) {
      encodes.push([this.width, this.height, type, quality]);
      callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]));
    });
    const result = await browserRasterToJpeg(new Uint8Array([1]), { maxSide: 4096, quality: 0.9, orientation: 6 });
    // Stored 6000 × 4000, upright 4000 × 6000, scaled so the long side is 4096.
    expect(encodes).toEqual([[2731, 4096, "image/jpeg", 0.9]]);
    expect(context.setTransform).toHaveBeenCalledExactlyOnceWith(0, 1, -1, 0, 2731, 0);
    expect(context.drawImage).toHaveBeenCalledWith(decoded, 0, 0, 4096, 2731);
    expect(result).toEqual({ jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 2731, height: 4096, sourceWidth: 4000, sourceHeight: 6000 });
    expect(decoded.close).toHaveBeenCalled();
    // Under the cap the size is kept; an encoder that returns nothing is an error.
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((callback: BlobCallback) => callback(null));
    await expect(browserRasterToJpeg(new Uint8Array([1]), { maxSide: 8000, quality: 0.9 })).rejects.toThrow("the webview could not encode it as JPEG.");
    expect(scaledToSide({ width: 300, height: 200 }, 4096)).toEqual({ width: 300, height: 200 });
  });

  it("untilAborted passes a value through when nothing aborts", async () => {
    await expect(untilAborted(Promise.resolve(3), new AbortController().signal)).resolves.toBe(3);
    await expect(untilAborted(Promise.reject(new Error("no")), undefined)).rejects.toThrow("no");
  });
});
