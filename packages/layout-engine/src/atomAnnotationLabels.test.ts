import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  annotationBondLines,
  annotationLabelBoxesOverlap,
  estimateAnnotationTextWidth,
  layoutAtomAnnotationLabels,
  type AnnotationAtom,
  type AnnotationLabelBox
} from "./atomAnnotationLabels";

describe("annotation bond lines", () => {
  it("keeps single strokes and scales centered double/triple gaps with the fitted drawing", () => {
    const a = { x: 10, y: 20 };
    const b = { x: 40, y: 20 };
    expect(annotationBondLines(a, b, 1)).toEqual([{ x1: 10, y1: 20, x2: 40, y2: 20 }]);
    expect(annotationBondLines(a, b, 2)).toEqual([
      { x1: 10, y1: 18.5, x2: 40, y2: 18.5 },
      { x1: 10, y1: 21.5, x2: 40, y2: 21.5 }
    ]);
    expect(annotationBondLines(a, b, 3, 0.5)).toEqual([
      { x1: 10, y1: 18.5, x2: 40, y2: 18.5 },
      { x1: 10, y1: 20, x2: 40, y2: 20 },
      { x1: 10, y1: 21.5, x2: 40, y2: 21.5 }
    ]);
  });

  it("offsets diagonal bonds perpendicularly with the existing tenth-unit rounding", () => {
    const a = { x: 1, y: 2 };
    const b = { x: 4, y: 6 };
    expect(annotationBondLines(a, b, 2, 0.5)).toEqual([
      { x1: 1.6, y1: 1.6, x2: 4.6, y2: 5.6 },
      { x1: 0.4, y1: 2.5, x2: 3.4, y2: 6.5 }
    ]);
    expect(annotationBondLines(b, a, 2, 0.5)).toEqual([
      { x1: 3.4, y1: 6.5, x2: 0.4, y2: 2.5 },
      { x1: 4.6, y1: 5.6, x2: 1.6, y2: 1.6 }
    ]);
  });

  it("preserves the fallback for unsupported orders and coincident endpoints", () => {
    expect(annotationBondLines({ x: 0, y: 0 }, { x: 0, y: 10 }, 4)).toEqual([
      { x1: 0, y1: 0, x2: 0, y2: 10 }
    ]);
    expect(annotationBondLines({ x: 1, y: 2 }, { x: 1, y: 2 }, 3, 0.2)).toEqual(
      Array.from({ length: 3 }, () => ({ x1: 1, y1: 2, x2: 1, y2: 2 }))
    );
  });
});

function inside(box: AnnotationLabelBox): void {
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(340);
  expect(box.y + box.height).toBeLessThanOrEqual(260);
}

function checkPlacement(atoms: AnnotationAtom[], bonds: { from: number; to: number }[]) {
  const input = { atoms, bonds, width: 340, height: 260 };
  const before = structuredClone(input);
  const result = layoutAtomAnnotationLabels(input);
  // Frozen before spatial indexing: these cover the ring, hydrogen grid, shelf and isolated atom.
  const originalPlacements: Record<number, string> = {
    8: "fc432153b2228a165cb2b39664565dd53520e8f1bd1146f1a82062b142f42a54",
    40: "ca5a78fdda2006bdc8435c8ce5196b422c584fed6ca6398826194306b786b08d",
    20: "2b3f16e9d6c62cf9d3d8a35ddd7f125e3274564d268d1348f45051b4aa073c8e",
    1: "e4f31c70e2177ecd00ce20581702527d0fcf390eaf6ebe1289a8b3e648c82d8b"
  };
  expect(createHash("sha256").update(JSON.stringify(result)).digest("hex")).toBe(originalPlacements[atoms.length]);
  expect(input).toEqual(before);
  expect(layoutAtomAnnotationLabels(input)).toEqual(result);
  expect(result.labels).toHaveLength(atoms.filter((atom) => atom.annotation).length);
  for (const [index, label] of result.labels.entries()) {
    inside(label);
    expect(label.width).toBeCloseTo(estimateAnnotationTextWidth(label.text, result.labelFontSize));
    for (const other of result.labels.slice(index + 1)) {
      expect(annotationLabelBoxesOverlap(label, other)).toBe(false);
    }
    for (const atom of result.atoms) {
      const width = Math.max(26 * result.fitScale, estimateAnnotationTextWidth(atom.element, result.atomFontSize) + 4 * result.fitScale);
      const box = { x: atom.x - width / 2, y: atom.y - 13 * result.fitScale, width, height: 26 * result.fitScale };
      inside(box);
      expect(annotationLabelBoxesOverlap(label, box)).toBe(false);
    }
    for (const bond of bonds) {
      const a = result.atoms.find((atom) => atom.index === bond.from)!;
      const b = result.atoms.find((atom) => atom.index === bond.to)!;
      // Sample the rendered bond as small boxes, including its stroke and parallel offsets.
      for (let step = 0; step <= 100; step += 1) {
        const pad = 3 * result.fitScale;
        expect(annotationLabelBoxesOverlap(label, {
          x: a.x + (b.x - a.x) * step / 100 - pad,
          y: a.y + (b.y - a.y) * step / 100 - pad,
          width: pad * 2, height: pad * 2
        })).toBe(false);
      }
    }
  }
  return result;
}

