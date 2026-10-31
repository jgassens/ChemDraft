import { describe, expect, it } from "vitest";
import { compareLayoutQuality, evaluateLayoutQuality, MAX_BRIDGE_STRETCH, type LayoutPoint } from "./layoutQuality";

const polygon = (n: number): LayoutPoint[] => Array.from({ length: n }, (_, i) => ({
  x: Math.cos(i * 2 * Math.PI / n), y: Math.sin(i * 2 * Math.PI / n)
}));
const cycle = (n: number) => Array.from({ length: n }, (_, from) => ({ from, to: (from + 1) % n }));

describe("2D layout quality", () => {
  it("bounds diamond-chain ring perception at 37 and 499 atoms", () => {
    for (const k of [12, 166]) {
      const atoms = Array.from({ length: k + 1 }, (_, i) => ({ x: 2 * i, y: 0 }));
      const bonds: { from: number; to: number }[] = [{ from: 0, to: k }];
      for (let i = 0; i < k; i++) {
        const top = atoms.length;
        atoms.push({ x: 2 * i + 1, y: 1 }, { x: 2 * i + 1, y: -1 });
        bonds.push({ from: i, to: top }, { from: top, to: i + 1 },
          { from: i, to: top + 1 }, { from: top + 1, to: i + 1 });
      }
      const start = performance.now();
      const q = evaluateLayoutQuality(atoms, bonds);
      const elapsed = performance.now() - start;
      console.log(`DIAMOND_TIMING k=${k} atoms=${atoms.length} ms=${elapsed.toFixed(1)} rings=${q.rings.length}`);
      expect(elapsed).toBeLessThan(1000);
      expect(q.rings.length).toBeLessThanOrEqual(bonds.length);
    }
  });

  it("counts an atom in a nonincident bond's interior as a hard defect", () => {
    const q = evaluateLayoutQuality([{ x: 0, y: 0 }, { x: 1.08, y: 0 }, { x: 0.54, y: 0 }],
      [{ from: 0, to: 1 }]);
    expect(q.overlappingAtoms).toEqual([]);
    expect(q.hardDefects).toBeGreaterThan(0);
    expect(q.passes).toBe(false);
  });

  it("counts collinear bonds with positive length overlap as hard defects", () => {
    const q = evaluateLayoutQuality([0, 1, 0.5, 1.5].map(x => ({ x, y: 0 })),
      [{ from: 0, to: 1 }, { from: 2, to: 3 }], 1);
    expect(q.overlappingAtoms).toEqual([]);
    expect(q.collinearBondOverlaps).toEqual([[0, 1]]);
    expect(q.hardDefects).toBeGreaterThan(0);
    expect(q.passes).toBe(false);
  });

  it.each([1.5, MAX_BRIDGE_STRETCH, 1.7])("relaxes only a bridge between separate ring systems (%s)", stretch => {
    const atoms = [...polygon(6), ...polygon(6).map(p => ({ x: p.x + 2 + stretch, y: p.y }))];
    const bonds = [...cycle(6), ...cycle(6).map(b => ({ from: b.from + 6, to: b.to + 6 })), { from: 0, to: 9 }];
    const q = evaluateLayoutQuality(atoms, bonds, 1);
    expect(q.hardDefects).toBe(0);
    expect(q.bridgeBonds).toEqual([12]);
    expect(q.maxBridgeLength).toBeCloseTo(stretch);
    expect(q.passes).toBe(false);
    expect(q.passesRelaxed).toBe(stretch <= MAX_BRIDGE_STRETCH);
    expect(evaluateLayoutQuality(atoms, bonds).passesRelaxed).toBe(stretch <= MAX_BRIDGE_STRETCH);
  });

  it("never relaxes a ring bond or a bond to an acyclic substituent", () => {
    const atoms = polygon(6).map(p => ({ x: p.x * 1.5, y: p.y * 1.5 }));
    const ring = evaluateLayoutQuality(atoms, cycle(6), 1);
    expect(ring.rings[0].maxAngleError).toBeCloseTo(0);
    expect(ring.maxBondLength).toBeCloseTo(1.5);
    expect(ring.bridgeBonds).toEqual([]);
    expect(ring.passesRelaxed).toBe(false);
    const substituent = evaluateLayoutQuality([...polygon(6), { x: 2.5, y: 0 }], [...cycle(6), { from: 0, to: 6 }], 1);
    expect(substituent.bridgeBonds).toEqual([]);
    expect(substituent.passesRelaxed).toBe(false);
  });

  it.each([5, 6])("accepts a regular %i-ring in either coordinate orientation", n => {
    for (const sign of [-1, 1]) {
      const quality = evaluateLayoutQuality(polygon(n).map(p => ({ x: p.x, y: sign * p.y })), cycle(n));
      expect(quality.passes).toBe(true);
      expect(quality.rings).toHaveLength(1);
      expect(quality.rings[0].maxAngleError).toBeCloseTo(0, 10);
      expect(quality.minBondLength).toBeCloseTo(1, 10);
      expect(quality.maxBondLength).toBeCloseTo(1, 10);
      expect(quality.bondLengthStdDev).toBeCloseTo(0, 10);
    }
  });

  it("rejects a squashed hexagon and compares soft scores after hard defects", () => {
    const regular = evaluateLayoutQuality(polygon(6), cycle(6));
    const squashed = evaluateLayoutQuality(polygon(6).map(p => ({ x: p.x, y: p.y * 0.5 })), cycle(6));
    expect(squashed.passes).toBe(false);
    expect(squashed.passesRelaxed).toBe(false);
    expect(squashed.minBondLength).toBeLessThan(0.9);
    expect(squashed.rings[0].maxAngleError).toBeGreaterThan(10);
    expect(compareLayoutQuality(regular, squashed)).toBeLessThan(0);
  });

  it("counts proper crossings, excluding shared endpoints and collinear touches", () => {
    const atoms = [{ x: -1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }, { x: 1, y: -1 }];
    const quality = evaluateLayoutQuality(atoms, [{ from: 0, to: 1 }, { from: 2, to: 3 }]);
    expect(quality.crossings).toEqual([[0, 1]]);
    expect(quality.hardDefects).toBe(1);
    expect(quality.passes).toBe(false);
    expect(quality.passesRelaxed).toBe(false);
    expect(evaluateLayoutQuality(atoms, [{ from: 0, to: 1 }, { from: 0, to: 3 }]).crossings).toEqual([]);
    expect(evaluateLayoutQuality([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
      [{ from: 0, to: 1 }, { from: 2, to: 3 }]).crossings).toEqual([]);
  });

  it("counts all overlapping pairs, including bonded atoms, against the supplied reference", () => {
    const quality = evaluateLayoutQuality([{ x: 0, y: 0 }, { x: 0.3, y: 0 }, { x: 1.3, y: 0 }],
      [{ from: 0, to: 1 }, { from: 1, to: 2 }], 1);
    expect(quality.overlappingAtoms).toEqual([[0, 1]]);
    expect(quality.nearestAtomPairDistance).toBeCloseTo(0.3);
    expect(quality.nearestNonBondedAtomPairDistance).toBeCloseTo(1.3);
    expect(quality.bondLengthStdDev).toBeCloseTo(0.35);
    expect(quality.passes).toBe(false);
    expect(quality.passesRelaxed).toBe(false);
    const distorted = evaluateLayoutQuality(polygon(6).map(p => ({ x: p.x, y: p.y * 0.3 })), cycle(6));
    expect(compareLayoutQuality(distorted, quality)).toBeLessThan(0);
  });

  it("uses reflex interior angles instead of their small supplements", () => {
    const atoms = polygon(6);
    atoms[0] = { x: 0, y: 0 };
    expect(evaluateLayoutQuality(atoms, cycle(6)).rings[0].maxAngleError).toBeCloseTo(120);
  });

  it("detects same-side fused rings, but accepts opposite-side regular rings", () => {
    const hex = polygon(6);
    const p = hex[0], q = hex[1];
    const reflect = (a: LayoutPoint) => {
      const t = ((a.x - p.x) * (q.x - p.x) + (a.y - p.y) * (q.y - p.y)) / ((q.x - p.x) ** 2 + (q.y - p.y) ** 2);
      return { x: 2 * (p.x + t * (q.x - p.x)) - a.x, y: 2 * (p.y + t * (q.y - p.y)) - a.y };
    };
    const bonds = [...cycle(6), { from: 1, to: 6 }, { from: 6, to: 7 }, { from: 7, to: 8 }, { from: 8, to: 9 }, { from: 9, to: 0 }];
    const same = evaluateLayoutQuality([...hex, ...hex.slice(2)], bonds);
    const opposite = evaluateLayoutQuality([...hex, ...hex.slice(2).map(reflect)], bonds);
    expect(same.fusedSideDefects).toEqual([[0, 1]]);
    expect(opposite.fusedSideDefects).toEqual([]);
    expect(opposite.passes).toBe(true);
  });

  it("does not certify a cubane projection with distorted cage bonds", () => {
    const atoms = [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 },
      { x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
    const bonds = [...cycle(4), ...cycle(4).map(b => ({ from: b.from + 4, to: b.to + 4 })),
      ...Array.from({ length: 4 }, (_, from) => ({ from, to: from + 4 }))];
    const quality = evaluateLayoutQuality(atoms, bonds);
    expect(quality.passes).toBe(false);
    expect(quality.rings).toHaveLength(6);
    expect(quality.hasBridgedRings).toBe(true);
    expect(quality.minBondLength).toBeLessThan(0.9);
  });

  it("handles isolated and collapsed atoms and refuses invalid geometry", () => {
    expect(evaluateLayoutQuality([{ x: 0, y: 0 }], []).passes).toBe(true);
    expect(evaluateLayoutQuality([{ x: 0, y: 0 }, { x: 0, y: 0 }], [{ from: 0, to: 1 }]).passes).toBe(false);
    expect(() => evaluateLayoutQuality([{ x: NaN, y: 0 }], [])).toThrow(/finite/);
  });

  it("finds a six-ring even when every one of its bonds is also in a smaller ring", () => {
    const atoms = polygon(6);
    const bonds = cycle(6);
    for (let from = 0; from < 6; from++) {
      const start = atoms.length;
      atoms.push({ x: 10 + 4 * from, y: 0 }, { x: 11 + 4 * from, y: 1 }, { x: 12 + 4 * from, y: 0 });
      bonds.push({ from, to: start }, { from: start, to: start + 1 },
        { from: start + 1, to: start + 2 }, { from: start + 2, to: (from + 1) % 6 });
    }
    const quality = evaluateLayoutQuality(atoms, bonds);
    expect(quality.rings.filter(r => r.atoms.length === 5)).toHaveLength(6);
    expect(quality.rings.filter(r => r.atoms.length === 6)).toHaveLength(1);
  });
});
