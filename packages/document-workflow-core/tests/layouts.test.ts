import { describe, expect, it } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";

import { layoutGrid, layoutReactionScheme, type LayoutBounds } from "../src/index";

function molecule(id: string, width = 40, height = 20): MoleculeObject {
  return {
    id, type: "molecule", x: 0, y: 0, width, height, rotation: 0, style: {},
    structureFormat: "smiles", structure: "C",
    atoms: [{ id: `${id}_a`, element: "C", x: 0, y: 0, formalCharge: 0 }],
    bonds: [], superatoms: [], rGroups: []
  };
}

function bounds(width = 40, height = 20): LayoutBounds {
  return { minX: 0, minY: 0, maxX: width, maxY: height };
}

function overlaps(left: { x: number; y: number; width: number; height: number }, right: typeof left): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x &&
    left.y < right.y + right.height && left.y + left.height > right.y;
}

describe("shared reaction and grid layout", () => {
  it("places a reaction deterministically at its anchor without molecule overlaps", () => {
    const options = {
      reactants: [{ molecule: molecule("reactant"), bounds: bounds() }],
      products: [{ molecule: molecule("product", 60, 30), bounds: bounds(60, 30) }],
      arrowKind: "forward" as const,
      conditionText: "H2SO4",
      anchor: { x: 80, y: 120 },
      gutter: 24,
      bondLength: 30,
      pagePadding: 24
    };
    const first = layoutReactionScheme(options);
    const second = layoutReactionScheme(options);

    expect(first.document).toEqual(second.document);
    expect(first.molecules[0]).toMatchObject({ x: 80, y: 110 });
    expect(first.arrow.start).toEqual({ kind: "point", point: { x: 144, y: 120 } });
    expect(overlaps(first.molecules[0]!, first.molecules[1]!)).toBe(false);
    expect(first.condition?.y).toBeLessThan(first.arrow.y);
  });

  it("positions grid cells from the anchor with labels below and no overlapping molecules", () => {
    const layout = layoutGrid({
      entries: [
        { molecule: molecule("one"), bounds: bounds(), label: "A" },
        { molecule: molecule("two", 60, 30), bounds: bounds(60, 30), label: "B" },
        { molecule: molecule("three"), bounds: bounds(), label: "C" }
      ],
      columns: 2,
      gutter: 16,
      anchor: { x: 40, y: 50 },
      pageWidth: 800
    });

    expect(layout.columns).toBe(2);
    expect(layout.rows).toBe(2);
    expect(layout.molecules[0]).toMatchObject({ x: 58, y: 55 });
    expect(layout.molecules.every((entry, index) => layout.molecules.slice(index + 1)
      .every((other) => !overlaps(entry, other)))).toBe(true);
    expect(layout.labels.every((label, index) => label.y > layout.molecules[index]!.y)).toBe(true);
  });
});
