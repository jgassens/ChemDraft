import { createHash } from "node:crypto";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";
import { planPageSvgRender } from "./index";
import { sketchRegressionMolecule } from "./sketchRegression.fixture";
import { moleculeSketchTickPath } from "./sketchTicks";
import { elementFragments } from "./testing";

const render = (object: MoleculeObject) => planPageSvgRender({
  ...createEmptyDocument({ now: "2026-01-01T00:00:00.000Z" }).pages[0]!, objects: [object]
});
const fragments = (object: MoleculeObject) => render(object).fragments.flatMap(elementFragments);
const marks = (object: MoleculeObject) => fragments(object).filter((f) => f.attrs.class === "native-molecule-sketch");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const points = (d: unknown) => {
  const numbers = String(d).match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  return Array.from({ length: numbers.length / 2 }, (_, i) => ({ x: numbers[2 * i]!, y: numbers[2 * i + 1]! }));
};

function tickMolecule(style: "hashed" | "dashed", seed = 7, roughness = 1.25, length = 60, label = false) {
  const object = sketchRegressionMolecule(true);
  object.atoms = object.atoms.slice(0, 2);
  object.atoms[1] = { ...object.atoms[1]!, x: 40 + length, element: label ? "N" : "C" };
  object.bonds = [{ ...object.bonds[0]!, display: { bondStyle: style } }];
  object.style.visualEffects = [{ kind: "sketch", seed, roughness, bowing: 1 }];
  return object;
}

