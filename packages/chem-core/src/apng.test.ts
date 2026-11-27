import { crc32, deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { APNG_MAX_CHUNKS, apngFirstFrame, buildPngChunk, pngChunkAt, pngCrc32, validatePngImage } from "./index";
import {
  BLUE, defaultImageFirstFrameApng, fcTLChunk, fdATChunk, ihdrChunk, pixelData, PNG_SIGNATURE_BYTES, pngChunk, rawPixels, RED,
  separateFirstFrameApng, solidTestPng, u32
} from "./apng.fixture";

function chunks(bytes: Uint8Array) {
  const result: { type: string; data: Uint8Array; crcOk: boolean }[] = [];
  for (let offset = 8, next = pngChunkAt(bytes, offset); next; offset = next.end, next = pngChunkAt(bytes, offset)) {
    const stored = Buffer.from(bytes.subarray(next.end - 4, next.end)).readUInt32BE(0);
    result.push({ type: next.type, data: next.data, crcOk: stored === crc32(bytes.subarray(next.offset + 4, next.end - 4)) });
  }
  return result;
}
const imageData = (bytes: Uint8Array) => inflateSync(Buffer.concat(chunks(bytes).filter((c) => c.type === "IDAT").map((c) => c.data)));
const apng = (options: Parameters<typeof separateFirstFrameApng>[4] = {}) => separateFirstFrameApng(4, 3, RED, BLUE, options);
/** A copy of a chunk whose stored CRC no longer matches its type and data. */
const damaged = (chunk: Buffer) => {
  const copy = Buffer.from(chunk);
  copy[copy.length - 1]! ^= 0xff;
  return copy;
};
/** The indexed 2 x 1 animated PNG: a palette, transparency, a red default image and a frame 0 of palette index 1. */
const indexedApng = (plte = pngChunk("PLTE", Buffer.from([255, 0, 0, 0, 0, 255]))) => Buffer.concat([PNG_SIGNATURE_BYTES,
  pngChunk("IHDR", Buffer.concat([u32(2, 1), Buffer.from([8, 3, 0, 0, 0])])), pngChunk("acTL", u32(1, 0)), plte,
  pngChunk("tRNS", Buffer.from([255, 128])), pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0]))), fcTLChunk(0, 2, 1),
  fdATChunk(1, deflateSync(Buffer.from([0, 1, 1]))), pngChunk("IEND")]);

describe("PNG chunk framing", () => {
  it("computes the chunk CRC as zlib does", () => {
    const data = Buffer.from("IHDR and some data");
    expect(pngCrc32(data)).toBe(crc32(data));
    const read = chunks(Buffer.concat([PNG_SIGNATURE_BYTES, buildPngChunk("tEXt", Buffer.from("a\0b"))]));
    expect(read.map(({ type, crcOk }) => ({ type, crcOk }))).toEqual([{ type: "tEXt", crcOk: true }]);
    expect(Buffer.from(read[0]!.data).toString("latin1")).toBe("a\0b");
  });

  it("refuses a chunk whose length runs past the buffer", () => {
    expect(pngChunkAt(pngChunk("IDAT", Buffer.alloc(10)).subarray(0, 15), 0)).toBeUndefined();
  });
});

