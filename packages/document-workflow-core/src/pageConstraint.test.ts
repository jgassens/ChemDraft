import { describe, expect, it } from "vitest";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { ParsedMolfileGraph } from "@chemdraft/clipboard-adapter";
import { moleculeGeometryFromAtoms, scaleParsedMolfileAtoms } from "./molecule";
import { PAGE_CONSTRAINT_EPSILON_PX, pageConstrainedShift } from "./pageConstraint";

const page = { width: 600, height: 400 };

describe("pageConstrainedShift", () => {
  it("leaves bounds that are already on the page alone", () => {
    expect(pageConstrainedShift(page, { x: 10, y: 20, width: 100, height: 50 })).toEqual({ x: 0, y: 0 });
    expect(pageConstrainedShift(page, { x: 0, y: 0, width: 600, height: 400 })).toEqual({ x: 0, y: 0 });
  });

  it("pulls bounds hanging over any edge back onto the page", () => {
    expect(pageConstrainedShift(page, { x: 550, y: 380, width: 100, height: 50 })).toEqual({ x: -50, y: -30 });
    expect(pageConstrainedShift(page, { x: -40, y: -15, width: 100, height: 50 })).toEqual({ x: 40, y: 15 });
    expect(pageConstrainedShift(page, { x: -40, y: 380, width: 100, height: 50 })).toEqual({ x: 40, y: -30 });
  });

  it("aligns bounds larger than the page with the page's top-left, per axis", () => {
    expect(pageConstrainedShift(page, { x: 100, y: 100, width: 800, height: 500 })).toEqual({ x: -100, y: -100 });
    // Only the width exceeds the page: x goes to 0, y is still kept inside.
    expect(pageConstrainedShift(page, { x: -50, y: 370, width: 700, height: 50 })).toEqual({ x: 50, y: -20 });
  });

  it("ignores floating-point noise unless one axis really moves, then shifts both exactly", () => {
    const noise = PAGE_CONSTRAINT_EPSILON_PX / 2;
    expect(pageConstrainedShift(page, { x: -noise, y: 350 + noise, width: 100, height: 50 })).toEqual({ x: 0, y: 0 });
    expect(pageConstrainedShift(page, { x: -PAGE_CONSTRAINT_EPSILON_PX, y: 0, width: 100, height: 50 })).toEqual({ x: 0, y: 0 });
    const shift = pageConstrainedShift(page, { x: -noise, y: 360, width: 100, height: 50 });
    expect(shift.x).toBeCloseTo(noise, 12);
    expect(shift.y).toBe(-10);
  });
});

describe("structure paste uses the shared page rule", () => {
  const graph = (points: Array<[number, number]>): ParsedMolfileGraph => ({
    format: "molfile-v2000",
    atoms: points.map(([x, y], index) => ({ id: `a${index}`, element: "C", x, y, formalCharge: 0 })),
    bonds: points.slice(1).map((_, index) => ({ id: `b${index}`, fromAtomId: `a${index}`, toAtomId: `a${index + 1}`, order: "single" })),
    warnings: []
  });
  const nativePage = (width: number, height: number) => ({ id: "page", width, height }) as unknown as ChemDraftDocument["pages"][number];

  it.each([
    ["inside the page", { x: 300, y: 200 }],
    ["over the right and bottom edges", { x: 595, y: 398 }],
    ["over the left and top edges", { x: 2, y: 1 }]
  ])("matches the unconstrained placement plus pageConstrainedShift (%s)", (_case, point) => {
    const parsed = graph([[0, 0], [1.5, 0], [2.25, 1.3]]);
    const target = nativePage(600, 400);
    const free = scaleParsedMolfileAtoms(parsed, point, target, 30, false);
    const shift = pageConstrainedShift(target, moleculeGeometryFromAtoms(free));
    const constrained = scaleParsedMolfileAtoms(parsed, point, target, 30);
    expect(constrained).toEqual(free.map((atom) => ({ ...atom, x: atom.x + shift.x, y: atom.y + shift.y })));
    const bounds = moleculeGeometryFromAtoms(constrained);
    expect(bounds.x).toBeGreaterThanOrEqual(-PAGE_CONSTRAINT_EPSILON_PX);
    expect(bounds.y).toBeGreaterThanOrEqual(-PAGE_CONSTRAINT_EPSILON_PX);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(600 + PAGE_CONSTRAINT_EPSILON_PX);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(400 + PAGE_CONSTRAINT_EPSILON_PX);
  });

  it("does not move a structure that overhangs by less than the epsilon", () => {
    const parsed = graph([[0, 0], [1.5, 0]]);
    const target = nativePage(600, 400);
    const free = scaleParsedMolfileAtoms(parsed, { x: 300, y: 200 }, target, 30, false);
    const bounds = moleculeGeometryFromAtoms(free);
    // A page whose right edge sits just inside the structure's bounds.
    const tight = nativePage(bounds.x + bounds.width - PAGE_CONSTRAINT_EPSILON_PX / 2, 400);
    expect(scaleParsedMolfileAtoms(parsed, { x: 300, y: 200 }, tight, 30)).toEqual(free);
  });
});
