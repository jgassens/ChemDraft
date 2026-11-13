import { describe, expect, it } from "vitest";
import { createEmptyDocument, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import { moveDocumentObject, moveNativeMoleculeParts, normalizeCommittedDocument } from "../../../apps/desktop/src/documentWorkflow";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

describe("electron-mark CDXML appearance warnings", () => {
  it.each([false, true])("warns when moving an imported doublet atom leaves its dot behind (legacy=%s)", legacy => {
    const imported = openChemDraftPayload('<CDXML><page><fragment id="1"><n id="2" p="100 100" Element="6" Radical="Doublet"/></fragment></page></CDXML>').document!;
    const molecule = imported.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    const mark = imported.pages[0].objects.find((object): object is ElectronMarkObject => object.type === "electron-mark")!;
    if (legacy) {
      const placement = mark.compatibility!.unknown.cdxmlRadicalMarkPlacement as Record<string, unknown>;
      delete placement.offsetX;
      delete placement.offsetY;
    }
    const moved = normalizeCommittedDocument(moveNativeMoleculeParts(imported, {
      kind: "atom", objectId: molecule.id, atomId: molecule.atoms[0].id
    }, { x: 100, y: 0 }));
    const movedMolecule = moved.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    expect(movedMolecule.atoms[0].x).toBeCloseTo(molecule.atoms[0].x + 100);
    expect(movedMolecule.atoms[0].markRadicals).toBe(1);
    expect(moved.pages[0].objects.find(object => object.id === mark.id)).toMatchObject({ x: mark.x, y: mark.y });
    for (const embedNativePayload of [false, true]) {
      const together = normalizeCommittedDocument(moveDocumentObject(imported, molecule.id, { x: molecule.x + 100, y: molecule.y }));
      for (const unchanged of [imported, together]) {
        for (const exported of [exportDocumentToCdxml(unchanged, { embedNativePayload }), exportDocumentToCdx(unchanged, { embedNativePayload })]) {
          expect(exported.warnings.filter(warning => warning.code === "cdxml.electron_mark_appearance_payload_only")).toEqual([]);
        }
      }
      for (const exported of [exportDocumentToCdxml(moved, { embedNativePayload }), exportDocumentToCdx(moved, { embedNativePayload })]) {
        expect(exported.warnings).toContainEqual(expect.objectContaining({
          code: "cdxml.electron_mark_appearance_payload_only", sourceObjectId: mark.id
        }));
      }
    }
  });

  it("keeps untouched legacy triplet placement metadata warning-free", () => {
    const imported = openChemDraftPayload('<CDXML><page><fragment id="1"><n id="2" p="100 100" Element="6" Radical="Triplet"/></fragment></page></CDXML>').document!;
    const marks = imported.pages[0].objects.filter((object): object is ElectronMarkObject => object.type === "electron-mark");
    // HEAD saved overlapping triplet frames and only absolute placement coordinates.
    for (const mark of marks) {
      mark.x = marks[0].x;
      mark.y = marks[0].y;
      mark.compatibility!.unknown.cdxmlRadicalMarkPlacement = {
        x: mark.x, y: mark.y, objectId: mark.anchor.objectId, atomId: mark.anchor.atomId
      };
    }
    for (const exported of [exportDocumentToCdxml(imported), exportDocumentToCdx(imported)]) {
      expect(exported.warnings).toEqual([]);
    }
  });

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
