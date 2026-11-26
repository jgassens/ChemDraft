// DEV-ONLY drag harness for phase 0 of docs/plans/art-library.md (hands-on steps:
// docs/plans/art-library-drag-spike.md). Remove in phase 3 with DragTestTile.tsx, the tile's slot in
// dialogs/StructureTemplatePicker.tsx, and `art_library_dev_drag_test_prepare` in art_library.rs.
import { Channel, invoke } from "@tauri-apps/api/core";

/** How a drag ended, as `art_library_start_drag` reports it once per drag. */
export interface ArtDragEnded { outcome: "dropped" | "cancelled"; x: number; y: number }

export interface DragTestBridge {
  /** The fixed drag-test SVG's path, written by Rust; `null` in a stable build (nothing written). */
  prepare(): Promise<string | null>;
  /** Starts the operating-system file drag. `onEnd` is called once when the drag ends. */
  startDrag(path: string, onEnd: (ended: ArtDragEnded) => void): Promise<void>;
}

export const nativeDragTestBridge: DragTestBridge = {
  prepare: () => invoke<string | null>("art_library_dev_drag_test_prepare"),
  startDrag: (path, onEnd) => {
    const channel = new Channel<ArtDragEnded>();
    channel.onmessage = onEnd;
    return invoke("art_library_start_drag", { path, onEnd: channel });
  }
};

function isDesktopWebview(): boolean {
  const scope = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(scope.__TAURI_INTERNALS__ || scope.__TAURI__);
}

/**
 * Whether the dialog may even ask Rust for the harness: a labelled build running in a desktop webview.
 * A stable build is unlabelled, so it never asks; Rust separately answers `null` unless the app runs
 * under the development identifier, so a stray label alone cannot show the tile either.
 */
export function dragTestHarnessRequested(label: string = typeof __WORKTREE_LABEL__ === "string" ? __WORKTREE_LABEL__ : "",
  desktop: boolean = isDesktopWebview()): boolean {
  return desktop && label.trim().length > 0;
}

/** Pointer travel, in CSS pixels, before a press becomes a drag. */
export const DRAG_TEST_THRESHOLD_PX = 4;

export function passedDragThreshold(from: { x: number; y: number }, to: { x: number; y: number },
  threshold = DRAG_TEST_THRESHOLD_PX): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > threshold;
}

export function describeDragEnd(ended: ArtDragEnded): string {
  return ended.outcome === "dropped"
    ? `Dropped (pointer at ${ended.x}, ${ended.y}).`
    : "Drag cancelled: nothing accepted the file.";
}
