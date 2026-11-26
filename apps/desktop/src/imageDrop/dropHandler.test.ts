// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_OBJECT_BYTES } from "@chemdraft/chem-core";
import {
  MAX_DROPPED_IMAGES, MAX_DROPPED_IMAGE_BYTES, MAX_DROPPED_IMAGE_TOTAL_BYTES, classifyDroppedFile, rewordPictureError
} from "./dropFiles";
import {
  formatImageDropStatus, handleDroppedFiles, prepareDroppedImages, splitDrop, type DroppedImageSource
} from "./dropHandler";
import { DROP_DOCUMENT_MARGIN_BYTES, savedPictureBytes } from "./dropDocumentBudget";
import { prepareDroppedImage } from "./prepareDroppedImage";
import type { DecodeCheck, DroppedImageDecoders, RasterToPng } from "./rasterDecode";
import { MAX_OPEN_DOCUMENT_BYTES } from "../documentText";
import { browserDroppedImageSource, nativeDroppedImageSource } from "./readDroppedFile";
import { gifHeader, jpegHeader, pngBytes, pngWithSize, svgBytes, webpVp8Header } from "./testFixtures";

const NS = 'xmlns="http://www.w3.org/2000/svg"';

/** A decoder that never runs a webview: it returns a real PNG with the requested size claimed. */
function fakeRaster(width = 1, height = 1): RasterToPng & { calls: number } {
  const fn = Object.assign(async () => {
    fn.calls += 1;
    return { png: pngBytes(), width, height, sourceWidth: width, sourceHeight: height, downscaled: false };
  }, { calls: 0 });
  return fn;
}

/** A decode check that always succeeds, counting its calls. */
function fakeCheck(size = { width: 1, height: 1 }): DecodeCheck & { calls: Array<[string, AbortSignal | undefined]> } {
  const fn = Object.assign(async (_bytes: Uint8Array, mimeType: string, options?: { signal?: AbortSignal }) => {
    fn.calls.push([mimeType, options?.signal]);
    return size;
  }, { calls: [] as Array<[string, AbortSignal | undefined]> });
  return fn;
}

function decoders(rasterToPng: RasterToPng = fakeRaster(), decodeCheck: DecodeCheck = fakeCheck()): DroppedImageDecoders {
  return { rasterToPng, decodeCheck };
}

function memorySource(name: string, bytes: Uint8Array, size = bytes.length): DroppedImageSource & { reads: number } {
  const source = {
    name, reads: 0,
    size: async () => size,
    read: async () => { source.reads += 1; return bytes; }
  };
  return source;
}

describe("classifyDroppedFile", () => {
  it("reads pictures by extension, refuses undecodable picture types and leaves documents alone", () => {
    for (const name of ["a.png", "B.JPG", "c.jpeg", "d.jfif", "e.gif", "f.webp", "g.SVG", "C:\\x\\h.png"]) {
      expect(classifyDroppedFile(name).kind, name).toBe("image");
    }
    for (const name of ["a.bmp", "a.tif", "a.TIFF", "a.ico", "a.heic", "a.heif", "a.avif", "a.pdf", "a.svgz"]) {
      expect(classifyDroppedFile(name).kind, name).toBe("refused");
    }
    expect(classifyDroppedFile("a.bmp")).toEqual({ kind: "refused",
      reason: "BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first." });
    // Links and shortcuts would otherwise go to the document-open path and fail with a parser's wording.
    for (const name of ["link.url", "Page.WEBLOC", "C:\\Users\\me\\Desktop\\link.url"]) {
      expect(classifyDroppedFile(name), name).toEqual({ kind: "refused", reason: "it is a web link, not a picture or a drawing." });
    }
    expect(classifyDroppedFile("Drawing.lnk")).toEqual({ kind: "refused", reason: "it is a shortcut; drop the file it points to instead." });
    // Refusals describe a file by its extension, never by the program that writes it.
    expect(classifyDroppedFile("poster.ai")).toEqual({ kind: "refused",
      reason: ".ai files can't be placed as pictures; export it as PNG or SVG first." });
    for (const name of ["a.cdxml", "a.chemdraft", "a.cdx", "a.mol", "a.sdf", "a.rxn", "a.smi", "noextension", ".png"]) {
      expect(classifyDroppedFile(name).kind, name).toBe("document");
    }
  });

  it("rewords the shared paste validators for a drop", () => {
    expect(rewordPictureError("Couldn't paste the picture: the PNG has invalid structure.")).toBe("the PNG has invalid structure.");
  });
});

