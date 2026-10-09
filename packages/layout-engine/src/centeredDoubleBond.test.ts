import { describe, expect, it } from "vitest";
import {
  createEmptyDocument,
  nativeDrawingStyleFromObjectStyle,
  type MoleculeObject,
  type Point
} from "@chemdraft/chem-core";
import {
  doubleBondRendersSymmetric,
  nativeMultipleBondGapPx,
  planPageSvgRender,
  type PageSvgElementFragment
} from "./index";
import { elementFragments } from "./testing";

type Side = "left" | "right" | "center" | undefined;
const rise = 30 * Math.sqrt(3);

function chain(side: Side, branch = false): MoleculeObject {
  return {
    id: "m", type: "molecule", x: 0, y: 0, width: 180, height: 150, rotation: 0,
    style: {}, structureFormat: "smiles", structure: "C/C=C/C", superatoms: [], rGroups: [],
    atoms: [
      { id: "a", element: "C", x: 30, y: 80 + rise, formalCharge: 0 },
      { id: "b", element: "C", x: 60, y: 80, formalCharge: 0 },
      { id: "c", element: "C", x: 120, y: 80, formalCharge: 0 },
      { id: "d", element: "C", x: 150, y: 80 - rise, formalCharge: 0 },
      ...(branch ? [{ id: "e", element: "C", x: 30, y: 80 - rise, formalCharge: 0 }] : [])
    ],
    bonds: [
      { id: "ab", fromAtomId: "a", toAtomId: "b", order: "single" },
      { id: "bc", fromAtomId: "b", toAtomId: "c", order: "double",
        ...(side ? { display: { doubleBondSide: side } } : {}) },
      { id: "cd", fromAtomId: "c", toAtomId: "d", order: "single" },
      ...(branch ? [{ id: "be", fromAtomId: "b", toAtomId: "e", order: "single" as const }] : [])
    ]
  };
}

function lines(molecule: MoleculeObject): PageSvgElementFragment[] {
  const page = createEmptyDocument().pages[0];
  page.objects = [molecule];
  return planPageSvgRender(page).fragments.flatMap(elementFragments).filter((fragment) =>
    fragment.tag === "line" && String(fragment.attrs.class).startsWith("native-bond-line")
  );
}

function endpoints(line: PageSvgElementFragment): [Point, Point] {
  return [
    { x: Number(line.attrs.x1), y: Number(line.attrs.y1) },
    { x: Number(line.attrs.x2), y: Number(line.attrs.y2) }
  ];
}

/** Distance to the FINITE rendered stroke axis: an intersection with its extension is insufficient. */
function distanceToSegment(point: Point, line: PageSvgElementFragment): number {
  const [start, end] = endpoints(line);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
}

