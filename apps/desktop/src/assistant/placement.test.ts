import { describe, expect, it } from "vitest";
import { ASSISTANT_GAP, choosePlacement, overlaps, relativeRect } from "./placement";

const page = { width: 1000, height: 1000 };
const size = { width: 100, height: 80 };
describe("assistant placement", () => {
  it("anchors at the visible viewport centre", () => {
    expect(choosePlacement({ page, size, occupied: [], viewport: { x: 200, y: 300, width: 400, height: 200 } }).rect)
      .toEqual({ x: 350, y: 360, ...size });
  });
  it("ignores coordinates carried by a size measurement", () => {
    const bounds = { x: 10, y: 20, width: 100, height: 80 };
    expect(choosePlacement({ page, size: bounds, occupied: [], viewport: { x: 200, y: 300, width: 400, height: 200 } }).rect)
      .toEqual({ x: 350, y: 360, width: 100, height: 80 });
    expect(relativeRect(bounds, { x: 200, y: 200, width: 100, height: 100 }, "right").x).toBe(312);
  });
  it("finds the nearest free area, including objects inserted earlier", () => {
    const occupied = [{ x: 400, y: 400, width: 200, height: 200 }];
    const first = choosePlacement({ page, size, occupied, viewport: { x: 300, y: 300, width: 400, height: 400 } });
    expect(occupied.every(rect => !overlaps(first.rect, rect, ASSISTANT_GAP))).toBe(true);
    const second = choosePlacement({ page, size, occupied: [...occupied, first.rect], viewport: { x: 300, y: 300, width: 400, height: 400 } });
    expect(overlaps(second.rect, first.rect, ASSISTANT_GAP)).toBe(false);
    expect(first.warnings).toEqual([]);
  });
  it("falls below the lowest object when viewport is unavailable", () => {
    expect(choosePlacement({ page, size, occupied: [{ x: 50, y: 60, width: 100, height: 200 }] }).rect)
      .toEqual({ x: 36, y: 260 + ASSISTANT_GAP, ...size });
  });
  it("overflows to the right of an occupied column", () => {
    const occupied = [{ x: 36, y: 36, width: 300, height: 920 }];
    const placed = choosePlacement({ page, size, occupied });
    expect(placed.rect.x).toBe(336 + ASSISTANT_GAP);
    expect(overlaps(placed.rect, occupied[0]!, ASSISTANT_GAP)).toBe(false);
  });
  it("warns on fallback when nothing can fit", () => {
    const placed = choosePlacement({ page, size, occupied: [{ x: 0, y: 0, ...page }] });
    expect(placed.rect).toEqual({ x: 450, y: 460, ...size });
    expect(placed.warnings).toEqual(["assistant.placement_overlaps"]);
  });
  it("uses a 12 pixel relative gap on every side", () => {
    const target = { x: 200, y: 200, width: 100, height: 100 };
    expect(relativeRect(size, target, "right").x).toBe(312);
    expect(relativeRect(size, target, "left").x).toBe(88);
    expect(relativeRect(size, target, "above").y).toBe(108);
    expect(relativeRect(size, target, "below").y).toBe(312);
  });
});
