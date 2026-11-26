/**
 * PNG chunk framing shared by every reader and writer of PNG bytes in the packages: one place for the
 * signature, chunk framing, the chunk CRC and building a chunk. Nothing here decodes pixels.
 */

export const PNG_SIGNATURE: readonly number[] = [137, 80, 78, 71, 13, 10, 26, 10];

export interface PngChunk {
  /** Four ASCII characters, e.g. "IHDR". */
  type: string;
  /** Offset of the chunk's length field. */
  offset: number;
  /** Data length, excluding length, type and CRC. */
  length: number;
  /** The chunk's data (a view into the input). */
  data: Uint8Array;
  /** Offset just past the chunk's CRC: where the next chunk starts. */
  end: number;
}

export function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/** The chunk whose length field starts at `offset`, or undefined when its framing runs past the buffer. */
export function pngChunkAt(bytes: Uint8Array, offset: number): PngChunk | undefined {
  if (offset < 0 || offset + 12 > bytes.length) return undefined;
  const length = ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
  if (length > bytes.length - offset - 12) return undefined;
  return {
    type: String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!),
    offset, length, data: bytes.subarray(offset + 8, offset + 8 + length), end: offset + 12 + length
  };
}

let crcTable: Uint32Array | undefined;

/** CRC-32 as PNG uses it (ISO 3309), over the given bytes; a chunk's CRC covers its type and data. */
export function pngCrc32(bytes: Uint8Array, crc = 0xffffffff): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  for (let index = 0; index < bytes.length; index++) crc = crcTable[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One complete chunk: length, type, data and the CRC computed over type and data. */
export function buildPngChunk(type: string, data: Uint8Array): Uint8Array {
  if (!/^[A-Za-z]{4}$/.test(type)) throw new Error(`"${type}" is not a PNG chunk type.`);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) chunk[4 + index] = type.charCodeAt(index);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, pngCrc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
