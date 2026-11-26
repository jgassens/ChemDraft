import { droppedFileBaseName, droppedImageSizeError, formatDropBytes } from "./dropFiles";
import type { DroppedImageSource } from "./dropHandler";
import { DropReasonError } from "./dropReason";
import { abortReason, untilAborted } from "./rasterDecode";

function tooLarge(size: number, maxBytes: number): Error {
  return new DropReasonError(droppedImageSizeError(size, maxBytes) ?? "it is too large.");
}

/** The file outgrew its metadata while it was read. */
function grewTooLarge(maxBytes: number): Error {
  return new DropReasonError(`it is larger than the ${formatDropBytes(maxBytes)} limit for a dropped picture.`);
}

/**
 * A browser `File`: size from its metadata, then a read bounded to one byte past the limit. A read
 * cannot be cancelled; past the deadline its result is let go.
 */
export function browserDroppedImageSource(file: Pick<File, "name" | "size" | "arrayBuffer"> & Partial<Pick<File, "slice">>): DroppedImageSource {
  return {
    name: file.name,
    size: async () => file.size,
    read: async (maxBytes, { signal } = {}) => {
      if (file.size > maxBytes) throw tooLarge(file.size, maxBytes);
      const blob = typeof file.slice === "function" ? file.slice(0, maxBytes + 1) : file;
      const bytes = new Uint8Array(await untilAborted(blob.arrayBuffer(), signal));
      if (bytes.length > maxBytes) throw grewTooLarge(maxBytes);
      return bytes;
    }
  };
}

/**
 * A dropped native path. Tauri's fs plugin adds dropped paths to its scope. The read is chunked and
 * stops one chunk past the limit, so a file that grows after `stat` is still refused. Every call
 * (stat, open, each chunk) ends at the deadline's signal; the file is closed then, not left open
 * behind a read that never returns.
 */
export function nativeDroppedImageSource(path: string): DroppedImageSource {
  return {
    name: droppedFileBaseName(path),
    size: async ({ signal } = {}) => {
      const { stat } = await import("@tauri-apps/plugin-fs");
      return (await untilAborted(stat(path), signal)).size;
    },
    read: async (maxBytes, { signal } = {}) => {
      const { open } = await import("@tauri-apps/plugin-fs");
      if (signal?.aborted) throw abortReason(signal);
      // A file the open delivers after the deadline is closed at once.
      const file = await untilAborted(open(path, { read: true }), signal, late => { void late.close().catch(() => undefined); });
      let closing: Promise<void> | undefined;
      const close = () => (closing ??= file.close().catch(() => undefined));
      const closeOnAbort = () => { void close(); };
      signal?.addEventListener("abort", closeOnAbort, { once: true });
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = new Uint8Array(Math.min(256 * 1024, maxBytes + 1 - length));
          const count = await untilAborted(file.read(chunk), signal);
          if (count === null || count === 0) break;
          length += count;
          if (length > maxBytes) throw grewTooLarge(maxBytes);
          chunks.push(chunk.subarray(0, count));
        }
      } finally {
        signal?.removeEventListener("abort", closeOnAbort);
        // After an abort the close is already under way; a close that stalls must not hold the drop.
        if (signal?.aborted) void close();
        else await close();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    }
  };
}
