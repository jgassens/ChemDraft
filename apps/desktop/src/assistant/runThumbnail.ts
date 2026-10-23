import type { ChemDraftDocument, DocumentObject } from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import {
  moleculeVisualBoundsForArrangement, textVisualBoundsForArrangement, planNativeArtVisual,
  type LayoutBounds
} from "@chemdraft/layout-engine";
import { rotatedGraphicLocalBounds } from "../graphicHandleGeometry";

/** Transcript preview only: never changes coordinates or chemistry in the source document. */
export function runThumbnail(document: ChemDraftDocument, touchedIds: readonly string[]): string | undefined {
  const touched = new Set(touchedIds);
  const regions = document.pages.flatMap((page, pageIndex) => {
    const bounds = page.objects.filter(object => touched.has(object.id)).map(objectBounds);
    if (!bounds.length) return [];
    const x = Math.min(...bounds.map(bound => bound.x)) - 12;
    const y = Math.min(...bounds.map(bound => bound.y)) - 12;
    const width = Math.max(...bounds.map(bound => bound.x + bound.width)) + 12 - x;
    const height = Math.max(...bounds.map(bound => bound.y + bound.height)) + 12 - y;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
    const exported = exportDocumentToSvg(document, { pageIndex, background: "transparent" }).contents;
    const body = exported.slice(exported.indexOf(">") + 1, exported.lastIndexOf("</svg>"));
    return [{ x, y, width, height, body }];
  });
  if (!regions.length) return undefined;
  // Multiple touched pages have independent coordinates; stack their crops in the transcript.
  const width = Math.max(...regions.map(region => region.width));
  const height = regions.reduce((sum, region) => sum + region.height, 0);
  const scale = Math.min(1, 1600 / Math.max(width, height));
  let top = 0;
  const body = regions.map(region => {
    const markup = `<svg x="0" y="${top}" width="${region.width}" height="${region.height}" viewBox="${region.x} ${region.y} ${region.width} ${region.height}">${region.body}</svg>`;
    top += region.height;
    return markup;
  }).join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width * scale} ${height * scale}" role="img" aria-label="Assistant changes"><rect width="100%" height="100%" fill="white"/><g transform="scale(${scale})">${body}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function objectBounds(object: DocumentObject): LayoutBounds {
  if (object.type === "molecule") return moleculeVisualBoundsForArrangement(object);
  if (object.type === "text") return textVisualBoundsForArrangement(object);
  if (object.type === "graphic") {
    const frame = planNativeArtVisual(object, { coordinateSpace: "local" }).frameBounds;
    const rotated = rotatedGraphicLocalBounds(object, frame, object.rotation);
    return { ...rotated, x: object.x + rotated.x, y: object.y + rotated.y };
  }
  return object;
}
