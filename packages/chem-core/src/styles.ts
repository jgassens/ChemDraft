export type NativeBondLineCap = "butt" | "round" | "square";
export type NativeBondSpacingMode = "absolute" | "percent";
export type NativeTextAlignment = "left" | "center" | "right" | "justify";
export type NativeTextFontStyle = "normal" | "italic";
export type NativeTextDecoration = "none" | "underline";
export type NativeAtomLabelAlignment = "automatic" | "left" | "center" | "right";
export type NativeAtomLabelPlacement = "automatic" | "above" | "below";

export interface NativeDrawingStyle {
  stylePresetId: string;
  chainAngleDegrees: number;
  bondLengthPx: number;
  bondStrokeWidthPx: number;
  bondBoldWidthPx: number;
  bondColor: string;
  bondLineCap: NativeBondLineCap;
  bondSpacingMode: NativeBondSpacingMode;
  bondSpacingPercent: number;
  multipleBondGapPx: number;
  doubleBondInsetPx: number;
  bondMarginWidthPx: number;
  bondHashSpacingPx: number;
  bondOverlapClearancePx: number;
  atomIndicatorShowQuery: boolean;
  atomIndicatorShowStereochemistry: boolean;
  atomIndicatorShowEnhancedStereochemistry: boolean;
  atomIndicatorShowAtomNumbers: boolean;
  bondIndicatorShowQuery: boolean;
  bondIndicatorShowStereochemistry: boolean;
  bondIndicatorShowReaction: boolean;
  atomLabelFontFamily: string;
  atomLabelFontSizePx: number;
  atomLabelFontWeight: number;
  atomLabelFontStyle: NativeTextFontStyle;
  atomLabelColor: string;
  atomLabelBackgroundColor: string;
  atomLabelPaddingPx: number;
  atomLabelBondClearancePx: number;
  atomLabelAlignment: NativeAtomLabelAlignment;
  atomLabelPlacement: NativeAtomLabelPlacement;
  atomLabelShowTerminalCarbons: boolean;
  atomLabelHideImplicitHydrogens: boolean;
}

export interface ChemDraftStylePreset {
  id: string;
  name: string;
  source: "core" | "imported";
  sourceFormat?: string;
  sourceName?: string;
  applicationVersion?: string;
  drawing: NativeDrawingStyle;
}

export interface NativeTextStyle {
  fontFamily: string;
  fontSizePx: number;
  color: string;
  letterSpacingPx: number;
  lineHeight: number;
  paragraphSpacingPx: number;
  textAlign: NativeTextAlignment;
  fontWeight: number;
  fontStyle: NativeTextFontStyle;
  textDecoration: NativeTextDecoration;
}

export const ChemDraftSyntheticStylePreset = {
  id: "chemdraft.synthetic",
  name: "ChemDraft Synthetic",
  source: "core",
  drawing: {
    stylePresetId: "chemdraft.synthetic",
    chainAngleDegrees: 120,
    bondLengthPx: 22,
    bondStrokeWidthPx: 2,
    bondBoldWidthPx: 4.8,
    bondColor: "#000000",
    bondLineCap: "butt",
    bondSpacingMode: "absolute",
    bondSpacingPercent: 18,
    multipleBondGapPx: 4.8,
    doubleBondInsetPx: 4.5,
    bondMarginWidthPx: 6,
    bondHashSpacingPx: 9,
    bondOverlapClearancePx: 6,
    atomIndicatorShowQuery: true,
    atomIndicatorShowStereochemistry: false,
    atomIndicatorShowEnhancedStereochemistry: true,
    atomIndicatorShowAtomNumbers: false,
    bondIndicatorShowQuery: true,
    bondIndicatorShowStereochemistry: false,
    bondIndicatorShowReaction: true,
    atomLabelFontFamily: "Arial, Helvetica, sans-serif",
    atomLabelFontSizePx: 15,
    atomLabelFontWeight: 400,
    atomLabelFontStyle: "normal",
    atomLabelColor: "#000000",
    atomLabelBackgroundColor: "#ffffff",
    atomLabelPaddingPx: 2,
    atomLabelBondClearancePx: 7,
    atomLabelAlignment: "automatic",
    atomLabelPlacement: "automatic",
    atomLabelShowTerminalCarbons: false,
    atomLabelHideImplicitHydrogens: false
  }
} as const satisfies ChemDraftStylePreset;

