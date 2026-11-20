const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  return crc;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function base64Digit(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

/** Validate and size base64 before allocating its decoded buffer. */
export class Base64Size {
  private digits = 0;
  private padding = 0;

  constructor(private readonly limit: number, private readonly limitError: string) {}

  add(code: number): void {
    if (code === 61 && this.padding < 2) {
      this.padding++;
    } else {
      if (this.padding || base64Digit(code) < 0) throw new Error("Invalid base64 character or padding.");
      this.digits++;
      if (Math.floor(this.digits * 3 / 4) > this.limit) throw new Error(this.limitError);
    }
  }

  finish(): number {
    const remainder = this.digits % 4;
    if (remainder === 1 || (this.padding > 0 && remainder + this.padding !== 4)) {
      throw new Error("Invalid base64 length or padding.");
    }
    return Math.floor(this.digits * 3 / 4);
  }
}

/** Write previously validated base64 directly into its exact-size output. */
export function base64Writer(output: Uint8Array): (code: number) => void {
  let offset = 0;
  let bits = 0;
  let value = 0;
  return (code) => {
    if (code === 61) return;
    value = (value << 6) | base64Digit(code);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[offset++] = value >>> bits;
    }
  };
}

/** Decode standard base64, with optional padding, from a compact string such as Office.js returns. */
export function decodeBase64Bounded(base64: string, maxBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid base64 byte limit.");
  const limitError = `Base64 data exceeds the ${maxBytes}-byte limit.`;
  if (base64.length > Math.ceil(maxBytes / 3) * 4) throw new Error(limitError);
  const size = new Base64Size(maxBytes, limitError);
  for (let i = 0; i < base64.length; i++) size.add(base64.charCodeAt(i));
  const output = new Uint8Array(size.finish());
  const write = base64Writer(output);
  for (let i = 0; i < base64.length; i++) write(base64.charCodeAt(i));
  return output;
}

export class UnsupportedDecompressionError extends Error {
  readonly code = "unsupported-decompression";
}

export function createDecompressionStream(format: CompressionFormat): DecompressionStream {
  if (typeof globalThis.DecompressionStream !== "function") {
    throw new UnsupportedDecompressionError("This runtime lacks DecompressionStream.");
  }
  try {
    return new globalThis.DecompressionStream(format);
  } catch {
    throw new UnsupportedDecompressionError(`This runtime does not support the ${format} decompression format.`);
  }
}

function* inputBlocks(parts: readonly Uint8Array[]): Generator<Uint8Array<ArrayBuffer>> {
  const blockSize = 16 * 1024;
  for (const part of parts) {
    for (let offset = 0; offset < part.length; offset += blockSize) {
      const length = Math.min(blockSize, part.length - offset);
      yield part.buffer instanceof ArrayBuffer
        ? new Uint8Array(part.buffer, part.byteOffset + offset, length)
        : Uint8Array.from(part.subarray(offset, offset + length));
    }
  }
}

/** Feed the decoder incrementally and cancel as soon as output exceeds the byte budget. */
export async function inflateBounded(
  parts: readonly Uint8Array[],
  decompressor: DecompressionStream,
  limit: number,
  limitError: string,
  output?: Uint8Array,
): Promise<Uint8Array> {
  const blocks = inputBlocks(parts);
  const reader = new ReadableStream<BufferSource>({
    pull(controller) {
      const next = blocks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
  }).pipeThrough(decompressor).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > limit - length) {
        await reader.cancel().catch(() => {});
        throw new Error(limitError);
      }
      if (output) output.set(value, length);
      else chunks.push(value);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  if (output) return output.subarray(0, length);

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
