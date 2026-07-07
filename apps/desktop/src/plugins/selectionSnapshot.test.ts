import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";

import { buildPluginSelectionSnapshot } from "./selectionSnapshot";

// Minimal document shape exercised by buildPluginSelectionSnapshot (id, pages[].id, page.objects,
// object.type/id/structureFormat/structure, selection.objectIds). Cast to the full type for focus.
function documentWith(selection: string[]): ChemDraftDocument {
  return {
    id: "doc1",
    selection: { objectIds: selection },
    pages: [
      {
        id: "p1",
        objects: [
          { id: "m1", type: "molecule", structureFormat: "smiles", structure: "c1ccccc1" },
          { id: "t1", type: "text", text: "note" },
          { id: "m2", type: "molecule", structureFormat: "molfile-v2000", structure: "mol block" }
        ]
      }
    ]
  } as unknown as ChemDraftDocument;
}

describe("buildPluginSelectionSnapshot", () => {
  it("maps selected molecules with identity, format, and a source fingerprint, in selection order", () => {
    const snapshot = buildPluginSelectionSnapshot(documentWith(["m2", "m1"]));

    expect(snapshot.objectIds).toEqual(["m2", "m1"]);
    expect(snapshot.molecules.map((molecule) => molecule.objectId)).toEqual(["m2", "m1"]);

    const [first] = snapshot.molecules;
    expect(first).toMatchObject({
      objectId: "m2",
      documentId: "doc1",
      pageId: "p1",
      structureFormat: "molfile-v2000",
      structure: "mol block"
    });
    expect(first.sourceFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("excludes unselected objects and non-molecules", () => {
    const snapshot = buildPluginSelectionSnapshot(documentWith(["m1", "t1"]));
    expect(snapshot.molecules.map((molecule) => molecule.objectId)).toEqual(["m1"]);
  });

  it("produces a stable fingerprint for unchanged input and a different one after an edit", () => {
    const before = buildPluginSelectionSnapshot(documentWith(["m1"])).molecules[0].sourceFingerprint;
    const again = buildPluginSelectionSnapshot(documentWith(["m1"])).molecules[0].sourceFingerprint;
    expect(again).toBe(before);

    const edited = documentWith(["m1"]);
    (edited.pages[0].objects[0] as { structure: string }).structure = "CCO";
    expect(buildPluginSelectionSnapshot(edited).molecules[0].sourceFingerprint).not.toBe(before);
  });
});
