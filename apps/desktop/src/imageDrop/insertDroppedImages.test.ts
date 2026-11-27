import { describe, expect, it } from "vitest";
import { createEmptyDocument, type GraphicObject } from "@chemdraft/chem-core";
import { DROP_CASCADE_OFFSET, DROP_FIT_PAGE_FRACTION, insertDroppedImages, placeDroppedImages } from "./insertDroppedImages";
import type { PreparedDroppedImage } from "./prepareDroppedImage";
import { PNG_1X1_BASE64, pngWithSize } from "./testFixtures";

const page = { width: 800, height: 600 };

describe("placeDroppedImages", () => {
  it("centres the first picture on the drop point at natural size", () => {
    expect(placeDroppedImages(page, { x: 400, y: 300 }, [{ width: 100, height: 50 }]))
      .toEqual([{ x: 350, y: 275, width: 100, height: 50, scaled: false }]);
  });

  it("scales a picture larger than the page's centred margin box down uniformly into it, never up", () => {
    expect(DROP_FIT_PAGE_FRACTION).toBe(0.8);
    const [frame] = placeDroppedImages(page, { x: 400, y: 300 }, [{ width: 1600, height: 400 }]);
    // The box is 640 × 480 at (80, 60).
    expect(frame).toEqual({ x: 80, y: 220, width: 640, height: 160, scaled: true });
    expect(placeDroppedImages(page, { x: 0, y: 0 }, [{ width: 2, height: 2 }])[0]).toMatchObject({ width: 2, height: 2 });
    // Just over the box in one direction is enough to shrink it.
    expect(placeDroppedImages(page, { x: 400, y: 300 }, [{ width: 700, height: 100 }])[0])
      .toEqual({ x: 80, y: 300 - 100 * 640 / 700 / 2, width: 640, height: 100 * 640 / 700, scaled: true });
  });

  it("lands a page-sized photo with a margin on every side, wherever it is dropped (owner rule, 2026-11-27)", () => {
    // The hands-on case: a 2448 × 3264 portrait photo on a US Letter page once landed at 792 × 1056, edge to edge.
    const letter = { width: 816, height: 1056 };
    for (const point of [{ x: 408, y: 528 }, { x: 0, y: 0 }, { x: 816, y: 1056 }, { x: 10, y: 900 }]) {
      const [frame] = placeDroppedImages(letter, point, [{ width: 2448, height: 3264 }]);
      expect(frame!.scaled).toBe(true);
      expect(frame!.width / frame!.height).toBeCloseTo(2448 / 3264, 9);
      expect(frame!.height).toBeCloseTo(1056 * 0.8, 9);
      expect(frame!.y).toBeCloseTo(1056 * 0.1, 9);
      expect(frame!.x).toBeGreaterThanOrEqual(816 * 0.1 - 1e-9);
      expect(frame!.x + frame!.width).toBeLessThanOrEqual(816 * 0.9 + 1e-9);
    }
    const [centred] = placeDroppedImages(letter, { x: 408, y: 528 }, [{ width: 2448, height: 3264 }]);
    expect(centred!.x).toBeCloseTo(91.2, 9);
    expect(centred!.width).toBeCloseTo(633.6, 9);
  });

  it("shifts a picture near the edge so it lies wholly on the page", () => {
    expect(placeDroppedImages(page, { x: 790, y: 5 }, [{ width: 100, height: 50 }])[0]).toEqual({ x: 700, y: 0, width: 100, height: 50, scaled: false });
  });

  it("cascades further pictures by a constant offset, still on the page", () => {
    const frames = placeDroppedImages(page, { x: 100, y: 100 }, [{ width: 40, height: 40 }, { width: 40, height: 40 }, { width: 40, height: 40 }]);
    expect(frames.map(frame => [frame.x, frame.y])).toEqual([[80, 80], [80 + DROP_CASCADE_OFFSET, 80 + DROP_CASCADE_OFFSET], [80 + 2 * DROP_CASCADE_OFFSET, 80 + 2 * DROP_CASCADE_OFFSET]]);
  });

  it("cascades up and left near the bottom-right corner instead of stacking pictures", () => {
    const edge = placeDroppedImages(page, { x: 780, y: 580 }, [{ width: 40, height: 40 }, { width: 40, height: 40 }]);
    expect(edge.map(frame => [frame.x, frame.y])).toEqual([[760, 560], [760 - DROP_CASCADE_OFFSET, 560 - DROP_CASCADE_OFFSET]]);
    // Right edge only: down as usual, but left.
    const right = placeDroppedImages(page, { x: 780, y: 100 }, [{ width: 40, height: 40 }, { width: 40, height: 40 }]);
    expect(right.map(frame => [frame.x, frame.y])).toEqual([[760, 80], [760 - DROP_CASCADE_OFFSET, 80 + DROP_CASCADE_OFFSET]]);
  });

  it("keeps every picture at its own position while the page has room, shrinking the step if it must", () => {
    const sizes = Array.from({ length: 50 }, () => ({ width: 100, height: 100 }));
    const frames = placeDroppedImages(page, { x: 400, y: 300 }, sizes);
    expect(new Set(frames.map(frame => `${frame.x},${frame.y}`)).size).toBe(50);
    for (const frame of frames) {
      expect(frame.x).toBeGreaterThanOrEqual(0);
      expect(frame.y).toBeGreaterThanOrEqual(0);
      expect(frame.x + frame.width).toBeLessThanOrEqual(page.width + 1e-9);
      expect(frame.y + frame.height).toBeLessThanOrEqual(page.height + 1e-9);
    }
    // A picture as large as the page fills the margin box and leaves no room: only then do pictures share a position.
    const full = placeDroppedImages(page, { x: 400, y: 300 }, [page, page]);
    expect(full.map(frame => [frame.x, frame.y])).toEqual([[80, 60], [80, 60]]);
  });

  it("keeps the first of many pictures centred on the drop point, shrinking later steps instead", () => {
    const sizes = Array.from({ length: 20 }, () => ({ width: 100, height: 100 }));
    const frames = placeDroppedImages(page, { x: 400, y: 300 }, sizes);
    expect(frames[0]).toMatchObject({ x: 350, y: 250 });
    expect(new Set(frames.map(frame => `${frame.x},${frame.y}`)).size).toBe(20);
    for (const frame of frames) {
      expect(frame.x).toBeGreaterThanOrEqual(0);
      expect(frame.y).toBeGreaterThanOrEqual(0);
      expect(frame.x + frame.width).toBeLessThanOrEqual(page.width + 1e-9);
      expect(frame.y + frame.height).toBeLessThanOrEqual(page.height + 1e-9);
    }
    // Near the bottom edge with room only above: the first stays put, the rest go up.
    const low = placeDroppedImages(page, { x: 100, y: 500 }, sizes.slice(0, 6));
    expect(low[0]).toMatchObject({ x: 50, y: 450 });
    expect(low[5]).toMatchObject({ x: 50 + 5 * DROP_CASCADE_OFFSET, y: 450 - 5 * DROP_CASCADE_OFFSET });
  });
});

