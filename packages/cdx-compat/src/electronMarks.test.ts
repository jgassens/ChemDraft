import { describe, expect, it } from "vitest";
import { createEmptyDocument, type ElectronMarkObject } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";

describe("electron-mark CDXML appearance warnings", () => {
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
