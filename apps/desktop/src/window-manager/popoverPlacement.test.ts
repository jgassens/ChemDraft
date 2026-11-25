import { describe, expect, it, vi } from "vitest";
import {
  placeAnchoredPopover,
  popoverAnchorRect,
  resolveAnchoredPopoverPosition,
  type PopoverAnchorRect
} from "./popoverPlacement";

const screen = { left: 0, top: 0, right: 1920, bottom: 1040 };
const button = (left: number, top: number, size = 22): PopoverAnchorRect => ({ left, top, right: left + size, bottom: top + size });
function inside(frame: { x: number; y: number }, size: { width: number; height: number }, area: typeof screen) {
  return frame.x >= area.left && frame.y >= area.top &&
    frame.x + size.width <= area.right && frame.y + size.height <= area.bottom;
}

describe("placeAnchoredPopover", () => {
  it("opens below the anchor when it fits", () => {
    expect(placeAnchoredPopover({ anchor: button(100, 100), size: { width: 240, height: 187 }, workArea: screen }))
      .toEqual({ x: 100, y: 126, side: "below" });
  });

  it("flips above the anchor near the bottom of the work area", () => {
    // 900 + 22 + 4 + 187 = 1113 > 1040, while 900 - 4 - 187 = 709 fits.
    expect(placeAnchoredPopover({ anchor: button(100, 900), size: { width: 240, height: 187 }, workArea: screen }))
      .toEqual({ x: 100, y: 709, side: "above" });
  });

  it("shifts onto the roomier side when neither side fits whole", () => {
    const area = { left: 0, top: 0, right: 800, bottom: 300 };
    // Room below 300 - 176 = 124, above 150 - 4 = 146: above wins, then shifts down to the top.
    const above = placeAnchoredPopover({ anchor: button(10, 150), size: { width: 100, height: 250 }, workArea: area });
    expect(above).toEqual({ x: 10, y: 0, side: "above" });
    // Room below 300 - 76 = 224, above 50 - 4 = 46: below wins, then shifts up to fit.
    const below = placeAnchoredPopover({ anchor: button(10, 50), size: { width: 100, height: 250 }, workArea: area });
    expect(below).toEqual({ x: 10, y: 50, side: "below" });
    expect(inside(below, { width: 100, height: 250 }, area)).toBe(true);
  });

  it("shifts left at the right edge and right at the left edge", () => {
    const size = { width: 240, height: 187 };
    expect(placeAnchoredPopover({ anchor: button(1900, 100), size, workArea: screen }).x).toBe(1920 - 240);
    expect(placeAnchoredPopover({ anchor: button(-30, 100), size, workArea: screen }).x).toBe(0);
  });

  it("keeps the frame off the menu bar and the Dock or taskbar", () => {
    // macOS: a 25 pt menu bar on top and a Dock at the bottom; Windows/Linux: a bottom taskbar.
    const area = { left: 0, top: 25, right: 1512, bottom: 905 };
    const size = { width: 240, height: 187 };
    const nearDock = placeAnchoredPopover({ anchor: button(300, 860), size, workArea: area });
    expect(nearDock.side).toBe("above");
    expect(inside(nearDock, size, area)).toBe(true);
    const nearMenuBar = placeAnchoredPopover({ anchor: button(300, 26), size, workArea: area });
    expect(nearMenuBar).toEqual({ x: 300, y: 52, side: "below" });
  });

  it("pins a popover larger than the work area to its top-left", () => {
    const area = { left: 0, top: 0, right: 200, bottom: 150 };
    expect(placeAnchoredPopover({ anchor: button(50, 50), size: { width: 300, height: 400 }, workArea: area }))
      .toMatchObject({ x: 0, y: 0 });
  });

  it("works on a secondary monitor with a negative or offset origin", () => {
    // A monitor left of and below the primary: logical work area -1920..0 × 1080..2120.
    const area = { left: -1920, top: 1080, right: 0, bottom: 2120 };
    const size = { width: 240, height: 187 };
    const nearBottom = placeAnchoredPopover({ anchor: button(-100, 2050), size, workArea: area });
    expect(nearBottom).toEqual({ x: -240, y: 2050 - 4 - 187, side: "above" });
    expect(inside(nearBottom, size, area)).toBe(true);
    const nearTopLeft = placeAnchoredPopover({ anchor: button(-1930, 1070), size, workArea: area });
    expect(nearTopLeft).toEqual({ x: -1920, y: 1096, side: "below" });
  });

  it.each([1, 1.25, 1.5])("stays inside the work area on the physical pixel grid at scale %s", (scale) => {
    // A 2560×1440 panel at this scale with a 48 px taskbar: the work area in logical points.
    const area = { left: 0, top: 0, right: 2560 / scale, bottom: (1440 - 48) / scale };
    const size = { width: 241, height: 187 };
    for (const anchor of [button(5, 5), button(area.right - 3, 3), button(3, area.bottom - 25),
      button(area.right - 30, area.bottom - 24), button(area.right / 2 + 0.3, area.bottom / 2 + 0.7)]) {
      const frame = placeAnchoredPopover({ anchor, size, workArea: area, scale });
      const physical = { x: Math.round(frame.x * scale), y: Math.round(frame.y * scale) };
      // Whole physical pixels: the conversion back cannot round the frame out of the work area.
      expect(Math.abs(frame.x * scale - physical.x)).toBeLessThan(1e-6);
      expect(Math.abs(frame.y * scale - physical.y)).toBeLessThan(1e-6);
      expect(physical.x).toBeGreaterThanOrEqual(0);
      expect(physical.y).toBeGreaterThanOrEqual(0);
      expect(physical.x + Math.ceil(size.width * scale)).toBeLessThanOrEqual(2560);
      expect(physical.y + Math.ceil(size.height * scale)).toBeLessThanOrEqual(1440 - 48);
    }
  });

  it("uses a 1.5 scale secondary monitor's own grid and origin", () => {
    // Physical origin (-3456, 0), 3456×2160 at 150% with a 72 px taskbar.
    const scale = 1.5;
    const area = { left: -3456 / scale, top: 0, right: 0, bottom: (2160 - 72) / scale };
    const size = { width: 240, height: 187 };
    const frame = placeAnchoredPopover({ anchor: button(-20, area.bottom - 30), size, workArea: area, scale });
    expect(frame.side).toBe("above");
    expect(frame.x).toBe(-240);
    expect(inside(frame, size, area)).toBe(true);
  });
});

