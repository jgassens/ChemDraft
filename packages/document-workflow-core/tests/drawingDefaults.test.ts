import { describe, expect, it } from "vitest";
import { createEmptyDocument, ChemDraftSyntheticStylePreset, nativeDrawingStyleFromObjectStyle } from "@chemdraft/chem-core";
import { documentDrawingDefaults } from "../src/drawingDefaults";

describe("document drawing defaults", () => {
  it("uses the hand drawing preset and matching caption size", () => {
    const defaults = documentDrawingDefaults(createEmptyDocument());
    expect(defaults.drawing).toEqual(ChemDraftSyntheticStylePreset.drawing);
    expect(defaults.bondLengthPx).toBe(22);
    expect(defaults.objectStyle).toEqual(defaults.drawing);
    expect(defaults.textStyle).toEqual({ fontFamily: "Arial, Helvetica, sans-serif", fontSizePx: 15 });
  });
  it("applies document drawing fields to both geometry and object style", () => {
    const document = createEmptyDocument();
    document.styles.drawing = { bondLengthPx: 30, bondStrokeWidthPx: 1.2,
      atomLabelFontSizePx: 12, atomLabelFontFamily: "Times", bondLineCap: "round",
      atomLabelShowTerminalCarbons: true, stylePresetId: "custom" };
    const defaults = documentDrawingDefaults(document);
    expect(defaults.drawing).toMatchObject(document.styles.drawing);
    expect(defaults.objectStyle).toEqual(defaults.drawing);
    expect(defaults.bondLengthPx).toBe(30);
    expect(defaults.textStyle).toEqual({ fontFamily: "Times", fontSizePx: 12 });
  });
  it.each([null, [], "bad", { bondLengthPx: 500, bondStrokeWidthPx: -1,
    atomLabelFontSizePx: NaN, chainAngleDegrees: "90", bondLineCap: "invalid",
    atomLabelFontFamily: "", unknown: 1, bondColor: "red", atomLabelFontWeight: 600 }])(
    "ignores malformed metadata field by field: %j", drawing => {
      const document = createEmptyDocument();
      document.styles.drawing = drawing;
      const defaults = documentDrawingDefaults(document);
      expect(defaults.bondLengthPx).toBe(22);
      expect(defaults.drawing.bondStrokeWidthPx).toBe(2);
      expect(defaults.drawing.atomLabelFontSizePx).toBe(15);
      expect(defaults.drawing.chainAngleDegrees).toBe(120);
      expect(defaults.drawing.bondLineCap).toBe("butt");
      expect(defaults.objectStyle).not.toHaveProperty("unknown");
      if (drawing && !Array.isArray(drawing) && typeof drawing === "object") {
        expect(defaults.drawing.bondColor).toBe("red");
        expect(defaults.drawing.atomLabelFontWeight).toBe(600);
      }
      expect(defaults.objectStyle).toEqual(defaults.drawing);
    }
  );
  it.each([8, 120])("accepts inclusive bond length boundary %s", bondLengthPx => {
    const document = createEmptyDocument(); document.styles.drawing = { bondLengthPx };
    expect(documentDrawingDefaults(document).bondLengthPx).toBe(bondLengthPx);
  });
  it.each([
    "doubleBondInsetPx", "bondMarginWidthPx", "bondOverlapClearancePx",
    "atomLabelPaddingPx", "atomLabelBondClearancePx"
  ] as const)("honours zero and rejects negative/non-finite %s", field => {
    const document = createEmptyDocument();
    for (const value of [0, -1, NaN]) {
      document.styles.drawing = { [field]: value };
      const defaults = documentDrawingDefaults(document);
      const expected = value === 0 ? 0 : ChemDraftSyntheticStylePreset.drawing[field];
      expect(defaults.drawing[field]).toBe(expected);
      expect(defaults.objectStyle[field]).toBe(expected);
    }
  });
  it("uses chem-core's numeric field rules, with the insertion bond-length range", () => {
    const document = createEmptyDocument();
    const fields = Object.entries(ChemDraftSyntheticStylePreset.drawing)
      .filter(([, value]) => typeof value === "number").map(([key]) => key);
    for (const value of [0, -1, NaN, Infinity, 1, 30]) {
      const input = Object.fromEntries(fields.map(key => [key, value]));
      document.styles.drawing = input;
      expect(documentDrawingDefaults(document).drawing).toEqual(nativeDrawingStyleFromObjectStyle({
        ...input, bondLengthPx: value >= 8 && value <= 120 ? value : 22
      }));
    }
  });
  it("resolves custom text independently and retains valid siblings of bad fields", () => {
    const document = createEmptyDocument();
    document.styles.text = { fontFamily: "Times", fontSizePx: 20, color: "blue", fontWeight: 700, fontStyle: "italic", unknown: 9 };
    expect(documentDrawingDefaults(document).textStyle).toEqual({ fontFamily: "Times", fontSizePx: 20,
      color: "blue", fontWeight: 700, fontStyle: "italic" });
    document.styles.text = { fontFamily: " ", fontSizePx: 201, color: "blue", fontWeight: NaN, fontStyle: "wrong" };
    expect(documentDrawingDefaults(document).textStyle).toEqual({ fontFamily: "Arial, Helvetica, sans-serif", fontSizePx: 15, color: "blue" });
  });
});
