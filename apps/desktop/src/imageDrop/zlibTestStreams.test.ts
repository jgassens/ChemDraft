import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pngImageDataError } from "./pngIntegrity";
import { testPng } from "./pngTestImages";
import { zlibOfZeros } from "./zlibTestStreams";

describe("zlibOfZeros", () => {
  it.each([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    255, 256, 257, 258, 259, 260, 261, 262,
    515, 516, 517, 518, 519, 520, 521
  ])("inflates to exactly %i zero bytes with a valid zlib checksum", count => {
    expect(inflateSync(zlibOfZeros(count))).toEqual(Buffer.alloc(count));
  });

  it("passes the PNG check with all 260 filtered bytes of a 16 × 4 RGBA image", async () => {
    const png = testPng({ width: 16, height: 4, colourType: 6, zlib: () => zlibOfZeros(260) });
    expect(await pngImageDataError(png)).toBeUndefined();
  });
});
