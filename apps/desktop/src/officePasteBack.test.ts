import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyChargeToolAtPoint, createPhase4Document, createSelectionClipboardPayload, insertNativeSingleBondMolecule,
  normalizeCommittedDocument, pasteSelectionClipboardPayload, translateInsertedDocumentObjects,
} from "./documentWorkflow";
import { assertOfficePastePreservesExistingChemistry, insertOfficeStructures } from "./officeStructureImport";

describe("Office paste-back commit", () => {
  it("refuses a pasted floating charge mark that would charge an existing neutral atom at the pointer", () => {
    const source = applyChargeToolAtPoint(createPhase4Document(), 1, { x: 80, y: 80 });
    const payload = createSelectionClipboardPayload(source)!;
    expect(payload.objects[0]).toMatchObject({ type: "electron-mark", anchor: { kind: "point" }, charge: 1 });

    const before = normalizeCommittedDocument(insertNativeSingleBondMolecule(createPhase4Document(), { x: 300, y: 300 }));
    const molecule = before.pages[0]!.objects[0]!;
    if (molecule.type !== "molecule") throw new Error("Expected a native molecule.");
    const atom = molecule.atoms[0]!;
    // The trial below the existing drawing passes. Actual placement moves the mark beside the atom.
    const trial = insertOfficeStructures(before, [{ location: "the copied picture", payload }]);
    expect(trial.placed).toHaveLength(1);
    expect(() => assertOfficePastePreservesExistingChemistry(before, normalizeCommittedDocument(trial.document))).not.toThrow();
    const prepared = pasteSelectionClipboardPayload(before, payload, { x: payload.bounds.centerX, y: payload.bounds.centerY });
    const placed = translateInsertedDocumentObjects(prepared, prepared.selection.objectIds,
      atom.x - payload.bounds.centerX, atom.y - 8 - payload.bounds.centerY);
    const normalized = normalizeCommittedDocument(placed);
    expect(normalized.pages[0]!.objects[0]).toMatchObject({ atoms: [expect.objectContaining({ formalCharge: 1 }), expect.anything()] });
    expect(() => assertOfficePastePreservesExistingChemistry(before, normalized))
      .toThrow(/formal charge on C atom .* would change from 0 to 1\. Nothing was pasted\./);
    expect(atom.formalCharge).toBe(0);
  });

  it("handles a rejected Office toolbar menu update", () => {
    const mainWindow = readFileSync(new URL("./MainWindow.tsx", import.meta.url), "utf8");
    expect(mainWindow).toMatch(/setToolbarsMenu\(entries, rulersVisible, crosshairsVisible, false, officeUpdateTitle\)\.catch\(/);
  });
});