describe("apngFirstFrame", () => {
  it("passes a plain PNG through as the very same bytes", () => {
    const png = new Uint8Array(solidTestPng(4, 3, RED));
    const result = apngFirstFrame(png);
    expect(result).toEqual({ bytes: png, frame: "static" });
    expect(result.bytes).toBe(png);
  });

  it("uses the default image as it is when it is the first frame", () => {
    const png = new Uint8Array(defaultImageFirstFrameApng(4, 3, BLUE, RED));
    const result = apngFirstFrame(png);
    expect(result).toEqual({ bytes: png, frame: "default-image" });
    expect(result.bytes).toBe(png);
  });

  it("rebuilds a static PNG from the first frame when the default image is not part of the animation", () => {
    const gama = pngChunk("gAMA", u32(45455)), text = pngChunk("tEXt", Buffer.from("Comment\0kept out"));
    const result = apngFirstFrame(apng({ extra: [gama, text] }));
    expect(result.frame).toBe("first-frame");
    expect(result.warning).toBeUndefined();
    const read = chunks(result.bytes);
    expect(read.map((c) => c.type)).toEqual(["IHDR", "gAMA", "IDAT", "IEND"]);
    expect(read.every((c) => c.crcOk)).toBe(true);
    expect(Buffer.from(read[0]!.data)).toEqual(ihdrChunk(4, 3).subarray(8, 21));
    // The pixels are frame 0's (blue), not the default image's (red).
    expect(imageData(result.bytes)).toEqual(rawPixels(4, 3, BLUE));
    expect(validatePngImage(result.bytes).info).toMatchObject({ pixelWidth: 4, pixelHeight: 3 });
  });

  it("keeps the palette and transparency chunks of an indexed picture", () => {
    const result = apngFirstFrame(indexedApng());
    expect(chunks(result.bytes).map((c) => c.type)).toEqual(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
    expect(imageData(result.bytes)).toEqual(Buffer.from([0, 1, 1]));
  });

  it("joins a first frame split over several fdAT chunks, in order", () => {
    const data = pixelData(4, 3, BLUE);
    const result = apngFirstFrame(apng({ frame: [fcTLChunk(0, 4, 3), fdATChunk(1, data.subarray(0, 5)), fdATChunk(2, data.subarray(5))] }));
    expect(result.frame).toBe("first-frame");
    expect(chunks(result.bytes).filter((c) => c.type === "IDAT")).toHaveLength(2);
    expect(imageData(result.bytes)).toEqual(rawPixels(4, 3, BLUE));
  });

  it.each([
    ["a malformed acTL", { actl: pngChunk("acTL", u32(2)) }, "animation control chunk is malformed"],
    ["an acTL of no frames", { actl: pngChunk("acTL", u32(0, 0)) }, "animation control chunk is malformed"],
    ["a first frame that is not the whole canvas", { frame: [fcTLChunk(0, 2, 3), fdATChunk(1, pixelData(2, 3, BLUE))] }, "not the whole 4 x 3 canvas"],
    ["a first frame offset from the corner", { frame: [fcTLChunk(0, 4, 3, 1, 0), fdATChunk(1, pixelData(4, 3, BLUE))] }, "not the whole 4 x 3 canvas"],
    ["frame data out of sequence", { frame: [fcTLChunk(0, 4, 3), fdATChunk(5, pixelData(4, 3, BLUE))] }, "out of sequence"],
    ["a first frame with no data", { frame: [fcTLChunk(0, 4, 3)] }, "has no data"],
    ["a truncated frame control", { frame: [pngChunk("fcTL", u32(0, 4, 3)), fdATChunk(1, pixelData(4, 3, BLUE))] }, "frame control chunk is malformed"]
  ])("falls back to the default image with a warning for %s", (_name, options, reason) => {
    const result = apngFirstFrame(new Uint8Array(apng(options)));
    expect(result.frame).toBe("fallback");
    // The default image alone: no animation chunks left for a decoder to refuse, the red pixels kept.
    expect(chunks(result.bytes).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(chunks(result.bytes).every((c) => c.crcOk)).toBe(true);
    expect(imageData(result.bytes)).toEqual(rawPixels(4, 3, RED));
    expect(result.warning).toContain(reason);
    expect(result.warning).toContain("its default image is drawn instead");
  });

  it.each([
    ["frame 0's fcTL", { frame: [damaged(fcTLChunk(0, 4, 3)), fdATChunk(1, pixelData(4, 3, BLUE))] }, "fcTL"],
    ["frame 0's fdAT", { frame: [fcTLChunk(0, 4, 3), damaged(fdATChunk(1, pixelData(4, 3, BLUE)))] }, "fdAT"],
    ["the acTL", { actl: damaged(pngChunk("acTL", u32(2, 0))) }, "acTL"]
  ])("falls back to the default image with a warning when %s fails its CRC", (_name, options, type) => {
    const result = apngFirstFrame(new Uint8Array(apng(options)));
    expect(result.frame).toBe("fallback");
    expect(chunks(result.bytes).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(imageData(result.bytes)).toEqual(rawPixels(4, 3, RED));
    expect(result.warning).toContain(`its ${type} chunk fails its CRC check`);
  });

  it.each([
    ["a gAMA", () => apng({ extra: [damaged(pngChunk("gAMA", u32(45455)))] }), "gAMA", ["IHDR", "gAMA", "IDAT", "IEND"]],
    ["a PLTE", () => indexedApng(damaged(pngChunk("PLTE", Buffer.from([255, 0, 0, 0, 0, 255])))), "PLTE", ["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]],
    ["the IHDR", () => Buffer.concat([PNG_SIGNATURE_BYTES, damaged(ihdrChunk(4, 3)), apng().subarray(8 + 25)]), "IHDR", ["IHDR", "IDAT", "IEND"]]
  ])("falls back with a warning rather than copy %s chunk that fails its CRC", (_name, build, type, kept) => {
    const result = apngFirstFrame(new Uint8Array(build()));
    expect(result.frame).toBe("fallback");
    expect(result.warning).toContain(`its ${type} chunk fails its CRC check`);
    expect(result.warning).toContain("its default image is drawn instead");
    // The existing fallback: the default image alone, its chunks as they were.
    expect(chunks(result.bytes).map((c) => c.type)).toEqual(kept);
  });

  it("falls back rather than walk more chunks than the bound", () => {
    const filler = pngChunk("tEXt", Buffer.from("a\0b"));
    const png = Buffer.concat([PNG_SIGNATURE_BYTES, ihdrChunk(4, 3), pngChunk("acTL", u32(1, 0)), pngChunk("IDAT", pixelData(4, 3, RED)),
      Buffer.concat(Array.from({ length: APNG_MAX_CHUNKS }, () => filler)), fcTLChunk(0, 4, 3), fdATChunk(1, pixelData(4, 3, BLUE)), pngChunk("IEND")]);
    const result = apngFirstFrame(png);
    expect(result.frame).toBe("fallback");
    expect(result.warning).toContain(`more than ${APNG_MAX_CHUNKS} chunks`);
    // Too many chunks to strip within the bound either: the input comes back as it is.
    expect(result.bytes).toBe(png);
  });

  it("ignores an acTL after the image data, as the APNG format does", () => {
    const png = new Uint8Array(Buffer.concat([PNG_SIGNATURE_BYTES, ihdrChunk(4, 3), pngChunk("IDAT", pixelData(4, 3, RED)),
      pngChunk("acTL", u32(1, 0)), fcTLChunk(0, 4, 3), fdATChunk(1, pixelData(4, 3, BLUE)), pngChunk("IEND")]));
    expect(apngFirstFrame(png)).toEqual({ bytes: png, frame: "static" });
  });

  it("leaves bytes that are not a PNG alone", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(apngFirstFrame(bytes)).toEqual({ bytes, frame: "static" });
  });
});
