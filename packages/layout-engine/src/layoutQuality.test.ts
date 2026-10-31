import { describe, expect, it } from "vitest";
import { compareLayoutQuality, evaluateLayoutQuality, prepareLayoutLabelEvaluator, labelBoxBondDistance,
  LABEL_CLEARANCE_PADDING, MAX_BRIDGE_STRETCH, type LayoutPoint, type LayoutLabelBox } from "./layoutQuality";
import { testMoleculeFromSmiles } from "./testing";
import { moleculeLayoutLabelBoxes, planMoleculeAtomLabels } from "./index";
import type { MoleculeObject } from "@chemdraft/chem-core";

const polygon = (n: number): LayoutPoint[] => Array.from({ length: n }, (_, i) => ({
  x: Math.cos(i * 2 * Math.PI / n), y: Math.sin(i * 2 * Math.PI / n)
}));
const cycle = (n: number) => Array.from({ length: n }, (_, from) => ({ from, to: (from + 1) % n }));

describe("2D layout quality", () => {
  it("spatial label checks match exhaustive contacts and exact clearance through rigid swings", () => {
    const atoms = Array.from({ length: 16 }, (_, i) => ({ x: (i % 4) * 30, y: Math.floor(i / 4) * 30 }));
    const bonds = atoms.slice(1).map((_, i) => ({ from: i, to: i + 1 }));
    const moving = new Set([8, 9, 10, 11, 12, 13, 14, 15]);
    const boxes: LayoutLabelBox[] = atoms.map((a, atom) => ({ atom, x: a.x - 8, y: a.y - 10,
      width: atom === 15 ? 80 : 16, height: atom === 15 ? 80 : 20 }));
    const reference = 30, padding = LABEL_CLEARANCE_PADDING * reference;
    const exhaustive = (points: LayoutPoint[], labels: LayoutLabelBox[]) => {
      const labelBondOverlaps: [number, number][] = [], labelLabelOverlaps: [number, number][] = [];
      let smallestLabelBondClearance = Infinity;
      labels.forEach((box, i) => {
        bonds.forEach((b, j) => {
          if (b.from === box.atom || b.to === box.atom) return;
          smallestLabelBondClearance = Math.min(smallestLabelBondClearance,
            labelBoxBondDistance(box, points[b.from], points[b.to]) / reference);
          if (labelBoxBondDistance({ ...box, x: box.x - padding, y: box.y - padding,
            width: box.width + 2 * padding, height: box.height + 2 * padding }, points[b.from], points[b.to]) === 0)
            labelBondOverlaps.push([box.atom, j]);
        });
        labels.slice(i + 1).forEach(other => {
          if (box.x <= other.x + other.width + padding && other.x <= box.x + box.width + padding &&
              box.y <= other.y + other.height + padding && other.y <= box.y + box.height + padding)
            labelLabelOverlaps.push([box.atom, other.atom]);
        });
      });
      return { labelBondOverlaps, labelLabelOverlaps, smallestLabelBondClearance };
    };
    const check = prepareLayoutLabelEvaluator(atoms, bonds, boxes, reference, moving);
    // Includes mobile/mobile label changes, mobile labels against stationary bonds,
    // and the reverse: a moving bond against a stationary label.
    for (const degrees of [0, 30, -40, 90, 180]) {
      const angle = degrees * Math.PI / 180, pivot = atoms[7];
      const points = atoms.map((a, i) => !moving.has(i) ? a : ({
        x: pivot.x + (a.x - pivot.x) * Math.cos(angle) - (a.y - pivot.y) * Math.sin(angle),
        y: pivot.y + (a.x - pivot.x) * Math.sin(angle) + (a.y - pivot.y) * Math.cos(angle)
      }));
      const labels = boxes.map(b => ({ ...b, x: b.x + points[b.atom].x - atoms[b.atom].x,
        y: b.y + points[b.atom].y - atoms[b.atom].y }));
      const expected = exhaustive(points, labels);
      expect(check(points, labels)).toEqual(expected);
      const full = prepareLayoutLabelEvaluator(points, bonds, labels, reference)();
      expect(full).toEqual(expected);
    }
    // Nonzero minima, and a sparse long-distance query whose empty cells must not dominate.
    const sparse = atoms.map((a, i) => ({ x: a.x + (i % 2) * 10_000, y: a.y + (i % 2) * 10_000 }));
    const farBoxes = boxes.slice(0, 2).map(b => ({ ...b, x: b.x - 20_000, y: b.y - 1000, width: 1, height: 1 }));
    expect(prepareLayoutLabelEvaluator(sparse, bonds, farBoxes, reference)()).toEqual(exhaustive(sparse, farBoxes));
  });
  it("uses renderer boxes for heteroatoms, isotope/charge labels and abbreviations with per-atom styles", () => {
    const molecule: MoleculeObject = {
      id: "labels", type: "molecule", x: 0, y: 0, width: 200, height: 80, rotation: 0,
      structure: "", structureFormat: "smiles", superatoms: [], rGroups: [],
      style: { bondLengthPx: 30, atomLabelFontSizePx: 15, atomLabelFontSizes: { a4: 23 } },
      atoms: ["C", "O", "C", "N", "OMe"].map((element, i) => ({
        id: `a${i}`, element, x: i * 30, y: 0, formalCharge: i === 3 ? 1 : 0,
        ...(i === 2 ? { isotope: 13 } : {}) })),
      bonds: Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, fromAtomId: `a${i}`, toAtomId: `a${i + 1}`, order: "single" }))
    };
    const plans = planMoleculeAtomLabels(molecule);
    const boxes = moleculeLayoutLabelBoxes(molecule);
    expect(boxes.map(box => box.atom)).toEqual([1, 2, 3, 4]);
    expect(plans.at(-1)!.fontSizePx).toBe(23);
    expect(boxes).toEqual(plans.map(plan => ({ atom: molecule.atoms.indexOf(plan.atom),
      x: plan.anchor.x + plan.layout.bounds.x, y: plan.anchor.y + plan.layout.bounds.y,
      width: plan.layout.bounds.width, height: plan.layout.bounds.height })));
  });
  it("counts padded label/bond and label/label contacts as hard defects, excluding incident bonds", () => {
    const atoms = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }];
    const bonds = [{ from: 0, to: 1 }];
    const box = { atom: 2, x: 0.3, y: -0.1, width: 0.4, height: 1.2 };
    const evaluate = (boxes: typeof box[]) => evaluateLayoutQuality(atoms, bonds, 1, undefined, undefined, boxes);
    expect(evaluate([box]).labelBondOverlaps).toEqual([[2, 0]]);
    expect(evaluate([box]).passes).toBe(false);
    expect(evaluate([{ ...box, y: 0.02 }]).passes).toBe(false); // padding rejects near touches too
    expect(evaluate([{ ...box, y: 0.05 }]).passes).toBe(true);
    expect(evaluate([{ ...box, atom: 0 }]).labelBondOverlaps).toEqual([]);
    expect(evaluate([{ ...box, y: 1 }, { ...box, atom: 1, y: 1 }]).labelLabelOverlaps).toEqual([[2, 1]]);
    expect(evaluate([{ ...box, y: 1 }, { ...box, atom: 1, y: 3 }]).hardDefects).toBe(0);
  });

  it("exempts only declared label pairs, retaining other labels and all skeleton checks", () => {
    const atoms = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0 }];
    const bonds = [{ from: 0, to: 1 }, { from: 0, to: 2 }];
    const boxes = [0, 2, 3].map(atom => ({ atom, x: 0.3, y: -0.1, width: 0.4, height: 1.2 }));
    const raw = evaluateLayoutQuality(atoms, bonds, 1, undefined, undefined, boxes);
    // Reversing the exemption's indices must not change which single pair is exempted.
    const exempt = evaluateLayoutQuality(atoms, bonds, 1, undefined, undefined, boxes, [[3, 2]]);
    expect(raw.labelLabelOverlaps).toEqual([[0, 2], [0, 3], [2, 3]]);
    expect(exempt.labelLabelOverlaps).toEqual([[0, 2], [0, 3]]);
    expect(exempt.labelBondOverlaps).toEqual(raw.labelBondOverlaps);
    expect(exempt.labelBondOverlaps).toContainEqual([3, 0]);
    expect(exempt.smallestLabelBondClearance).toBe(raw.smallestLabelBondClearance);
    expect(exempt.overlappingAtoms).toEqual(raw.overlappingAtoms);
    expect(exempt.overlappingAtoms).toContainEqual([2, 3]);
    expect(exempt.atomBondOverlaps).toEqual(raw.atomBondOverlaps);
    expect(exempt.atomBondOverlaps).toContainEqual([3, 0]);
    expect(exempt.collinearBondOverlaps).toEqual(raw.collinearBondOverlaps);
    expect(exempt.collinearBondOverlaps).toEqual([[0, 1]]);
    expect(exempt.hardDefects).toBe(raw.hardDefects - 1);
    expect(exempt.passes).toBe(false);
    expect(exempt.passesRelaxed).toBe(false);
  });

  it("skips bridged ring angles but keeps planar limits on fused blocks in the same graph", () => {
    const source = testMoleculeFromSmiles("C1CC2CCC1C2");
    const indices = new Map(source.atoms.map((a, i) => [a.id, i]));
    const bonds = source.bonds.map(b => ({ from: indices.get(b.fromAtomId)!, to: indices.get(b.toAtomId)! }));
    const q = evaluateLayoutQuality(source.atoms, bonds);
    expect(q.hasBridgedRings).toBe(true);
    expect(q.rings.every(r => r.maxAngleError === undefined)).toBe(true);
    const fused = testMoleculeFromSmiles("C1CCC2CCCCC2C1");
    const ids = new Map(fused.atoms.map((a, i) => [a.id, i + source.atoms.length]));
    const mixed = evaluateLayoutQuality([...source.atoms, ...fused.atoms.map(a => ({ ...a, x: a.x + 100 }))],
      [...bonds, ...fused.bonds.map(b => ({ from: ids.get(b.fromAtomId)!, to: ids.get(b.toAtomId)! }))]);
    expect(mixed.rings.filter(r => r.atoms.some(i => i >= source.atoms.length)).every(r => r.maxAngleError !== undefined)).toBe(true);
    expect(mixed.rings.some(r => (r.maxAngleError ?? 0) > 10)).toBe(true);
    expect(mixed.passes).toBe(false);
  });
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

  it("accepts a cubane projection with distorted cage bonds but no hard defects", () => {
    const atoms = [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 },
      { x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
    const bonds = [...cycle(4), ...cycle(4).map(b => ({ from: b.from + 4, to: b.to + 4 })),
      ...Array.from({ length: 4 }, (_, from) => ({ from, to: from + 4 }))];
    const quality = evaluateLayoutQuality(atoms, bonds);
    // Cage bond lengths are projection conventions, so only hard defects veto this block.
    expect(quality.passes).toBe(true);
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