describe("prepareDroppedImage", () => {
  it("keeps PNG byte for byte, once the webview has decoded it", async () => {
    const raster = fakeRaster();
    const check = fakeCheck();
    const result = await prepareDroppedImage("a.png", pngBytes(), decoders(raster, check));
    expect(result).toEqual({ ok: true, image: { name: "a.png", mimeType: "image/png",
      dataBase64: btoa(String.fromCharCode(...pngBytes())), notes: [] } });
    expect(raster.calls).toBe(0);
    expect(check.calls.map(([mimeType]) => mimeType)).toEqual(["image/png"]);
  });

  it("refuses a PNG whose chunks frame correctly but whose pixels cannot be decoded", async () => {
    const broken: DecodeCheck = async () => { throw new Error("the webview could not decode it."); };
    expect(await prepareDroppedImage("a.png", pngWithSize(4, 4), decoders(fakeRaster(), broken)))
      .toEqual({ ok: false, reason: "the PNG could not be decoded: the webview could not decode it." });
    expect(await prepareDroppedImage("b.png", pngWithSize(4, 4), decoders(fakeRaster(), fakeCheck({ width: 0, height: 0 }))))
      .toEqual({ ok: false, reason: "the PNG could not be decoded: the webview could not decode it." });
    // The decoder's own size is held to the caps too.
    expect(await prepareDroppedImage("c.png", pngWithSize(4, 4), decoders(fakeRaster(), fakeCheck({ width: 16_385, height: 1 }))))
      .toEqual({ ok: false, reason: "it is 16385 × 1 pixels; the limit is 16384 pixels on a side." });
  });

  it("draws the sanitized SVG before keeping it, and refuses one the webview cannot draw", async () => {
    const check = fakeCheck({ width: 0, height: 0 });
    const svg = svgBytes(`<svg ${NS} width="4" height="4"><rect width="4" height="4"/></svg>`);
    const result = await prepareDroppedImage("a.svg", svg, decoders(fakeRaster(), check));
    // An SVG without an intrinsic size decodes to 0 × 0 and is still fine.
    expect(result.ok).toBe(true);
    expect(check.calls.map(([mimeType]) => mimeType)).toEqual(["image/svg+xml"]);
    const broken: DecodeCheck = async () => { throw new Error("the webview could not decode it."); };
    expect(await prepareDroppedImage("b.svg", svg, decoders(fakeRaster(), broken)))
      .toEqual({ ok: false, reason: "the SVG could not be drawn: the webview could not decode it." });
  });

  it("decodes every bitmap an SVG embeds under the file's deadline, and refuses the SVG naming one that fails", async () => {
    const png = btoa(String.fromCharCode(...pngBytes()));
    const jpeg = btoa(String.fromCharCode(...jpegHeader(2, 2)));
    const svg = svgBytes(`<svg ${NS} width="4" height="4"><image href="data:image/png;base64,${png}" width="2" height="2"/>`
      + `<image href="data:image/png;base64,${png}" width="2" height="2"/><image href="data:image/jpeg;base64,${jpeg}" width="2" height="2"/></svg>`);
    const check = fakeCheck({ width: 2, height: 2 });
    const signal = new AbortController().signal;
    expect((await prepareDroppedImage("a.svg", svg, decoders(fakeRaster(), check), { signal })).ok).toBe(true);
    // Each distinct bitmap once, then the SVG itself, all with the file's signal.
    expect(check.calls).toEqual([["image/png", signal], ["image/jpeg", signal], ["image/svg+xml", signal]]);
    const failsJpeg: DecodeCheck = async (_bytes, mimeType) => {
      if (mimeType === "image/jpeg") throw new Error("the webview could not decode it.");
      return { width: 2, height: 2 };
    };
    expect(await prepareDroppedImage("b.svg", svg, decoders(fakeRaster(), failsJpeg)))
      .toEqual({ ok: false, reason: "an embedded JPEG picture could not be decoded: the webview could not decode it." });
    const empty: DecodeCheck = async (_bytes, mimeType) => mimeType === "image/png" ? { width: 0, height: 0 } : { width: 2, height: 2 };
    expect(await prepareDroppedImage("c.svg", svg, decoders(fakeRaster(), empty)))
      .toEqual({ ok: false, reason: "an embedded PNG picture could not be decoded: the webview could not decode it." });
    // A decoder that never settles on the embedded bitmap ends at the deadline like any other.
    const hangs: DecodeCheck = (_bytes, mimeType) => mimeType === "image/png" ? new Promise(() => {}) : Promise.resolve({ width: 2, height: 2 });
    const result = await prepareDroppedImages([memorySource("d.svg", svg)], decoders(fakeRaster(), hangs), { deadlineMs: 50 });
    expect(result.refusals).toEqual([{ name: "d.svg", reason: "reading it took longer than 0.1 seconds." }]);
  });

  it("re-encodes JPEG, GIF and WebP through the injected decoder after a header check", async () => {
    for (const [name, bytes] of [["a.jpg", jpegHeader(8, 8)], ["a.gif", gifHeader(8, 8)], ["a.webp", webpVp8Header(8, 8)]] as const) {
      const raster = vi.fn(fakeRaster());
      const result = await prepareDroppedImage(name, bytes, decoders(raster));
      expect(result.ok, name).toBe(true);
      expect(raster).toHaveBeenCalledWith(bytes, expect.stringMatching(/^image\/(jpeg|gif|webp)$/), MAX_IMAGE_OBJECT_BYTES, {});
    }
  });

  it("refuses a decompression bomb from its header, before decoding", async () => {
    const raster = fakeRaster();
    expect(await prepareDroppedImage("bomb.jpg", jpegHeader(16_385, 4), decoders(raster)))
      .toEqual({ ok: false, reason: "it is 16385 × 4 pixels; the limit is 16384 pixels on a side." });
    expect(await prepareDroppedImage("bomb.gif", gifHeader(16_000, 16_000), decoders(raster)))
      .toEqual({ ok: false, reason: "it is 16000 × 16000 pixels; the decoded limit is 256 MiB." });
    expect(await prepareDroppedImage("bomb.webp", webpVp8Header(16_383, 16_383), decoders(raster))).toMatchObject({ ok: false });
    expect(await prepareDroppedImage("bomb.png", pngWithSize(20_000, 1), decoders(raster)))
      .toEqual({ ok: false, reason: "it is 20000 × 1 pixels; the limit is 16384 pixels on a side." });
    expect(raster.calls).toBe(0);
  });

  it("refuses truncated headers and mislabelled contents by reason", async () => {
    const raster = fakeRaster();
    expect(await prepareDroppedImage("a.jpg", jpegHeader(8, 8).subarray(0, 24), decoders(raster)))
      .toEqual({ ok: false, reason: "the JPEG header is damaged or truncated, so its size can't be read." });
    expect(await prepareDroppedImage("a.png", new TextEncoder().encode("hello"), decoders(raster)))
      .toEqual({ ok: false, reason: "its contents are not a PNG, JPEG, GIF, WebP or SVG picture." });
    expect(await prepareDroppedImage("a.png", new Uint8Array([0x42, 0x4d, ...new Array(40).fill(0)]), decoders(raster)))
      .toEqual({ ok: false, reason: "BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first." });
    expect(await prepareDroppedImage("a.svg", new Uint8Array([0x1f, 0x8b, 8, 0]), decoders(raster)))
      .toEqual({ ok: false, reason: "compressed SVG (.svgz) can't be dropped; save it as plain SVG first." });
    expect(await prepareDroppedImage("a.png", pngBytes().subarray(0, 40), decoders(raster)))
      .toEqual({ ok: false, reason: "the PNG has invalid structure." });
    expect(raster.calls).toBe(0);
  });

  it("recognises a PNG named .jpg by its bytes", async () => {
    expect(await prepareDroppedImage("photo.jpg", pngBytes(), decoders(fakeRaster()))).toMatchObject({ ok: true, image: { mimeType: "image/png" } });
  });

  it("keeps the original drawn size when the decoder had to downscale", async () => {
    const raster: RasterToPng = async () => ({ png: pngBytes(), width: 3000, height: 2000, sourceWidth: 6000, sourceHeight: 4000, downscaled: true });
    const result = await prepareDroppedImage("big.jpg", jpegHeader(6000, 4000), decoders(raster));
    expect(result).toMatchObject({ ok: true, image: { naturalSize: { width: 6000, height: 4000 },
      notes: ["stored at 3000 × 2000 pixels (from 6000 × 4000) to fit the 25.0 MB picture limit"] } });
  });

  it("reports a decoder failure with the format", async () => {
    const raster: RasterToPng = async () => { throw new Error("the webview could not decode it."); };
    expect(await prepareDroppedImage("a.webp", webpVp8Header(2, 2), decoders(raster)))
      .toEqual({ ok: false, reason: "the WebP could not be converted: the webview could not decode it." });
  });

  it("sanitizes SVG and embeds the sanitized text, decoding UTF-8 and UTF-16 with a BOM", async () => {
    const source = `<svg ${NS} width="10" height="5"><script>x()</script><rect width="10" height="5" fill="url(https://e.test/#g)"/><text>αβ</text></svg>`;
    const utf8 = await prepareDroppedImage("a.svg", svgBytes(source), decoders(fakeRaster()));
    expect(utf8).toMatchObject({ ok: true, image: { mimeType: "image/svg+xml",
      notes: ["external content was removed", "scripts and animation were removed"] } });
    const text = utf8.ok ? new TextDecoder().decode(Uint8Array.from(atob(utf8.image.dataBase64), c => c.charCodeAt(0))) : "";
    expect(text).not.toContain("script");
    expect(text).not.toContain("e.test");
    expect(text).toContain("viewBox=\"0 0 10 5\"");
    expect(text).toContain("αβ");
    const units = [0xff, 0xfe, ...Array.from(source, character => [character.charCodeAt(0) & 0xff, character.charCodeAt(0) >> 8]).flat()];
    const utf16 = await prepareDroppedImage("b.svg", new Uint8Array(units), decoders(fakeRaster()));
    expect(utf16.ok && utf16.image.dataBase64).toBe(utf8.ok && utf8.image.dataBase64);
    expect(await prepareDroppedImage("c.svg", new Uint8Array([...svgBytes(`<svg ${NS}><text>`), 0xc3, 0x28, ...svgBytes("</text></svg>")]), decoders(fakeRaster())))
      .toEqual({ ok: false, reason: "the SVG is not valid UTF-8 or UTF-16 text." });
    expect(await prepareDroppedImage("d.svg", svgBytes(`<svg ${NS}><g></svg>`), decoders(fakeRaster())))
      .toEqual({ ok: false, reason: "the SVG is not well-formed XML." });
  });
});

