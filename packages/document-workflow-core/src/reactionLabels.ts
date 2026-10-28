import {
  nativeTextStyleFromObjectStyle,
  textStyleToObjectStyle,
  type ArrowObject,
  type NativeTextStyle,
  type TextObject,
  type TextSpan
} from "@chemdraft/chem-core";
import { reactionArrowVerticalExtent } from "@chemdraft/layout-engine";
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
const arrowTextPaddingInBonds = 0.5;
const arrowClearanceEm = 0.35;
const captionClearanceEm = 0.8;
const minimumCaptionWidthInBonds = 8;
const defaultLabelStyle: Partial<NativeTextStyle> = { fontSizePx: 14, textAlign: "center" };

function lineSpans(text: string): TextSpan[] {
  return formulaSpansForMixedText(text) ?? [{ text, script: "normal", style: {} }];
}

function explicitLines(entries: readonly string[], style: NativeTextStyle, maxWidth: number): string[] {
  return entries.flatMap((entry) => entry.replace(/\r\n?/g, "\n").split("\n"))
    .map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      if (estimateNativeTextSpanLineWidth(lineSpans(line), style) <= maxWidth) return [line];
      const lines: string[] = [];
      let current = "";
      // Keep whitespace as authored except at an inserted line break. A token is indivisible.
      for (const match of line.matchAll(/\S+\s*/g)) {
        const candidate = current + match[0];
        if (current && estimateNativeTextSpanLineWidth(lineSpans(candidate.trimEnd()), style) > maxWidth) {
          lines.push(current.trimEnd());
          current = match[0];
        } else current = candidate;
      }
      if (current) lines.push(current.trimEnd());
      return lines;
    });
}

function measureBlock(entries: readonly string[], style: NativeTextStyle, maxWidth: number, caption = false): LabelBlock | undefined {
  const lines = explicitLines(entries, style, maxWidth);
  if (!lines.length) return undefined;
  const spanLines = lines.map(lineSpans);
  const spans = spanLines.flatMap((line, index): TextSpan[] => index === 0
    ? line : [{ text: "\n", script: "normal", style: {} }, ...line]);
  return {
    text: lines.join("\n"),
    spans,
    style: { ...style, textAlign: !caption && lines.every((line) => /^\d+\.\s/.test(line)) ? "left" : "center" },
    size: nativeTextObjectSizeForSpanLines(spanLines, style)
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
      Math.max(above?.size.width ?? 0, below?.size.width ?? 0) + arrowTextPaddingInBonds * options.bondLength)
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
  const extent = reactionArrowVerticalExtent(plan.options.arrowKind, plan.arrowLength);
  const clearance = arrowClearanceEm * plan.textStyle.fontSizePx;
  const object = (block: LabelBlock, id: string, center: number, y: number): TextObject => ({
    id, type: "text", x: center - block.size.width / 2, y,
    width: block.size.width, height: block.size.height, rotation: 0,
    style: { ...textStyleToObjectStyle(block.style), textBoxSizingMode: "auto" },
    compatibility: { sourceFormat: "chemdraft-native", warnings: [], unknown: {} },
    text: block.text, spans: block.spans
  });
  const above = plan.above ? object(plan.above, `${idPrefix}_above`, midpoint.x,
    midpoint.y + extent.top - clearance - plan.above.size.lineBoxHeight) : undefined;
  const below = plan.below ? object(plan.below, `${idPrefix}_below`, midpoint.x,
    midpoint.y + extent.bottom + clearance) : undefined;
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
