import type { ClipboardReadPayload } from "@chemdraft/clipboard-adapter";
import { isDesktopRuntime } from "./window-manager";

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