describe("size and count caps", () => {
  it("refuses a file over 20 MB from metadata without reading it, and accepts exactly 20 MB", async () => {
    const over = memorySource("over.png", pngBytes(), MAX_DROPPED_IMAGE_BYTES + 1);
    const exact = memorySource("exact.png", pngBytes(), MAX_DROPPED_IMAGE_BYTES);
    const result = await prepareDroppedImages([over, exact], decoders());
    expect(over.reads).toBe(0);
    expect(exact.reads).toBe(1);
    expect(result.images.map(image => image.name)).toEqual(["exact.png"]);
    expect(result.refusals).toEqual([{ name: "over.png", reason: "it is just over 20.0 MB; a dropped picture can be at most 20.0 MB." }]);
  });

  it("caps pictures per drop and total bytes, naming each refused file", async () => {
    const many = Array.from({ length: MAX_DROPPED_IMAGES + 2 }, (_, index) => memorySource(`p${index}.png`, pngBytes()));
    const result = await prepareDroppedImages(many, decoders());
    expect(result.images).toHaveLength(MAX_DROPPED_IMAGES);
    expect(result.refusals).toEqual([
      { name: "p50.png", reason: "only 50 pictures can be dropped at once.", wholeDrop: "count" },
      { name: "p51.png", reason: "only 50 pictures can be dropped at once.", wholeDrop: "count" }
    ]);
    const big = Array.from({ length: 11 }, (_, index) => memorySource(`b${index}.png`, pngBytes(), MAX_DROPPED_IMAGE_BYTES));
    const total = await prepareDroppedImages(big, decoders());
    expect(total.images).toHaveLength(MAX_DROPPED_IMAGE_TOTAL_BYTES / MAX_DROPPED_IMAGE_BYTES);
    expect(total.refusals).toEqual([{ name: "b10.png", reason: "the pictures in one drop can total at most 200.0 MB.", wholeDrop: "totalBytes" }]);
    expect(big[10]!.reads).toBe(0);
  });

  it("browser reads check File.size first and again after reading", async () => {
    const arrayBuffer = vi.fn(async () => pngBytes().buffer as ArrayBuffer);
    const lying = browserDroppedImageSource({ name: "x.png", size: 10, arrayBuffer });
    await expect(lying.read(9)).rejects.toThrow(/^it is just over 0\.0 MB; a dropped picture can be at most 0\.0 MB\.$/);
    expect(arrayBuffer).not.toHaveBeenCalled();
    const grows = browserDroppedImageSource({ name: "x.png", size: 1, arrayBuffer });
    await expect(grows.read(10)).rejects.toThrow("it is larger than the 0.0 MB limit for a dropped picture.");
    await expect(browserDroppedImageSource({ name: "x.png", size: 70, arrayBuffer }).read(70)).resolves.toHaveLength(70);
  });

  it("native reads stat first and stop one byte past the limit", async () => {
    vi.resetModules();
    const close = vi.fn(async () => {});
    vi.doMock("@tauri-apps/plugin-fs", () => ({
      stat: async () => ({ size: 3 }),
      open: async () => {
        let left = 100;
        return { read: async (buffer: Uint8Array) => { const count = Math.min(buffer.length, left); left -= count; return count; }, close };
      }
    }));
    const { nativeDroppedImageSource: fresh } = await import("./readDroppedFile");
    const source = fresh("/tmp/dir/grows.png");
    expect(source.name).toBe("grows.png");
    expect(await source.size()).toBe(3);
    await expect(source.read(10)).rejects.toThrow("limit for a dropped picture");
    expect(close).toHaveBeenCalled();
    await expect(source.read(100)).resolves.toHaveLength(100);
    vi.doUnmock("@tauri-apps/plugin-fs");
    expect(nativeDroppedImageSource("C:\\Pictures\\a.png").name).toBe("a.png");
  });
});

