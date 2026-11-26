import { describe, expect, it } from "vitest";
import { createEmptyDocument, type GraphicObject } from "@chemdraft/chem-core";
import { DROP_CASCADE_OFFSET, insertDroppedImages, placeDroppedImages } from "./insertDroppedImages";
import type { PreparedDroppedImage } from "./prepareDroppedImage";
import { PNG_1X1_BASE64, pngWithSize } from "./testFixtures";

const page = { width: 800, height: 600 };

describe("placeDroppedImages", () => {
  it("centres the first picture on the drop point at natural size", () => {
    expect(placeDroppedImages(page, { x: 400, y: 300 }, [{ width: 100, height: 50 }]))
      .toEqual([{ x: 350, y: 275, width: 100, height: 50, scaled: false }]);
  });

  it("scales a picture larger than the page down uniformly, never up", () => {
    const [frame] = placeDroppedImages(page, { x: 400, y: 300 }, [{ width: 1600, height: 400 }]);
    expect(frame).toEqual({ x: 0, y: 200, width: 800, height: 200, scaled: true });
    expect(placeDroppedImages(page, { x: 0, y: 0 }, [{ width: 2, height: 2 }])[0]).toMatchObject({ width: 2, height: 2 });
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
    // A picture as large as the page leaves no room: only then do pictures share a position.
    const full = placeDroppedImages(page, { x: 400, y: 300 }, [page, page]);
    expect(full.map(frame => [frame.x, frame.y])).toEqual([[0, 0], [0, 0]]);
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
      [0, 0],
      [DROP_CASCADE_OFFSET, DROP_CASCADE_OFFSET],
      [2 * DROP_CASCADE_OFFSET, 2 * DROP_CASCADE_OFFSET]
    ]);
  });

  it("leaves a strip above and to the left of every later picture in a five-size cascade", () => {
    const sizes = [
      { width: 40, height: 60 }, { width: 120, height: 40 }, { width: 60, height: 180 },
      { width: 400, height: 300 }, { width: 200, height: 120 }
    ];
    const frames = placeDroppedImages(page, { x: 200, y: 150 }, sizes);
    expect(frames[0]).toMatchObject({ x: 180, y: 120 });
    expect(frames.map(({ width, height }) => ({ width, height }))).toEqual(sizes);
    for (const [index, frame] of frames.entries()) {
      for (const later of frames.slice(index + 1)) {
        expect(later.x - frame.x).toBeGreaterThanOrEqual(DROP_CASCADE_OFFSET);
        expect(later.y - frame.y).toBeGreaterThanOrEqual(DROP_CASCADE_OFFSET);
      }
    }
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

  it("keeps large pictures of the same size distinct when reversing at a page edge", () => {
    const sizes = [{ width: 40, height: 40 }, ...Array.from({ length: 14 }, () => ({ width: 700, height: 500 }))];
    const frames = placeDroppedImages(page, { x: 780, y: 580 }, sizes);
    expect(frames[0]).toMatchObject({ x: 760, y: 560 });
    expect(new Set(frames.map(({ x, y }) => `${x},${y}`)).size).toBe(sizes.length);
    expect(frames.at(-1)).toMatchObject({ x: 0, y: 0, width: 700, height: 500 });
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
    const pageWidth = result.document.pages[0]!.width;
    expect(wide!.width).toBeCloseTo(pageWidth);
    expect(wide!.height).toBeCloseTo(10 * pageWidth / 4000);
    expect(result.scaledToPage).toEqual(["big.png"]);
  });

  it("keeps a later large picture behind a smaller one it would hide in an up-left cascade", () => {
    const document = createEmptyDocument({ title: "Drop" });
    const page = document.pages[0]!;
    const result = insertDroppedImages(document, [
      image("small.png", { naturalSize: { width: 40, height: 40 } }),
      image("large.png", { naturalSize: { width: 300, height: 300 } })
    ], { x: page.width - 50, y: page.height - 50 });
    const [large, small] = result.document.pages[0]!.objects as GraphicObject[];
    expect([large!.id, small!.id]).toEqual([...result.objectIds].reverse());
    expect(small).toMatchObject({ x: page.width - 70, y: page.height - 70, width: 40, height: 40 });
    expect(large).toMatchObject({
      x: page.width - 300 - DROP_CASCADE_OFFSET, y: page.height - 300 - DROP_CASCADE_OFFSET, width: 300, height: 300
    });
  });
});
