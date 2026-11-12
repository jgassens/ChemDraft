import { toNativeCanvasMenu, type CanvasMenuItem } from "./canvasContextMenuModel";

let nextRequest = 0;

/** Returns undefined only when native presentation is unavailable; cancellation is a result. */
export async function popupNativeCanvasMenu(items: readonly CanvasMenuItem[], position: { x: number; y: number }) {
  const route = toNativeCanvasMenu(items, String(++nextRequest));
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const selected = await invoke<string | null>("popup_canvas_context_menu", { items: route.items, position });
    return { select: (onInvoke: (commandId: string) => void) => route.select(selected, onInvoke) };
  } catch {
    return undefined;
  }
}