export const DefaultNativeDrawingStyle: NativeDrawingStyle = ChemDraftSyntheticStylePreset.drawing;

export const DefaultNativeTextStyle = {
  fontFamily: "Arial, Helvetica, sans-serif",
  fontSizePx: 18,
  color: "#111111",
  letterSpacingPx: 0,
  lineHeight: 1.2,
  paragraphSpacingPx: 0,
  textAlign: "left",
  fontWeight: 400,
  fontStyle: "normal",
  textDecoration: "none"
} as const satisfies NativeTextStyle;

export function stylePresetToObjectStyle(
  preset: ChemDraftStylePreset = ChemDraftSyntheticStylePreset
): Record<string, unknown> {
  const { stylePresetId: _drawingStylePresetId, ...drawingStyle } = preset.drawing;
  return {
    ...drawingStyle,
    stylePresetId: preset.id
  };
}

export function nativeDrawingStyleFromObjectStyle(style: Record<string, unknown> = {}): NativeDrawingStyle {
  const fallback = DefaultNativeDrawingStyle;

  return {
    stylePresetId: stringValue(style.stylePresetId, fallback.stylePresetId),
    chainAngleDegrees: positiveNumber(style.chainAngleDegrees, fallback.chainAngleDegrees),
    bondLengthPx: positiveNumber(style.bondLengthPx, fallback.bondLengthPx),
    bondStrokeWidthPx: positiveNumber(style.bondStrokeWidthPx, fallback.bondStrokeWidthPx),
    bondBoldWidthPx: positiveNumber(style.bondBoldWidthPx, fallback.bondBoldWidthPx),
    bondColor: stringValue(style.bondColor, fallback.bondColor),
    bondLineCap: bondLineCapValue(style.bondLineCap, fallback.bondLineCap),
    bondSpacingMode: bondSpacingModeValue(style.bondSpacingMode, fallback.bondSpacingMode),
    bondSpacingPercent: positiveNumber(style.bondSpacingPercent, fallback.bondSpacingPercent),
    multipleBondGapPx: positiveNumber(style.multipleBondGapPx, fallback.multipleBondGapPx),
    doubleBondInsetPx: nonnegativeNumber(style.doubleBondInsetPx, fallback.doubleBondInsetPx),
    bondMarginWidthPx: nonnegativeNumber(style.bondMarginWidthPx, fallback.bondMarginWidthPx),
    bondHashSpacingPx: positiveNumber(style.bondHashSpacingPx, fallback.bondHashSpacingPx),
    bondOverlapClearancePx: nonnegativeNumber(
      style.bondOverlapClearancePx,
      fallback.bondOverlapClearancePx
    ),
    atomIndicatorShowQuery: booleanValue(style.atomIndicatorShowQuery, fallback.atomIndicatorShowQuery),
    atomIndicatorShowStereochemistry: booleanValue(
      style.atomIndicatorShowStereochemistry,
      fallback.atomIndicatorShowStereochemistry
    ),
    atomIndicatorShowEnhancedStereochemistry: booleanValue(
      style.atomIndicatorShowEnhancedStereochemistry,
      fallback.atomIndicatorShowEnhancedStereochemistry
    ),
    atomIndicatorShowAtomNumbers: booleanValue(
      style.atomIndicatorShowAtomNumbers,
      fallback.atomIndicatorShowAtomNumbers
    ),
    bondIndicatorShowQuery: booleanValue(style.bondIndicatorShowQuery, fallback.bondIndicatorShowQuery),
    bondIndicatorShowStereochemistry: booleanValue(
      style.bondIndicatorShowStereochemistry,
      fallback.bondIndicatorShowStereochemistry
    ),
    bondIndicatorShowReaction: booleanValue(style.bondIndicatorShowReaction, fallback.bondIndicatorShowReaction),
    atomLabelFontFamily: stringValue(style.atomLabelFontFamily, fallback.atomLabelFontFamily),
    atomLabelFontSizePx: positiveNumber(style.atomLabelFontSizePx, fallback.atomLabelFontSizePx),
    atomLabelFontWeight: positiveNumber(style.atomLabelFontWeight, fallback.atomLabelFontWeight),
    atomLabelFontStyle: fontStyleValue(style.atomLabelFontStyle, fallback.atomLabelFontStyle),
    atomLabelColor: stringValue(style.atomLabelColor, fallback.atomLabelColor),
    atomLabelBackgroundColor: stringValue(style.atomLabelBackgroundColor, fallback.atomLabelBackgroundColor),
    atomLabelPaddingPx: nonnegativeNumber(style.atomLabelPaddingPx, fallback.atomLabelPaddingPx),
    atomLabelBondClearancePx: nonnegativeNumber(
      style.atomLabelBondClearancePx,
      fallback.atomLabelBondClearancePx
    ),
    atomLabelAlignment: atomLabelAlignmentValue(style.atomLabelAlignment, fallback.atomLabelAlignment),
    atomLabelPlacement: atomLabelPlacementValue(style.atomLabelPlacement, fallback.atomLabelPlacement),
    atomLabelShowTerminalCarbons: booleanValue(
      style.atomLabelShowTerminalCarbons,
      fallback.atomLabelShowTerminalCarbons
    ),
    atomLabelHideImplicitHydrogens: booleanValue(
      style.atomLabelHideImplicitHydrogens,
      fallback.atomLabelHideImplicitHydrogens
    )
  };
}

