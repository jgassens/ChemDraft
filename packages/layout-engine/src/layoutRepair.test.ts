import { describe, expect, it } from "vitest";
import { compareLayoutRepairs, repairLayoutOverlaps, conventionalLayoutOrientations, orientLayoutForLabels, type LayoutRepair } from "./layoutRepair";
import { evaluateLayoutQuality, type LayoutPoint, type LayoutBond } from "./layoutQuality";

const polygon = (n: number, center: LayoutPoint, phase = 0): LayoutPoint[] => {
  const r = 1 / (2 * Math.sin(Math.PI / n));
  return Array.from({ length: n }, (_, i) => ({
    x: center.x + r * Math.cos(phase + 2 * Math.PI * i / n),
    y: center.y + r * Math.sin(phase + 2 * Math.PI * i / n)
  }));
};
const cycle = (n: number, offset = 0): LayoutBond[] => Array.from({ length: n }, (_, i) => ({
  from: i + offset, to: (i + 1) % n + offset
}));
const rotate = (points: LayoutPoint[], pivot: LayoutPoint, degrees: number) => points.map(p => {
  const a = degrees * Math.PI / 180;
  return { x: pivot.x + (p.x - pivot.x) * Math.cos(a) - (p.y - pivot.y) * Math.sin(a),
    y: pivot.y + (p.x - pivot.x) * Math.sin(a) + (p.y - pivot.y) * Math.cos(a) };
});

function expectRigid(before: LayoutPoint[], after: LayoutPoint[], bonds: LayoutBond[]) {
  const q = evaluateLayoutQuality(before, bonds);
  for (const ring of q.rings) {
    for (const a of ring.atoms) for (const b of ring.atoms) {
      expect(Math.hypot(after[a].x - after[b].x, after[a].y - after[b].y))
        .toBeCloseTo(Math.hypot(before[a].x - before[b].x, before[a].y - before[b].y), 12);
    }
    const area = (points: LayoutPoint[]) => ring.atoms.reduce((sum, a, i) => {
      const b = ring.atoms[(i + 1) % ring.atoms.length];
      return sum + points[a].x * points[b].y - points[b].x * points[a].y;
    }, 0);
    expect(Math.sign(area(after))).toBe(Math.sign(area(before))); // never reflected
  }
  for (const { from: a, to: b } of bonds) {
    expect(Math.hypot(after[a].x - after[b].x, after[a].y - after[b].y))
      .toBeCloseTo(Math.hypot(before[a].x - before[b].x, before[a].y - before[b].y), 12);
  }
}

function expectLocalScoresMatchFullEvaluation(repairs: LayoutRepair[], bonds: LayoutBond[]) {
  for (const repair of repairs) {
    const full = evaluateLayoutQuality(repair.atoms, bonds, repair.quality.referenceBondLength);
    expect(full.hardDefects).toBe(0);
    expect(full.passes).toBe(repair.quality.passes);
    expect(full.passesRelaxed).toBe(repair.quality.passesRelaxed);
    expect(full.nearestAtomPairDistance).toBeCloseTo(repair.quality.nearestAtomPairDistance, 12);
    expect(full.nearestNonBondedAtomPairDistance).toBeCloseTo(repair.quality.nearestNonBondedAtomPairDistance, 12);
  }
}

