import { describe, expect, it } from "vitest";
import { createEmptyDocument, type ChemDraftDocument, type GraphicObject } from "@chemdraft/chem-core";
import { visiblePaintOrder } from "./dropStacking";
import { DROP_CASCADE_OFFSET, arrangeDroppedImages, insertDroppedImages, placeDroppedImages } from "./insertDroppedImages";
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

interface Box { x: number; y: number; width: number; height: number }

/** `box` minus `cut`: up to four boxes, exactly. */
function subtractBox(box: Box, cut: Box): Box[] {
  const left = Math.max(box.x, cut.x);
  const right = Math.min(box.x + box.width, cut.x + cut.width);
  const top = Math.max(box.y, cut.y);
  const bottom = Math.min(box.y + box.height, cut.y + cut.height);
  if (left >= right || top >= bottom) return [box];
  const pieces: Box[] = [
    { x: box.x, y: box.y, width: left - box.x, height: box.height },
    { x: right, y: box.y, width: box.x + box.width - right, height: box.height },
    { x: left, y: box.y, width: right - left, height: top - box.y },
    { x: left, y: bottom, width: right - left, height: box.y + box.height - bottom }
  ];
  return pieces.filter(piece => piece.width > 0 && piece.height > 0);
}

const identical = (a: Box, b: Box) =>
  [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height].every(difference => Math.abs(difference) <= 1e-9);

/** For each picture on the page, bottom to top: the area no picture painted above it covers, unless that one has its very frame. */
function visibleAreas(pictures: readonly Box[]): number[] {
  return pictures.map((picture, index) => {
    let pieces = [{ x: picture.x, y: picture.y, width: picture.width, height: picture.height }];
    for (const above of pictures.slice(index + 1)) {
      if (!identical(above, picture)) pieces = pieces.flatMap(piece => subtractBox(piece, above));
    }
    return pieces.reduce((sum, piece) => sum + piece.width * piece.height, 0);
  });
}