describe("seeded sketch hash/dash ink", () => {
  for (const style of ["hashed", "dashed"] as const) {
    it(`${style}: deterministic, seed-sensitive, with no clean underdrawing or chemistry changes`, () => {
      const object = tickMolecule(style);
      const before = JSON.stringify(object);
      expect(render(object)).toEqual(render(structuredClone(object)));
      expect(marks(object)).not.toEqual(marks(tickMolecule(style, 8)));
      expect(marks(object).length).toBeGreaterThan(1);
      expect(marks(object).every((f) => f.attrs.stroke === "none" && f.attrs.fill === "#111111")).toBe(true);
      expect(fragments(object).some((f) => f.attrs.class === "native-bond-hash" || f.attrs["stroke-dasharray"])).toBe(false);
      expect(JSON.stringify(object)).toBe(before);
      const off = structuredClone(object); off.style.visualEffects = [];
      const targets = (o: MoleculeObject) => fragments(o).filter((f) => String(f.attrs.class).includes("hit-target") || f.attrs.class === "native-bond-hover-decorator");
      expect(targets(object)).toEqual(targets(off));
    });

    it(`${style}: zero roughness uses precisely the unjittered source marks`, () => {
      const object = tickMolecule(style, 7, 0);
      const off = structuredClone(object); off.style.visualEffects = [];
      const clean = fragments(off).filter((f) => f.attrs.class === "native-bond-hash");
      if (style === "hashed") {
        const rounded = (value: unknown) => Number(Number(value).toFixed(3));
        expect(marks(object).map((f) => f.attrs.d)).toEqual(clean.map((f) =>
          `M ${rounded(f.attrs.x1)} ${rounded(f.attrs.y1)} L ${rounded(f.attrs.x2)} ${rounded(f.attrs.y2)}`
        ));
      } else {
        expect(marks(object).map((f) => f.attrs.d)).toEqual(Array.from({ length: 8 }, (_, i) =>
          `M ${40 + i * 8} 40 L ${Math.min(100, 40 + i * 8 + 4.4)} 40`
        ));
      }
      expect(marks(object).every((f) => f.attrs.fill === "none")).toBe(true);
    });

    it(`${style}: control hulls never touch, widen monotonically for hashes, and respect label cutoffs`, () => {
      for (const length of [6, 12, 28, 60, 120]) {
        for (const label of [false, true]) {
          for (const roughness of [0.1, 1.25, 5]) {
            for (const seed of [1, 7, 23, 91]) {
              const object = tickMolecule(style, seed, roughness, length, label);
              const hit = fragments(object).find((f) => f.attrs.class === "native-bond-hit-target");
              if (!hit) continue; // A bond completely hidden by a label has no visible ink.
              let previousMaxX = -Infinity;
              let previousWidth = 0;
              for (const mark of marks(object)) {
                const hull = points(mark.attrs.d);
                const minX = Math.min(...hull.map((p) => p.x));
                const maxX = Math.max(...hull.map((p) => p.x));
                expect(minX).toBeGreaterThan(previousMaxX);
                expect(minX).toBeGreaterThanOrEqual(Number(hit.attrs.x1) - 0.001);
                expect(maxX).toBeLessThanOrEqual(Number(hit.attrs.x2) + 0.001);
                previousMaxX = maxX;
                if (style === "hashed") {
                  const width = Math.max(...hull.map((p) => p.y)) - Math.min(...hull.map((p) => p.y));
                  // Very short native hashes already have equal widths (the pen is wider
                  // than their nominal flare); never reverse either profile.
                  expect(width).toBeGreaterThanOrEqual(previousWidth - 0.001);
                  previousWidth = width;
                }
              }
            }
          }
        }
      }
    });
  }

  it("keeps disjoint ink cells on rotated and reversed bonds", () => {
    for (const style of ["hashed", "dashed"] as const) {
      for (const degrees of [-135, -45, 90, 180]) {
        const radians = degrees * Math.PI / 180;
        const ux = Math.cos(radians), uy = Math.sin(radians);
        const object = tickMolecule(style);
        object.atoms[1] = { ...object.atoms[1]!, x: 40 + 60 * ux, y: 40 + 60 * uy };
        let previousEnd = -Infinity;
        for (const mark of marks(object)) {
          const distances = points(mark.attrs.d).map((p) => (p.x - 40) * ux + (p.y - 40) * uy);
          expect(Math.min(...distances)).toBeGreaterThan(previousEnd);
          expect(Math.min(...distances)).toBeGreaterThanOrEqual(-0.002);
          expect(Math.max(...distances)).toBeLessThanOrEqual(60.002);
          previousEnd = Math.max(...distances);
        }
      }
    }
  });

  it("replaces a joined terminal hash polygon with one bounded pen mark", () => {
    const object = tickMolecule("hashed");
    object.style.bondLengthPx = 28;
    object.style.bondHashSpacingPx = 9;
    object.atoms = [
      { ...object.atoms[0]!, x: 275.1499818530336, y: 337.37075656112074 },
      { ...object.atoms[1]!, x: 292.3483233769756, y: 359.4537761410923 },
      { id: "next", element: "C", x: 320.3566949143234, y: 359.68028607004834, formalCharge: 0 }
    ];
    object.bonds.push({ id: "next-bond", fromAtomId: "b", toAtomId: "next", order: "single" });
    const off = structuredClone(object); off.style.visualEffects = [];
    const clean = fragments(off).filter((f) => f.attrs.class === "native-bond-hash");
    expect(clean).toHaveLength(5);
    expect(clean[4]!.tag).toBe("polygon");
    const ink = marks(object).filter((f) => f.attrs.fill !== "none");
    expect(ink).toHaveLength(5);
    const ux = (object.atoms[1]!.x - object.atoms[0]!.x) / 28;
    const uy = (object.atoms[1]!.y - object.atoms[0]!.y) / 28;
    let previousEnd = -Infinity;
    for (const mark of ink) {
      const distances = points(mark.attrs.d).map((p) => (p.x - object.atoms[0]!.x) * ux + (p.y - object.atoms[0]!.y) * uy);
      expect(Math.min(...distances)).toBeGreaterThan(previousEnd);
      previousEnd = Math.max(...distances);
    }
    expect(fragments(object).some((f) => f.attrs.class === "native-bond-hash")).toBe(false);
  });

  it("keeps angular, relative length, axial and weight jitter independent of mark length", () => {
    const centerline = (length: number, roughness: number) => {
      const path = moleculeSketchTickPath({
        source: { x1: 50 - length / 2, y1: 0, x2: 50 + length / 2, y2: 0 },
        axis: { x1: 0, y1: 0, x2: 100, y2: 0 }, cellStart: 0, cellEnd: 100,
        lengthVariation: length * 0.15, identity: "bond:0", hashed: false
      }, { seed: 7, roughness, bowing: 1, color: "#111111", strokeWidth: 1.5 });
      const p = points(path.d);
      const start = { x: (p[0]!.x + p[7]!.x) / 2, y: (p[0]!.y + p[7]!.y) / 2 };
      const end = { x: (p[3]!.x + p[4]!.x) / 2, y: (p[3]!.y + p[4]!.y) / 2 };
      return {
        angle: Math.atan2(end.y - start.y, end.x - start.x),
        ratio: Math.hypot(end.x - start.x, end.y - start.y) / length,
        shift: (start.x + end.x) / 2 - 50,
        weights: [Math.hypot(p[0]!.x - p[7]!.x, p[0]!.y - p[7]!.y), Math.hypot(p[3]!.x - p[4]!.x, p[3]!.y - p[4]!.y)]
      };
    };
    const short = centerline(4, 1.25), long = centerline(12, 1.25), half = centerline(12, 0.625);
    expect(short.angle).toBeCloseTo(long.angle, 3);
    expect(short.ratio).toBeCloseTo(long.ratio, 3);
    expect(short.shift).toBeCloseTo(long.shift, 3);
    expect(short.weights[0]).toBeCloseTo(long.weights[0]!, 2);
    expect(short.weights[1]).toBeCloseTo(long.weights[1]!, 2);
    expect(Math.abs(long.angle)).toBeLessThanOrEqual(7.1 * Math.PI / 180);
    expect(long.ratio).toBeGreaterThanOrEqual(0.85);
    expect(long.ratio).toBeLessThanOrEqual(1.15);
    expect(Math.abs(long.shift)).toBeLessThanOrEqual(0.65);
    expect(half.angle).toBeCloseTo(long.angle / 2, 3);
    expect(half.ratio - 1).toBeCloseTo((long.ratio - 1) / 2, 3);
  });

  it("matches byte digests captured from the renderer BEFORE this change", () => {
    expect(digest(render(sketchRegressionMolecule(false)))).toBe("dee8f9e869c7490ada2efce7ae5ae3fec5d374da30ac8662b5c0d67a9ee8311a");
    const noTicks = sketchRegressionMolecule(true); noTicks.bonds = noTicks.bonds.slice(2);
    expect(digest(render(noTicks))).toBe("ba947d3584eb14f936251da4b6b661c93d6eb69e9e680dbbec2a7d77a52d9aa4");
    // Ordinary/wedge/double/triple/ring strokes AFTER hashes/dashes retain their random stream.
    const mixed = marks(sketchRegressionMolecule(true)).flatMap((f) => String(f.attrs.d).split("M")
      .filter((p) => p.trim() && Number(p.trim().split(/\s+/)[1]) >= 100).map((p) => "M" + p));
    expect(digest(mixed)).toBe("bc78d74a2b4e99ddc72f2b374548a5fce2fc627486934420e9a6a1a0e765d4c6");
  });
});