describe("Effect color popover at the bottom of a Windows work area (1.2.4 report)", () => {
  // Reported: popover top y 1208, height 187, availHeight 1296 — 99 px under the taskbar.
  const area = { left: 0, top: 0, right: 2304, bottom: 1296 };
  // The Effect swatch whose bottom + 4 gave that top: bottom 1204, a 22 pt control.
  const swatch = { left: 1500, top: 1182, right: 1522, bottom: 1204 };
  const size = { width: 252, height: 187 };

  it.each([1, 1.25, 1.5])("flips above the swatch and is fully inside at scale %s", (scale) => {
    const frame = placeAnchoredPopover({ anchor: swatch, size, workArea: area, scale });
    expect(frame.side).toBe("above");
    expect(frame.y + size.height).toBeLessThanOrEqual(1296);
    expect(frame.y + size.height).toBeLessThanOrEqual(swatch.top);
    expect(inside(frame, size, area)).toBe(true);
  });

  it("resolves the popover payload's anchor against the work area under the swatch", async () => {
    const readArea = vi.fn(async () => ({ ...area, scale: 1.5 }));
    const anchor = { x: swatch.left, y: swatch.bottom + 4, rect: swatch };
    const position = await resolveAnchoredPopoverPosition(anchor, size, readArea);
    expect(readArea).toHaveBeenCalledWith(1511, 1193);
    expect(position.y).toBeLessThanOrEqual(1296 - 187);
    expect(position.y + 187).toBeLessThanOrEqual(swatch.top);
  });

  it("keeps the bare below-anchor point only when no work area is known", async () => {
    const position = await resolveAnchoredPopoverPosition({ x: 1500, y: 1208 }, size, async () => undefined);
    expect(position).toEqual({ x: 1500, y: 1208 });
  });

  it("treats a payload without a rect as a zero-height anchor at its point", () => {
    expect(popoverAnchorRect({ x: 10, y: 30 })).toEqual({ left: 10, top: 26, right: 10, bottom: 26 });
  });
});
