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
