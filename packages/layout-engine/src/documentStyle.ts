import { ChemDraftSyntheticStylePreset, type ChemDraftStylePreset, type NativeTextStyle } from "@chemdraft/chem-core";

/** Physical contract for the fixed document style. Native coordinates remain canvas units. */
export const DocumentStyleScale = {
  pointsPerUnit: 14.4 / 22,
  marginPt: 4,
  defaultDpi: 300,
  minDpi: 72,
  maxDpi: 1200,
  pointsPerInch: 72
} as const;

const units = (points: number) => points / DocumentStyleScale.pointsPerUnit;

/** Convert native canvas bounds to the point-space SVG viewport without fitting. */
export function documentStylePointBounds(bounds: { x: number; y: number; width: number; height: number }) {
  const scale = DocumentStyleScale.pointsPerUnit;
  return { x: bounds.x * scale, y: bounds.y * scale, width: bounds.width * scale, height: bounds.height * scale };
}

export const DocumentStylePreset = {
  id: "chemdraft.document",
  name: "Document style",
  source: "core",
  drawing: {
    ...ChemDraftSyntheticStylePreset.drawing,
    stylePresetId: "chemdraft.document",
    chainAngleDegrees: 120,
    bondLengthPx: units(14.4),
    bondStrokeWidthPx: units(1.134),
    bondBoldWidthPx: units(2.268),
    bondSpacingMode: "percent",
    bondSpacingPercent: 18,
    multipleBondGapPx: units(14.4) * 0.18,
    bondHashSpacingPx: units(2.5),
    bondMarginWidthPx: units(1.6),
    atomLabelFontFamily: "Arial, Helvetica, sans-serif",
    atomLabelFontSizePx: units(10)
  }
} as const satisfies ChemDraftStylePreset;

/** Only these whole-molecule dimensions belong to document style. The preset id selects the
 * explicit wedge width; native style resolution never uses it to replace colours. Keep appearance
 * overrides; page scaling adjusts pixel dimensions in per-atom/per-bond size maps. */
export const DocumentMoleculeSizeStyle = Object.fromEntries(([
  "stylePresetId",
  "bondLengthPx", "bondStrokeWidthPx", "bondBoldWidthPx", "bondSpacingMode", "bondSpacingPercent",
  "multipleBondGapPx", "doubleBondInsetPx", "bondHashSpacingPx", "bondMarginWidthPx",
  "chainAngleDegrees", "atomLabelFontFamily", "atomLabelFontSizePx"
] as const).map((key) => [key, DocumentStylePreset.drawing[key]]));

export const DocumentTextStyle = {
  fontFamily: DocumentStylePreset.drawing.atomLabelFontFamily,
  fontSizePx: DocumentStylePreset.drawing.atomLabelFontSizePx
} as const satisfies Partial<NativeTextStyle>;

export const FigureStyles = ["fit", "document"] as const;
export type FigureStyle = typeof FigureStyles[number];
