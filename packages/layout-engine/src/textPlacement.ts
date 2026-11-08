import { nativeTextStyleFromObjectStyle, type TextObject } from "@chemdraft/chem-core";

/** CSS font/line-box metrics in rendered CSS pixels. The browser supplies these;
 * ink bounds (cap height, actualBoundingBoxAscent) are NOT CSS font ascent. Equal
 * leading added to ascent and descent cancels in cssTextFirstBaseline. */
export interface NativeTextCssMetrics {
  ascentPx: number;
  descentPx: number;
}

export function cssTextFirstBaseline(lineHeightPx: number, metrics: NativeTextCssMetrics): number {
  return metrics.ascentPx + (lineHeightPx - metrics.ascentPx - metrics.descentPx) / 2;
}

/** The baseline and alignment anchor used by both SVG and the live editor. Page units. */
export function planTextObjectPlacement(object: TextObject) {
  const style = nativeTextStyleFromObjectStyle(object.style);
  const alignment = style.textAlign === "center" ? 0.5 : style.textAlign === "right" ? 1 : 0;
  return {
    style,
    alignment,
    x: object.x + alignment * object.width,
    y: object.y + style.fontSizePx,
    textAnchor: alignment === 0.5 ? "middle" : alignment === 1 ? "end" : "start",
    lineAdvance: style.fontSizePx * style.lineHeight + style.paragraphSpacingPx
  } as const;
}

/** Transient chrome only: never changes the stored frame. There is no layout border
 * or padding: the editor outline paints without moving the text's alignment anchor.
 * The historical fit allowance (0.5 page units + 4 screen px) is retained for input
 * fit and cancels out of the alignment anchor. The SVG preview uses the frame's
 * viewport; the transparent input's line box is placed at the same baseline. */
export function planTextObjectEditorPlacement(
  object: TextObject,
  scale: number,
  contentWidth: number,
  metrics: NativeTextCssMetrics,
  viewportOffset = { x: 0, y: 0 }
) {
  const placement = planTextObjectPlacement(object);
  const fixedWidth = object.style.textBoxSizingMode === "fixed-width" || object.style.textBoxSizingMode === "fixed-size";
  // Keep even empty/imported fixed-size boxes clickable. Grow around the same
  // horizontal anchor, never by padding that would displace the text.
  const width = Math.max(24, fixedWidth ? object.width * scale
    : Math.max(object.width * scale, (contentWidth + 0.5) * scale + 4));
  const growth = width - object.width * scale;
  const lineHeight = placement.lineAdvance * scale;
  const top = (placement.y - object.y) * scale - cssTextFirstBaseline(lineHeight, metrics);
  const minimumHeight = Math.max(lineHeight, metrics.ascentPx + metrics.descentPx);
  const height = Math.max(object.height * scale, minimumHeight);
  const frameHeight = Math.max(height, top + minimumHeight);
  return {
    frame: {
      left: viewportOffset.x + object.x * scale - placement.alignment * growth,
      top: viewportOffset.y + object.y * scale,
      width,
      height: frameHeight,
      originX: object.width * scale / 2 + placement.alignment * growth,
      originY: object.height * scale / 2
    },
    content: {
      left: 0,
      top,
      width,
      height,
      padding: 0,
      borderWidth: 0,
      boxSizing: "border-box" as const,
      fontSize: placement.style.fontSizePx * scale,
      lineHeight: `${lineHeight}px`,
      textAlign: placement.style.textAlign
    },
    // Paint the live glyphs with the canvas SVG renderer. HTML line layout can
    // snap a baseline/aligned run to a different pixel even when its measured
    // origin agrees with SVG. Keep this viewport in page units, without rounding
    // to either CSS or device pixels; DPR must not enter placement geometry.
    preview: {
      style: { left: 0, top: 0, width, height: frameHeight },
      viewBox: [object.x - placement.alignment * growth / scale, object.y,
        width / scale, frameHeight / scale].join(" ")
    }
  };
}
