import { describe, expect, it } from "vitest";

import {
  annotationLabelBoxesOverlap,
  estimateAnnotationTextWidth,
  layoutAtomAnnotationLabels,
  type AnnotationAtom,
  type AnnotationLabelBox
} from "./atomAnnotationLabels";

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
});