describe("deadlines", () => {
  it("gives each file a deadline, tells the decoder through its signal, and goes on with the next file", async () => {
    let seen: AbortSignal | undefined;
    // One decoder honours the signal, one never settles at all.
    const honours: RasterToPng = (_bytes, _type, _max, options) => new Promise((_resolve, reject) => {
      seen = options?.signal;
      options?.signal?.addEventListener("abort", () => reject(options.signal!.reason));
    });
    const hangs: DecodeCheck = () => new Promise(() => {});
    const sources = [memorySource("slow.jpg", jpegHeader(8, 8)), memorySource("stuck.png", pngBytes()), memorySource("ok.gif", gifHeader(2, 2))];
    let calls = 0;
    const result = await prepareDroppedImages(sources, {
      rasterToPng: (...args) => (calls++ === 0 ? honours(...args) : fakeRaster()(...args)),
      decodeCheck: hangs
    }, { deadlineMs: 50 });
    expect(seen?.aborted).toBe(true);
    expect(result.images.map(image => image.name)).toEqual(["ok.gif"]);
    expect(result.refusals).toEqual([
      { name: "slow.jpg", reason: "reading it took longer than 0.1 seconds." },
      { name: "stuck.png", reason: "reading it took longer than 0.1 seconds." }
    ]);
  });
});

