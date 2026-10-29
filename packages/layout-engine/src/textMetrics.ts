/** Explicit SVG script metrics. Offsets are in PARENT em, independent of script size.
 * WebKit/Chromium's historical sub/super placement was approximately this offset;
 * explicit sizes and coordinates also work in svg2pdf without host font metrics. */
export const nativeTextScriptFontScale = 0.72;
export const nativeTextSubscriptOffsetEm = 0.4;
export const nativeTextSuperscriptOffsetEm = nativeTextSubscriptOffsetEm;

/** Native text estimates for the default Arial/Helvetica stack. Ink metrics are em fractions. */
export const nativeTextMetrics = {
  descentEm: 0.21,
  capHeightEm: 0.716
} as const;

export function nativeTextCharacterWidthFactor(character: string): number {
  if (character === "\t") return 1.6;
  if (character.trim().length === 0) return 0.34;
  if ("ilI.,:;!|".includes(character)) return 0.28;
  if ("mwMW@#%&".includes(character)) return 0.82;
  if (/[A-Z0-9]/.test(character)) return 0.62;
  return 0.54;
}
