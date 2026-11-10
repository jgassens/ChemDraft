import { describe, expect, it } from "vitest";
import { DocumentTextStyle, nativeTextStyleFromObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { moleculeInkBounds, reactionArrowHeadLengthPx,
  reactionArrowInkBounds, reactionSchemeDrawingMetrics } from "@chemdraft/layout-engine";

import { estimateNativeTextLineWidth, layoutGrid, layoutReactionScheme, layoutReactionSchemeAsync, nativeTextObjectSizeForText,
  type LayoutBounds } from "../src/index";

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
  it("preserves isotope, radical and nonstandard hydrogen annotations when choosing scheme labels", () => {
    const base = molecule("salt");
    const sodium = { id: "na", element: "Na", x: 0, y: 0, formalCharge: 1 };
    const hydroxide = { id: "o", element: "O", x: 22, y: 0, formalCharge: -1 };
    const variants: MoleculeObject["atoms"][] = [
      [{ ...sodium, isotope: 23 }, hydroxide], [sodium, { ...hydroxide, isotope: 18 }],
      [sodium, { ...hydroxide, markRadicals: 1 }], [sodium, { ...hydroxide, hydrogenCount: 0 }],
      [{ ...sodium, hydrogenCount: 1 }, hydroxide]
    ];
    for (const atoms of variants) {
      const result = layoutReactionScheme({ reactants: [{ molecule: { ...base, atoms } }], products: [],
        arrowKind: "forward", anchor: { x: 24, y: 120 }, gutter: 24, bondLength: 22, pagePadding: 24 });
      expect(result.molecules[0]!.atoms.map(({ x: _x, y: _y, ...atom }) => atom))
        .toEqual(atoms.map(({ x: _x, y: _y, ...atom }) => atom));
    }
  });
  it("shares a 1500 ms budget across products and yields before alignment", async () => {
    let now = 0, calls = 0, yields = 0;
    const result = await layoutReactionSchemeAsync({
      reactants: [{ molecule: molecule("r") }], products: ["p1", "p2", "p3"].map(id => ({ molecule: molecule(id) })),
      arrowKind: "forward", anchor: { x: 24, y: 120 }, gutter: 24, bondLength: 22, pagePadding: 24,
      alignmentScheduler: { now: () => now, yieldControl: async () => { yields++; } },
      alignProduct: (_references, _product, budget) => {
        expect(budget!.deadline).toBe(1500);
        expect(yields).toBeGreaterThan(calls);
        calls++; now += 1500;
        return undefined;
      }
    });
    expect(calls).toBe(1);
    expect(result.molecules).toHaveLength(4);
  });
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
    const ink = moleculeInkBounds(first.molecules[0]!);
    expect(ink.x).toBe(80);
    expect(ink.y + ink.height / 2).toBeCloseTo(120);
    expect(first.arrow.start.point!.x - Number(first.arrow.style.strokeWidth) / 2 - ink.x - ink.width).toBeCloseTo(1.25 * 30);
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
    const drawing = reactionSchemeDrawingMetrics(layout.molecules[0]!);

    expect(nativeTextStyleFromObjectStyle(condition.style)).toMatchObject(DocumentTextStyle);
    expect(nativeTextStyleFromObjectStyle(plus.style).fontSizePx).toBe(drawing.fontSizePx);
    expect(plus.width).toBe(drawing.plusSize);
    expect(plus.style.strokeWidth).toBe(drawing.strokeWidth);
    expect(condition).toMatchObject({ width: conditionSize.width, height: conditionSize.height });
    expect(layout.arrow.width).toBeCloseTo(estimateNativeTextLineWidth(options.conditionText,
      nativeTextStyleFromObjectStyle(condition.style)) + 2 * (reactionArrowHeadLengthPx + 0.25 * DocumentTextStyle.fontSizePx));
    const firstInk = moleculeInkBounds(layout.molecules[0]!), secondInk = moleculeInkBounds(layout.molecules[1]!);
    expect(secondInk.x - firstInk.x).toBeCloseTo(firstInk.width + 2 * 1.25 * 22 + plus.width);
    const conditionStyle = nativeTextStyleFromObjectStyle(condition.style);
    expect(condition.y + conditionStyle.fontSizePx).toBeCloseTo(
      120 - drawing.strokeWidth / 2 - (0.3 + 0.21) * conditionStyle.fontSizePx
    );
    const page = layout.document.pages[0]!;
    expect(page.width).toBeGreaterThanOrEqual(layout.molecules[2]!.x + layout.molecules[2]!.width + 24);
    expect(page.layout).toMatchObject({ presetId: "custom", widthPx: page.width, heightPx: page.height });
    expect(options).toEqual(original);

    const textStyle = { fontSizePx: 24, fontWeight: 700 };
    const styled = layoutReactionScheme({ ...options, style: "document", textStyle });
    expect(styled.arrow.width).toBeGreaterThan(layout.arrow.width);
    expect(nativeTextStyleFromObjectStyle(styled.above!.style)).toMatchObject({ ...DocumentTextStyle, ...textStyle });
    expect(nativeTextStyleFromObjectStyle(styled.pluses[0]!.style).fontSizePx).toBe(drawing.fontSizePx);
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
    expect(layout.above!.style.lineHeight).toBeCloseTo(1.236, 8);
  });

  it("fits all blocks and a wrapped plain-prose caption with page padding, translating the scheme together", () => {
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
    for (const block of [layout.above!, layout.below!]) {
      expect(block.style.lineHeight).toBeCloseTo(1.236, 8);
      expect(block.height).toBe(59.62);
    }
    for (const object of page.objects) {
      expect(object.x).toBeGreaterThanOrEqual(24);
      expect(object.y).toBeGreaterThanOrEqual(24);
      expect(object.x + object.width).toBeLessThanOrEqual(page.width - 24 + 0.01);
      expect(object.y + object.height).toBeLessThanOrEqual(page.height - 24 + 0.01);
    }
    expect(layout.arrow.start.kind).toBe("point");
    if (layout.arrow.start.kind !== "point") throw new Error("Expected a point anchor");
    const ink = moleculeInkBounds(layout.molecules[0]!);
    expect(ink.x + ink.width + 1.25 * 22 + Number(layout.arrow.style.strokeWidth) / 2).toBeCloseTo(layout.arrow.start.point!.x);
    expect(ink.y + ink.height / 2).toBeCloseTo(layout.arrow.start.point!.y);
    expect(layout.caption!.text).toContain("\n");
    expect(layout.caption!.spans.every((span) => span.script === "normal")).toBe(true);
    expect(layout.caption!.text).toContain("CH2Cl2");
    expect(layout.caption!.y).toBeCloseTo(Math.max(
      ...layout.molecules.map(moleculeInkBounds).map(b => b.y + b.height), layout.below!.y + layout.below!.height
    ) + 0.8 * 15);
    const left = Math.min(...layout.molecules.map(moleculeInkBounds).map(b => b.x));
    const right = Math.max(...layout.molecules.map(moleculeInkBounds).map(b => b.x + b.width));
    expect(layout.caption!.x + layout.caption!.width / 2).toBeCloseTo((left + right) / 2);
    expect(component).toEqual(original);
  });

  it("centres the caption using measured ink rather than a stale supplied frame", () => {
    const layout = layoutReactionScheme({
      reactants: [{ molecule: molecule("reactant", 20, 20), bounds: bounds(80, 100) }],
      products: [], arrowKind: "forward", caption: "Product",
      anchor: { x: 24, y: 120 }, gutter: 24, bondLength: 22, pagePadding: 24
    });
    if (layout.arrow.end.kind !== "point") throw new Error("Expected a point anchor");
    expect(layout.caption!.x + layout.caption!.width / 2).toBeCloseTo((24 + layout.arrow.end.point!.x) / 2);
    const ink = moleculeInkBounds(layout.molecules[0]!);
    expect(layout.caption!.y).toBeCloseTo(Math.max(ink.y + ink.height, layout.arrow.y + layout.arrow.height) + 0.8 * 14);
  });
});