describe("placeDroppedImages with mixed sizes", () => {
  it("gives small pictures their own positions beside one that fills the page", () => {
    const frames = placeDroppedImages(page, { x: 400, y: 300 }, [page, { width: 40, height: 40 }, { width: 40, height: 40 }]);
    expect(frames.map(frame => [frame.x, frame.y])).toEqual([
      [80, 60],
      [380 + DROP_CASCADE_OFFSET, 280 + DROP_CASCADE_OFFSET],
      [380 + 2 * DROP_CASCADE_OFFSET, 280 + 2 * DROP_CASCADE_OFFSET]
    ]);
  });

  it("keeps each picture within its own room, with distinct positions for every picture that has room", () => {
    const sizes = [{ width: 790, height: 590 }, ...Array.from({ length: 10 }, () => ({ width: 40, height: 40 })), { width: 600, height: 100 }];
    const frames = placeDroppedImages(page, { x: 780, y: 580 }, sizes);
    for (const frame of frames) {
      expect(frame.x).toBeGreaterThanOrEqual(0);
      expect(frame.y).toBeGreaterThanOrEqual(0);
      expect(frame.x + frame.width).toBeLessThanOrEqual(page.width + 1e-9);
      expect(frame.y + frame.height).toBeLessThanOrEqual(page.height + 1e-9);
    }
    const small = frames.slice(1, 11).map(frame => `${frame.x},${frame.y}`);
    expect(new Set(small).size).toBe(10);
  });
});

describe("insertDroppedImages", () => {
  const image = (name: string, overrides: Partial<PreparedDroppedImage> = {}): PreparedDroppedImage =>
    ({ name, mimeType: "image/png", dataBase64: PNG_1X1_BASE64, notes: [], ...overrides });

  it("adds every picture and selects them in one change, with fresh ids", () => {
    const document = createEmptyDocument({ title: "Drop" });
    const result = insertDroppedImages(document, [image("a.png"), image("b.png")], { x: 200, y: 200 });
    const pictures = result.document.pages[0]!.objects as GraphicObject[];
    expect(pictures.map(object => object.id)).toEqual(result.objectIds);
    expect(new Set(result.objectIds).size).toBe(2);
    expect(result.document.selection.objectIds).toEqual(result.objectIds);
    expect(pictures.map(object => [object.graphicKind, object.x, object.y, object.width, object.height]))
      .toEqual([["image", 199.5, 199.5, 1, 1], ["image", 199.5 + DROP_CASCADE_OFFSET, 199.5 + DROP_CASCADE_OFFSET, 1, 1]]);
    expect(document.pages[0]!.objects).toHaveLength(0);
  });

  it("keeps a downscaled picture's original drawn size and reports pictures shrunk to the page", () => {
    const document = createEmptyDocument({ title: "Drop" });
    const big = btoa(String.fromCharCode(...pngWithSize(4000, 10)));
    const result = insertDroppedImages(document, [image("small.png", { naturalSize: { width: 30, height: 20 } }), image("big.png", { dataBase64: big })],
      { x: 100, y: 100 });
    const [small, wide] = result.document.pages[0]!.objects as GraphicObject[];
    expect([small!.width, small!.height]).toEqual([30, 20]);
    expect(small!.data.image?.pixelWidth).toBe(1);
    const boxWidth = result.document.pages[0]!.width * DROP_FIT_PAGE_FRACTION;
    expect(wide!.width).toBeCloseTo(boxWidth);
    expect(wide!.height).toBeCloseTo(10 * boxWidth / 4000);
    expect(result.scaledToPage).toEqual(["big.png"]);
  });
});