describe("rigid fragment overlap repair", () => {
  it("orients the largest ring horizontally with the pendant below, deterministically without reflection", () => {
    const ring = polygon(6, { x: 0, y: 0 }).map(a => ({ x: a.x * 2, y: a.y }));
    const atoms = rotate([...ring, { x: 0, y: 3 }], { x: 0, y: 0 }, 37);
    const bonds = [...cycle(6), { from: 1, to: 6 }];
    const snapshot = structuredClone(atoms);
    const orientations = conventionalLayoutOrientations(atoms, bonds);
    const first = orientations[0];
    expect(first.angleDegrees).toBeCloseTo(-37);
    expect(first.atoms[6].y).toBeGreaterThan(0);
    expect(first.atoms.slice(0, 6).reduce((sum, a) => sum + a.x * a.y, 0)).toBeCloseTo(0, 12);
    expect(orientations).toHaveLength(12);
    for (const orientation of orientations) expectRigid(atoms, orientation.atoms, bonds);
    expect(conventionalLayoutOrientations(atoms, bonds)).toEqual(orientations);
    expect(atoms).toEqual(snapshot);
    // Only the second orientation has a clear synthetic label: it must be tried before rejection.
    const labels = (points: readonly LayoutPoint[]) => [{ atom: 6, x: points[6].y > 0 ? -3 : 20,
      y: -2, width: 6, height: 4 }];
    expect(orientLayoutForLabels(atoms, bonds, labels).angleDegrees).toBeCloseTo(143);
    const stepLabels = (points: readonly LayoutPoint[]) => [{ atom: 6, x: Math.abs(points[6].x) < 1 ? -3 : 20,
      y: -2, width: 6, height: 4 }];
    expect(orientLayoutForLabels(atoms, bonds, stepLabels).angleDegrees).toBeCloseTo(-7);
  });

  it("repairs a label-only collision by swinging a substituent, replanning text for every trial", () => {
    const atoms = [...polygon(6, { x: 0, y: 0 }), { x: 2, y: 0 }];
    const bonds = [...cycle(6), { from: 0, to: 6 }];
    const labels = (points: readonly LayoutPoint[]) => [{ atom: 6,
      x: points[6].x - 1, y: points[6].y - 0.1, width: 1.2, height: 0.2 }];
    const q = evaluateLayoutQuality(atoms, bonds, 1, undefined, undefined, labels(atoms));
    expect(q.overlappingAtoms).toEqual([]);
    expect(q.labelBondOverlaps.length).toBeGreaterThan(0);
    const repairs = repairLayoutOverlaps(atoms, bonds, { labelBoxes: labels });
    expect(repairs.length).toBeGreaterThan(0);
    for (const repair of repairs) {
      expect(evaluateLayoutQuality(repair.atoms, bonds, 1, undefined, undefined, labels(repair.atoms)).hardDefects).toBe(0);
      expectRigid(atoms, repair.atoms, bonds);
    }
  });
  it("bounds repair work on 500 atoms with coincident hexagons deterministically", () => {
    const atoms: LayoutPoint[] = [];
    const bonds: LayoutBond[] = [];
    for (let i = 0; i < 83; i++) {
      atoms.push(...polygon(6, { x: 0, y: 0 }));
      bonds.push(...cycle(6, i * 6));
      if (i) bonds.push({ from: (i - 1) * 6, to: i * 6 + 3 });
    }
    atoms.push({ x: 2, y: 0 }, { x: 3, y: 0 });
    bonds.push({ from: 0, to: 498 }, { from: 498, to: 499 });
    const snapshot = structuredClone(atoms);
    const start = performance.now();
    const first = repairLayoutOverlaps(atoms, bonds);
    const elapsed = performance.now() - start;
    console.log(`REPAIR_TIMING atoms=${atoms.length} ms=${elapsed.toFixed(1)}`);
    expect(elapsed).toBeLessThan(2000);
    expect(repairLayoutOverlaps(atoms, bonds)).toEqual(first);
    expect(atoms).toEqual(snapshot);
  }, 60_000);

  it("orders strict repairs by soft score, clearance, and then input order", () => {
    const quality = evaluateLayoutQuality(polygon(6, { x: 0, y: 0 }), cycle(6));
    const repair = (softScore: number, nearest: number, passes = true): LayoutRepair => ({
      atoms: [], kind: "spiro rotation", pivot: 0, movedAtoms: [], angleDegrees: 0,
      quality: { ...quality, passes, passesRelaxed: true, softScore, nearestNonBondedAtomPairDistance: nearest }
    });
    const best = repair(1, 2), tie = repair(1, 2), lessClear = repair(1, 1);
    const worse = repair(2, 10), relaxed = repair(0, 20, false);
    expect([relaxed, worse, best, lessClear, tie].sort(compareLayoutRepairs))
      .toEqual([best, tie, lessClear, worse, relaxed]);
  });
  it("rotates a spiro ring away from a third ring while preserving all intra-ring distances", () => {
    const hex = polygon(6, { x: 0, y: 0 });
    // Fuse the second hexagon across the upper edge (1--2).
    const p = hex[1], q = hex[2];
    const reflect = (a: LayoutPoint) => {
      const t = ((a.x - p.x) * (q.x - p.x) + (a.y - p.y) * (q.y - p.y)) /
        ((q.x - p.x) ** 2 + (q.y - p.y) ** 2);
      return { x: 2 * (p.x + t * (q.x - p.x)) - a.x, y: 2 * (p.y + t * (q.y - p.y)) - a.y };
    };
    const fused = [0, 3, 4, 5].map(i => reflect(hex[i]));
    const fusedIndices = [6, 1, 2, 7, 8, 9];
    const radius = 1 / (2 * Math.sin(Math.PI / 5));
    const pent = polygon(5, { x: hex[0].x + radius, y: hex[0].y }, Math.PI);
    const atoms = [...hex, ...fused, ...rotate(pent.slice(1), hex[0], 60)];
    const pentIndices = [0, 10, 11, 12, 13];
    const bonds = [...cycle(6), ...[fusedIndices, pentIndices].flatMap(ids => ids.map((from, i) => ({
      from, to: ids[(i + 1) % ids.length]
    }))).filter(b => !(b.from === 1 && b.to === 2))];
    const original = evaluateLayoutQuality(atoms, bonds);
    expect(original.overlappingAtoms.length).toBeGreaterThan(0);
    expect(original.overlappingAtoms.some(([a, b]) => a >= 6 && a <= 9 && b >= 10)).toBe(true);
    expect(original.crossings).toEqual([]);
    const repairs = repairLayoutOverlaps(atoms, bonds);
    expect(repairs.length).toBeGreaterThan(0);
    expectLocalScoresMatchFullEvaluation(repairs, bonds);
    expect(repairs[0].kind).toBe("spiro rotation");
    expect(repairs[0].pivot).toBe(0);
    expect(repairs[0].quality.passes).toBe(true);
    const repaired = repairs[0].atoms;
    const neighbours = bonds.flatMap(b => b.from === 0 ? [b.to] : b.to === 0 ? [b.from] : []);
    for (const a of neighbours) for (const b of neighbours) {
      if (a === b) continue;
      const angleA = Math.atan2(repaired[a].y - repaired[0].y, repaired[a].x - repaired[0].x);
      const angleB = Math.atan2(repaired[b].y - repaired[0].y, repaired[b].x - repaired[0].x);
      expect(Math.acos(Math.cos(angleA - angleB)) * 180 / Math.PI).toBeGreaterThanOrEqual(30 - 1e-9);
    }
    expectRigid(atoms, repairs[0].atoms, bonds);
    expect(repairLayoutOverlaps(atoms, bonds)).toEqual(repairs);
  });

  it("clears a pendant phenyl by a bridge swing and is deterministic", () => {
    const first = polygon(6, { x: 0, y: 0 });
    const second = polygon(6, { x: 3, y: 0 });
    // A nearby substituent collides with the phenyl; both rings remain regular.
    const atoms = [...first, ...rotate(second, first[0], 35), { x: 1.5, y: Math.sqrt(3) / 2 }];
    const bonds = [...cycle(6), ...cycle(6, 6), { from: 0, to: 9 }, { from: 1, to: 12 }];
    const snapshot = structuredClone(atoms);
    const repairs = repairLayoutOverlaps(atoms, bonds);
    expect(repairs.length).toBeGreaterThan(0);
    expectLocalScoresMatchFullEvaluation(repairs, bonds);
    const repaired = repairs.find(r => r.kind === "bridge swing")!;
    expect(repaired).toBeDefined();
    expect(Math.abs(repaired.angleDegrees)).toBeLessThanOrEqual(40);
    expect(repaired.quality.passes).toBe(true);
    expectRigid(atoms, repaired.atoms, bonds);
    expect(atoms).toEqual(snapshot);
    expect(repairLayoutOverlaps(atoms, bonds)).toEqual(repairs);
    const substituent = repairs.find(r => r.kind === "substituent swing")!;
    expect(substituent).toBeDefined();
    expect(substituent.movedAtoms).toEqual([12]);
    expect(Math.abs(substituent.angleDegrees)).toBeLessThanOrEqual(40);
    expectRigid(atoms, substituent.atoms, bonds);
  });

  it("returns no repair when a collision is inside one rigid ring", () => {
    const atoms = polygon(6, { x: 0, y: 0 });
    atoms[2] = { ...atoms[0] };
    expect(repairLayoutOverlaps(atoms, cycle(6))).toEqual([]);
  });

  it("leaves already passing layouts and layouts with crossings alone", () => {
    expect(repairLayoutOverlaps(polygon(6, { x: 0, y: 0 }), cycle(6))).toEqual([]);
    expect(repairLayoutOverlaps([{ x: -1, y: -1 }, { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }],
      [{ from: 0, to: 1 }, { from: 2, to: 3 }])).toEqual([]);
  });
});
