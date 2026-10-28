import {
  ChemDraftSyntheticStylePreset, nativeDrawingStyleFromObjectStyle, stylePresetToObjectStyle,
  type ChemDraftDocument, type NativeDrawingStyle, type NativeTextStyle
} from "@chemdraft/chem-core";

export interface DocumentDrawingDefaults {
  drawing: NativeDrawingStyle;
  objectStyle: ReturnType<typeof stylePresetToObjectStyle>;
  bondLengthPx: number;
  textStyle: Partial<NativeTextStyle>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Resolve insertion defaults field by field; malformed metadata never discards valid siblings. */
export function documentDrawingDefaults(document: ChemDraftDocument): DocumentDrawingDefaults {
  const preset = ChemDraftSyntheticStylePreset;
  const input = record(document.styles.drawing);
  // Keep chem-core's per-field validation, including fields that permit zero. Only bond
  // length has an additional insertion range; invalid siblings still resolve independently.
  const drawing = nativeDrawingStyleFromObjectStyle({
    ...input,
    bondLengthPx: typeof input.bondLengthPx === "number" && input.bondLengthPx >= 8 && input.bondLengthPx <= 120
      ? input.bondLengthPx : preset.drawing.bondLengthPx
  });
  const objectStyle = stylePresetToObjectStyle({ ...preset, id: drawing.stylePresetId, drawing });
  const text = record(document.styles.text);
  const textStyle: Partial<NativeTextStyle> = {
    fontFamily: drawing.atomLabelFontFamily, fontSizePx: drawing.atomLabelFontSizePx
  };
  for (const key of ["fontFamily", "color"] as const) {
    const value = text[key];
    if (typeof value === "string" && value.trim()) textStyle[key] = value;
  }
  if (typeof text.fontSizePx === "number" && Number.isFinite(text.fontSizePx)
    && text.fontSizePx >= 4 && text.fontSizePx <= 200) textStyle.fontSizePx = text.fontSizePx;
  if (typeof text.fontWeight === "number" && Number.isFinite(text.fontWeight)
    && text.fontWeight > 0) textStyle.fontWeight = text.fontWeight;
  if (text.fontStyle === "normal" || text.fontStyle === "italic") textStyle.fontStyle = text.fontStyle;
  return { drawing, objectStyle, bondLengthPx: drawing.bondLengthPx, textStyle };
}
