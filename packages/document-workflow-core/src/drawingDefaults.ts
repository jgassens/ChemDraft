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
  const overrides: Record<string, unknown> = {};
  // chem-core's resolver validates string enums and supplies their preset fallback. There is
  // no drawing-style Zod schema; prefilter numeric values here for the insertion contract.
  for (const key of Object.keys(preset.drawing) as (keyof NativeDrawingStyle)[]) {
    const value = input[key];
    if (typeof value !== typeof preset.drawing[key]) continue;
    if (typeof value === "number" && (!Number.isFinite(value) || value <= 0)) continue;
    if (key === "bondLengthPx" && (Number(value) < 8 || Number(value) > 120)) continue;
    overrides[key] = value;
  }
  const drawing = nativeDrawingStyleFromObjectStyle(overrides);
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
