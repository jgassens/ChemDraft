import { deflateSync } from "node:zlib";
import { buildPngChunk } from "./png";

/** Hand-built PNG and animated PNG test pictures, shared by the chem-core, export-engine and CLI tests. */

export type Rgba = [number, number, number, number];
export const RED: Rgba = [255, 0, 0, 255];
export const BLUE: Rgba = [0, 0, 255, 255];
export const GREEN: Rgba = [0, 255, 0, 255];

export const PNG_SIGNATURE_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const pngChunk = (type: string, data: Uint8Array = new Uint8Array(0)) => Buffer.from(buildPngChunk(type, data));
export const u32 = (...values: number[]) => {
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => data.writeUInt32BE(value, index * 4));
  return data;
};
/** Unfiltered scanlines of one colour: RGBA, or RGB when `channels` is 3. */
export const rawPixels = (width: number, height: number, color: Rgba, channels: 3 | 4 = 4) => {
  const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: width }, () => Buffer.from(color.slice(0, channels)))]);
  return Buffer.concat(Array.from({ length: height }, () => row));
};
export const pixelData = (width: number, height: number, color: Rgba, channels: 3 | 4 = 4) => deflateSync(rawPixels(width, height, color, channels));
export const ihdrChunk = (width: number, height: number, channels: 3 | 4 = 4) =>
  pngChunk("IHDR", Buffer.concat([u32(width, height), Buffer.from([8, channels === 4 ? 6 : 2, 0, 0, 0])]));
export const fcTLChunk = (sequence: number, width: number, height: number, x = 0, y = 0) =>
  pngChunk("fcTL", Buffer.concat([u32(sequence, width, height, x, y), Buffer.from([0, 1, 0, 10, 0, 0])]));
export const fdATChunk = (sequence: number, data: Uint8Array) => pngChunk("fdAT", Buffer.concat([u32(sequence), data]));

/** A still PNG of one colour. */
export function solidTestPng(width: number, height: number, color: Rgba, channels: 3 | 4 = 4): Buffer {
  return Buffer.concat([PNG_SIGNATURE_BYTES, ihdrChunk(width, height, channels),
    pngChunk("IDAT", pixelData(width, height, color, channels)), pngChunk("IEND")]);
}

/**
 * An animated PNG of `defaultColor` whose default image is not part of the animation: frame 0 is
 * `firstColor` and frame 1 green. `frame` replaces frame 0's fcTL and fdAT chunks, `actl` the acTL.
 */
export function separateFirstFrameApng(width: number, height: number, defaultColor: Rgba, firstColor: Rgba,
  options: { channels?: 3 | 4; actl?: Buffer; frame?: Buffer[]; extra?: Buffer[] } = {}): Buffer {
  const channels = options.channels ?? 4;
  return Buffer.concat([PNG_SIGNATURE_BYTES, ihdrChunk(width, height, channels), ...(options.extra ?? []),
    options.actl ?? pngChunk("acTL", u32(2, 0)),
    pngChunk("IDAT", pixelData(width, height, defaultColor, channels)),
    ...(options.frame ?? [fcTLChunk(0, width, height), fdATChunk(1, pixelData(width, height, firstColor, channels))]),
    fcTLChunk(2, width, height), fdATChunk(3, pixelData(width, height, GREEN, channels)), pngChunk("IEND")]);
}

/** An animated PNG whose default image (`firstColor`) is frame 0; frame 1 is `laterColor`. */
export function defaultImageFirstFrameApng(width: number, height: number, firstColor: Rgba, laterColor: Rgba): Buffer {
  return Buffer.concat([PNG_SIGNATURE_BYTES, ihdrChunk(width, height), pngChunk("acTL", u32(2, 0)), fcTLChunk(0, width, height),
    pngChunk("IDAT", pixelData(width, height, firstColor)), fcTLChunk(1, width, height),
    fdATChunk(2, pixelData(width, height, laterColor)), pngChunk("IEND")]);
}