describe("explicit centered double bond geometry", () => {
  it.each([false, true])("joins both lines at 120 degree corners (branched: %s)", (branch) => {
    const molecule = chain("center", branch);
    const before = JSON.stringify(molecule);
    const rendered = lines(molecule);
    const doubles = rendered.filter((line) => line.attrs["data-bond-id"] === "bc");
    expect(doubles).toHaveLength(2);
    const style = nativeDrawingStyleFromObjectStyle(molecule.style);
    const halfGap = nativeMultipleBondGapPx(style) / 2;
    for (const [index, line] of doubles.entries()) {
      const [start, end] = endpoints(line);
      expect(start.y).toBeCloseTo(80 + (index === 0 ? halfGap : -halfGap), 8);
      expect(end.y).toBe(start.y);
      for (const [endpoint, ids] of [[start, ["ab", "be"]], [end, ["cd"]]] as const) {
        const neighbors = rendered.filter((neighbor) => (ids as readonly string[]).includes(String(neighbor.attrs["data-bond-id"])));
        // Exactly on a finite stroke, stronger than the requested half-stroke tolerance.
        expect(Math.min(...neighbors.map((neighbor) => distanceToSegment(endpoint, neighbor)))).toBeLessThan(1e-8);
        expect(Math.min(...neighbors.map((neighbor) => distanceToSegment(endpoint, neighbor))))
          .toBeLessThanOrEqual(style.bondStrokeWidthPx / 2);
      }
      // Exact centreline miters: neither centered stroke extends past the chosen junction.
      expect(Math.abs(start.x - 60)).toBeCloseTo(halfGap / Math.sqrt(3), 8);
      expect(Math.abs(end.x - 120)).toBeCloseTo(halfGap / Math.sqrt(3), 8);
    }
    // The outer neighbour terminates at the outer double line, without a protruding tail.
    const right = rendered.find((line) => line.attrs["data-bond-id"] === "cd")!;
    expect(endpoints(right)[0]).toEqual(endpoints(doubles[0])[1]);
    if (branch) {
      const left = rendered.filter((line) => ["ab", "be"].includes(String(line.attrs["data-bond-id"])));
      // Each side uses the real forward ray of its nearer neighbour; neither needs extension.
      expect(left.find((line) => line.attrs["data-bond-id"] === "ab")!.attrs.x2).toBe(60);
      expect(left.find((line) => line.attrs["data-bond-id"] === "be")!.attrs.x1).toBe(60);
    }
    expect(JSON.stringify(molecule)).toBe(before);
    expect(doubleBondRendersSymmetric(molecule.atoms[1], molecule.atoms[2], molecule, molecule.bonds[1], undefined)).toBe(true);
  });

  it("is independent of bond traversal order", () => {
    const molecule = chain("center", true);
    const signature = (m: MoleculeObject) => lines(m).map((line) =>
      [line.attrs["data-bond-id"], ...endpoints(line)]
    ).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(signature({ ...molecule, bonds: [...molecule.bonds].reverse() })).toEqual(signature(molecule));
  });

  it.each([0, 0.0001])("bevels parallel/acute neighbours without a long miter (%s radians)", (angle) => {
    const molecule = chain("center");
    molecule.atoms[0] = { ...molecule.atoms[0], x: 0, y: 80 + 60 * Math.sin(angle) };
    const rendered = lines(molecule);
    const doubles = rendered.filter((line) => line.attrs["data-bond-id"] === "bc");
    const neighbors = rendered.filter((line) => line.attrs["data-bond-id"] === "ab");
    for (const line of doubles) {
      const start = endpoints(line)[0];
      expect(start.x).toBe(60);
      expect(Math.min(...neighbors.map((neighbor) => distanceToSegment(start, neighbor)))).toBeLessThan(1e-8);
    }
    for (const neighbor of neighbors) {
      expect(Math.max(...endpoints(neighbor).map((point) => point.x))).toBeLessThanOrEqual(60);
    }
  });

  it.each([37, 90, 180])("keeps finite-stroke joins after rotating the graph %s degrees", (degrees) => {
    const molecule = chain("center", true);
    molecule.style = { multipleBondGapPx: 8, bondStrokeWidthPx: 1 };
    const angle = degrees * Math.PI / 180;
    molecule.atoms = molecule.atoms.map((atom) => ({
      ...atom,
      x: atom.x * Math.cos(angle) - atom.y * Math.sin(angle),
      y: atom.x * Math.sin(angle) + atom.y * Math.cos(angle)
    }));
    const rendered = lines(molecule);
    for (const line of rendered.filter((candidate) => candidate.attrs["data-bond-id"] === "bc")) {
      for (const point of endpoints(line)) {
        expect(Math.min(...rendered.filter((candidate) => candidate.attrs["data-bond-id"] !== "bc")
          .map((neighbor) => distanceToSegment(point, neighbor)))).toBeLessThan(1e-8);
      }
    }
  });

  it("uses the existing gap setting and keeps terminal ends on the atom planes", () => {
    const molecule = chain("center");
    molecule.atoms = molecule.atoms.slice(1, 3);
    molecule.bonds = [molecule.bonds[1]];
    molecule.style = { bondSpacingMode: "percent", bondSpacingPercent: 20, bondLengthPx: 60 };
    const halfGap = nativeMultipleBondGapPx(nativeDrawingStyleFromObjectStyle(molecule.style)) / 2;
    expect(lines(molecule).map(endpoints)).toEqual([
      [{ x: 60, y: 80 + halfGap }, { x: 120, y: 80 + halfGap }],
      [{ x: 60, y: 80 - halfGap }, { x: 120, y: 80 - halfGap }]
    ]);
  });

  it("retains existing label clearance at a labelled end, including when it has a neighbour", () => {
    const molecule = chain("center");
    molecule.atoms[2] = { ...molecule.atoms[2], element: "N" };
    const doubles = lines(molecule).filter((line) => line.attrs["data-bond-id"] === "bc");
    const legacy = chain("left");
    legacy.atoms[2] = molecule.atoms[2];
    const primary = lines(legacy).find((line) => line.attrs["data-bond-id"] === "bc")!;
    for (const line of doubles) {
      expect(line.attrs.x2).toBe(primary.attrs.x2);
      expect(Number(line.attrs.x2)).toBeLessThan(120);
    }
    expect(lines(molecule).find((line) => line.attrs["data-bond-id"] === "cd")!.attrs.x1)
      .toBe(lines(legacy).find((line) => line.attrs["data-bond-id"] === "cd")!.attrs.x1);
  });

  it.each(["left", "right", undefined] as const)("keeps legacy %s coordinates byte-identical", (side) => {
    const molecule = chain(side);
    const doubles = lines(molecule).filter((line) => line.attrs["data-bond-id"] === "bc");
    const offset = side === "right" ? -4.8 : 4.8;
    expect(JSON.stringify(doubles.map(endpoints))).toBe(JSON.stringify([
      [{ x: 60, y: 80 }, { x: 120, y: 80 }],
      [{ x: 64.5, y: 80 + offset }, { x: 115.5, y: 80 + offset }]
    ]));
    expect(lines(molecule).find((line) => line.attrs["data-bond-id"] === "ab")!.attrs.x2).toBe(60);
    expect(lines(molecule).find((line) => line.attrs["data-bond-id"] === "cd")!.attrs.x1).toBe(120);
  });
});
