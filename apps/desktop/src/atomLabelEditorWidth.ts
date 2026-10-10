import type { NativeDrawingStyle } from "@chemdraft/chem-core";

/**
 * Width of the inline atom-label editor (`.native-atom-label-editor`).
 *
 * The editor used to be sized in `ch`, the advance of "0". Label fonts set "O", "M" and "m" much
 * wider than "0", so a draft such as "OMe" overflowed the input, which scrolled to keep the caret
 * in view and hid the first glyph ("▯me"). The draft is measured in the editor's own font instead.
 *
 * Canvas `measureText` gives the same answer in WebKit (macOS) and WebView2 (Windows). CSS
 * `field-sizing: content` would size the input with no script, but WebKit lacks it.
 */

/** The label-style fields the editor sets its font from. */
export type AtomLabelEditorFont = Pick<
  NativeDrawingStyle,
  "atomLabelFontFamily" | "atomLabelFontSizePx" | "atomLabelFontStyle" | "atomLabelFontWeight"
>;

/** Width in CSS px of `text` set in the CSS `font` shorthand, or undefined when it cannot be measured. */
export type AtomLabelTextMeasurer = (text: string, font: string) => number | undefined;

type MeasuringContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// undefined: not created yet. null: this host has no 2D canvas (jsdom without the canvas package),
// remembered so the editor does not retry on every keystroke.
let measuringContext: MeasuringContext | null | undefined;

const UNSET_FONT = "1px serif";

function createMeasuringContext(): MeasuringContext | null {
  try {
    if (typeof OffscreenCanvas === "function") {
      const context = new OffscreenCanvas(1, 1).getContext("2d");
      if (context) {
        return context;
      }
    }
    return typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  } catch {
    return null;
  }
}

export const measureTextWithCanvas: AtomLabelTextMeasurer = (text, font) => {
  if (measuringContext === undefined) {
    measuringContext = createMeasuringContext();
  }
  if (!measuringContext) {
    return undefined;
  }
  // A canvas ignores a `font` it cannot parse and keeps the one it had (10px sans-serif when new),
  // which would measure the label too narrow. An imported family name that is not a valid CSS
  // identifier does that. Set a sentinel first, so a rejected font is seen and not measured.
  measuringContext.font = UNSET_FONT;
  const unset = measuringContext.font;
  measuringContext.font = font;
  if (measuringContext.font === unset) {
    return undefined;
  }
  const width = measuringContext.measureText(text).width;
  return Number.isFinite(width) ? width : undefined;
};

/**
 * The editor's font as a CSS `font` shorthand, at the UNSCALED size: the editor multiplies its font
 * size by `--page-scale`, and so must its width.
 */
export function atomLabelEditorFontShorthand(style: AtomLabelEditorFont): string {
  return `${style.atomLabelFontStyle} ${style.atomLabelFontWeight} ${style.atomLabelFontSizePx}px ${style.atomLabelFontFamily}`;
}

/**
 * CSS `width` for the editor holding `draft`. The editor is `box-sizing: border-box` with 1px of
 * horizontal padding on each side and no side borders, centred on the atom by
 * `translate(-50%, -50%)`, so whatever width this returns stays centred on the label anchor.
 */
export function atomLabelEditorWidth(
  draft: string,
  style: AtomLabelEditorFont,
  measure: AtomLabelTextMeasurer = measureTextWithCanvas
): string {
  // An empty draft keeps the inline width it always had. What shows is App.css's min-width
  // (0.75em), which is wider than 1ch in the label fonts.
  if (draft.length === 0) {
    return "1ch";
  }
  const textPx = measure(draft, atomLabelEditorFontShorthand(style));
  if (textPx === undefined) {
    // Nothing to measure with: size by character count, as before.
    return `${draft.length + 0.6}ch`;
  }
  // The measured text scales with the font, so with --page-scale. The 0.6ch of caret room is what
  // the old width allowed; being font-relative it also absorbs the sub-pixel differences between
  // canvas and DOM text layout at every zoom. 2px is the horizontal padding.
  return `calc(${Math.ceil(textPx * 100) / 100}px * var(--page-scale) + 0.6ch + 2px)`;
}