describe("atom annotation labels", () => {
  it("estimates text deterministically from character count and font size", () => {
    expect(estimateAnnotationTextWidth("7.30", 14)).toBe(63);
    expect(estimateAnnotationTextWidth("7.30", 7)).toBe(31.5);
    expect(estimateAnnotationTextWidth("128.0 / 129.0ᵢ", 14)).toBeGreaterThan(estimateAnnotationTextWidth("128.0", 14));
  });

  it("fits an annotated ring and long element labels clear of every vertex and bond", () => {
    const atoms = Array.from({ length: 8 }, (_, index) => ({
      index, x: Math.cos(index * Math.PI / 4), y: Math.sin(index * Math.PI / 4),
      element: index === 0 ? "Cl" : "C", annotation: index % 2 ? "127.34" : "126.89"
    }));
    checkPlacement(atoms, atoms.map((atom) => ({ from: atom.index, to: (atom.index + 1) % 8 })));
  });

  it("fits many explicit hydrogen annotations without clipping or dropping labels", () => {
    const atoms = Array.from({ length: 40 }, (_, index) => ({
      index, x: index % 10, y: Math.floor(index / 10),
      element: index < 10 ? "C" : "H", annotation: index % 2 ? "7.30" : "7.25 / 7.28ᵢ"
    }));
    checkPlacement(atoms, atoms.slice(1).map((atom) => ({ from: atom.index - 1, to: atom.index })));
  });

  it("handles coincident coordinates, isolated atoms and annotations wider than the viewBox", () => {
    checkPlacement(Array.from({ length: 20 }, (_, index) => ({
      index, x: 0, y: 0, element: "O", annotation: index === 0 ? "shift ".repeat(40) : "45.01"
    })), []);
    checkPlacement([{ index: 0, x: 5, y: 5, element: "H", annotation: "1.21" }], []);
    expect(layoutAtomAnnotationLabels({ atoms: [], bonds: [], width: 340, height: 260 }).labels).toEqual([]);
  });

  it("ignores non-finite vertices and bond geometry without disturbing valid placements", () => {
    const atoms = [{ index: 0, x: 5, y: 5, element: "H", annotation: "1.21" }];
    const input = { atoms, bonds: [], width: 340, height: 260 };
    expect(layoutAtomAnnotationLabels({
      ...input,
      atoms: [...atoms, { index: 1, x: Infinity, y: 0, element: "C", annotation: "bad" },
        { index: 2, x: 0, y: NaN, element: "O" }],
      bonds: [{ from: 0, to: 1 }, { from: 0, to: 2 }]
    })).toEqual(layoutAtomAnnotationLabels(input));
    expect(annotationBondLines({ x: Infinity, y: 0 }, { x: 0, y: 0 }, 1)).toEqual([]);
    expect(annotationBondLines({ x: 0, y: 0 }, { x: 0, y: 1 }, NaN)).toEqual([]);
    expect(annotationBondLines({ x: 0, y: 0 }, { x: 0, y: 1 }, 1, Infinity)).toEqual([]);
    expect(annotationBondLines({ x: Number.MAX_VALUE, y: 0 }, { x: -Number.MAX_VALUE, y: 1 }, 1)).toEqual([]);
    expect(layoutAtomAnnotationLabels({ ...input, width: Infinity }).atoms).toEqual([]);
    expect(layoutAtomAnnotationLabels({ ...input, padding: NaN })).toEqual(layoutAtomAnnotationLabels(input));
  });

  it("places all 4,000 annotations beside 8,000 bonds in a few seconds", () => {
    const atoms = Array.from({ length: 4000 }, (_, index) => ({
      index, x: index % 80, y: Math.floor(index / 80), element: "C", annotation: "128.00"
    }));
    const bonds = Array.from({ length: 8000 }, (_, index) => ({ from: index % 4000, to: (index + 1) % 4000 }));
    const start = performance.now();
    const result = layoutAtomAnnotationLabels({ atoms, bonds, width: 340, height: 260 });
    expect(performance.now() - start).toBeLessThan(2500);
    expect(result.atoms).toHaveLength(4000);
    expect(result.labels).toHaveLength(4000);
    expect(JSON.stringify(result)).not.toMatch(/null/);
  });
});
