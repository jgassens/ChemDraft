import { describe, expect, it } from "vitest";
import { serializeDocument, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import * as workflow from "./documentWorkflow";
import { electronMarkDropFixture, dropMolecule } from "./testSupport/electronMarkDropFixture";

describe("copying tool-created atom marks with their molecule", () => {
  for (const marks of ["charge", "radical", "both"] as const) {
    for (const operation of ["duplicate", "paste"] as const) {
      it.each([1, 24])(`${operation} ${marks} at offset %s preserves both molecules`, offset => {
        const fixture = electronMarkDropFixture(marks === "radical" ? { kind: "radical-dot" } : { kind: "charge", charge: 1 });
        let document = fixture.document;
        const sourceId = dropMolecule(document).id;
        if (marks === "both") document = workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(document,
          { kind: "radical-dot" }, { kind: "atom", objectId: sourceId, atomId: fixture.nitrogen.id, distanceToPointer: 0 }));
        const originals = structuredClone(document.pages[0].objects);
        for (const mark of originals.filter(o => o.type === "electron-mark")) expect(mark.atomAssociation).toBeUndefined();
        document = workflow.selectDocumentObjects(document, document.pages[0].id, originals.map(o => o.id));
        document = { ...document, pages: [{ ...document.pages[0], objects: [...document.pages[0].objects].reverse() }] };
        const before = serializeDocument(document);
        let edited;
        if (operation === "duplicate") edited = workflow.duplicateSelectedDocumentObjects(document, { x: offset, y: offset });
        else {
          const payload = workflow.parseSelectionClipboardPayload(workflow.serializeSelectionClipboardPayload(workflow.createSelectionClipboardPayload(document)!))!;
          edited = workflow.pasteSelectionClipboardPayload(document, payload, { x: payload.bounds.centerX + offset, y: payload.bounds.centerY + offset });
        }
        const committed = workflow.normalizeCommittedDocument(edited);
        const reopened = workflow.openNativeDocument(serializeDocument(committed)).document!;
        for (const result of [edited, committed, workflow.normalizeCommittedDocument(reopened)]) {
          for (const original of originals) expect(result.pages[0].objects.find(o => o.id === original.id)).toEqual(original);
          const copied = result.pages[0].objects.find((o): o is MoleculeObject => o.type === "molecule" && o.id !== sourceId)!;
          expect(copied).toBeDefined();
          const originalMolecule = originals.find(o => o.id === sourceId) as MoleculeObject;
          expect(copied.atoms).toEqual(originalMolecule.atoms.map(a => ({ ...a, x: a.x + offset, y: a.y + offset })));
          expect(copied.structure).toEqual(originalMolecule.structure);
          expect(copied.chemistry).toEqual(originalMolecule.chemistry);
          const copiedMarks = result.pages[0].objects.filter((o): o is ElectronMarkObject => o.type === "electron-mark" && !originals.some(original => original.id === o.id));
          expect(copiedMarks).toHaveLength(marks === "both" ? 2 : 1);
          for (const mark of copiedMarks) expect(mark.anchor).toEqual({ kind: "atom", objectId: copied.id, atomId: fixture.nitrogen.id });
          expect(new Set(result.pages[0].objects.map(o => o.id)).size).toBe(result.pages[0].objects.length);
        }
        expect(serializeDocument(document)).toBe(before);
      });
    }
  }
});
