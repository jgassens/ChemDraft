/** Native text estimates for the default Arial/Helvetica stack. Ink metrics are em fractions;
 * SVG's font-dependent sub/super baseline shifts are bounded conservatively in script em. */
export const nativeTextMetrics = {
  descentEm: 0.21,
  capHeightEm: 0.716,
  scriptFontScale: 0.72,
  scriptBaselineShiftEm: 0.6
} as const;

export function nativeTextCharacterWidthFactor(character: string): number {
  if (character === "\t") return 1.6;
  if (character.trim().length === 0) return 0.34;
  if ("ilI.,:;!|".includes(character)) return 0.28;
  if ("mwMW@#%&".includes(character)) return 0.82;
  if (/[A-Z0-9]/.test(character)) return 0.62;
  return 0.54;
}