export function textStyleToObjectStyle(
  style: Partial<NativeTextStyle> = {}
): Record<string, unknown> {
  const resolved = nativeTextStyleFromObjectStyle(style);
  return {
    fontFamily: resolved.fontFamily,
    fontSizePx: resolved.fontSizePx,
    color: resolved.color,
    letterSpacingPx: resolved.letterSpacingPx,
    lineHeight: resolved.lineHeight,
    paragraphSpacingPx: resolved.paragraphSpacingPx,
    textAlign: resolved.textAlign,
    fontWeight: resolved.fontWeight,
    fontStyle: resolved.fontStyle,
    textDecoration: resolved.textDecoration
  };
}

export function nativeTextStyleFromObjectStyle(style: Record<string, unknown> = {}): NativeTextStyle {
  const fallback = DefaultNativeTextStyle;

  return {
    fontFamily: stringValue(style.fontFamily, fallback.fontFamily),
    fontSizePx: positiveNumber(style.fontSizePx, fallback.fontSizePx),
    color: stringValue(style.color, fallback.color),
    letterSpacingPx: numberValue(style.letterSpacingPx, fallback.letterSpacingPx),
    lineHeight: positiveNumber(style.lineHeight, fallback.lineHeight),
    paragraphSpacingPx: nonnegativeNumber(style.paragraphSpacingPx, fallback.paragraphSpacingPx),
    textAlign: textAlignValue(style.textAlign, fallback.textAlign),
    fontWeight: positiveNumber(style.fontWeight, fallback.fontWeight),
    fontStyle: fontStyleValue(style.fontStyle, fallback.fontStyle),
    textDecoration: textDecorationValue(style.textDecoration, fallback.textDecoration)
  };
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonnegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function bondLineCapValue(value: unknown, fallback: NativeBondLineCap): NativeBondLineCap {
  return value === "butt" || value === "round" || value === "square" ? value : fallback;
}

function bondSpacingModeValue(value: unknown, fallback: NativeBondSpacingMode): NativeBondSpacingMode {
  return value === "absolute" || value === "percent" ? value : fallback;
}

function textAlignValue(value: unknown, fallback: NativeTextAlignment): NativeTextAlignment {
  return value === "left" || value === "center" || value === "right" || value === "justify"
    ? value
    : fallback;
}

function fontStyleValue(value: unknown, fallback: NativeTextFontStyle): NativeTextFontStyle {
  return value === "normal" || value === "italic" ? value : fallback;
}

function atomLabelAlignmentValue(value: unknown, fallback: NativeAtomLabelAlignment): NativeAtomLabelAlignment {
  return value === "automatic" || value === "left" || value === "center" || value === "right"
    ? value
    : fallback;
}

function atomLabelPlacementValue(value: unknown, fallback: NativeAtomLabelPlacement): NativeAtomLabelPlacement {
  return value === "automatic" || value === "above" || value === "below" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function textDecorationValue(value: unknown, fallback: NativeTextDecoration): NativeTextDecoration {
  return value === "none" || value === "underline" ? value : fallback;
}
