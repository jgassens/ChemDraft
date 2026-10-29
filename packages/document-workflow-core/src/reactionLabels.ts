import {
  nativeTextStyleFromObjectStyle,
  textStyleToObjectStyle,
  type ArrowObject,
  type NativeTextStyle,
  type TextObject,
  type TextSpan
} from "@chemdraft/chem-core";
import {
  nativeTextMetrics, nativeTextScriptFontScale, nativeTextSubscriptBottomEm, nativeTextSuperscriptOffsetEm,
  reactionArrowHeadDepthPx, reactionArrowVerticalExtent
} from "@chemdraft/layout-engine";
import { formulaSpansForMixedText } from "./formulaText";
import { estimateNativeTextSpanLineWidth, nativeTextObjectSizeForSpanLines } from "./textObjects";

export interface ReactionLabelsOptions {
  above: readonly string[];
  below: readonly string[];
  caption?: string;
  textStyle?: Partial<NativeTextStyle>;
  bondLength: number;
  arrowKind: ArrowObject["arrowKind"];
}

interface LabelBlock {
  text: string;
  spans: TextSpan[];
  style: NativeTextStyle;
  size: ReturnType<typeof nativeTextObjectSizeForSpanLines>;
  ink: Array<{ top: number; bottom: number }>;
}

export interface ReactionLabelsPlan {
  arrowLength: number;
  above?: LabelBlock;
  below?: LabelBlock;
  options: ReactionLabelsOptions;
  textStyle: NativeTextStyle;
}

// Journal-scheme policy, in bond lengths or em so it follows the caller's drawing scale.
const labelWidthInBonds = 10;
const minimumArrowInBonds = 2.5;
const arrowHeadClearanceEm = 0.25;
const arrowClearanceEm = 0.3;
const scriptLineClearanceEm = 0.12;
const captionClearanceEm = 0.8;
const minimumCaptionWidthInBonds = 8;
const defaultLabelStyle: Partial<NativeTextStyle> = { fontSizePx: 14, textAlign: "center" };

function lineSpans(text: string, caption = false): TextSpan[] {
  const spans = (!caption && formulaSpansForMixedText(text)) || [{ text, script: "normal", style: {} }];
  return spans.reduce<TextSpan[]>((runs, span) => {
    const previous = runs.at(-1);
    if (previous && previous.script === span.script &&
      Object.keys(previous.style).length === Object.keys(span.style).length &&
      Object.entries(previous.style).every(([key, value]) => value === span.style[key])) {
      previous.text += span.text;
    } else runs.push({ ...span });
    return runs;
  }, []);
}

function explicitLines(entries: readonly string[]): string[] {
  return entries.flatMap((entry) => entry.replace(/\r\n?/g, "\n").split("\n"))
    .map((line) => line.replace(/^[ \t]+|[ \t]+$/g, "")).filter(Boolean);
}

function wrapLines(authoredLines: readonly string[], style: NativeTextStyle, maxWidth: number, caption: boolean): string[] {
  return authoredLines.flatMap((line) => {
    if (estimateNativeTextSpanLineWidth(lineSpans(line, caption), style) <= maxWidth) return [line];
    const lines: string[] = [];
    let current = "";
    // Break only at spaces/tabs; NBSP and narrow NBSP stay inside indivisible tokens.
    for (const match of line.matchAll(/[^ \t]+[ \t]*/g)) {
      const candidate = current + match[0];
      if (current && estimateNativeTextSpanLineWidth(lineSpans(candidate.replace(/[ \t]+$/, ""), caption), style) > maxWidth) {
        lines.push(current.replace(/[ \t]+$/, ""));
        current = match[0];
      } else current = candidate;
    }
    if (current) lines.push(current.replace(/[ \t]+$/, ""));
    return lines;
  });
}

