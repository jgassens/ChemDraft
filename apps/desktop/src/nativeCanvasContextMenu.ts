import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { toNativeCanvasMenu, withStereoReadout, type CanvasMenuItem, type NativeCanvasMenuItem } from "./canvasContextMenuModel";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";
import {
  currentWindowLogicalPosition, currentWindowLogicalWorkArea, isDesktopRuntime, monitorLogicalWorkAreaAt,
  type MonitorLogicalBounds
} from "./window-manager";

let nextRequest = 0;

/** A native popup cannot change once it is tracking, so the stereo readout gets this long to
 * resolve before the menu opens without it. With the stereo engine already loaded (the document
 * window preloads it) the readout resolves well inside this; a cold load is not waited for. */
export const NATIVE_STEREO_READOUT_BUDGET_MS = 120;

export interface NativeCanvasMenuOptions {
  /** Resolves the read-only stereo row; must not reject (see `resolveStereoReadout`). */
  loadStereoReadout?: () => Promise<string | undefined>;
  stereoReadoutBudgetMs?: number;
  /** Checked after every wait before the native invoke; once false, the popup is never shown. */
  isActive?: () => boolean;
  /** Where the document window's content sits and the work area the menu must fit in. Defaults to
   * the native reads; undefined (or a failed read) leaves the menu at the pointer. */
  readScreen?: (position: { x: number; y: number }) => Promise<NativeMenuScreen | undefined>;
  platform?: ShortcutPlatform;
}

/** Global logical coordinates (the space `monitorLogicalWorkAreaAt` reports in). */
export interface NativeMenuScreen {
  /** Top-left of the document window's content, where client coordinates start. */
  origin: { x: number; y: number };
  /** Work area of the monitor under the pointer: Dock, menu bar and taskbar excluded. */
  workArea: MonitorLogicalBounds;
}

/** Logical sizes of one native menu row, generous so the estimate errs on the large side: an
 * estimate that is too small would leave the last rows below the screen edge on macOS, which
 * truncates a popup there instead of moving it. */
const NATIVE_MENU_METRICS: Record<ShortcutPlatform, { row: number; separator: number; padding: number; char: number; chrome: number }> = {
  macos: { row: 24, separator: 12, padding: 12, char: 7.5, chrome: 72 },
  windows: { row: 30, separator: 10, padding: 10, char: 7.5, chrome: 96 },
  linux: { row: 30, separator: 10, padding: 10, char: 7.5, chrome: 96 }
};

/** The estimated logical size of a native popup holding `items` (submenus open beside it). */
export function estimateNativeMenuSize(
  items: readonly NativeCanvasMenuItem[], platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): { width: number; height: number } {
  const metrics = NATIVE_MENU_METRICS[platform];
  let height = metrics.padding;
  let longest = 0;
  for (const item of items) {
    if (item.kind === "separator") { height += metrics.separator; continue; }
    height += metrics.row;
    longest = Math.max(longest, item.label.length);
  }
  return { width: Math.max(180, longest * metrics.char + metrics.chrome), height };
}

/**
 * Where to anchor a menu of `size` opened at the client point `position` so every row is on the
 * screen: below and right of the pointer when it fits, flipped above or to the left when that
 * side fits, otherwise moved just far enough in from the edge (never past the top or left).
 * Returned in client coordinates, as `popup_canvas_context_menu` takes them.
 */
export function placeNativeCanvasMenu(
  position: { x: number; y: number }, size: { width: number; height: number }, screen: NativeMenuScreen
): { x: number; y: number } {
  const axis = (client: number, origin: number, extent: number, start: number, end: number) => {
    const pointer = origin + client;
    if (pointer + extent <= end) return client;
    if (pointer - extent >= start) return client - extent;
    return Math.max(start, end - extent) - origin;
  };
  const { origin, workArea } = screen;
  return {
    x: axis(position.x, origin.x, size.width, workArea.left, workArea.right),
    y: axis(position.y, origin.y, size.height, workArea.top, workArea.bottom)
  };
}

/** The document window's content origin and the work area under the pointer, read natively. The
 * window's own monitor is used unless the pointer is on another one (a window spanning screens);
 * then that monitor's own work area, so its Dock or taskbar is left clear too. */
export async function readNativeMenuScreen(position: { x: number; y: number }): Promise<NativeMenuScreen | undefined> {
  if (!isDesktopRuntime()) return undefined;
  const origin = await currentWindowLogicalPosition("inner");
  if (!origin) return undefined;
  const pointer = { x: origin.x + position.x, y: origin.y + position.y };
  const contains = (area: MonitorLogicalBounds) =>
    pointer.x >= area.left && pointer.x < area.right && pointer.y >= area.top && pointer.y < area.bottom;
  const windowArea = await currentWindowLogicalWorkArea();
  if (contains(windowArea)) return { origin, workArea: windowArea };
  const pointerWorkArea = await monitorLogicalWorkAreaAt(pointer.x, pointer.y);
  return { origin, workArea: pointerWorkArea ?? windowArea };
}

async function nativeMenuPosition(
  items: readonly NativeCanvasMenuItem[], position: { x: number; y: number }, options: NativeCanvasMenuOptions
) {
  try {
    const screen = await (options.readScreen ?? readNativeMenuScreen)(position);
    return screen ? placeNativeCanvasMenu(position, estimateNativeMenuSize(items, options.platform), screen) : position;
  } catch {
    return position;
  }
}

async function readoutWithinBudget(load: () => Promise<string | undefined>, budgetMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      load().catch(() => undefined),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), budgetMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Returns undefined only when native presentation is unavailable; cancellation is a result.
 * Returns null, without presenting anything, when `isActive` turns false before the popup opens.
 * The same Tauri command serves macOS (app-wide menu host) and Windows (document window). */
export async function popupNativeCanvasMenu(
  items: readonly CanvasMenuItem[], position: { x: number; y: number }, options: NativeCanvasMenuOptions = {}
) {
  const readout = options.loadStereoReadout
    ? await readoutWithinBudget(options.loadStereoReadout, options.stereoReadoutBudgetMs ?? NATIVE_STEREO_READOUT_BUDGET_MS)
    : undefined;
  const inactive = () => options.isActive?.() === false;
  if (inactive()) return null;
  const route = toNativeCanvasMenu(withStereoReadout(items, readout), String(++nextRequest));
  // Placed after the readout row is known, so the menu that opens is the one that was measured.
  const placed = await nativeMenuPosition(route.items, position, options);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    if (inactive()) return null;
    const selected = await invoke<string | null>("popup_canvas_context_menu", { items: route.items, position: placed });
    return { select: (onInvoke: (commandId: string) => void) => route.select(selected, onInvoke) };
  } catch {
    return undefined;
  }
}
