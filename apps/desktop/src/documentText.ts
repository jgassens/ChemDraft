/** Open transport shared by file pickers and shell requests. CDX stays binary; text uses its BOM. */
export type DocumentContents = string | Uint8Array;

export const MAX_OPEN_DOCUMENT_BYTES = 64 * 1024 * 1024;

export function assertDocumentSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OPEN_DOCUMENT_BYTES) {
    throw new Error("Document exceeds the 64 MB size limit");
  }
}

/** Check Blob metadata before arrayBuffer allocates the entire file. */
export async function readBrowserDocumentFile(file: Pick<Blob, "size" | "arrayBuffer">): Promise<DocumentContents> {
  assertDocumentSize(file.size);
  return decodeDocumentBytes(new Uint8Array(await file.arrayBuffer()));
}

export async function readNativeDocumentFile(path: string): Promise<DocumentContents> {
  const { stat, open } = await import("@tauri-apps/plugin-fs");
  assertDocumentSize((await stat(path)).size);
  const file = await open(path, { read: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length <= MAX_OPEN_DOCUMENT_BYTES) {
      const chunk = new Uint8Array(Math.min(64 * 1024, MAX_OPEN_DOCUMENT_BYTES + 1 - length));
      const count = await file.read(chunk);
      if (count === null || count === 0) break;
      length += count;
      assertDocumentSize(length);
      chunks.push(chunk.subarray(0, count));
    }
  } finally {
    await file.close();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return decodeDocumentBytes(bytes);
}

/** Shell transport must be checked before copying its JSON byte array or hashing it. */
export function decodeNativeDocumentContents(payload: { contents: string; bytes?: readonly number[] }): DocumentContents {
  if (!payload.bytes) {
    assertDocumentSize(payload.contents.length);
    return payload.contents;
  }
  assertDocumentSize(payload.bytes.length);
  if (!payload.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new Error("Document contains invalid binary bytes");
  }
  return new Uint8Array(payload.bytes);
}

export function isCdxDocumentBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && [0x56, 0x6a, 0x43, 0x44, 0x30, 0x31, 0x30, 0x30].every((byte, i) => bytes[i] === byte);
}

/** A stable key for coalescing shell events and repeated browser opens without decoding binary. */
export function documentContentsKey(contents: DocumentContents): string {
  assertDocumentSize(contents.length);
  if (typeof contents === "string") return `text:${contents}`;
  const chunks: string[] = [];
  for (let offset = 0; offset < contents.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...contents.subarray(offset, offset + 0x8000)));
  }
  return `bytes:${chunks.join("")}`;
}

export function decodeDocumentBytes(bytes: Uint8Array): DocumentContents {
  assertDocumentSize(bytes.byteLength);
  if (isCdxDocumentBytes(bytes)) return bytes;
  // A dangling odd byte after UTF-16 is dropped, as Rust's `chunks_exact(2)` drops it: decoded, it
  // becomes a trailing U+FFFD that the XML validator refuses, so the same truncated file opened
  // from Explorer and failed from File ▸ Open.
  const utf16Units = (from: number) => bytes.subarray(from, from + ((bytes.length - from) & ~1));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(utf16Units(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(utf16Units(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  return new TextDecoder("utf-8").decode(bytes);
}
