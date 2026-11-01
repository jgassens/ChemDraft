import { describe, expect, it } from "vitest";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { layoutGrid } from "../src/gridLayout";
import { insertNativeTextObject } from "../src/textObjects";

describe("grid object ids", () => {
  it.each([true, false])("preserves the pre-move CLI allocation sequence (all labels: %s)", (allLabels) => {
    const entries = ["A", "B", "C"].map((label, index) => ({
      molecule: {
        id: `source_${index}`, type: "molecule", x: 0, y: 0, width: 40, height: 20,
        rotation: 0, style: {}, structureFormat: "smiles", structure: "C",
        atoms: [{ id: "a", element: "C", x: 0, y: 0, formalCharge: 0 }],
        bonds: [], superatoms: [], rGroups: []
      } satisfies MoleculeObject,
      bounds: { minX: 0, minY: 0, maxX: 40, maxY: 20 },
      label: allLabels || index !== 1 ? label : null
    }));
    const layout = layoutGrid({ entries, columns: 2, gutter: 32, anchor: { x: 24, y: 24 }, pageWidth: 800 });

    // Before the move, the CLI appended each molecule, then called insertNativeTextObject.
    let previous = createEmptyDocument({ title: "ChemDraft grid" });
    entries.forEach((entry, index) => {
      const page = previous.pages[0]!;
      previous = { ...previous, pages: [{ ...page, objects: [...page.objects, layout.molecules[index]!] }] };
      if (entry.label !== null) previous = insertNativeTextObject(previous, { x: 24, y: 24 }, entry.label);
    });
    const ids = layout.document.pages[0]!.objects.map(object => object.id);
    expect(ids).toEqual(previous.pages[0]!.objects.map(object => object.id));
    expect(ids).toEqual(allLabels
      ? ["mol_grid_001", "text_002", "mol_grid_002", "text_004", "mol_grid_003", "text_006"]
      : ["mol_grid_001", "text_002", "mol_grid_002", "mol_grid_003", "text_005"]);
  });
});
