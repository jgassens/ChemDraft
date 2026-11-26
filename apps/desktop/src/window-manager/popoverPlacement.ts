import type { MonitorLogicalBounds } from "./index";

/** Space between a popover and the control it opens from, in logical points. */
export const POPOVER_ANCHOR_GAP = 4;

/** A rectangle in global logical coordinates (the space `set_current_window_global_position` takes). */
export interface PopoverAnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A monitor's work area (taskbar, Dock and menu bar excluded) plus its scale factor. */
export interface PopoverWorkArea extends MonitorLogicalBounds {
  scale?: number;
}

export interface PopoverPlacement {
  x: number;
  y: number;
  side: "below" | "above";
}

// Logical work areas are physical pixels divided by the scale, so 2048 / 1.5 * 1.5 can come back
// as 2047.9999…; this keeps such values on their own pixel.
const EPSILON = 1e-6;

/**
 * Pure placement for a popover window opened from a control: below the anchor when it fits in the
 * work area, else above it when that fits, else on the roomier side and shifted until it is
 * inside. Horizontally it starts at the anchor's left edge and shifts left or right to stay inside.
 *
 * Everything is in global logical coordinates, `workArea` being the work area of the monitor the
 * anchor is on (not the whole screen: the frame must never sit under the Windows taskbar, the Dock
 * or the menu bar). The result is snapped to that monitor's physical pixel grid (`scale`), rounding
 * inward, so the window's physical frame — which is what the OS actually clips — stays inside too.
 * A popover larger than the work area is pinned to its top-left corner.
 */
export function placeAnchoredPopover(input: {
  anchor: PopoverAnchorRect;
  size: { width: number; height: number };
  workArea: MonitorLogicalBounds;
  scale?: number;
  gap?: number;
}): PopoverPlacement {
  const { anchor, size, workArea } = input;
  const gap = input.gap ?? POPOVER_ANCHOR_GAP;
  const scale = input.scale !== undefined && Number.isFinite(input.scale) && input.scale > 0 ? input.scale : 1;
  const px = (value: number) => Math.round(value * scale);
  // `+ 0` turns the -0 that Math.ceil gives for a value just under zero into 0.
  const areaLeft = Math.ceil(workArea.left * scale - EPSILON) + 0;
  const areaTop = Math.ceil(workArea.top * scale - EPSILON) + 0;
  const areaRight = Math.floor(workArea.right * scale + EPSILON);
  const areaBottom = Math.floor(workArea.bottom * scale + EPSILON);
  const width = Math.ceil(Math.max(0, size.width) * scale - EPSILON);
  const height = Math.ceil(Math.max(0, size.height) * scale - EPSILON);

  const belowTop = px(anchor.bottom + gap);
  const aboveBottom = px(anchor.top - gap);
  const aboveTop = aboveBottom - height;
  let side: PopoverPlacement["side"];
  let y: number;
  if (belowTop + height <= areaBottom) {
    side = "below";
    y = belowTop;
  } else if (aboveTop >= areaTop) {
    side = "above";
    y = aboveTop;
  } else {
    // Neither side fits whole: take the one with more room, then shift it inside below.
    side = areaBottom - belowTop >= aboveBottom - areaTop ? "below" : "above";
    y = side === "below" ? belowTop : aboveTop;
  }
  y = Math.max(areaTop, Math.min(y, areaBottom - height));
  const x = Math.max(areaLeft, Math.min(px(anchor.left), areaRight - width));
  return { x: x / scale, y: y / scale, side };
}

/** The anchor rect a popover payload stands for. Older payloads carry only the below-anchor point
 *  (`y` = anchor bottom + gap); treat those as a zero-height anchor there. */
export function popoverAnchorRect(anchor: { x: number; y: number; rect?: PopoverAnchorRect }): PopoverAnchorRect {
  if (anchor.rect) return anchor.rect;
  const bottom = anchor.y - POPOVER_ANCHOR_GAP;
  return { left: anchor.x, top: bottom, right: anchor.x, bottom };
}

/**
 * Where a popover window of `size` belongs for `anchor`: the work area of the monitor under the
 * anchor's center (`readArea`), then {@link placeAnchoredPopover}. With no work area known, the
 * unclamped below-anchor point — a popover at its control beats one on the wrong screen.
 */
export async function resolveAnchoredPopoverPosition(
  anchor: { x: number; y: number; rect?: PopoverAnchorRect },
  size: { width: number; height: number },
  readArea: (x: number, y: number) => Promise<PopoverWorkArea | undefined>
): Promise<{ x: number; y: number }> {
  const rect = popoverAnchorRect(anchor);
  const area = await readArea((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2).catch(() => undefined);
  if (!area) return { x: anchor.x, y: anchor.y };
  const { x, y } = placeAnchoredPopover({ anchor: rect, size, workArea: area, scale: area.scale });
  return { x, y };
}
