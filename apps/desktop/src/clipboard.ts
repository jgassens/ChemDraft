import type { ClipboardReadPayload } from "@chemdraft/clipboard-adapter";
import { isDesktopRuntime } from "./window-manager";

export interface ClipboardWriteTextItem {
  type: string;
  text: string;
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
  const normalizedItems = normalizeClipboardWriteTextItems(items);
  if (normalizedItems.length === 0) {
    return false;
  }

  if (isDesktopRuntime()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("write_clipboard_text_items", { items: normalizedItems });
      return true;
    } catch {
      // Fall through to the browser Clipboard API. Tauri previews and tests can
      // still succeed there, but callers must treat a final false as a hard fail.
    }
  }

  const plainText = preferredPlainText(normalizedItems);
  if (plainText === undefined) {
    return false;
  }

  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.writeText) {
    return false;
  }

  try {
    await clipboard.writeText(plainText);
    return true;
  } catch {
    return false;
  }
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
  if (isDesktopRuntime()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("write_clipboard_image", { pngBytes: Array.from(pngBytes) });
      return true;
    } catch {
      // Fall through to the browser Clipboard API below.
    }
  }

  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.write || typeof ClipboardItem === "undefined") {
    return false;
  }

  try {
    const buffer = new ArrayBuffer(pngBytes.byteLength);
    new Uint8Array(buffer).set(pngBytes);
    await clipboard.write([new ClipboardItem({ "image/png": new Blob([buffer], { type: "image/png" }) })]);
    return true;
  } catch {
    return false;
  }
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
  let offset = PNG_SIGNATURE.length;
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

/** Rasterize an SVG string to PNG bytes with a canvas — the non-desktop Copy As ▸ PNG path. */
export async function rasterizeSvgInBrowser(svgText: string, scale = 2, pixelsPerInch?: number): Promise<Uint8Array> {
  const svgUrl = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("SVG could not be rasterized."));
      element.src = svgUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
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
    return pixelsPerInch === undefined ? pngBytes : pngWithPhysicalDensity(pngBytes, pixelsPerInch);
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
