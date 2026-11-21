import { describe, expect, it } from "vitest";

import {
  ANNOTATION_BOND_LABEL_MARGIN,
  annotationAtomDrawsLabel,
  annotationAtomLabelBox,
  annotationBondLines,
  annotationLabelBoxesOverlap,
  estimateAnnotationTextWidth,
  layoutAtomAnnotationLabels,
  type AnnotationAtom,
  type AnnotationLabelBox
} from "./atomAnnotationLabels";

// Independent oracle for the drawn element label: centered text, one em tall.
function elementLabelBox(atom: { x: number; y: number; element: string }, fontSize: number): AnnotationLabelBox {
  const width = estimateAnnotationTextWidth(atom.element, fontSize);
  return { x: atom.x - width / 2, y: atom.y - fontSize / 2, width, height: fontSize };
}

// Strictly inside the box shrunk by the margin minus tenth-unit rounding slack.
function insideLabelClearance(point: { x: number; y: number }, box: AnnotationLabelBox, margin: number): boolean {
  const slack = margin - 0.08;
  return point.x > box.x - slack && point.x < box.x + box.width + slack &&
    point.y > box.y - slack && point.y < box.y + box.height + slack;
}

describe("annotation bond ends at element labels", () => {
  const labeled = ["N+", "O−", "Sn", "N", "Cl", "CH3"];

  it("treats every atom except a bare carbon as a drawn label", () => {
    for (const element of labeled) expect(annotationAtomDrawsLabel(element)).toBe(true);
    expect(annotationAtomDrawsLabel("C")).toBe(false);
    expect(annotationAtomDrawsLabel("")).toBe(false);
    expect(annotationAtomDrawsLabel(undefined)).toBe(false);
    expect(annotationAtomLabelBox({ x: 5, y: 5, element: "C" }, 15)).toBeUndefined();
    expect(annotationAtomLabelBox({ x: 5, y: 5, element: "Sn" }, 15)).toEqual(elementLabelBox({ x: 5, y: 5, element: "Sn" }, 15));
  });

  it.each([1, 0.5, 2])("stops every stroke outside the label box plus margin at fit scale %s", (fitScale) => {
    const fontSize = 15 * fitScale;
    const margin = ANNOTATION_BOND_LABEL_MARGIN * fitScale;
    const length = 60 * fitScale;
    for (const element of labeled) {
      for (let step = 0; step < 24; step += 1) {
        const angle = step * Math.PI / 12;
        const labeledAtom = { x: 100, y: 100, element };
        const carbon = { x: 100 + Math.cos(angle) * length, y: 100 + Math.sin(angle) * length, element: "C" };
        const box = elementLabelBox(labeledAtom, fontSize);
        for (const order of [1, 2, 3]) {
          for (const [a, b] of [[labeledAtom, carbon], [carbon, labeledAtom]]) {
            const lines = annotationBondLines(a, b, order, fitScale);
            expect(lines).toHaveLength(order);
            const plain = annotationBondLines({ x: a.x, y: a.y }, { x: b.x, y: b.y }, order, fitScale);
            for (const [i, line] of lines.entries()) {
              const labeledEnd = a === labeledAtom ? { x: line.x1, y: line.y1 } : { x: line.x2, y: line.y2 };
              expect(insideLabelClearance(labeledEnd, box, margin), `${element} order ${order} angle ${step}`).toBe(false);
              // Trimmed only by the label extent plus margin, not arbitrarily shortened.
              const vertexDistance = Math.hypot(labeledEnd.x - labeledAtom.x, labeledEnd.y - labeledAtom.y);
              expect(vertexDistance).toBeLessThanOrEqual(Math.hypot(box.width / 2 + margin, box.height / 2 + margin) + gapAllowance(fitScale));
              // The unlabeled carbon end keeps its exact untrimmed coordinate.
              const carbonEnd = a === carbon ? { x: line.x1, y: line.y1 } : { x: line.x2, y: line.y2 };
              const plainEnd = a === carbon ? { x: plain[i].x1, y: plain[i].y1 } : { x: plain[i].x2, y: plain[i].y2 };
              expect(carbonEnd).toEqual(plainEnd);
            }
          }
        }
      }
    }
  });

  it("keeps carbon-carbon geometry identical to bonds given without elements", () => {
    const pairs = [[{ x: 10, y: 20 }, { x: 40, y: 20 }], [{ x: 1, y: 2 }, { x: 4, y: 6 }], [{ x: 0, y: 0 }, { x: 0, y: 10 }]];
    for (const [a, b] of pairs) {
      for (const order of [1, 2, 3, 4]) {
        for (const fitScale of [1, 0.5]) {
          expect(annotationBondLines({ ...a, element: "C" }, { ...b, element: "C" }, order, fitScale))
            .toEqual(annotationBondLines(a, b, order, fitScale));
        }
      }
    }
  });

  it("trims both ends between two labels and omits a bond hidden behind them", () => {
    const lines = annotationBondLines({ x: 0, y: 0, element: "N+" }, { x: 60, y: 0, element: "O−" }, 2);
    expect(lines).toHaveLength(2);
    const left = elementLabelBox({ x: 0, y: 0, element: "N+" }, 15);
    const right = elementLabelBox({ x: 60, y: 0, element: "O−" }, 15);
    for (const line of lines) {
      expect(line.x1).toBeCloseTo(left.x + left.width + ANNOTATION_BOND_LABEL_MARGIN, 1);
      expect(line.x2).toBeCloseTo(right.x - ANNOTATION_BOND_LABEL_MARGIN, 1);
    }
    expect(annotationBondLines({ x: 0, y: 0, element: "Sn" }, { x: 12, y: 0, element: "Sn" }, 1)).toEqual([]);
  });

  it("uses the given atom font size for the label extent", () => {
    const [small] = annotationBondLines({ x: 0, y: 0, element: "Sn" }, { x: 80, y: 0 }, 1, 1, 10);
    const [large] = annotationBondLines({ x: 0, y: 0, element: "Sn" }, { x: 80, y: 0 }, 1, 1, 20);
    expect(small.x1).toBeCloseTo(estimateAnnotationTextWidth("Sn", 10) / 2 + ANNOTATION_BOND_LABEL_MARGIN, 1);
    expect(large.x1).toBeCloseTo(estimateAnnotationTextWidth("Sn", 20) / 2 + ANNOTATION_BOND_LABEL_MARGIN, 1);
  });
});

// Offset strokes of a multiple bond sit up to one gap off the axis.
function gapAllowance(fitScale: number): number {
  return 3 * fitScale + 0.1;
}

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
  it("measures the drawn numeric advances without reserving invisible trailing space", () => {
    // Helvetica/Arial digits advance 0.556 em and the decimal point advances 0.278 em.
    expect(estimateAnnotationTextWidth("7.30", 14)).toBeCloseTo((3 * 0.556 + 0.278) * 14);
    expect(estimateAnnotationTextWidth("7.30", 7)).toBeCloseTo((3 * 0.556 + 0.278) * 7);
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