function measureBlock(entries: readonly string[], style: NativeTextStyle, maxWidth: number, caption = false): LabelBlock | undefined {
  const authoredLines = explicitLines(entries);
  const lines = wrapLines(authoredLines, style, maxWidth, caption);
  if (!lines.length) return undefined;
  const spanLines = lines.map((line) => lineSpans(line, caption));
  const spans = spanLines.flatMap((line, index): TextSpan[] => index === 0
    ? line : [{ text: "\n", script: "normal", style: {} }, ...line]);
  const { descentEm, capHeightEm } = nativeTextMetrics;
  const ink = spanLines.map(line => ({
    bottom: Math.max(descentEm, ...line.filter(span => span.script === "subscript")
      .map(span => nativeTextSubscriptBottomEm(span.text))),
    top: line.some(span => span.script === "superscript")
      ? Math.max(capHeightEm, nativeTextSuperscriptOffsetEm + nativeTextScriptFontScale * capHeightEm) : capHeightEm
  }));
  // One advance per object, sized for its tightest adjacent pair. Paragraph spacing
  // contributes to that advance in the renderer and must not be reserved twice.
  let lineHeight = Math.max(1.2, style.lineHeight);
  for (let index = 1; index < ink.length; index++) {
    lineHeight = Math.max(lineHeight, ink[index - 1]!.bottom + ink[index]!.top
      + scriptLineClearanceEm - style.paragraphSpacingPx / style.fontSizePx);
  }
  const blockStyle = {
    ...style,
    lineHeight,
    textAlign: !caption && authoredLines.every((line) => /^\d+\.\s/.test(line)) ? "left" as const : "center" as const
  };
  return {
    text: lines.join("\n"),
    spans,
    ink,
    style: blockStyle,
    size: nativeTextObjectSizeForSpanLines(spanLines, blockStyle)
  };
}

/** Plans explicit lines and measures each block once, before molecule placement needs its arrow. */
export function planReactionLabels(options: ReactionLabelsOptions): ReactionLabelsPlan {
  const textStyle = nativeTextStyleFromObjectStyle({ ...defaultLabelStyle, ...options.textStyle });
  const maxWidth = labelWidthInBonds * options.bondLength;
  const above = measureBlock(options.above, textStyle, maxWidth);
  const below = measureBlock(options.below, textStyle, maxWidth);
  return {
    options, textStyle, above, below,
    arrowLength: Math.max(minimumArrowInBonds * options.bondLength,
      Math.max(above?.size.contentWidth ?? 0, below?.size.contentWidth ?? 0)
        + 2 * (reactionArrowHeadDepthPx(options.arrowKind) + arrowHeadClearanceEm * textStyle.fontSizePx))
  };
}

/** Places the measured blocks without another sizing pass. schemeBounds includes molecules,
 * plus signs and the arrow; the caption is centred beneath that complete horizontal extent. */
export function layoutReactionLabels(
  plan: ReactionLabelsPlan,
  placement: {
    arrowMidpoint: { x: number; y: number };
    schemeBounds: { minX: number; minY: number; maxX: number; maxY: number };
    idPrefix: string;
  }
): { above?: TextObject; below?: TextObject; caption?: TextObject } {
  const { arrowMidpoint: midpoint, schemeBounds, idPrefix } = placement;
  const extent = reactionArrowVerticalExtent(plan.options.arrowKind, plan.arrowLength, "shafts");
  const clearance = arrowClearanceEm * plan.textStyle.fontSizePx;
  const object = (block: LabelBlock, id: string, center: number, y: number): TextObject => ({
    // Left-aligned text starts at object.x; the box's trailing padding is not visible text.
    id, type: "text", x: center - (block.style.textAlign === "left" ? block.size.contentWidth : block.size.width) / 2, y,
    width: block.size.width, height: block.size.height, rotation: 0,
    style: { ...textStyleToObjectStyle(block.style), textBoxSizingMode: "auto" },
    compatibility: { sourceFormat: "chemdraft-native", warnings: [], unknown: {} },
    text: block.text, spans: block.spans
  });
  // Subtract all advances before the last above baseline; below, place the first ink top.
  const above = plan.above ? object(plan.above, `${idPrefix}_above`, midpoint.x,
    midpoint.y + extent.top - clearance - plan.above.ink.at(-1)!.bottom * plan.above.style.fontSizePx
      - plan.above.style.fontSizePx - (plan.above.size.lineBoxHeight
        - plan.above.style.fontSizePx * plan.above.style.lineHeight)) : undefined;
  const below = plan.below ? object(plan.below, `${idPrefix}_below`, midpoint.x,
    midpoint.y + extent.bottom + clearance
      + (plan.below.ink[0]!.top - 1) * plan.below.style.fontSizePx) : undefined;
  const minX = Math.min(schemeBounds.minX, above?.x ?? Infinity, below?.x ?? Infinity);
  const maxX = Math.max(schemeBounds.maxX, above ? above.x + above.width : -Infinity,
    below ? below.x + below.width : -Infinity);
  const captionBlock = measureBlock(plan.options.caption ? [plan.options.caption] : [], plan.textStyle,
    Math.max(maxX - minX, minimumCaptionWidthInBonds * plan.options.bondLength), true);
  const caption = captionBlock ? object(captionBlock, `${idPrefix}_caption`, (minX + maxX) / 2,
    Math.max(schemeBounds.maxY, below ? below.y + below.height : -Infinity,
      above ? above.y + above.height : -Infinity) + captionClearanceEm * plan.textStyle.fontSizePx) : undefined;
  return { above, below, caption };
}
