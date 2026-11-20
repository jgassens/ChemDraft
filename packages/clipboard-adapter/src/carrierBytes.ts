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
