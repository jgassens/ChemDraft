import { describe, expect, it } from "vitest";
import { DocumentTextStyle, nativeTextStyleFromObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { reactionArrowVerticalExtent } from "@chemdraft/layout-engine";

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
    expect(first.above?.y).toBeLessThan(first.arrow.y);
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
    const condition = layout.above!;
    const plus = layout.pluses[0]!;
    const conditionSize = nativeTextObjectSizeForText(options.conditionText, DocumentTextStyle);
    const plusSize = nativeTextObjectSizeForText("+", DocumentTextStyle);

    expect(nativeTextStyleFromObjectStyle(condition.style)).toMatchObject(DocumentTextStyle);
    expect(nativeTextStyleFromObjectStyle(plus.style)).toMatchObject(DocumentTextStyle);
    expect(condition).toMatchObject({ width: conditionSize.width, height: conditionSize.height });
    expect(layout.arrow.width).toBeCloseTo(conditionSize.width + 11);
    expect(layout.molecules[1]!.x - layout.molecules[0]!.x).toBeCloseTo(40 + 48 + plusSize.width);
    const conditionStyle = nativeTextStyleFromObjectStyle(condition.style);
    expect(condition.y + conditionStyle.fontSizePx * conditionStyle.lineHeight).toBeCloseTo(
      120 + reactionArrowVerticalExtent("forward", layout.arrow.width).top - 0.35 * conditionStyle.fontSizePx
    );
    const page = layout.document.pages[0]!;
    expect(page.width).toBe(layout.molecules[2]!.x + 40 + 24);
    expect(page.layout).toMatchObject({ presetId: "custom", widthPx: page.width, heightPx: page.height });
    expect(options).toEqual(original);

    const textStyle = { fontSizePx: 24, fontWeight: 700 };
    const styled = layoutReactionScheme({ ...options, style: "document", textStyle });
    expect(styled.arrow.width).toBeGreaterThan(layout.arrow.width);
    for (const text of [styled.above!, ...styled.pluses]) {
      expect(nativeTextStyleFromObjectStyle(text.style)).toMatchObject({ ...DocumentTextStyle, ...textStyle });
    }
  });

  it("adapts legacy conditions before above lines without splitting punctuation or changing text", () => {
    const layout = layoutReactionScheme({
      reactants: [{ molecule: molecule("reactant"), bounds: bounds() }], products: [],
      arrowKind: "forward", conditionText: "H2SO4, heat", above: ["then stir; wait"],
      anchor: { x: 24, y: 120 }, gutter: 24, bondLength: 22, pagePadding: 24
    });
    expect(layout.above!.text).toBe("H2SO4, heat\nthen stir; wait");
    expect(layout.above!.spans.filter((span) => span.script === "subscript").map((span) => span.text)).toEqual(["2", "4"]);
    expect(nativeTextStyleFromObjectStyle(layout.above!.style)).toMatchObject({ fontSizePx: 14, textAlign: "center" });
  });

  it("fits all blocks and a wrapped formula caption with page padding, translating the scheme together", () => {
    const component = { molecule: molecule("reactant", 40, 80), bounds: bounds(40, 80) };
    const original = structuredClone(component);
    const layout = layoutReactionScheme({
      reactants: [component], products: [component], arrowKind: "equilibrium",
      above: ["Ti(OiPr)4", "(+)-DET", "t-BuOOH"], below: ["CH2Cl2", "−20 °C", "4 h"],
      caption: "Product isolated from CH2Cl2 after the reaction and characterized by the stated method.",
      textStyle: { fontSizePx: 15 },
      anchor: { x: 0, y: 0 }, gutter: 24, bondLength: 22, pagePadding: 24
    });
    const page = layout.document.pages[0]!;
    for (const object of page.objects) {
      expect(object.x).toBeGreaterThanOrEqual(24);
      expect(object.y).toBeGreaterThanOrEqual(24);
      expect(object.x + object.width).toBeLessThanOrEqual(page.width - 24 + 0.01);
      expect(object.y + object.height).toBeLessThanOrEqual(page.height - 24 + 0.01);
    }
    expect(layout.arrow.start.kind).toBe("point");
    if (layout.arrow.start.kind !== "point") throw new Error("Expected a point anchor");
    expect(layout.molecules[0]!.x + 40 + 24).toBe(layout.arrow.start.point.x);
    expect(layout.molecules[0]!.y + 40).toBe(layout.arrow.start.point.y);
    expect(layout.caption!.text).toContain("\n");
    expect(layout.caption!.spans.some((span) => span.script === "subscript")).toBe(true);
    expect(layout.caption!.y).toBeCloseTo(Math.max(
      ...layout.molecules.map((entry) => entry.y + entry.height), layout.below!.y + layout.below!.height
    ) + 0.8 * 15);
    const left = Math.min(...layout.molecules.map((entry) => entry.x));
    const right = Math.max(...layout.molecules.map((entry) => entry.x + entry.width));
    expect(layout.caption!.x + layout.caption!.width / 2).toBeCloseTo((left + right) / 2);
    expect(component).toEqual(original);
  });

  it("centres the caption using supplied visible molecule bounds, including label overhangs", () => {
    const layout = layoutReactionScheme({
      reactants: [{ molecule: molecule("reactant", 20, 20), bounds: bounds(80, 100) }],
      products: [], arrowKind: "forward", caption: "Product",
      anchor: { x: 24, y: 120 }, gutter: 24, bondLength: 22, pagePadding: 24
    });
    if (layout.arrow.end.kind !== "point") throw new Error("Expected a point anchor");
    expect(layout.caption!.x + layout.caption!.width / 2).toBeCloseTo((24 + layout.arrow.end.point.x) / 2);
    expect(layout.caption!.y).toBeCloseTo(170 + 0.8 * 14);
  });
});
