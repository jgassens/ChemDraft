/** SVG number formatting shared by layout renderers; preserves the historical -0 handling. */
export function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}
