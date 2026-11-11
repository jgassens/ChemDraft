import type { Point } from "@chemdraft/chem-core";

const cssPxPerInch = 96;
const cdxmlPointsPerInch = 72;
const cdxmlScale = cdxmlPointsPerInch / cssPxPerInch;

/** CDXML 2D positions are "x y" — see the CDXCoordinates note that the y-first order belongs to
 *  BINARY CDX, not CDXML. ChemDraft wrote y-first through codec v1; v2 writes spec order, and a v1
 *  file's visible layer is transposed on import (see transposeImportedObject in index.ts). */
export function formatPoint(point: Point): string {
  return `${formatNumber(cssPxToCdxml(point.x))} ${formatNumber(cssPxToCdxml(point.y))}`;
}

export function cssPxToCdxml(value: number): number {
  return value * cdxmlScale;
}

export function cdxmlToCssPx(value: number): number {
  return value / cdxmlScale;
}

export function formatNumber(value: number): string {
  const fixed = value.toFixed(4);
  return fixed.replace(/\.?0+$/, "") || "0";
}
