import { stylePresetToObjectStyle, type ChemDraftDocument } from "@chemdraft/chem-core";
import { DocumentStylePreset, DocumentTextStyle } from "@chemdraft/layout-engine";
import { applyMoleculeTargetBondLength } from "./molecule";
import { nativeTextObjectSizeForText } from "./textObjects";

/** Apply the physical figure preset without changing the molecular graph or relative bond lengths.
 * Positions stay in native canvas units; exporters alone convert those units to points.
 */
export function applyDocumentStyle(document: ChemDraftDocument): ChemDraftDocument {
  const ids = document.pages.flatMap((page) => page.objects.filter((object) => object.type === "molecule").map((object) => object.id));
  const scaled = applyMoleculeTargetBondLength(document, ids, DocumentStylePreset.drawing.bondLengthPx);
  return {
    ...scaled,
    pages: scaled.pages.map((page) => ({
      ...page,
      objects: page.objects.map((object) => {
        if (object.type === "molecule") {
          // Per-bond/atom size overrides must not defeat a requested fixed physical style.
          const style = { ...object.style, ...stylePresetToObjectStyle(DocumentStylePreset) };
          for (const key of ["bondLengths", "bondStrokeWidths", "bondBoldWidths", "bondSpacingModes",
            "bondSpacingPercents", "bondMultipleBondGaps", "bondMarginWidths", "bondHashSpacings",
            "atomLabelFontFamilies", "atomLabelFontSizes"]) delete style[key];
          return { ...object, style };
        }
        if (object.type === "text") {
          const style = { ...object.style, ...DocumentTextStyle };
          const size = nativeTextObjectSizeForText(object.text, style, { width: object.width });
          return {
            ...object, style, ...size,
            spans: object.spans.map((span) => ({ ...span, style: { ...span.style, ...DocumentTextStyle } }))
          };
        }
        return object;
      })
    }))
  };
}