describe("deadlines cover the filesystem too", () => {
  it("ends a stat that never returns at the deadline and goes on with the next file", async () => {
    const stuck: DroppedImageSource = { name: "stuck.png", size: () => new Promise(() => {}), read: async () => pngBytes() };
    const result = await prepareDroppedImages([stuck, memorySource("ok.png", pngBytes())], decoders(), { deadlineMs: 50 });
    expect(result.images.map(image => image.name)).toEqual(["ok.png"]);
    expect(result.refusals).toEqual([{ name: "stuck.png", reason: "its size could not be read (it took longer than 0.1 seconds)." }]);
  });

  it("ends a read that never returns at the deadline, tells the reader through its signal, and goes on", async () => {
    let seen: AbortSignal | undefined;
    const stalled: DroppedImageSource = {
      name: "stalled.png", size: async () => 10,
      read: (_max, options) => { seen = options?.signal; return new Promise(() => {}); }
    };
    const result = await prepareDroppedImages([stalled, memorySource("ok.png", pngBytes())], decoders(), { deadlineMs: 50 });
    expect(seen?.aborted).toBe(true);
    expect(result.images.map(image => image.name)).toEqual(["ok.png"]);
    expect(result.refusals).toEqual([{ name: "stalled.png", reason: "reading it took longer than 0.1 seconds." }]);
  });

  it("closes a native file whose read stalls, as soon as the deadline aborts it", async () => {
    vi.resetModules();
    const close = vi.fn(async () => {});
    vi.doMock("@tauri-apps/plugin-fs", () => ({
      stat: () => new Promise(() => {}),
      open: async () => ({ read: () => new Promise(() => {}), close })
    }));
    const { nativeDroppedImageSource: fresh } = await import("./readDroppedFile");
    const source = fresh("/tmp/stalled.png");
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("late")), 20);
    await expect(source.read(100, { signal: controller.signal })).rejects.toThrow("late");
    expect(close).toHaveBeenCalledTimes(1);
    const statController = new AbortController();
    setTimeout(() => statController.abort(new Error("slow stat")), 20);
    await expect(source.size({ signal: statController.signal })).rejects.toThrow("slow stat");
    vi.doUnmock("@tauri-apps/plugin-fs");
  });
});

describe("the document size limit", () => {
  const png = btoa(String.fromCharCode(...pngBytes()));
  const cost = savedPictureBytes(png.length);

  it("counts a picture's base64 twice encoded: 4/3 of it in the saved file", () => {
    expect(cost).toBe(Math.ceil((png.length + 1024) * 4 / 3));
    // Twenty-five 20 MB pictures fit the per-drop caps but could never be reopened.
    expect(25 * savedPictureBytes(Math.ceil(20 * 1024 * 1024 * 4 / 3))).toBeGreaterThan(MAX_OPEN_DOCUMENT_BYTES);
  });

  it("refuses pictures past the budget while preparing, so their base64 is never held", async () => {
    const sources = ["a.png", "b.png", "c.png"].map(name => memorySource(name, pngBytes()));
    const result = await prepareDroppedImages(sources, decoders(), { budgetBytes: 2 * cost });
    expect(result.images.map(image => image.name)).toEqual(["a.png", "b.png"]);
    expect(result.refusals).toEqual([{ name: "c.png", reason: "it would make the document larger than 64.0 MB, the most ChemDraft can open." }]);
  });

  it("admits the pictures that fit beside the document at commit, measured again then, and names the rest", async () => {
    const inserted: string[][] = [];
    const status: string[] = [];
    let measured = 0;
    const room = MAX_OPEN_DOCUMENT_BYTES - DROP_DOCUMENT_MARGIN_BYTES;
    await handleDroppedFiles([{ name: "one.png" }, { name: "two.png" }, { name: "three.png" }], {
      nameOf: entry => entry.name,
      imageSource: entry => memorySource(entry.name, pngBytes()),
      openDocuments: async () => undefined,
      // At drop time there is room for all three; by commit the document has grown to fit one.
      documentBytes: () => (measured++ === 0 ? 0 : room - cost),
      insertImages: images => { inserted.push(images.map(image => image.name)); return { ok: true, scaledToPage: [] }; },
      decoders: decoders(),
      setStatus: text => status.push(text)
    });
    expect(measured).toBe(2);
    expect(inserted).toEqual([["one.png"]]);
    expect(status.at(-1)).toBe([
      "Inserted picture one.png",
      "Couldn't drop \"two.png\": it would make the document larger than 64.0 MB, the most ChemDraft can open",
      "Couldn't drop \"three.png\": it would make the document larger than 64.0 MB, the most ChemDraft can open."
    ].join("; "));
  });
});

