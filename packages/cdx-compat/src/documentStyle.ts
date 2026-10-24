import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { NativeDrawingStyle } from "@chemdraft/chem-core";

/** The document-level drawing settings a CDXML file carries on its root `<CDXML>` element, in
 *  CDXML's own units: points, a percent of bond length for `bondSpacingPercent`, degrees for
 *  `chainAngleDegrees`. A field is absent when the reference file did not set it. */
export interface CdxmlDocumentStyle {
  bondLengthPt?: number;
  lineWidthPt?: number;
  boldWidthPt?: number;
  hashSpacingPt?: number;
  marginWidthPt?: number;
  bondSpacingPercent?: number;
  chainAngleDegrees?: number;
  labelFontName?: string;
  labelSizePt?: number;
  /** CDXML face bits: 1 bold, 2 italic, 4 underline, 8 outline, 16 shadow, 32 subscript,
   *  64 superscript; 96 is the "formula" face that subscripts counts in labels such as CH3. */
  labelFace?: number;
  captionFontName?: string;
  captionSizePt?: number;
  captionFace?: number;
}

export interface CdxmlDocumentStyleReadResult {
  style: CdxmlDocumentStyle;
  /** Structure-drawing attributes the reference did not set, so ChemDraft's own values stay in
   *  force. Caption attributes are carried when present but never reported: structures have none. */
  missing: string[];
}

type NumericStyleField = Exclude<keyof CdxmlDocumentStyle, "labelFontName" | "captionFontName">;

/** Each numeric setting, its CDXML attribute, and the range a real drawing style falls inside.
 *  A value outside the range is refused rather than clamped: it means the file is not a style
 *  reference, and a silently clamped style would export a drawing nobody asked for. */
const numericAttributes: readonly {
  field: NumericStyleField; attribute: string; min: number; max: number; integer?: true; caption?: true;
}[] = [
  { field: "bondLengthPt", attribute: "BondLength", min: 1, max: 200 },
  { field: "lineWidthPt", attribute: "LineWidth", min: 0.05, max: 20 },
  { field: "boldWidthPt", attribute: "BoldWidth", min: 0.05, max: 40 },
  { field: "hashSpacingPt", attribute: "HashSpacing", min: 0.1, max: 50 },
  { field: "marginWidthPt", attribute: "MarginWidth", min: 0, max: 50 },
  { field: "bondSpacingPercent", attribute: "BondSpacing", min: 1, max: 100 },
  { field: "chainAngleDegrees", attribute: "ChainAngle", min: 1, max: 179 },
  { field: "labelSizePt", attribute: "LabelSize", min: 1, max: 144 },
  { field: "labelFace", attribute: "LabelFace", min: 0, max: 255, integer: true },
  { field: "captionSizePt", attribute: "CaptionSize", min: 1, max: 144, caption: true },
  { field: "captionFace", attribute: "CaptionFace", min: 0, max: 255, integer: true, caption: true }
];

// Font names land in CDXML attributes and in the SVG/CSS font stack, so only plain names pass.
const safeFontName = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

const styleParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name) => name === "font"
});

/** Read the drawing settings from a CDXML file's root element and font table. Throws with the
 *  offending attribute named when the file is not CDXML or a value is not a usable style. */
export function readCdxmlDocumentStyle(contents: string): CdxmlDocumentStyleReadResult {
  const text = contents.replace(/^﻿/, "");
  const validation = XMLValidator.validate(text);
  if (validation !== true) {
    throw new Error(`The style reference is not well-formed XML: ${validation.err.msg} (line ${validation.err.line}).`);
  }
  const parsed = styleParser.parse(text) as Record<string, unknown>;
  const root = parsed.CDXML;
  if (!isRecord(root)) {
    throw new Error("The style reference is not CDXML: it has no top-level <CDXML> element.");
  }

  const style: CdxmlDocumentStyle = {};
  const missing: string[] = [];
  for (const { field, attribute, min, max, integer, caption } of numericAttributes) {
    const raw = root[attribute];
    if (typeof raw !== "string" || raw.trim() === "") {
      if (!caption) missing.push(attribute);
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new Error(`The style reference's ${attribute}="${raw}" is not a usable value (expected ${integer ? "an integer" : "a number"} from ${min} to ${max}).`);
    }
    style[field] = value;
  }

  const fonts = fontTable(root);
  const labelFont = fontNameFor(root.LabelFont, fonts, "LabelFont");
  if (labelFont === undefined) missing.push("LabelFont");
  else style.labelFontName = labelFont;
  const captionFont = fontNameFor(root.CaptionFont, fonts, "CaptionFont");
  if (captionFont !== undefined) style.captionFontName = captionFont;

  return { style, missing };
}

const cssPxPerPoint = 96 / 72;

/** The native drawing-style fields a CDXML style sets. CDXML points become CSS pixels at the
 *  same 72/96 ratio the CDXML writer uses, so exporting the styled molecule writes these exact
 *  point values back out. */
