import { measureNativeTextSpanLineWidth, nativeTextCharacterWidthFactor, nativeTextScriptFontScale } from "@chemdraft/layout-engine";
import { describe, expect, it } from "vitest";
import { createEmptyDocument, nativeTextStyleFromObjectStyle, type TextSpan, type MoleculeObject } from "@chemdraft/chem-core";
import { layoutGrid } from "../src/gridLayout";
import { estimateNativeTextLineWidth, estimateNativeTextSpanLineWidth, nativeTextObjectSizeForSpanLines, nativeTextObjectSizeForText, insertNativeTextObject } from "../src/textObjects";

describe("grid object ids", () => {
  it.each([true, false])("preserves the pre-move CLI allocation sequence (all labels: %s)", (allLabels) => {
    const entries = ["A", "B", "C"].map((label, index) => ({
      molecule: {
        id: `source_${index}`, type: "molecule", x: 0, y: 0, width: 40, height: 20,
        rotation: 0, style: {}, structureFormat: "smiles", structure: "C",
        atoms: [{ id: "a", element: "C", x: 0, y: 0, formalCharge: 0 }],
        bonds: [], superatoms: [], rGroups: []
      } satisfies MoleculeObject,
      bounds: { minX: 0, minY: 0, maxX: 40, maxY: 20 },
      label: allLabels || index !== 1 ? label : null
    }));
    const layout = layoutGrid({ entries, columns: 2, gutter: 32, anchor: { x: 24, y: 24 }, pageWidth: 800 });

    // Before the move, the CLI appended each molecule, then called insertNativeTextObject.
    let previous = createEmptyDocument({ title: "ChemDraft grid" });
    entries.forEach((entry, index) => {
      const page = previous.pages[0]!;
      previous = { ...previous, pages: [{ ...page, objects: [...page.objects, layout.molecules[index]!] }] };
      if (entry.label !== null) previous = insertNativeTextObject(previous, { x: 24, y: 24 }, entry.label);
    });
    const ids = layout.document.pages[0]!.objects.map(object => object.id);
    expect(ids).toEqual(previous.pages[0]!.objects.map(object => object.id));
    expect(ids).toEqual(allLabels
      ? ["mol_grid_001", "text_002", "mol_grid_002", "text_004", "mol_grid_003", "text_006"]
      : ["mol_grid_001", "text_002", "mol_grid_002", "mol_grid_003", "text_005"]);
  });
});

describe("shared text sizing", () => {
  it("delegates line and span sizing to metrics without narrowing any legacy line", () => {
    const style = nativeTextStyleFromObjectStyle({ fontSizePx: 18, letterSpacingPx: 1 });
    for (const text of ["CCCCCCCCC", "iiii", "MW% 123", "hé🧪", "\t", ""]) {
      const spans: TextSpan[] = [{ text, script: "normal", style: {} }];
      const legacy = [...text].reduce((sum, char, index) =>
        sum + 18 * nativeTextCharacterWidthFactor(char) + (index > 0 ? 1 : 0), 0);
      expect(estimateNativeTextSpanLineWidth(spans, style)).toBe(measureNativeTextSpanLineWidth(spans, style));
      expect(estimateNativeTextLineWidth(text, style)).toBeGreaterThanOrEqual(legacy);
      expect(nativeTextObjectSizeForText(text, style).width).toBeGreaterThanOrEqual(Math.max(36, legacy + 6));
    }
    const spans: TextSpan[] = [
      { text: "CC", script: "normal", style: { fontWeight: 700, fontSizePx: 24 } },
      { text: "C", script: "subscript", style: { letterSpacingPx: 2 } }
    ];
    const legacy = 24 * 0.62 * 2 + 1 + 18 * nativeTextScriptFontScale * 0.62 + 2;
    const measured = measureNativeTextSpanLineWidth(spans, style);
    expect(estimateNativeTextSpanLineWidth(spans, style)).toBe(measured);
    expect(measured).toBeGreaterThanOrEqual(legacy);
    expect(nativeTextObjectSizeForSpanLines([spans], style).contentWidth).toBe(measured);
    expect(nativeTextObjectSizeForSpanLines([spans], style).width).toBeCloseTo(measured + 6, 2);
    expect(nativeTextObjectSizeForText("CCC", style, { spans }).width).toBeCloseTo(measured + 6, 2);
    expect(nativeTextObjectSizeForText("CCCCCCCCC", { fontSizePx: 18 }).width).toBe(122.96);
    expect(nativeTextObjectSizeForText("CCCCCCCCC", style, {
      spans: [{ text: "CCCCCCCCC", script: "subscript", style: {} }]
    }).width).toBeGreaterThanOrEqual(nativeTextObjectSizeForText("CCCCCCCCC", style).width);
  });
});