describe("every picture of a drop keeps visible area", () => {
  const image = (name: string, width: number, height: number): PreparedDroppedImage =>
    ({ name, mimeType: "image/png", dataBase64: PNG_1X1_BASE64, notes: [], naturalSize: { width, height } });
  const onPage = (width: number, height: number): ChemDraftDocument => {
    const document = createEmptyDocument({ title: "Drop" });
    const page = document.pages[0]!;
    return { ...document, pages: [{ ...page, width, height, layout: { ...page.layout!, widthPx: width, heightPx: height } }] };
  };
  const pictures = (document: ChemDraftDocument) => document.pages[0]!.objects as GraphicObject[];

  it("paints a narrow picture above the wider one two others would hide between them", () => {
    const result = insertDroppedImages(onPage(800, 600), [image("80.png", 80, 600), image("160.png", 160, 600), image("760.png", 760, 600)],
      { x: 740, y: 560 });
    const painted = pictures(result.document);
    // The cascade is kept: these pictures only change paint order.
    expect(painted.map(({ x, width }) => [x, width])).toEqual([[0, 760], [620, 160], [700, 80]]);
    for (const area of visibleAreas(painted)) expect(area).toBeGreaterThan(0);
    expect(result.document.selection.objectIds).toEqual(result.objectIds);
    expect(result.objectIds.map(id => painted.find(object => object.id === id)!.width)).toEqual([80, 160, 760]);
  });

  it("gives pictures a shared corner when no paint order of the cascade leaves each one visible", () => {
    // The cascade puts the 20 and 780 wide pictures side by side, tiling the page-sized one.
    const sizes = [{ width: 20, height: 600 }, { width: 780, height: 600 }, { width: 800, height: 600 }];
    const cascade = placeDroppedImages({ width: 800, height: 600 }, { x: 5, y: 300 }, sizes);
    expect(cascade.map(({ x }) => x)).toEqual([0, 20, 0]);
    expect(visiblePaintOrder(cascade)).toBeUndefined();
    const result = insertDroppedImages(onPage(800, 600), sizes.map(({ width, height }) => image(`${width}.png`, width, height)), { x: 5, y: 300 });
    const painted = pictures(result.document);
    expect(painted.map(({ x, y, width }) => [x, y, width])).toEqual([[0, 0, 800], [0, 0, 780], [0, 0, 20]]);
    for (const area of visibleAreas(painted)) expect(area).toBeGreaterThan(0);
    expect(result.document.selection.objectIds).toEqual(result.objectIds);
  });

  it("moves a copy that would share its twin's frame to where it shows an edge, keeping the rest visible", () => {
    // No paint order of the cascade works, so every picture takes one corner: the two 20 wide copies
    // would share a frame. The later copy moves the shortest way that leaves every picture visible.
    const sizes = [{ width: 20, height: 600 }, { width: 780, height: 600 }, { width: 800, height: 600 }, { width: 20, height: 600 }];
    expect(visiblePaintOrder(placeDroppedImages({ width: 800, height: 600 }, { x: 5, y: 300 }, sizes))).toBeUndefined();
    const arranged = arrangeDroppedImages({ width: 800, height: 600 }, { x: 5, y: 300 }, sizes);
    expect(arranged.stacked).toEqual([]);
    expect(arranged.frames.map(({ x, y }) => [x, y])).toEqual([[0, 0], [0, 0], [0, 0], [DROP_CASCADE_OFFSET, 0]]);
    const result = insertDroppedImages(onPage(800, 600), sizes.map(({ width, height }, index) => image(`${index}.png`, width, height)), { x: 5, y: 300 });
    const painted = pictures(result.document);
    for (const area of visibleAreas(painted)) expect(area).toBeGreaterThan(0);
    expect(result.stackedExactly).toEqual([]);
  });

  it("keeps pictures as large as the page stacked, and names them", () => {
    const result = insertDroppedImages(onPage(800, 600),
      [image("a.png", 800, 600), image("small.png", 50, 50), image("b.png", 1600, 1200), image("c.png", 800, 600)], { x: 400, y: 300 });
    const painted = pictures(result.document);
    const byName = (name: string) => painted.find(object => object.id === result.objectIds[["a.png", "small.png", "b.png", "c.png"].indexOf(name)])!;
    for (const name of ["a.png", "b.png", "c.png"]) expect(byName(name)).toMatchObject({ x: 0, y: 0, width: 800, height: 600 });
    expect(result.stackedExactly).toEqual([["a.png", "b.png", "c.png"]]);
    expect(visibleAreas(painted).at(-1)).toBeGreaterThan(0);
  });

  it("holds over many mixed sizes, page sizes and drop points, with the selection in drop order", () => {
    // Deterministic: mulberry32.
    let seed = 0x5eed1234;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
    const between = (low: number, high: number) => Math.round(low + random() * (high - low));
    let reordered = 0;
    let sharedCorner = 0;
    let separated = 0;
    for (let trial = 0; trial < 1500; trial++) {
      const page = pick([{ width: 800, height: 600 }, { width: 612, height: 792 }, { width: between(80, 2000), height: between(80, 2000) }]);
      const count = random() < 0.1 ? between(9, 20) : between(1, 8);
      const sizes: Array<{ width: number; height: number }> = [];
      for (let index = 0; index < count; index++) {
        const side = (extent: number) => pick([
          between(1, 30), between(20, Math.max(20, extent / 2)), between(extent / 2, extent), extent, extent - between(1, 30),
          between(extent, 3 * extent)
        ]);
        sizes.push(index && random() < 0.15 ? { ...sizes[between(0, index - 1)]! } : { width: Math.max(1, side(page.width)), height: Math.max(1, side(page.height)) });
      }
      const coordinate = (extent: number) => pick([between(0, extent), 0, extent, between(extent - 40, extent), between(0, 40), between(-50, extent + 50)]);
      const point = { x: coordinate(page.width), y: coordinate(page.height) };
      const cascade = placeDroppedImages(page, point, sizes);
      const order = visiblePaintOrder(cascade);
      if (!order) sharedCorner++;
      else if (order.some((index, at) => index !== at)) reordered++;
      const result = insertDroppedImages(onPage(page.width, page.height), sizes.map(({ width, height }, index) => image(`${index}.png`, width, height)), point);
      const painted = pictures(result.document);
      const context = JSON.stringify({ page, point, sizes });
      const areas = visibleAreas(painted);
      for (const [index, area] of areas.entries()) {
        const frame = painted[index]!;
        expect(area, `${context}: picture ${frame.id}`).toBeGreaterThan(1e-9);
        expect(frame.x).toBeGreaterThanOrEqual(0);
        expect(frame.y).toBeGreaterThanOrEqual(0);
        expect(frame.x + frame.width).toBeLessThanOrEqual(page.width + 1e-9);
        expect(frame.y + frame.height).toBeLessThanOrEqual(page.height + 1e-9);
      }
      expect(result.document.selection.objectIds).toEqual(result.objectIds);
      const arranged = arrangeDroppedImages(page, point, sizes);
      expect(result.objectIds.map(id => painted.find(object => object.id === id)!))
        .toMatchObject(arranged.frames.map(({ x, y, width, height }) => ({ x, y, width, height })));
      // Pictures share a frame only when it fills the page, and the drop names every one of them.
      const stacked = arranged.frames.flatMap((frame, index) =>
        arranged.frames.some((other, at) => at !== index && identical(other, frame)) ? [index] : []);
      expect(arranged.stacked.flat().sort((a, b) => a - b), context).toEqual(stacked);
      for (const index of stacked) expect(arranged.frames[index], context).toMatchObject({ x: 0, y: 0, width: page.width, height: page.height });
      expect(result.stackedExactly.flat().sort(), context).toEqual(stacked.map(index => `${index}.png`).sort());
      // Wherever the cascade can be ordered and no two of its pictures coincide, it is kept as placed.
      const coincident = cascade.some((frame, index) => cascade.some((other, at) => at !== index && identical(other, frame)));
      if (order && !coincident) expect(arranged.frames).toEqual(cascade);
      if (arranged.frames.some((frame, index) => !identical(frame, (order ? cascade : arranged.frames)[index]!)) && stacked.length < count) separated++;
    }
    // Every repair is exercised.
    expect(reordered).toBeGreaterThan(20);
    expect(sharedCorner).toBeGreaterThan(0);
    expect(separated).toBeGreaterThan(0);
  });
});
