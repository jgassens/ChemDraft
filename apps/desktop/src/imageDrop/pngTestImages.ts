/** Real PNGs built chunk by chunk, with every part open to damage, for the image-data tests. Tests only. */

import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { crc32 } from "../crc32";

/** The two hands-on failures: image data that cannot be inflated, and data that inflates wrong. */
export function damagedDropFixture(name: "r8-damaged.png" | "r9-midcorrupt.png"): Uint8Array {
  // From the repository root, where vitest runs; a jsdom module's own URL is not a file path.
  return new Uint8Array(readFileSync(`apps/desktop/src/imageDrop/fixtures/${name}`));
}

export interface TestPngChunk {
  type: string;
  data: Uint8Array;
  /** Written instead of the true CRC. */
  crc?: number;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

export interface TestPngOptions {
  width: number;
  height: number;
  colourType?: number;
  bitDepth?: number;
  interlace?: boolean;
  /** Change the inflated image data (filter bytes and rows) before it is compressed. */
  imageData?: (data: Uint8Array, rowStarts: number[]) => Uint8Array;
  /** Change the zlib stream before it is split into IDAT chunks. */
  zlib?: (stream: Uint8Array) => Uint8Array;
  /** IDAT data sizes in order; whatever is left goes in one last IDAT. */
  idatSizes?: number[];
  /** Change the chunk list (CRCs, order, extra chunks) before it is written. */
  chunks?: (chunks: TestPngChunk[]) => TestPngChunk[];
  /** Bytes after IEND. */
  trailing?: Uint8Array;
}

/** Count of `start + k * step` below `limit`. */
const steps = (limit: number, start: number, step: number) => limit > start ? Math.floor((limit - start - 1) / step) + 1 : 0;

/**
 * The inflated image data for these settings: each row a filter byte (cycling 0-4) and seeded
 * bytes, pass by pass for Adam7, with the offset of every row's filter byte.
 */
export function testImageData(width: number, height: number, colourType: number, bitDepth: number, interlace: boolean) {
  const bitsPerPixel = CHANNELS[colourType] * bitDepth;
  const passes = interlace
    ? ADAM7.map(([x, y, stepX, stepY]) => [steps(width, x, stepX), steps(height, y, stepY)])
    : [[width, height]];
  const rows: number[][] = [];
  for (const [columns, count] of passes) {
    if (!columns || !count) continue;
    for (let row = 0; row < count; row += 1) rows.push([Math.ceil(columns * bitsPerPixel / 8)]);
  }
  const data = new Uint8Array(rows.reduce((total, [length]) => total + 1 + length, 0));
  const rowStarts: number[] = [];
  let seed = 7;
  let offset = 0;
  rows.forEach(([length], index) => {
    rowStarts.push(offset);
    data[offset] = index % 5;
    for (let byte = 1; byte <= length; byte += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      data[offset + byte] = seed >>> 24;
    }
    offset += 1 + length;
  });
  return { data, rowStarts };
}

export function writeTestPng(chunks: readonly TestPngChunk[], trailing: Uint8Array = new Uint8Array()): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  for (const chunk of chunks) {
    const bytes = new Uint8Array(12 + chunk.data.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, chunk.data.length);
    bytes.set(new TextEncoder().encode(chunk.type), 4);
    bytes.set(chunk.data, 8);
    view.setUint32(8 + chunk.data.length, chunk.crc ?? crc32(bytes.subarray(4, 8 + chunk.data.length)));
    parts.push(bytes);
  }
  parts.push(trailing);
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** A real PNG (zlib from node:zlib), damaged only where the options say. */
export function testPng(options: TestPngOptions): Uint8Array {
  const { width, height, colourType = 2, bitDepth = 8, interlace = false } = options;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([bitDepth, colourType, 0, 0, interlace ? 1 : 0], 8);
  const { data, rowStarts } = testImageData(width, height, colourType, bitDepth, interlace);
  const imageData = options.imageData ? options.imageData(data, rowStarts) : data;
  let stream: Uint8Array = new Uint8Array(deflateSync(imageData));
  if (options.zlib) stream = options.zlib(stream);
  const chunks: TestPngChunk[] = [{ type: "IHDR", data: header }];
  if (colourType === 3) {
    chunks.push({ type: "PLTE", data: Uint8Array.from({ length: 3 * 2 ** Math.min(bitDepth, 8) }, (_, index) => index * 37) });
  }
  let offset = 0;
  for (const size of options.idatSizes ?? []) {
    chunks.push({ type: "IDAT", data: stream.subarray(offset, offset + size) });
    offset += size;
  }
  chunks.push({ type: "IDAT", data: stream.subarray(offset) }, { type: "IEND", data: new Uint8Array() });
  return writeTestPng(options.chunks ? options.chunks(chunks) : chunks, options.trailing);
}