describe("handleDroppedFiles", () => {
  type File = { name: string; bytes: Uint8Array };
  const file = (name: string, bytes: Uint8Array = pngBytes()): File => ({ name, bytes });

  function harness(insert: "ok" | "refuse" = "ok") {
    const calls = { opened: [] as string[][], inserted: [] as string[][], status: [] as string[] };
    return {
      calls,
      handler: {
        nameOf: (entry: File) => entry.name,
        imageSource: (entry: File) => memorySource(entry.name, entry.bytes),
        openDocuments: async (entries: File[]) => { calls.opened.push(entries.map(entry => entry.name)); return "Opened 1 document"; },
        insertImages: (images: { name: string }[]) => {
          calls.inserted.push(images.map(image => image.name));
          return insert === "ok" ? { ok: true as const, scaledToPage: [] } : { ok: false as const, reason: "the document tab changed during the read; try the drop again." };
        },
        decoders: decoders(),
        documentBytes: () => 0,
        setStatus: (status: string) => calls.status.push(status)
      }
    };
  }

  it("sends a drop without pictures to the document-open path unchanged", async () => {
    const { calls, handler } = harness();
    await handleDroppedFiles([file("a.cdxml"), file("b.chemdraft")], handler);
    expect(calls).toEqual({ opened: [["a.cdxml", "b.chemdraft"]], inserted: [], status: [] });
  });

  it("does both in a mixed drop: pictures first in one insertion, documents after, one combined status", async () => {
    const { calls, handler } = harness();
    await handleDroppedFiles([file("a.cdxml"), file("one.png"), file("bad.bmp"), file("fake.jpg", new TextEncoder().encode("nope")), file("two.png")], handler);
    expect(calls.inserted).toEqual([["one.png", "two.png"]]);
    expect(calls.opened).toEqual([["a.cdxml"]]);
    expect(calls.status.at(-1)).toBe([
      "Inserted 2 pictures (one.png, two.png)",
      "Couldn't drop \"bad.bmp\": BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first",
      "Couldn't drop \"fake.jpg\": its contents are not a PNG, JPEG, GIF, WebP or SVG picture",
      "Opened 1 document"
    ].join("; "));
  });

  it("sets the pictures' result on their tab before the documents open, then the whole outcome on the active tab", async () => {
    const events: string[] = [];
    const { handler } = harness();
    await handleDroppedFiles([file("a.cdxml"), file("one.png"), file("bad.bmp")], { ...handler,
      setStatus: status => events.push(`drop tab: ${status}`),
      showOutcome: status => events.push(`active tab: ${status}`),
      openDocuments: async () => { events.push("open documents"); return "Opened 1 document"; } });
    const pictures = "Inserted picture one.png; Couldn't drop \"bad.bmp\": BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first.";
    expect(events).toEqual([
      "drop tab: Reading the dropped picture…",
      `drop tab: ${pictures}`,
      "open documents",
      `active tab: ${pictures.replace(/\.$/, "")}; Opened 1 document`
    ]);
  });

  it("never leaves the drop tab on Reading, for a refusal at commit, a refusal at drop time or pictures only", async () => {
    for (const [insert, refusedNow, files] of [
      ["refuse", undefined, ["one.png", "a.mol"]],
      ["ok", "finish editing the text first.", ["one.png", "a.mol"]],
      ["ok", undefined, ["one.png", "two.png"]]
    ] as const) {
      const dropTab: string[] = [];
      const active: string[] = [];
      const { handler } = harness(insert);
      await handleDroppedFiles(files.map(name => file(name)), { ...handler, insertRefusal: () => refusedNow,
        setStatus: status => dropTab.push(status), showOutcome: status => active.push(status) });
      expect(dropTab.at(-1)).not.toMatch(/^Reading/);
      expect(dropTab.at(-1)).toMatch(insert === "refuse" || refusedNow ? /^"one\.png" was not inserted/ : /^Inserted 2 pictures/);
      expect(active).toHaveLength(1);
      expect(active[0]).toContain(dropTab.at(-1)!.replace(/\.$/, ""));
    }
  });

  it("reports a refused insertion and still opens the documents", async () => {
    const { calls, handler } = harness("refuse");
    await handleDroppedFiles([file("one.png"), file("a.mol")], handler);
    expect(calls.opened).toEqual([["a.mol"]]);
    expect(calls.status.at(-1)).toBe("\"one.png\" was not inserted: the document tab changed during the read; try the drop again; Opened 1 document");
  });

  it("names every picture a refused insertion leaves out, beside the documents of a mixed drop", async () => {
    const { calls, handler } = harness("refuse");
    await handleDroppedFiles([file("a.mol"), file("/in/a.png"), file("b.png"), file("bad.bmp"), file("c.png"), file("b.cdxml")], handler);
    expect(calls.opened).toEqual([["a.mol", "b.cdxml"]]);
    expect(calls.status.at(-1)).toBe([
      "\"a.png\", \"b.png\" and \"c.png\" were not inserted: the document tab changed during the read; try the drop again",
      "Couldn't drop \"bad.bmp\": BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first",
      "Opened 1 document"
    ].join("; "));
    const two = harness("refuse");
    await handleDroppedFiles([file("a.png"), file("b.png"), file("d.mol")], two.handler);
    expect(two.calls.status.at(-1)).toBe("\"a.png\" and \"b.png\" were not inserted: the document tab changed during the read; try the drop again; Opened 1 document");
  });

  it("refuses web links and shortcuts by name without reading or opening them, alone or among pictures", async () => {
    const { calls, handler } = harness();
    const link = memorySource("link.url", new TextEncoder().encode("[InternetShortcut]\nURL=https://example.com/\n"));
    await handleDroppedFiles([file("link.url")], { ...handler, imageSource: () => link });
    expect(link.reads).toBe(0);
    expect(calls.opened).toEqual([]);
    // No "Reading…" and no "No pictures were inserted": the refusal is the whole story, on the drop tab and as the outcome.
    expect(calls.status).toEqual(Array(2).fill("Couldn't drop \"link.url\": it is a web link, not a picture or a drawing."));

    const mixed = harness();
    await handleDroppedFiles([file("page.webloc"), file("one.png"), file("Drawing.lnk"), file("a.cdxml")], mixed.handler);
    expect(mixed.calls.inserted).toEqual([["one.png"]]);
    expect(mixed.calls.opened).toEqual([["a.cdxml"]]);
    expect(mixed.calls.status.at(-1)).toBe([
      "Inserted picture one.png",
      "Couldn't drop \"page.webloc\": it is a web link, not a picture or a drawing",
      "Couldn't drop \"Drawing.lnk\": it is a shortcut; drop the file it points to instead",
      "Opened 1 document"
    ].join("; "));

    // A link beside documents only: the documents still open, the link is named.
    const withDocument = harness();
    await handleDroppedFiles([file("link.url"), file("a.cdxml")], withDocument.handler);
    expect(withDocument.calls.opened).toEqual([["a.cdxml"]]);
    expect(withDocument.calls.status.at(-1)).toBe("Couldn't drop \"link.url\": it is a web link, not a picture or a drawing; Opened 1 document");
  });

  it("tells a guard refusal at drop time, before reading anything, and still opens the documents", async () => {
    const { calls, handler } = harness();
    const source = memorySource("one.png", pngBytes());
    await handleDroppedFiles([file("one.png"), file("a.mol")], { ...handler, imageSource: () => source,
      insertRefusal: () => "finish editing the text first." });
    expect(source.reads).toBe(0);
    expect(calls.inserted).toEqual([]);
    expect(calls.status.at(-1)).toBe("\"one.png\" was not inserted: finish editing the text first; Opened 1 document");
  });

  it("names the dropped picture files in a refusal at drop time, by their base names", async () => {
    const { calls, handler } = harness();
    await handleDroppedFiles([file("C:\\in\\one.png"), file("a.mol"), file("/in/two.svg")], { ...handler,
      insertRefusal: () => "finish editing the text first." });
    expect(calls.status.at(-1)).toBe("\"one.png\" and \"two.svg\" were not inserted: finish editing the text first; Opened 1 document");
  });

  it("commits only when the canvas is idle, and reports a canvas that stayed busy", async () => {
    const { calls, handler } = harness();
    let release!: () => void;
    const idle = new Promise<void>(resolve => { release = resolve; });
    const drop = handleDroppedFiles([file("one.png")], { ...handler,
      whenIdle: async <R,>(commit: () => R) => { await idle; return commit(); } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls.inserted).toEqual([]);
    release();
    await drop;
    expect(calls.inserted).toEqual([["one.png"]]);

    const busy = harness();
    await handleDroppedFiles([file("two.png")], { ...busy.handler,
      whenIdle: async () => { throw new Error("the canvas stayed busy with another edit; try the drop again."); } });
    expect(busy.calls.inserted).toEqual([]);
    expect(busy.calls.status.at(-1)).toBe("\"two.png\" was not inserted: the canvas stayed busy with another edit; try the drop again.");
  });

  it("serializes the picture work of overlapping drops", async () => {
    const order: string[] = [];
    let queue = Promise.resolve();
    const serialize = <R,>(task: () => Promise<R>) => {
      const run = queue.then(task);
      queue = run.then(() => undefined, () => undefined);
      return run;
    };
    const slow = harness();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = handleDroppedFiles([file("first.png")], { ...slow.handler, serialize,
      imageSource: entry => ({ ...memorySource(entry.name, entry.bytes), read: async () => { await gate; order.push("read first"); return entry.bytes; } }),
      insertImages: images => { order.push(`insert ${images[0]!.name}`); return { ok: true, scaledToPage: [] }; } });
    const second = handleDroppedFiles([file("second.png")], { ...slow.handler, serialize,
      insertImages: images => { order.push(`insert ${images[0]!.name}`); return { ok: true, scaledToPage: [] }; } });
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["read first", "insert first.png", "insert second.png"]);
  });
});

