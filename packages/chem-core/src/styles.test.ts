import { describe, expect, it } from "vitest";
import { Acs1996StylePreset, RscJournalStylePreset, NativeStylePresets, DOCUMENT_STYLE_UNITS_PER_PT,
  DocumentStylePreset, nativeDrawingStyleFromObjectStyle, nativeTextStyleFromObjectStyle, stylePresetToObjectStyle,
  createEmptyDocument, ChemDraftDocumentSchema, DocumentObjectSchema, DocumentSchemaVersion,
  deserializeDocument, serializeDocument, applyPatch } from "./index";

describe("native style presets", () => {
  it.each([
    { type: "molecule", structureFormat: "smiles", structure: "CO" },
    { type: "text", text: "Caption" },
    { type: "graphic", graphicKind: "rect" }
  ])("validates and round-trips optional preset metadata on $type objects without migrating old documents", fields => {
    const base = { ...fields, id: "object_001", x: 0, y: 0, width: 40, height: 20 };
    for (const style of [{}, { stylePresetId: Acs1996StylePreset.id }]) {
      const object = DocumentObjectSchema.parse({ ...base, style });
      expect(object.style.stylePresetId).toBe(style.stylePresetId);
      const document = createEmptyDocument();
      document.pages[0]!.objects.push(object);
      const restored = deserializeDocument(serializeDocument(document));
      expect(restored).toEqual(document);
      expect(restored.schema).toBe(DocumentSchemaVersion);
      expect(restored.pages[0]!.objects[0]!.style).toEqual(style);
    }
    expect(DocumentObjectSchema.safeParse({ ...base, style: { stylePresetId: 42 } }).success).toBe(false);
  });

  it.each(NativeStylePresets)("validates and resolves $id without losing fields", preset => {
    const drawing = stylePresetToObjectStyle(preset);
    const document = createEmptyDocument();
    document.styles.drawing = drawing;
    expect(ChemDraftDocumentSchema.parse(document).styles.drawing).toEqual(drawing);
    expect(nativeDrawingStyleFromObjectStyle(drawing)).toEqual(preset.drawing);
  });

  it("converts every ACS physical dimension with 22 units per 14.4 points", () => {
    const drawing = Acs1996StylePreset.drawing;
    expect(DOCUMENT_STYLE_UNITS_PER_PT).toBe(22 / 14.4);
    expect(drawing.bondLengthPx).toBe(22);
    for (const [field, points] of Object.entries({ bondLengthPx: 14.4, bondStrokeWidthPx: 0.6,
      bondBoldWidthPx: 2, bondHashSpacingPx: 2.5, bondMarginWidthPx: 1.6, atomLabelFontSizePx: 10 })) {
      expect(drawing[field as keyof typeof drawing]).toBe(points * 22 / 14.4);
    }
    expect(drawing.bondSpacingMode).toBe("percent");
    expect(drawing.bondSpacingPercent).toBe(18);
    expect(drawing.multipleBondGapPx).toBe(22 * 0.18);
    expect(drawing.atomLabelFontFamily).toBe("Arial, Helvetica, sans-serif");
    expect(drawing.atomLabelFontWeight).toBe(400);
    expect(drawing.doubleBondInsetPx).toBe(DocumentStylePreset.drawing.doubleBondInsetPx);
  });

  it("uses the sourced RSC dimensions and retains the unspecified document margin", () => {
    const drawing = RscJournalStylePreset.drawing;
    for (const [field, points] of Object.entries({ bondLengthPx: 12.2, bondStrokeWidthPx: 0.5,
      bondBoldWidthPx: 1.6, bondHashSpacingPx: 1.8, atomLabelFontSizePx: 7 })) {
      expect(drawing[field as keyof typeof drawing]).toBe(points * 22 / 14.4);
    }
    expect(drawing.bondSpacingMode).toBe("percent");
    expect(drawing.bondSpacingPercent).toBe(20);
    expect(drawing.bondMarginWidthPx).toBe(DocumentStylePreset.drawing.bondMarginWidthPx);
    expect(drawing.atomLabelFontFamily).toBe("Arial, Helvetica, sans-serif");
    expect(drawing.atomLabelFontWeight).toBe(400);
  });

  it("updates drawing/text defaults atomically and keeps unrelated document styles", () => {
    const before = createEmptyDocument();
    before.styles.other = { kept: true };
    const after = applyPatch(before, { op: "batch", patches: [
      { op: "setDrawingDefaults", drawing: Acs1996StylePreset.drawing,
        text: { fontFamily: "Arial", fontSizePx: 15, color: "blue", letterSpacingPx: 0, lineHeight: 1.2,
          paragraphSpacingPx: 0, textAlign: "left", fontWeight: 400, fontStyle: "normal", textDecoration: "none" } }
    ] });
    expect(after.styles.drawing).toEqual(Acs1996StylePreset.drawing);
    expect(after.styles.text).toMatchObject({ color: "blue", fontWeight: 400 });
    expect(after.styles.other).toEqual({ kept: true });
    expect(before.styles).toEqual({ other: { kept: true } });
    expect(() => applyPatch(before, { op: "batch", patches: [
      { op: "setDrawingDefaults", drawing: Acs1996StylePreset.drawing, text: nativeTextStyleFromObjectStyle({ color: "blue" }) },
      { op: "updateObject", objectId: "missing", changes: { style: {} } }
    ] })).toThrow();
    expect(before.styles).toEqual({ other: { kept: true } });
  });
});
