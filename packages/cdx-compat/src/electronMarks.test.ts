import { describe, expect, it } from "vitest";
import { createEmptyDocument, type ElectronMarkObject } from "@chemdraft/chem-core";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

describe("electron-mark CDXML appearance warnings", () => {
  it.each(["Doublet", "Triplet"])("exports imported %s dots without loss warnings until their appearance changes", radical => {
    const source = `<CDXML><page><fragment id="1"><n id="2" p="100 100" Element="6" Radical="${radical}"/></fragment></page></CDXML>`;
    const imported = openChemDraftPayload(source).document!;
    const binaryImported = importCdx(exportDocumentToCdx(imported, { embedNativePayload: false }).bytes).document!;
    for (const document of [imported, binaryImported]) {
      for (const embedNativePayload of [false, true]) {
        for (const format of ["CDXML", "CDX"] as const) {
          const exportDocument = (value: typeof document) => format === "CDXML"
            ? exportDocumentToCdxml(value, { embedNativePayload }) : exportDocumentToCdx(value, { embedNativePayload });
          // Synthesized dots carry Radical, while edited appearance still needs loss diagnostics.
          expect(exportDocument(document).warnings).toEqual([]);
          const edits: ((mark: ElectronMarkObject) => void)[] = [
            mark => { mark.x += 5; },
            mark => { mark.y += 5; },
            mark => { mark.width += 5; },
            mark => { mark.height += 5; },
            mark => { mark.rotation = 15; },
            mark => { mark.style.strokeWidth = 3; },
            mark => { mark.style.color = "#ff0000"; }
          ];
          for (const edit of edits) {
            const edited = structuredClone(document);
            const mark = edited.pages[0].objects.find((object): object is ElectronMarkObject => object.type === "electron-mark")!;
            edit(mark);
            const warnings = exportDocument(edited).warnings;
            expect(warnings).toContainEqual(expect.objectContaining({
              code: "cdxml.electron_mark_appearance_payload_only", sourceObjectId: mark.id
            }));
            expect(warnings.some(warning => warning.code === "cdxml.unknown_objects_not_saved")).toBe(!embedNativePayload);
          }
        }
      }
    }
  });

  it.each(["charge", "radical-dot", "lone-pair"] as const)("names a moved/resized/styled/rotated %s and preserves its exact native data", markKind => {
    const mark: ElectronMarkObject = { id: "authored-mark", type: "electron-mark", markKind,
      x: 260, y: 280, width: 72, height: 36, rotation: 37, style: { strokeWidth: 4.5 },
      ...(markKind === "charge" ? { charge: -2, radical: true } : {}),
      anchor: { kind: "point", point: { x: 296, y: 298 } } };
    const document = createEmptyDocument({ title: "Styled electron marks" });
    document.pages[0].objects.push(mark);
    const result = exportDocumentToCdxml(document);
    expect(result.warnings).toContainEqual({
      code: "cdxml.electron_mark_appearance_payload_only", sourceObjectId: mark.id,
      message: "CDXML export: electron mark authored-mark, including its position, size (72 × 36), thickness (4.5) and rotation (37°), is preserved only in the embedded ChemDraft payload; no visible CDXML symbol is written."
    });
    expect(openChemDraftPayload(result.contents).document?.pages[0].objects[0]).toEqual(mark);
  });
});