export function nativeDrawingStyleFromCdxmlStyle(style: CdxmlDocumentStyle): Partial<NativeDrawingStyle> {
  const patch: Partial<NativeDrawingStyle> = {};
  const px = (points: number) => roundStyleNumber(points * cssPxPerPoint);
  if (style.bondLengthPt !== undefined) patch.bondLengthPx = px(style.bondLengthPt);
  if (style.lineWidthPt !== undefined) patch.bondStrokeWidthPx = px(style.lineWidthPt);
  if (style.boldWidthPt !== undefined) patch.bondBoldWidthPx = px(style.boldWidthPt);
  if (style.hashSpacingPt !== undefined) patch.bondHashSpacingPx = px(style.hashSpacingPt);
  if (style.marginWidthPt !== undefined) patch.bondMarginWidthPx = px(style.marginWidthPt);
  if (style.chainAngleDegrees !== undefined) patch.chainAngleDegrees = style.chainAngleDegrees;
  if (style.bondSpacingPercent !== undefined) {
    // Percent mode, or nativeMultipleBondGapPx keeps the absolute gap and ignores the percent.
    patch.bondSpacingMode = "percent";
    patch.bondSpacingPercent = style.bondSpacingPercent;
    if (style.bondLengthPt !== undefined) {
      patch.multipleBondGapPx = roundStyleNumber(px(style.bondLengthPt) * style.bondSpacingPercent / 100);
    }
  }
  if (style.labelFontName !== undefined) patch.atomLabelFontFamily = fontStack(style.labelFontName);
  if (style.labelSizePt !== undefined) patch.atomLabelFontSizePx = px(style.labelSizePt);
  if (style.labelFace !== undefined) {
    patch.atomLabelFontWeight = (style.labelFace & 1) !== 0 ? 700 : 400;
    patch.atomLabelFontStyle = (style.labelFace & 2) !== 0 ? "italic" : "normal";
  }
  return patch;
}

/** Root-element attributes and the `<fonttable>` that declare a CDXML style, for the writer. */
export function cdxmlDocumentStyleHeader(style: CdxmlDocumentStyle): { attributes: string; fontTable: string } {
  const fontNames = [...new Set([style.labelFontName, style.captionFontName].filter((name): name is string => name !== undefined))];
  // Font ids are local to the file; start past the small ids readers reserve for system fonts.
  const fontId = (name: string) => String(3 + fontNames.indexOf(name));
  const attributes: [string, string][] = [];
  const number = (attribute: string, value: number | undefined) => {
    if (value !== undefined) attributes.push([attribute, formatPoints(value)]);
  };
  if (style.labelFontName !== undefined) attributes.push(["LabelFont", fontId(style.labelFontName)]);
  number("LabelSize", style.labelSizePt);
  number("LabelFace", style.labelFace);
  if (style.captionFontName !== undefined) attributes.push(["CaptionFont", fontId(style.captionFontName)]);
  number("CaptionSize", style.captionSizePt);
  number("CaptionFace", style.captionFace);
  number("HashSpacing", style.hashSpacingPt);
  number("MarginWidth", style.marginWidthPt);
  number("LineWidth", style.lineWidthPt);
  number("BoldWidth", style.boldWidthPt);
  number("BondLength", style.bondLengthPt);
  number("BondSpacing", style.bondSpacingPercent);
  number("ChainAngle", style.chainAngleDegrees);
  return {
    attributes: attributes.map(([name, value]) => ` ${name}="${value}"`).join(""),
    fontTable: fontNames.length === 0 ? "" : [
      "  <fonttable>",
      ...fontNames.map((name) => `    <font id="${fontId(name)}" charset="iso-8859-1" name="${escapeAttribute(name)}"/>`),
      "  </fonttable>"
    ].join("\n")
  };
}

function fontTable(root: Record<string, unknown>): Map<string, string> {
  const table = root.fonttable;
  const fonts = new Map<string, string>();
  if (!isRecord(table) || !Array.isArray(table.font)) return fonts;
  for (const font of table.font) {
    if (isRecord(font) && typeof font.id === "string" && typeof font.name === "string") fonts.set(font.id, font.name);
  }
  return fonts;
}

function fontNameFor(id: unknown, fonts: ReadonlyMap<string, string>, attribute: string): string | undefined {
  if (typeof id !== "string") return undefined;
  const name = fonts.get(id);
  if (name === undefined) {
    throw new Error(`The style reference's ${attribute}="${id}" names no font in its <fonttable>.`);
  }
  if (!safeFontName.test(name)) {
    throw new Error(`The style reference's ${attribute} font name "${name}" is not a plain font name.`);
  }
  return name;
}

function fontStack(name: string): string {
  const fallbacks = ["Arial", "Helvetica", "sans-serif"].filter((fallback) => fallback.toLowerCase() !== name.toLowerCase());
  return [name, ...fallbacks].join(", ");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatPoints(value: number): string {
  return String(Number(value.toFixed(4)));
}

function roundStyleNumber(value: number): number {
  return Number(value.toFixed(4));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
