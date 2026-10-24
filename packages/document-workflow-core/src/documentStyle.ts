import { DocumentMoleculeSizeStyle, DocumentStylePreset, DocumentTextStyle, applyPatches,
  type ChemDraftDocument, type CompatibilityWarning, type NativeDrawingStyle } from "@chemdraft/chem-core";
import { medianLength, representativeMoleculeBondLength, scalePageGeometry } from "@chemdraft/layout-engine";
import { applyMoleculeTargetBondLength } from "./molecule";
import { phase4Timestamp } from "./shared";

/** Scale the first page as one figure, then set only the fixed document dimensions.
 * Exporters alone convert native canvas units to points. Later pages remain unchanged.
 */
export function applyDocumentStyle(document: ChemDraftDocument, warnings: CompatibilityWarning[] = []): ChemDraftDocument {
  const page = document.pages[0];
  if (!page) return document;
  const lengths = page.objects.flatMap((object) => {
    const length = object.type === "molecule" ? representativeMoleculeBondLength(object) : undefined;
    return length === undefined ? [] : [length];
  });
  const representative = medianLength(lengths);
  if (lengths.length > 1 && Math.max(...lengths) / Math.min(...lengths) > 1.02) {
    warnings.push({ code: "document_style.mixed_bond_lengths",
      message: `Mixed molecule bond lengths differ by more than 2%; using the median across molecules (${Number(representative!.toFixed(2))} native units) to scale the whole page uniformly. Individual bond lengths remain proportional.` });
  }
  const scaled = scalePageGeometry(page, representative === undefined ? 1 : DocumentStylePreset.drawing.bondLengthPx / representative);
  return { ...document, pages: [{ ...scaled, objects: scaled.objects.map((object) => {
    if (object.type === "molecule") return { ...object, style: { ...object.style, ...DocumentMoleculeSizeStyle } };
    if (object.type === "text") return { ...object,
      style: { ...object.style, fontFamily: DocumentTextStyle.fontFamily,
        fontSizePx: object.style.fontSizePx ?? DocumentTextStyle.fontSizePx },
      spans: object.spans.map((span) => ({ ...span, style: { ...span.style, fontFamily: DocumentTextStyle.fontFamily } })) };
    if (object.type === "graphic" && object.graphicKind !== "image") {
      return { ...object, style: { ...object.style,
        strokeWidth: object.style.strokeWidth ?? DocumentStylePreset.drawing.bondStrokeWidthPx } };
    }
    if (object.type === "reaction-arrow" || object.type === "mechanism-arrow") {
      return { ...object, style: { ...object.style, strokeWidth: DocumentStylePreset.drawing.bondStrokeWidthPx } };
    }
    return object;
  }) }, ...document.pages.slice(1)] };
}

/** Give the listed molecules a drawing style taken from elsewhere (a CDXML style reference):
 * scale each to the style's bond length, then set the style's fields. Only geometry and display
 * change; atoms, bonds, charges and stereo are untouched.
 */
export function applyMoleculeDrawingStyle(
  document: ChemDraftDocument,
  moleculeObjectIds: readonly string[],
  drawingStyle: Partial<NativeDrawingStyle>
): ChemDraftDocument {
  const scaled = drawingStyle.bondLengthPx === undefined ? document
    : applyMoleculeTargetBondLength(document, moleculeObjectIds, drawingStyle.bondLengthPx);
  const targetIds = new Set(moleculeObjectIds);
  const patches = scaled.pages.flatMap((page) => page.objects.flatMap((object) =>
    object.type === "molecule" && targetIds.has(object.id)
      ? [{ op: "updateObject" as const, objectId: object.id, changes: { style: { ...object.style, ...drawingStyle } } }]
      : []));
  return patches.length > 0 ? applyPatches(scaled, patches, { now: phase4Timestamp }) : scaled;
}
