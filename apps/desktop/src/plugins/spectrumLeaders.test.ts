import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { annotationBondLines, estimateAnnotationTextWidth, layoutAtomAnnotationLabels, routeAtomAnnotationLeaders, type AnnotationLabelBox } from "@chemdraft/layout-engine";
import { describe, expect, it } from "vitest";

interface Point { x: number; y: number }
function visible(points: Point[]) {
  expect(points.length).toBeGreaterThanOrEqual(2);
  expect(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  expect(new Set(points.map(p => `${p.x},${p.y}`)).size).toBeGreaterThanOrEqual(2);
}

// Independently test closed segment intersections, including collinear overlap.
function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) - 1e-8 || Math.max(c.x, d.x) < Math.min(a.x, b.x) - 1e-8 ||
      Math.max(a.y, b.y) < Math.min(c.y, d.y) - 1e-8 || Math.max(c.y, d.y) < Math.min(a.y, b.y) - 1e-8) return false;
  return cross(a, b, c) * cross(a, b, d) <= 1e-8 && cross(c, d, a) * cross(c, d, b) <= 1e-8;
}

function boxCorners(box: AnnotationLabelBox): Point[] {
  return [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }];
}

function insideRing(point: Point, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Independent cycle oracle: shortest path after removing each bond, rather than the layout's
// planar face traversal. Covers both constituent rings of the fused naphthalene depiction.
function ringsOf(atoms: (Point & { index: number })[], bonds: { from: number; to: number }[]): Point[][] {
  const byIndex = new Map(atoms.map(atom => [atom.index, atom]));
  return bonds.flatMap(removed => {
    const paths = [[removed.from]], visited = new Set([removed.from]);
    for (const path of paths) {
      const last = path[path.length - 1];
      for (const bond of bonds) {
        if (bond === removed) continue;
        const next = bond.from === last ? bond.to : bond.to === last ? bond.from : undefined;
        if (next === undefined || visited.has(next)) continue;
        if (next === removed.to) return [[...path, next].map(index => byIndex.get(index)!)];
        visited.add(next);
        paths.push([...path, next]);
      }
    }
    return [];
  });
}

describe("spectrum structure leaders", () => {
  it.each([
    { name: "toluene", smiles: "Cc1ccccc1", annotations: [21.40, 142.14, 128.54, 129.01, 125.60, 128.54, 129.01] },
    { name: "naphthalene", smiles: "c1ccc2ccccc2c1", annotations: [127.70, 126.43, 125.61, 132.73, 127.70, 126.43, 125.61, 127.70, 132.73, 126.43] }
  ].flatMap(molecule => [1, 2].flatMap(size => [1, -1].map(mirror => ({ ...molecule, size, mirror })))))(
    "connects $name labels to their actual edges outside every ring at panel scale $size (y scale $mirror)", ({ smiles, annotations, size, mirror }) => {
      const depiction = depictSmiles2D(smiles);
      // Display regressions using the reported shift strings; these tests do not predict shifts.
      const atoms = depiction.atoms.map((atom, index) => ({ ...atom, y: atom.y * mirror, index, annotation: annotations[index].toFixed(2) }));
      const bonds = depiction.bonds.map(bond => ({ ...bond, order: bond.order === "double" ? 2 : 1 }));
      const placement = layoutAtomAnnotationLabels({ atoms, bonds, width: 340 * size, height: 260 * size });
      const byIndex = new Map(placement.atoms.map(atom => [atom.index, atom]));
      const bondLines = bonds.flatMap(bond => annotationBondLines(byIndex.get(bond.from)!, byIndex.get(bond.to)!, bond.order, placement.fitScale));
      const rings = ringsOf(placement.atoms, bonds);
      const leaders = routeAtomAnnotationLeaders({ ...placement, bonds, bondLines });
      for (const leader of leaders) {
        const { label, points } = leader;
        const end = points[points.length - 1];
        const edgeDistance = Math.min(...boxCorners(label).map((a, i, corners) => {
          const b = corners[(i + 1) % 4];
          const t = Math.max(0, Math.min(1, ((end.x - a.x) * (b.x - a.x) + (end.y - a.y) * (b.y - a.y)) /
            ((b.x - a.x) ** 2 + (b.y - a.y) ** 2)));
          return Math.hypot(end.x - a.x - t * (b.x - a.x), end.y - a.y - t * (b.y - a.y));
        }));
        expect(edgeDistance, `atom ${leader.index}: leader must reach the label edge`).toBeLessThan(1e-6);
        expect(points[0]).toEqual(expect.objectContaining({ x: byIndex.get(leader.index)!.x, y: byIndex.get(leader.index)!.y }));
        const atom = byIndex.get(leader.index)!;
        const nearest = { x: Math.max(label.x, Math.min(label.x + label.width, atom.x)),
          y: Math.max(label.y, Math.min(label.y + label.height, atom.y)) };
        expect(Math.hypot(nearest.x - atom.x, nearest.y - atom.y), `label ${leader.index} needlessly distant`)
          .toBeLessThan(45 * placement.fitScale);
        for (const ring of rings) {
          for (const point of [...boxCorners(label), { x: label.x + label.width / 2, y: label.y + label.height / 2 }]) {
            expect(insideRing(point, ring), `label ${leader.index} inside ring`).toBe(false);
          }
        }
        const clearance = 2 * placement.fitScale;
        const padded = { x: label.x - clearance, y: label.y - clearance, width: label.width + clearance * 2, height: label.height + clearance * 2 };
        for (const line of bondLines) {
          const a = { x: line.x1, y: line.y1 }, b = { x: line.x2, y: line.y2 };
          const contains = (p: Point) => p.x >= padded.x && p.x <= padded.x + padded.width && p.y >= padded.y && p.y <= padded.y + padded.height;
          expect(contains(a) || contains(b) || boxCorners(padded).some((p, i, corners) => intersects(a, b, p, corners[(i + 1) % 4])),
            `label ${leader.index} touches a bond`).toBe(false);
        }
      }
    }
  );
  it.each([
    { name: "toluene", smiles: "Cc1ccccc1" },
    { name: "naphthalene", smiles: "c1ccc2ccccc2c1" },
    { name: "pyridine with an atom label", smiles: "c1ccncc1" }
  ].flatMap(molecule => [1, 2].flatMap(size => [ { ...molecule, size, mirror: 1 }, { ...molecule, size, mirror: -1 } ])))(
    "routes $name from SMILES (y scale $mirror, panel scale $size) without crossing bonds, text or other leaders", ({ smiles, mirror, size }) => {
    const depiction = depictSmiles2D(smiles);
    // These are synthetic annotations to exercise layout, not predictions. Preserve OCL's atom
    // indices/coordinates, as the plugin's declarative structure and panel layout do.
    const atoms = depiction.atoms.map((atom, index) => ({ ...atom, y: atom.y * mirror, index, annotation: `${120 + index}.00` }));
    const bonds = depiction.bonds.map(bond => ({ ...bond, order: bond.order === "double" ? 2 : 1 }));
    const placement = layoutAtomAnnotationLabels({ atoms, bonds, width: 340 * size, height: 260 * size });
    const byIndex = new Map(placement.atoms.map(atom => [atom.index, atom]));
    const bondLines = bonds.flatMap(bond => annotationBondLines(byIndex.get(bond.from)!, byIndex.get(bond.to)!, bond.order, placement.fitScale));
    const before = structuredClone(placement);
    const input = { ...placement, bonds, bondLines };
    const leaders = routeAtomAnnotationLeaders(input);
    expect(placement).toEqual(before);
    expect(leaders.map(leader => leader.index)).toEqual(placement.labels.map(label => label.index));
    expect(routeAtomAnnotationLeaders(input)).toEqual(leaders);
    const segments = leaders.flatMap(leader => {
      visible(leader.points);
      expect(leader.crossesBonds, `unexpected fallback for atom ${leader.index}`).toBe(false);
      return leader.points.slice(1).map((b, i) => ({ index: leader.index, a: leader.points[i], b, initial: i === 0, terminal: i === leader.points.length - 2 }));
    });
    for (const segment of segments) {
      for (const bond of bonds) {
        let a = segment.a;
        // Only the first point may touch the leader's own atom.
        if (segment.initial && (bond.from === segment.index || bond.to === segment.index)) {
          a = { x: a.x + (segment.b.x - a.x) * 1e-5, y: a.y + (segment.b.y - a.y) * 1e-5 };
        }
        expect(intersects(a, segment.b, byIndex.get(bond.from)!, byIndex.get(bond.to)!),
          `leader ${segment.index} crosses bond ${bond.from}-${bond.to}`).toBe(false);
      }
      for (const line of bondLines) {
        let a = segment.a;
        if (segment.initial && Math.min(Math.hypot(line.x1 - a.x, line.y1 - a.y), Math.hypot(line.x2 - a.x, line.y2 - a.y)) <= 4 * placement.fitScale) {
          const fraction = Math.min(0.9, 4 * placement.fitScale / Math.hypot(segment.b.x - a.x, segment.b.y - a.y));
          a = { x: a.x + (segment.b.x - a.x) * fraction, y: a.y + (segment.b.y - a.y) * fraction };
        }
        expect(intersects(a, segment.b, { x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }), `leader ${segment.index} crosses stroke`).toBe(false);
      }
      const boxes = [
        ...leaders.map(leader => ({ ...leader.label, index: leader.index })),
        ...placement.atoms.filter(atom => atom.element !== "C").map(atom => {
          const width = estimateAnnotationTextWidth(atom.element, placement.atomFontSize) + 4 * placement.fitScale;
          return { index: undefined, x: atom.x - width / 2, y: atom.y - 12 * placement.fitScale,
            width, height: 24 * placement.fitScale };
        })
      ];
      for (const box of boxes) {
        const corners = [
          { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
          { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }
        ];
        // The final endpoint must touch its own box edge, but must never enter it.
        const end = segment.terminal && box.index === segment.index ? {
          x: segment.b.x + (segment.a.x - segment.b.x) * 1e-5,
          y: segment.b.y + (segment.a.y - segment.b.y) * 1e-5
        } : segment.b;
        expect(corners.some((p, i) => intersects(segment.a, end, p, corners[(i + 1) % 4])),
          `leader ${segment.index} crosses text`).toBe(false);
      }
      for (const other of segments) {
        if (other.index !== segment.index) expect(intersects(segment.a, segment.b, other.a, other.b),
          `leaders ${segment.index} and ${other.index} cross`).toBe(false);
      }
    }
  });

  it.each([true, false])("keeps every leader visible in a no-bond molecule (coincident: %s)", coincident => {
    const placement = layoutAtomAnnotationLabels({
      atoms: Array.from({ length: 10 }, (_, index) => ({ index, element: "C", x: coincident ? 0 : index * 20, y: 0, annotation: `${120 + index}.00` })),
      bonds: [], width: 340, height: 260
    });
    const leaders = routeAtomAnnotationLeaders({ ...placement, bonds: [], bondLines: [] });
    expect(leaders.map(l => l.index)).toEqual(placement.labels.map(l => l.index));
    for (const leader of leaders) { visible(leader.points); expect(leader.crossesBonds).toBe(false); }
  });

  // Original geometry, not a chemistry prediction: a cage projection surrounding one atom.
  function cage() {
    const atoms = [
      { index: 0, x: 0, y: 0, element: "C" }, { index: 1, x: 60, y: 0, element: "C" },
      ...[[-10, -10], [10, -10], [10, 10], [-10, 10]].map(([x, y], i) => ({ index: i + 2, x, y, element: "C" }))
    ];
    const bonds = [[2, 3], [3, 4], [4, 5], [5, 2], [0, 2], [0, 3], [0, 4], [0, 5]].map(([from, to]) => ({ from, to }));
    const byIndex = new Map(atoms.map(a => [a.index, a]));
    const bondLines = bonds.flatMap(b => annotationBondLines(byIndex.get(b.from)!, byIndex.get(b.to)!, 1));
    return { atoms, bonds, bondLines, fitScale: 1, atomFontSize: 15 };
  }

  it("uses a visible flagged fallback only for the atom enclosed by the cage", () => {
    const input = { ...cage(), labels: [
      { index: 0, x: -20, y: 35, width: 40, height: 16 },
      { index: 1, x: 80, y: -8, width: 40, height: 16 }
    ] };
    const leaders = routeAtomAnnotationLeaders(input);
    expect(leaders.map(l => l.crossesBonds)).toEqual([true, false]);
    for (const leader of leaders) visible(leader.points);
    expect(input.bondLines.some(line => intersects(leaders[0].points[0], leaders[0].points[1],
      { x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }))).toBe(true);
  });

  it("keeps the enclosed fallback visible when the expanded target touches the atom", () => {
    const gap = 1.5;
    const input = { ...cage(), labels: [{ index: 0, x: -40 - 2 * gap, y: -8, width: 40, height: 16 }] };
    const [leader] = routeAtomAnnotationLeaders(input);
    expect(leader.crossesBonds).toBe(true);
    expect(Math.hypot(leader.points[1].x, leader.points[1].y)).toBeGreaterThanOrEqual(2 * gap);
  });

  it("returns finite visible routes across seeded degenerate layouts", () => {
    let seed = 0x13c2026;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
    for (let i = 0; i < 240; i++) {
      const enclosed = i % 24 === 0;
      const base = enclosed ? cage() : {
        atoms: [{ index: 0, x: 0, y: 0, element: "C" },
          { index: 1, x: i % 2 ? 0 : 30, y: 0, element: "C" }],
        bonds: [], bondLines: [], fitScale: 1, atomFontSize: 15
      };
      const width = 4 + random() * 40, height = 4 + random() * 20;
      const labels = [{ index: 0, x: (random() - 0.7) * width, y: (random() - 0.7) * height, width, height }];
      const leaders = routeAtomAnnotationLeaders({ ...base, labels });
      expect(leaders).toHaveLength(1);
      for (const leader of leaders) {
        visible(leader.points);
        expect(Math.max(...leader.points.map(p => Math.hypot(p.x - leader.points[0].x, p.y - leader.points[0].y))))
          .toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("relocates an inaccessible label instead of crossing bonds for an exterior atom", () => {
    const input = { ...cage(), labels: [{ index: 1, x: -4, y: -4, width: 8, height: 8 }] };
    const before = structuredClone(input);
    const [leader] = routeAtomAnnotationLeaders(input);
    visible(leader.points);
    expect(leader.index).toBe(1);
    expect(leader.crossesBonds).toBe(false);
    expect([leader.label.x, leader.label.y]).not.toEqual([input.labels[0].x, input.labels[0].y]);
    expect(input).toEqual(before);
    for (let i = 1; i < leader.points.length; i++) {
      for (const line of input.bondLines) expect(intersects(leader.points[i - 1], leader.points[i],
        { x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 })).toBe(false);
    }
  });
});
