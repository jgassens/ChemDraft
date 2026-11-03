// Native text object sizing and insertion.
// Moved verbatim from apps/desktop/src/documentWorkflow.ts; see this package's README.

import {
  applyPatches,
  type ChemDraftDocument,
  type NativeTextStyle,
  nativeTextStyleFromObjectStyle,
  type TextObject,
  type TextSpan,
  textStyleToObjectStyle
} from "@chemdraft/chem-core";
import { measureNativeTextSpanLineWidth, textObjectSpanLines } from "@chemdraft/layout-engine";
import { clamp, firstPage, nextObjectId, type PagePoint, phase4Timestamp } from "./shared";

export const nativeTextObjectDimensions = {
  width: 240,
  height: 56
} as const;

export const nativeTextObjectMinimumDimensions = {
  width: 36,
  height: 24
} as const;

const nativeTextBoxHorizontalPadding = 6;

const nativeTextBoxVerticalPadding = 4;

export function nativeTextObjectSizeForText(
  text: string,
  style: Record<string, unknown> | Partial<NativeTextStyle> = {},
  options: { width?: number; height?: number; maxWidth?: number; maxHeight?: number; spans?: TextSpan[] } = {}
): { width: number; height: number } {
  const textStyle = nativeTextStyleFromObjectStyle(style);
  const paragraphs = normalizeTextLines(text);
  const plainLineWidths = paragraphs.map(line => estimateNativeTextLineWidth(line, textStyle));
  // This path historically sized unformatted text. Keep that floor when spans are supplied,
  // so smaller/script runs cannot shrink a box compared with its previous sizing behavior.
  const lineWidths = options.spans
    ? textObjectSpanLines({ text, spans: options.spans }).map((line, index) =>
      Math.max(plainLineWidths[index] ?? 0, estimateNativeTextSpanLineWidth(line, textStyle)))
    : plainLineWidths;
  const lineHeightPx = textStyle.fontSizePx * textStyle.lineHeight;
  const naturalContentWidth = Math.max(
    ...lineWidths,
    nativeTextObjectMinimumDimensions.width - nativeTextBoxHorizontalPadding
  );
  const maxWidth = options.maxWidth ?? nativeTextObjectDimensions.width;
  const width = clamp(
    options.width ?? naturalContentWidth + nativeTextBoxHorizontalPadding,
    nativeTextObjectMinimumDimensions.width,
    Math.max(nativeTextObjectMinimumDimensions.width, maxWidth)
  );
  const wrappedLineCount = lineWidths.reduce((count, lineWidth) => (
    count + Math.max(1, Math.ceil(lineWidth / Math.max(1, width - nativeTextBoxHorizontalPadding)))
  ), 0);
  const paragraphSpacing = Math.max(0, paragraphs.length - 1) * textStyle.paragraphSpacingPx;
  const naturalHeight = clamp(
    wrappedLineCount * lineHeightPx + paragraphSpacing + nativeTextBoxVerticalPadding,
    nativeTextObjectMinimumDimensions.height,
    Number.MAX_SAFE_INTEGER
  );
  const height = clamp(
    options.height ?? naturalHeight,
    nativeTextObjectMinimumDimensions.height,
    Math.max(nativeTextObjectMinimumDimensions.height, options.maxHeight ?? Number.MAX_SAFE_INTEGER)
  );

  return {
    width: roundToTextBoxPixel(width),
    height: roundToTextBoxPixel(height)
  };
}

/** Measure formatted conditions with the same character metrics as native text sizing.
 * SVG text breaks only at authored newlines; never claim a long line wrapped inside a capped box. */
export function nativeFormattedTextObjectSize(object: Pick<TextObject, "text" | "spans" | "style">): { width: number; height: number } {
  return nativeTextObjectSizeForText(object.text, object.style, {
    spans: object.spans,
    maxWidth: Number.MAX_SAFE_INTEGER
  });
}

export function createNativeTextObject(
  document: ChemDraftDocument,
  point: PagePoint,
  text = "Text",
  style: Partial<NativeTextStyle> = {}
): TextObject {
  const page = firstPage(document);
  const resolvedText = text.length > 0 ? text : "Text";
  const objectStyle = textStyleToObjectStyle(style);
  const size = nativeTextObjectSizeForText(resolvedText, objectStyle, {
    maxWidth: Math.max(nativeTextObjectMinimumDimensions.width, page.width - point.x)
  });
  const width = size.width;
  const height = size.height;

  return {
    id: nextObjectId(document, "text"),
    type: "text",
    x: clamp(point.x, 0, Math.max(0, page.width - width)),
    y: clamp(point.y, 0, Math.max(0, page.height - height)),
    width,
    height,
    rotation: 0,
    style: {
      ...objectStyle,
      textBoxSizingMode: "auto"
    },
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    },
    text: resolvedText,
    spans: [{ text: resolvedText, script: "normal", style: {} }]
  };
}

export function insertNativeTextObject(
  document: ChemDraftDocument,
  point: PagePoint,
  text = "Text",
  style: Partial<NativeTextStyle> = {}
): ChemDraftDocument {
  const page = firstPage(document);
  const object = createNativeTextObject(document, point, text, style);

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

function normalizeTextLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines.length > 0 ? lines : [""];
}

export function estimateNativeTextLineWidth(line: string, style: NativeTextStyle): number {
  if (line.length === 0) {
    return style.fontSizePx * 0.5;
  }

  return estimateNativeTextSpanLineWidth([{ text: line, script: "normal", style: {} }], style);
}

/** Matches the shared SVG renderer: scripts are 72% of the object's font size, while normal
 * spans may override their font size. Letter spacing continues across span boundaries. */
export function estimateNativeTextSpanLineWidth(spans: readonly TextSpan[], style: NativeTextStyle): number {
  return measureNativeTextSpanLineWidth(spans, style);
}

/** Sizes explicit rendered lines, with no implicit wrapping or maximum-width clamp. The line
 * box starts at object.y, as in planTextObjectSvg; the box's padding follows its content. */
export function nativeTextObjectSizeForSpanLines(
  lines: readonly (readonly TextSpan[])[],
  style: NativeTextStyle
): { width: number; height: number; lineBoxHeight: number; contentWidth: number } {
  const contentWidth = Math.max(0, ...lines.map((line) => estimateNativeTextSpanLineWidth(line, style)));
  const lineBoxHeight = lines.length * style.fontSizePx * style.lineHeight
    + Math.max(0, lines.length - 1) * style.paragraphSpacingPx;
  return {
    width: roundToTextBoxPixel(Math.max(nativeTextObjectMinimumDimensions.width, contentWidth + nativeTextBoxHorizontalPadding)),
    height: roundToTextBoxPixel(Math.max(nativeTextObjectMinimumDimensions.height, lineBoxHeight + nativeTextBoxVerticalPadding)),
    lineBoxHeight,
    contentWidth
  };
}

function roundToTextBoxPixel(value: number): number {
  return Math.round(value * 100) / 100;
}
