/** Native text estimates for the default Arial/Helvetica stack. Ink metrics are em fractions.
 * SVG sub/super shifts use the font's offsets at the script size: Arial's OS/2
 * ySubscriptYOffset/ySuperscriptYOffset are 283/977 with 2048 units per em. */
export const nativeTextMetrics = {
  descentEm: 0.21,
  capHeightEm: 0.716,
  scriptFontScale: 0.72,
  subscriptBaselineShiftEm: 283 / 2048,
  superscriptBaselineShiftEm: 977 / 2048
} as const;

export function nativeTextCharacterWidthFactor(character: string): number {
  if (character === "\t") return 1.6;
  if (character.trim().length === 0) return 0.34;
  if ("ilI.,:;!|".includes(character)) return 0.28;
  if ("mwMW@#%&".includes(character)) return 0.82;
  if (/[A-Z0-9]/.test(character)) return 0.62;
  return 0.54;
}
