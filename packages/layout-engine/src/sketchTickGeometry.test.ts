import { describe, expect, it } from "vitest";
import { moleculeSketchTickPath, type MoleculeSketchTick } from "./sketchTicks";

const parameters = { seed: 7, roughness: 1.25, bowing: 1, color: "#111111", strokeWidth: 2 };
const points = (d: string) => {
  const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  return Array.from({ length: n.length / 2 }, (_, i) => ({ x: n[i * 2]!, y: n[i * 2 + 1]! }));
};
function measured(tick: MoleculeSketchTick, options = parameters) {
  const path = moleculeSketchTickPath(tick, options), p = points(path.d);
  const start = { x: (p[0]!.x + p[7]!.x) / 2, y: (p[0]!.y + p[7]!.y) / 2 };
  const end = { x: (p[3]!.x + p[4]!.x) / 2, y: (p[3]!.y + p[4]!.y) / 2 };
  const middle = { x: (p[1]!.x + p[6]!.x) / 2, y: (p[1]!.y + p[6]!.y) / 2 };
  const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy);
  return {
    path, p, start, end, length, angle: Math.atan2(dx, -dy) * 180 / Math.PI,
    bow: Math.abs((middle.x - start.x) * dy - (middle.y - start.y) * dx) / length,
    weight: Math.abs((p[0]!.x - p[7]!.x) * dy - (p[0]!.y - p[7]!.y) * dx) / length
  };
}

// Source geometry for a 28 px hash, bold width 12, hash spacing 8, stroke width 2.
// Explicit coordinates keep this test independent of the source geometry implementation.
const lengths = [3.168, 4.336, 5.504, 6.672, 7.84];
const centers = [5.6, 11.2, 16.8, 22.4, 28];
const cells = [[0, 7.8], [9, 13.4], [14.6, 19], [20.2, 24.6], [25.8, 28]];
const hashes: MoleculeSketchTick[] = lengths.map((length, index) => ({
  source: { x1: centers[index]!, y1: length / 2, x2: centers[index]!, y2: -length / 2 },
  axis: { x1: 0, y1: 0, x2: 28, y2: 0 }, cellStart: cells[index]![0]!, cellEnd: cells[index]![1]!,
  identity: `hash-0:${index}:0`, hashed: true, lengthVariation: length * 0.25,
  widening: { lengths, index, identity: "hash-0" }
}));

