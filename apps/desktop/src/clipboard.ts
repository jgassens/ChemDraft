import type { ClipboardReadPayload } from "@chemdraft/clipboard-adapter";
import { isDesktopRuntime } from "./window-manager";

export interface ClipboardWriteTextItem {
  type: string;
  text: string;
}

export type ClipboardWriteItem =
  | { type: string; text: string; required?: boolean }
  | { type: string; bytes: Uint8Array; required?: boolean };

export interface ClipboardWriteResult {
  ok: boolean;
  written: string[];
  failed: { type: string; reason: string }[];
  warnings: string[];
}

export async function readClipboardPayload(): Promise<ClipboardReadPayload> {
  if (isDesktopRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<ClipboardReadPayload>("read_clipboard_payload");
  }

  const text = await readBrowserClipboardText();
  return {
    types: text ? ["text/plain"] : [],
    textItems: text ? [{ type: "text/plain", text }] : []
  };
}

export async function writeClipboardText(text: string): Promise<boolean> {
  return writeClipboardTextItems([{ type: "text/plain", text }]);
}

export async function writeClipboardTextItems(items: readonly ClipboardWriteTextItem[]): Promise<boolean> {
  const desktop = isDesktopRuntime();
  const result = await writeClipboardItems(items);
  // Legacy browser callers accept a plain-text fallback when richer formats are unavailable.
  return result.ok || (!desktop && result.written.includes("text/plain"));
}

/**
 * Native writes enforce required/optional items and validate before clearing the clipboard.
 * Browsers can write fewer formats; on every platform ok means all required items were written.
 */
export async function writeClipboardItems(items: readonly ClipboardWriteItem[]): Promise<ClipboardWriteResult> {
  const itemIndexes = new Map<string, number>();
  const normalizedItems: ClipboardWriteItem[] = [];
  for (const item of items) {
    const type = item.type.trim();
    const length = "text" in item ? item.text.length : item.bytes.byteLength;
    if (!type || length === 0) {
      continue;
    }
    const existingIndex = itemIndexes.get(type);
    if (existingIndex !== undefined) {
      const existing = normalizedItems[existingIndex];
      normalizedItems[existingIndex] = { ...existing, required: existing.required !== false || item.required !== false };
      continue;
    }
    itemIndexes.set(type, normalizedItems.length);
    normalizedItems.push({ ...item, type, required: item.required ?? true });
  }
  if (normalizedItems.length === 0) {
    return { ok: false, written: [], failed: [], warnings: [] };
  }

  if (isDesktopRuntime()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<ClipboardWriteResult>("write_clipboard_items", {
        items: normalizedItems.map((item) => "text" in item
          ? item
          : { type: item.type, bytesBase64: clipboardBytesBase64(item.bytes), required: item.required })
      });
    } catch (error) {
      // A refused native request must not clear the clipboard through a browser retry.
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: normalizedItems.every((item) => item.required === false),
        written: [],
        failed: normalizedItems.map((item) => ({ type: item.type, reason })),
        warnings: []
      };
    }
  }

  return writeBrowserClipboardItems(normalizedItems);
}

