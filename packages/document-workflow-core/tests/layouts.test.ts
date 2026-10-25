import { describe, expect, it } from "vitest";
import { DocumentTextStyle, nativeTextStyleFromObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";

import { layoutGrid, layoutReactionScheme, nativeTextObjectSizeForText, type LayoutBounds } from "../src/index";

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

  it("sizes document grid cells around wide labels and grows the page before placing text", () => {
    const entries = Array.from({ length: 6 }, (_, index) => ({
      molecule: molecule(`source_${index}`, 40, 300),
      bounds: bounds(40, 300),
      label: "A wide molecule caption"
    }));
    const original = structuredClone(entries);
    const options = { entries, columns: 2, gutter: 32, anchor: { x: 24, y: 24 }, pageWidth: 800 };
    const fit = layoutGrid(options);
    expect(layoutGrid({ ...options, style: "fit" }).document).toEqual(fit.document);
    const layout = layoutGrid({ ...options, style: "document" });
    const page = layout.document.pages[0]!;

    expect(page.layout).toMatchObject({ presetId: "custom", widthPx: page.width, heightPx: page.height });
    expect(page.height).toBeGreaterThan(fit.document.pages[0]!.height);
    expect(layout.labels[0]!.width).toBeGreaterThan(layout.molecules[0]!.width);
    expect(overlaps(layout.labels[0]!, layout.labels[1]!)).toBe(false);
    expect(layout.labels[1]!.x - layout.labels[0]!.x).toBeCloseTo(layout.labels[0]!.width + 32);
    expect(page.width).toBeCloseTo(48 + 2 * (layout.labels[0]!.width + 32));
    for (const [index, label] of layout.labels.entries()) {
      expect(nativeTextStyleFromObjectStyle(label.style)).toMatchObject(DocumentTextStyle);
      expect(label.y).toBe(layout.molecules[index]!.y + 308);
      expect(label.x).toBeGreaterThanOrEqual(24);
      expect(label.x + label.width).toBeLessThanOrEqual(page.width - 24);
      expect(label.y + label.height).toBeLessThanOrEqual(page.height - 24);
    }
    expect(entries).toEqual(original);
  });

  it("accepts a shared text style for grid labels and sizes cells with that style", () => {
    const textStyle = { ...DocumentTextStyle, fontSizePx: 28, fontStyle: "italic" as const };
    const label = "Wide caption";
    const size = nativeTextObjectSizeForText(label, textStyle);
    const layout = layoutGrid({
      entries: [{ molecule: molecule("source"), bounds: bounds(), label }],
      style: "document", textStyle, gutter: 16, anchor: { x: 40, y: 50 }, pageWidth: 800
    });
    expect(layout.labels[0]).toMatchObject({ width: size.width, height: size.height });
    expect(nativeTextStyleFromObjectStyle(layout.labels[0]!.style)).toMatchObject(textStyle);
    expect(layout.document.pages[0]!.width).toBe(80 + size.width + 16);
    expect(layout.document.pages[0]!.height).toBe(100 + 20 + 8 + size.height + 16);
  });

  it("uses document text metrics for reaction spacing, conditions and plus signs", () => {
    const options = {
      reactants: ["one", "two"].map((id) => ({ molecule: molecule(id), bounds: bounds() })),
      products: [{ molecule: molecule("product"), bounds: bounds() }],
      arrowKind: "forward" as const,
      conditionText: "room temperature",
      anchor: { x: 24, y: 120 }, gutter: 24, bondLength: 22, pagePadding: 24
    };
    const original = structuredClone(options);
    expect(layoutReactionScheme({ ...options, style: "fit" }).document)
      .toEqual(layoutReactionScheme(options).document);
    const layout = layoutReactionScheme({ ...options, style: "document" });
    const condition = layout.condition!;
    const plus = layout.pluses[0]!;
    const conditionSize = nativeTextObjectSizeForText(options.conditionText, DocumentTextStyle);
    const plusSize = nativeTextObjectSizeForText("+", DocumentTextStyle);

    expect(nativeTextStyleFromObjectStyle(condition.style)).toMatchObject(DocumentTextStyle);
    expect(nativeTextStyleFromObjectStyle(plus.style)).toMatchObject(DocumentTextStyle);
    expect(condition).toMatchObject({ width: conditionSize.width, height: conditionSize.height });
    expect(layout.arrow.width).toBeCloseTo(conditionSize.width + 48);
    expect(layout.molecules[1]!.x - layout.molecules[0]!.x).toBeCloseTo(40 + 48 + plusSize.width);
    expect(condition.y + condition.height).toBe(108);
    const page = layout.document.pages[0]!;
    expect(page.width).toBe(layout.molecules[2]!.x + 40 + 24);
    expect(page.layout).toMatchObject({ presetId: "custom", widthPx: page.width, heightPx: page.height });
    expect(options).toEqual(original);

    const textStyle = { fontSizePx: 24, fontWeight: 700 };
    const styled = layoutReactionScheme({ ...options, style: "document", textStyle });
    expect(styled.arrow.width).toBeGreaterThan(layout.arrow.width);
    for (const text of [styled.condition!, ...styled.pluses]) {
      expect(nativeTextStyleFromObjectStyle(text.style)).toMatchObject({ ...DocumentTextStyle, ...textStyle });
    }
  });
});