describe("sketch tick geometry without renderer dependencies", () => {
  it("realises the approved penicillin hash spreads, visible bow, disjoint hulls and widening", () => {
    const ink = hashes.map((tick) => measured(tick));
    const angles = ink.map((mark) => mark.angle);
    const ratios = ink.map((mark, index) => mark.length / lengths[index]!);
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeGreaterThanOrEqual(0.2);
    expect(Math.max(...ink.map((mark) => mark.bow))).toBeGreaterThan(0.4);
    let previousEnd = -Infinity, previousWidth = 0;
    for (const mark of ink) {
      expect(Math.min(...mark.p.map((p) => p.x))).toBeGreaterThan(previousEnd);
      previousEnd = Math.max(...mark.p.map((p) => p.x));
      const width = Math.max(...mark.p.map((p) => p.y)) - Math.min(...mark.p.map((p) => p.y));
      expect(width).toBeGreaterThanOrEqual(previousWidth);
      previousWidth = width;
    }
  });

  it("bounds realised jitter, scales it with roughness, and is deterministic", () => {
    const tick = { ...hashes[0]!, source: { x1: 50, y1: 6, x2: 50, y2: -6 },
      axis: { x1: 0, y1: 0, x2: 100, y2: 0 }, cellStart: 0, cellEnd: 100,
      widening: undefined, lengthVariation: 3 };
    const ranges = { angles: [] as number[], ratios: [] as number[], weights: [] as number[] };
    for (let seed = 1; seed <= 100; seed++) {
      const options = { ...parameters, seed };
      const full = measured(tick, options), half = measured(tick, { ...options, roughness: 0.625 });
      const zero = measured(tick, { ...options, roughness: 0 });
      const transverseRatio = Math.abs(full.end.y - full.start.y) / 12;
      expect(Math.abs(full.angle)).toBeLessThanOrEqual(14.01);
      expect(transverseRatio).toBeGreaterThanOrEqual(0.75 - 0.001);
      expect(transverseRatio).toBeLessThanOrEqual(1.25 + 0.001);
      expect(Math.abs((full.start.x + full.end.x) / 2 - 50)).toBeLessThanOrEqual(1.301);
      expect(full.weight).toBeGreaterThanOrEqual(1.2 - 0.002);
      expect(full.weight).toBeLessThanOrEqual(2.8 + 0.002);
      expect(full.bow).toBeLessThanOrEqual(0.801);
      expect(half.angle).toBeCloseTo(full.angle / 2, 1);
      expect((half.end.y - half.start.y) / -12 - 1).toBeCloseTo((transverseRatio - 1) / 2, 3);
      expect(half.weight - 2).toBeCloseTo((full.weight - 2) / 2, 2);
      expect(zero.angle).toBe(0);
      expect(zero.length).toBe(12);
      expect(zero.bow).toBe(0);
      expect(zero.weight).toBe(2);
      expect(full.path).toEqual(moleculeSketchTickPath(structuredClone(tick), options));
      ranges.angles.push(full.angle); ranges.ratios.push(transverseRatio); ranges.weights.push(full.weight);
    }
    // Check that the ranges are reached, rather than merely allowed by loose upper bounds.
    expect(Math.max(...ranges.angles) - Math.min(...ranges.angles)).toBeGreaterThan(26);
    expect(Math.max(...ranges.ratios) - Math.min(...ranges.ratios)).toBeGreaterThan(0.45);
    expect(Math.max(...ranges.weights) - Math.min(...ranges.weights)).toBeGreaterThan(1.5);
    expect(measured(tick).path).not.toEqual(measured(tick, { ...parameters, seed: 8 }).path);
  });

  it("reduces only a cramped hash's tilt and translates its intact end caps inside the cell", () => {
    const tick = { ...hashes[0]!, source: { x1: 10, y1: 6, x2: 10, y2: -6 },
      cellStart: 8.4, cellEnd: 11.6, widening: undefined, lengthVariation: 0 };
    const cramped = measured(tick);
    const roomy = measured({ ...tick, cellStart: 0, cellEnd: 28 });
    expect(Math.abs(cramped.angle)).toBeGreaterThan(0.1);
    expect(Math.abs(cramped.angle)).toBeLessThan(Math.abs(roomy.angle));
    expect(cramped.end.y - cramped.start.y).toBe(roomy.end.y - roomy.start.y);
    expect(cramped.p[0]!.y).toBe(cramped.p[7]!.y);
    expect(cramped.p[3]!.y).toBe(cramped.p[4]!.y);
    expect(Math.min(...cramped.p.map((p) => p.x))).toBeGreaterThanOrEqual(tick.cellStart - 0.001);
    expect(Math.max(...cramped.p.map((p) => p.x))).toBeLessThanOrEqual(tick.cellEnd + 0.001);
  });

  it("keeps hash hulls disjoint and widening across seeds and roughness, including tiny cells", () => {
    for (const roughness of [0, 0.1, 0.625, 1.25, 5]) {
      for (let seed = 1; seed <= 100; seed++) {
        let previousEnd = -Infinity, previousWidth = 0;
        for (const tick of hashes) {
          const mark = measured(tick, { ...parameters, roughness, seed });
          const min = Math.min(...mark.p.map((p) => p.x)), max = Math.max(...mark.p.map((p) => p.x));
          const width = Math.max(...mark.p.map((p) => p.y)) - Math.min(...mark.p.map((p) => p.y));
          expect(min).toBeGreaterThan(previousEnd);
          expect(min).toBeGreaterThanOrEqual(tick.cellStart - 0.001);
          expect(max).toBeLessThanOrEqual(tick.cellEnd + 0.001);
          expect(width).toBeGreaterThanOrEqual(previousWidth - 0.001);
          previousEnd = max; previousWidth = width;
        }
      }
    }
  });

  it("keeps visible dash gaps and clipped endpoints on rotated bonds at every strength", () => {
    for (const degrees of [0, 45, 90, -135]) {
      const radians = degrees * Math.PI / 180, ux = Math.cos(radians), uy = Math.sin(radians);
      for (const roughness of [0, 0.1, 1.25, 5]) {
        for (let seed = 1; seed <= 30; seed++) {
          let previousEnd = -Infinity;
          for (const [index, [start, end, cellStart, cellEnd]] of [
            [0, 4.4, 0, 5.8], [8, 12.4, 7, 13.8], [16, 20, 15, 20]
          ].entries()) {
            const tick: MoleculeSketchTick = {
              source: { x1: start! * ux, y1: start! * uy, x2: end! * ux, y2: end! * uy },
              axis: { x1: 0, y1: 0, x2: 20 * ux, y2: 20 * uy },
              cellStart: cellStart!, cellEnd: cellEnd!, lengthVariation: (end! - start!) * 0.25,
              identity: `dash:${index}`, hashed: false
            };
            const path = moleculeSketchTickPath(tick, { ...parameters, roughness, seed });
            const axial = points(path.d).map((p) => p.x * ux + p.y * uy);
            expect(Math.min(...axial)).toBeGreaterThan(previousEnd);
            expect(Math.min(...axial)).toBeGreaterThanOrEqual(cellStart! - 0.002);
            expect(Math.max(...axial)).toBeLessThanOrEqual(cellEnd! + 0.002);
            previousEnd = Math.max(...axial);
          }
        }
      }
    }
  });
});
