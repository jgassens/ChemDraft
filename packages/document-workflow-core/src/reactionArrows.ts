// Native reaction arrow creation and insertion.
// Moved verbatim from apps/desktop/src/documentWorkflow.ts; see this package's README.

import { applyPatches, type ArrowObject, type ChemDraftDocument } from "@chemdraft/chem-core";
import { firstPage, nextObjectId, type PagePoint, phase4Timestamp } from "./shared";

/** Cross-axis minimum for an arrow's frame. The widest glyph (equilibrium) reaches 7.5 px either
 *  side of the shaft, so a 24 px box keeps heads, transform handles, and align/marquee bounds
 *  around the drawing even when the arrow is axis-aligned. */
export const nativeReactionArrowMinExtentPx = 24;

export function createNativeReactionArrow(
  document: ChemDraftDocument,
  startPoint: PagePoint,
  endPoint: PagePoint,
  arrowKind: ArrowObject["arrowKind"]
): ArrowObject {
  const minX = Math.min(startPoint.x, endPoint.x);
  const maxX = Math.max(startPoint.x, endPoint.x);
  const minY = Math.min(startPoint.y, endPoint.y);
  const maxY = Math.max(startPoint.y, endPoint.y);
  const width = Math.max(maxX - minX, nativeReactionArrowMinExtentPx);
  const height = Math.max(maxY - minY, nativeReactionArrowMinExtentPx);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  return {
    id: nextObjectId(document, "arrow"),
    type: "reaction-arrow",
    x: midX - width / 2,
    y: midY - height / 2,
    width,
    height,
    rotation: 0,
    style: {},
    arrowKind,
    start: { kind: "point", point: { x: startPoint.x, y: startPoint.y } },
    end: { kind: "point", point: { x: endPoint.x, y: endPoint.y } },
    labels: [],
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    }
  };
}

export function insertNativeReactionArrow(
  document: ChemDraftDocument,
  startPoint: PagePoint,
  endPoint: PagePoint,
  arrowKind: ArrowObject["arrowKind"]
): ChemDraftDocument {
  const page = firstPage(document);
  const object = createNativeReactionArrow(document, startPoint, endPoint, arrowKind);

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}
