import {
  closeToolsetPopoverWindow, currentWindowLogicalPosition, isDesktopRuntime,
  listenForToolsetPopoverContentRequests, listenForToolsetPopoverDismiss, monitorLogicalWorkAreaAt,
  openToolsetPopoverWindow, setToolsetPopoverContent, toolsetPopoverTimestamp,
  type MonitorLogicalBounds, type ToolsetPopoverAnchor, type ToolsetToolbarSnapshot,
  type ToolsetWindowSize
} from "./index";
import { listenTauriEvent } from "./tauriEvents";

/** All inputs/outputs are global logical pixels; never multiply by the source window's DPI. */
export function placeToolbarPopover(
  opener: MonitorLogicalBounds, size: ToolsetWindowSize, area: MonitorLogicalBounds,
  orientation: "horizontal" | "vertical" = "horizontal", gap = 4
): { x: number; y: number } {
  let x = orientation === "vertical" ? opener.right + gap : opener.left;
  let y = orientation === "vertical" ? opener.top : opener.bottom + gap;
  if (orientation === "horizontal" && y + size.height > area.bottom) y = opener.top - gap - size.height;
  if (orientation === "vertical" && x + size.width > area.right) x = opener.left - gap - size.width;
  return {
    x: Math.max(area.left, Math.min(x, area.right - size.width)),
    y: Math.max(area.top, Math.min(y, area.bottom - size.height))
  };
}

const CLOSED_EVENT = "chemdraft://toolbar-popover-closed";
interface ClosedPayload { toolsetId: string; openedAt: number; restoreFocus: boolean }
export async function sendToolbarPopoverClosed(payload: ClosedPayload): Promise<void> {
  if (!isDesktopRuntime()) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit(CLOSED_EVENT, payload);
}

export interface ToolsetToolbarPopoverOptions {
  toolsetId: string;
  /** The actual owner button, in this webview. Never use aria-controls across webviews. */
  opener: HTMLElement;
  toolbar: ToolsetToolbarSnapshot;
  orientation?: "horizontal" | "vertical";
}
export interface ToolsetToolbarPopoverHandle {
  ready: Promise<void>;
  /** Call from the owner's state effect whenever items, availability, or control state change.
   * undefined (or an empty item list) closes. Refresh retains the original open timestamp. */
  update(toolbar: ToolsetToolbarSnapshot | undefined): Promise<void>;
  close(): Promise<void>;
  /** Owner unmount cleanup; also closes the popover. */
  dispose(): void;
}

const owners = new Map<string, () => void>();

/** T4b entry point. Uses the existing native request/snapshot path, including cold-open replay.
 * One reusable popover belongs to each palette: a hidden item's submenu replaces its toolbar
 * strip with a command list and Back, rather than opening a second native popover.
 * The caller feeds live snapshots with handle.update; opener removal is observed here. */
export function openToolsetToolbarItemsPopover({
  toolsetId, opener, toolbar, orientation = "horizontal"
}: ToolsetToolbarPopoverOptions): ToolsetToolbarPopoverHandle {
  owners.get(toolsetId)?.();
  const openedAt = toolsetPopoverTimestamp();
  let current = toolbar;
  let anchor: ToolsetPopoverAnchor | undefined;
  let closed = false;
  const cleanups: (() => void)[] = [];
  const stop = () => {
    closed = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
    if (owners.get(toolsetId) === stop) owners.delete(toolsetId);
  };
  owners.set(toolsetId, stop);
  const close = async () => {
    if (closed) return;
    stop();
    await closeToolsetPopoverWindow(toolsetId);
  };
  const valid = () => {
    if (!opener.isConnected || !current.items.length) return false;
    for (let element: HTMLElement | null = opener; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (element.hidden || style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  };
  const refreshAnchor = async () => {
    const origin = await currentWindowLogicalPosition("inner");
    if (closed) return;
    if (!origin) throw new Error("Cannot locate the toolbar popover's owner window.");
    const rect = opener.getBoundingClientRect();
    const bounds = { left: origin.x + rect.left, top: origin.y + rect.top,
      right: origin.x + rect.right, bottom: origin.y + rect.bottom };
    const workArea = await monitorLogicalWorkAreaAt((bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2);
    if (closed) return;
    anchor = { ...placeToolbarPopover(bounds, { width: 0, height: 0 }, workArea, orientation),
      opener: bounds, orientation, workArea };
  };
  const push = async () => {
    if (closed || !anchor) return;
    if (!valid()) { await close(); return; }
    await setToolsetPopoverContent(toolsetId, { kind: "toolbarItems", openedAt, toolbar: current }, anchor);
  };
  const subscribe = async (listener: Promise<() => void>) => {
    const cleanup = await listener;
    if (closed) cleanup(); else cleanups.push(cleanup);
  };
  const restore = async () => {
    if (!opener.isConnected) return;
    if (isDesktopRuntime()) {
      const [{ getCurrentWindow }, { getCurrentWebview }] = await Promise.all([
        import("@tauri-apps/api/window"), import("@tauri-apps/api/webview")
      ]);
      await getCurrentWindow().setFocus();
      await getCurrentWebview().setFocus();
    }
    if (opener.isConnected) opener.focus({ preventScroll: true });
  };
  const ready = (async () => {
    if (!valid()) { await close(); return; }
    const observer = new MutationObserver(() => { if (!valid()) void close().catch(() => undefined); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["hidden", "class", "style"] });
    cleanups.push(() => observer.disconnect());
    await subscribe(listenForToolsetPopoverContentRequests(id => {
      if (id === toolsetId) void push().catch(() => undefined);
    }));
    await subscribe(listenForToolsetPopoverDismiss(payload => {
      if (payload?.requestedAt !== undefined && payload.requestedAt < openedAt) return;
      stop();
    }));
    if (isDesktopRuntime()) await subscribe(listenTauriEvent<ClosedPayload>(CLOSED_EVENT, ({ payload }) => {
      if (payload.toolsetId !== toolsetId || payload.openedAt !== openedAt || closed) return;
      stop();
      if (payload.restoreFocus) void restore().catch(() => undefined);
    }));
    await refreshAnchor();
    if (closed) return;
    await openToolsetPopoverWindow(toolsetId, "toolbarItems", anchor!.x, anchor!.y);
    await push();
  })().catch(async error => { await close(); throw error; });
  return {
    ready,
    async update(next) {
      if (closed) return;
      if (!next || !next.items.length) { await close(); return; }
      current = next;
      await ready;
      if (closed) return;
      await refreshAnchor();
      await push();
    },
    close,
    dispose() { void close().catch(() => undefined); }
  };
}