function clipboardBytesBase64(bytes: Uint8Array): string {
  // Avoid spreading a large image into function arguments (which overflows the stack).
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

async function writeBrowserClipboardItems(items: readonly ClipboardWriteItem[]): Promise<ClipboardWriteResult> {
  const clipboard = globalThis.navigator?.clipboard;
  let reason = "Browser clipboard does not support this format.";
  const result = (written: string[]): ClipboardWriteResult => ({
    ok: items.every((item) => item.required === false || written.includes(item.type)),
    written,
    failed: items.filter((item) => !written.includes(item.type)).map((item) => ({ type: item.type, reason })),
    warnings: []
  });

  if (items.some((item) => item.type === "image/png" || item.type === "text/html")
    && clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      const data: Record<string, Blob> = {};
      for (const item of items) {
        if (!["text/plain", "text/html", "image/png"].includes(item.type)
          || (typeof ClipboardItem.supports === "function" && !ClipboardItem.supports(item.type))) {
          continue;
        }
        const contents = "text" in item ? item.text : new Uint8Array(item.bytes).buffer;
        data[item.type] = new Blob([contents], { type: item.type });
      }
      if (Object.keys(data).length > 0) {
        await clipboard.write([new ClipboardItem(data)]);
        return result(Object.keys(data));
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }

  const requestedPlainText = items.find((item) => item.type === "text/plain");
  let plainText: string | undefined;
  if (requestedPlainText) {
    if ("text" in requestedPlainText) {
      plainText = requestedPlainText.text;
    } else {
      try {
        plainText = new TextDecoder("utf-8", { fatal: true }).decode(requestedPlainText.bytes);
      } catch {
        reason = "text/plain bytes are not valid UTF-8.";
        return result([]);
      }
    }
  } else {
    const textItems = items.filter((item): item is ClipboardWriteTextItem => "text" in item);
    plainText = preferredPlainText(textItems);
  }
  if (plainText !== undefined && clipboard?.writeText) {
    try {
      await clipboard.writeText(plainText);
      return result(["text/plain"]);
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  return result([]);
}

export function writeClipboardDataTransfer(
  dataTransfer: DataTransfer,
  items: readonly ClipboardWriteTextItem[]
): boolean {
  const normalizedItems = normalizeClipboardWriteTextItems(items);
  if (normalizedItems.length === 0) {
    return false;
  }

  try {
    normalizedItems.forEach((item) => dataTransfer.setData(item.type, item.text));
    return true;
  } catch {
    return false;
  }
}

export function normalizeClipboardWriteTextItems(
  items: readonly ClipboardWriteTextItem[]
): ClipboardWriteTextItem[] {
  const seenTypes = new Set<string>();
  const normalizedItems: ClipboardWriteTextItem[] = [];

  items.forEach((item) => {
    const type = item.type.trim();
    if (!type || item.text.length === 0 || seenTypes.has(type)) {
      return;
    }

    seenTypes.add(type);
    normalizedItems.push({ type, text: item.text });
  });

  return normalizedItems;
}

function preferredPlainText(items: readonly ClipboardWriteTextItem[]): string | undefined {
  return items.find((item) => item.type === "text/plain")?.text ?? items[0]?.text;
}

async function readBrowserClipboardText(): Promise<string> {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.readText) {
    return "";
  }

  try {
    return await clipboard.readText();
  } catch {
    return "";
  }
}

/** Copy As ▸ PNG: raster bytes onto the clipboard — natively as public.png, or via ClipboardItem. */
export async function writeClipboardImage(pngBytes: Uint8Array): Promise<boolean> {
  return (await writeClipboardItems([{ type: "image/png", bytes: pngBytes }])).ok;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Inserts a pHYs chunk after IHDR so consumers paste an oversampled PNG at its
 * intended physical size instead of its pixel size. Replaces any existing pHYs.
 * Returns the input unchanged when the payload is not a well-formed PNG.
 */
export function pngWithPhysicalDensity(pngBytes: Uint8Array, pixelsPerInch: number): Uint8Array {
  if (!Number.isFinite(pixelsPerInch) || pixelsPerInch <= 0) {
    return pngBytes;
  }
  if (pngBytes.length < 16 || PNG_SIGNATURE.some((byte, index) => pngBytes[index] !== byte)) {
    return pngBytes;
  }

  const pixelsPerMeter = Math.round(pixelsPerInch / 0.0254);
  const physChunk = new Uint8Array(21);
  const view = new DataView(physChunk.buffer);
  view.setUint32(0, 9);
  physChunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, pixelsPerMeter);
  view.setUint32(12, pixelsPerMeter);
  physChunk[16] = 1; // unit: meter
  view.setUint32(17, pngCrc32(physChunk.subarray(4, 17)));

  const chunks: Uint8Array[] = [pngBytes.subarray(0, PNG_SIGNATURE.length)];
  let offset: number = PNG_SIGNATURE.length;
  let inserted = false;
  while (offset + 8 <= pngBytes.length) {
    const dataView = new DataView(pngBytes.buffer, pngBytes.byteOffset + offset);
    const length = dataView.getUint32(0);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > pngBytes.length) {
      return pngBytes;
    }
    const type = String.fromCharCode(pngBytes[offset + 4], pngBytes[offset + 5], pngBytes[offset + 6], pngBytes[offset + 7]);
    if (type !== "pHYs") {
      chunks.push(pngBytes.subarray(offset, chunkEnd));
    }
    if (type === "IHDR" && !inserted) {
      chunks.push(physChunk);
      inserted = true;
    }
    offset = chunkEnd;
  }
  if (!inserted) {
    return pngBytes;
  }

  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let outputOffset = 0;
  for (const chunk of chunks) {
    output.set(chunk, outputOffset);
    outputOffset += chunk.length;
  }
  return output;
}

/**
 * Rasterize an SVG string to PNG bytes with a canvas — the non-desktop Copy As ▸ PNG path.
 *
 * `cssPxPerInch` is the CSS pixels-per-inch convention the source SVG's units represent (96, for
 * every SVG this app emits), not the density to stamp directly — the embedded density is derived
 * from this times the scale actually applied, after `maxDimensionPx` clamping, mirroring the
 * native Rust rasterizer so the two paths can't silently produce different-sized pastes.
 */
export async function rasterizeSvgInBrowser(
  svgText: string,
  scale = 2,
  cssPxPerInch?: number,
  maxDimensionPx = 8192
): Promise<Uint8Array> {
  const svgUrl = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("SVG could not be rasterized."));
      element.src = svgUrl;
    });
    const requestedWidth = Math.max(1, Math.round(image.width * scale));
    const requestedHeight = Math.max(1, Math.round(image.height * scale));
    const requestedMax = Math.max(requestedWidth, requestedHeight);
    const clampScale = requestedMax > maxDimensionPx ? maxDimensionPx / requestedMax : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(requestedWidth * clampScale));
    canvas.height = Math.max(1, Math.round(requestedHeight * clampScale));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas 2D context unavailable.");
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      throw new Error("PNG encoding failed.");
    }
    const pngBytes = new Uint8Array(await blob.arrayBuffer());
    if (cssPxPerInch === undefined || image.width === 0) {
      return pngBytes;
    }
    const appliedScale = canvas.width / image.width;
    return pngWithPhysicalDensity(pngBytes, appliedScale * cssPxPerInch);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

export function clipboardPayloadFromDataTransfer(dataTransfer: DataTransfer): ClipboardReadPayload {
  const types = Array.from(dataTransfer.types);
  const textItems = types
    .map((type) => ({ type, text: dataTransfer.getData(type) }))
    .filter((item) => item.text.length > 0);

  return {
    types,
    textItems
  };
}
