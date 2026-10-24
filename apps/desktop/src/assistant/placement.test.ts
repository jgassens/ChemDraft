import { describe, expect, it } from "vitest";
import { ASSISTANT_GAP, choosePlacement, choosePagePlacements, overlaps, relativeRect } from "./placement";

const page = { width: 1000, height: 1000 };
const size = { width: 100, height: 80 };
describe("assistant placement", () => {
  it("uses each item's width for column spacing and respects asymmetric margins", () => {
    const page = { width: 612, height: 792, margin: { left: 48, right: 24, top: 80, bottom: 60 } };
    const placed = choosePagePlacements({ page, occupied: [], columns: 3,
      sizes: [{ width: 300, height: 100 }, { width: 50, height: 100 }, { width: 50, height: 100 }] });
    expect(placed.nonFitting).toEqual([]);
    expect(placed.requiredSize).toBeUndefined();
    expect(placed.rects.map(rect => [rect.x, rect.y])).toEqual([[48, 80], [404, 80], [510, 80]]);
  });
  it("keeps a fitting item in a remaining hole and proposes growth only for the oversized item", () => {
    const placed = choosePagePlacements({ page: { width: 612, height: 792 },
      occupied: [{ x: 36, y: 200, width: 540, height: 556 }], sizes: [{ width: 600, height: 100 }, { width: 80, height: 60 }] });
    expect(placed.nonFitting).toEqual([0]);
    expect(placed.requiredSize!.width).toBeGreaterThanOrEqual(672);
    expect(placed.rects[0]!.x).toBe(36);
    expect(placed.rects[0]!.y).toBeGreaterThan(756);
    expect(placed.rects[1]!.y + placed.rects[1]!.height).toBeLessThan(200);
  });
  it("computes one page size for every non-fitting item, keeping them separate", () => {
    const placed = choosePagePlacements({ page, occupied: [{ x: 0, y: 0, ...page }], sizes: [size, size] });
    expect(placed.nonFitting).toEqual([0, 1]);
    expect(placed.requiredSize!.height).toBeGreaterThan(page.height);
    expect(placed.rects.every(rect => rect.y > page.height)).toBe(true);
    expect(overlaps(placed.rects[0]!, placed.rects[1]!)).toBe(false);
  });
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
    expect(first.fits).toBe(true);
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
  it("reports no fit when the page is full", () => {
    const placed = choosePlacement({ page, size, occupied: [{ x: 0, y: 0, ...page }] });
    expect(placed.rect).toEqual({ x: 450, y: 460, ...size });
    expect(placed.fits).toBe(false);
  });
  it("uses a 12 pixel relative gap on every side", () => {
    const target = { x: 200, y: 200, width: 100, height: 100 };
    expect(relativeRect(size, target, "right").x).toBe(312);
    expect(relativeRect(size, target, "left").x).toBe(88);
    expect(relativeRect(size, target, "above").y).toBe(108);
    expect(relativeRect(size, target, "below").y).toBe(312);
  });
});
