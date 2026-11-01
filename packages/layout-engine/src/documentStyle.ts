/** Physical contract for the fixed document style. Native coordinates remain canvas units. */
export const DocumentStyleScale = {
  pointsPerUnit: 14.4 / 22,
  marginPt: 4,
  defaultDpi: 300,
  minDpi: 72,
  maxDpi: 1200,
  pointsPerInch: 72
} as const;

/** Convert native canvas bounds to the point-space SVG viewport without fitting. */
export function documentStylePointBounds(bounds: { x: number; y: number; width: number; height: number }) {
  const scale = DocumentStyleScale.pointsPerUnit;
  return { x: bounds.x * scale, y: bounds.y * scale, width: bounds.width * scale, height: bounds.height * scale };
}

export const FigureStyles = ["fit", "document"] as const;
export type FigureStyle = typeof FigureStyles[number];