describe("formatImageDropStatus", () => {
  it("does not throw for a very large refusal list", () => {
    const refusals = Array.from({ length: 150_000 }, (_, index) => ({ name: `f${index}.png`, reason: `r${index}.` }));
    const status = formatImageDropStatus({ inserted: [], refusals });
    expect(status).toContain("f0.png");
    expect(status).toContain("f149999.png");
  });
  it("lists a few names, then counts the rest", () => {
    const images = Array.from({ length: 7 }, (_, index) => ({ name: `p${index}.png`, mimeType: "image/png" as const, dataBase64: "", notes: [] }));
    expect(formatImageDropStatus({ inserted: images, refusals: [], scaledToPage: ["p1.png"] }))
      .toBe("Inserted 7 pictures (p0.png, p1.png, p2.png, p3.png, p4.png and 2 more); scaled to fit the page: p1.png");
    expect(formatImageDropStatus({ inserted: [], refusals: [{ name: "C:\\a\\x.tif", reason: "r." }] }))
      .toBe("No pictures were inserted; Couldn't drop \"x.tif\": r.");
    // Nothing in the drop was a picture to read: the refusal alone.
    expect(formatImageDropStatus({ inserted: [], refusals: [{ name: "x.url", reason: "r." }], nothingToRead: true }))
      .toBe("Couldn't drop \"x.url\": r.");
  });

  it("names every picture that was not inserted, quoted, one or several", () => {
    const status = (names: string[]) => formatImageDropStatus({ inserted: [], refusals: [], notInserted: { names, reason: "the reason." } });
    expect(status(["slow.png"])).toBe("\"slow.png\" was not inserted: the reason.");
    expect(status(["a.png", "C:\\x\\b.png"])).toBe("\"a.png\" and \"b.png\" were not inserted: the reason.");
    const many = Array.from({ length: 8 }, (_, index) => `p${index}.png`);
    expect(status(many)).toBe(`${many.slice(0, -1).map(name => `"${name}"`).join(", ")} and "p7.png" were not inserted: the reason.`);
  });

  it("drops a reason's own period before the separator, keeping only the last one", () => {
    expect(formatImageDropStatus({ inserted: [], refusals: [{ name: "a.png", reason: "first." }, { name: "b.png", reason: "second." }] }))
      .toBe("No pictures were inserted; Couldn't drop \"a.png\": first; Couldn't drop \"b.png\": second.");
  });

  it("names every refused file, however many", () => {
    const refusals = ["a.bmp", "b.bmp", "c.bmp", "d.bmp", "e.bmp", "fake.png"].map(name => ({ name, reason: "its reason." }));
    const status = formatImageDropStatus({ inserted: [], refusals });
    expect(status).toBe(["No pictures were inserted",
      ...refusals.map(refusal => `Couldn't drop "${refusal.name}": its reason`)].join("; ") + ".");
    expect(status).not.toMatch(/more files/);
  });

  it("gives whole-drop refusals one part naming each of their files", () => {
    const count = (name: string) => ({ name, reason: "only 50 pictures can be dropped at once.", wholeDrop: "count" as const });
    const format = (refusals: { name: string; reason: string; wholeDrop?: "count" | "totalBytes" }[]) =>
      formatImageDropStatus({ inserted: [], refusals });
    expect(format([count("a.png")])).toBe("No pictures were inserted; Couldn't drop \"a.png\": only 50 pictures can be dropped at once.");
    expect(format([count("a.png"), count("/x/b.png")]))
      .toBe("No pictures were inserted; Couldn't drop \"a.png\" and \"b.png\": only 50 pictures can be dropped at once.");
    expect(format([count("a.png"), count("b.png"), count("c.png")]))
      .toBe("No pictures were inserted; Couldn't drop \"a.png\", \"b.png\" and \"c.png\": only 50 pictures can be dropped at once.");
  });

  it("keeps per-file and whole-drop refusals in order, each group where its first file was", () => {
    const total = (name: string) => ({ name, reason: "the pictures in one drop can total at most 200.0 MB.", wholeDrop: "totalBytes" as const });
    const count = (name: string) => ({ name, reason: "only 50 pictures can be dropped at once.", wholeDrop: "count" as const });
    const own = (name: string) => ({ name, reason: "its contents are not a picture." });
    expect(formatImageDropStatus({ inserted: [], refusals: [own("x.bmp"), total("t1.png"), own("y.png"), count("c1.png"), total("t2.png"), count("c2.png"), own("z.png")] }))
      .toBe([
        "No pictures were inserted",
        "Couldn't drop \"x.bmp\": its contents are not a picture",
        "Couldn't drop \"t1.png\" and \"t2.png\": the pictures in one drop can total at most 200.0 MB",
        "Couldn't drop \"y.png\": its contents are not a picture",
        "Couldn't drop \"c1.png\" and \"c2.png\": only 50 pictures can be dropped at once",
        "Couldn't drop \"z.png\": its contents are not a picture."
      ].join("; "));
  });
});

describe("splitDrop", () => {
  it("keeps drop order within each group", () => {
    expect(splitDrop(["b.png", "a.cdx", "c.svg", "d.heic"], name => name))
      .toEqual({ images: ["b.png", "c.svg"], documents: ["a.cdx"], refusals: [{ name: "d.heic", reason: "HEIC/HEIF pictures can't be dropped yet; save it as PNG or JPEG first." }] });
  });
});
