import { createEmptyDocument, moleculeToMolfileV2000, type MoleculeObject } from "@chemdraft/chem-core";

export function unrecognizedLabelDocument(label = "Phe") {
  const document = createEmptyDocument({ title: "Unrecognized label", now: "2026-11-02T00:00:00Z" });
  const molecule: MoleculeObject = {
    id: "unrecognized_label", type: "molecule", x: 100, y: 100, width: 100, height: 100,
    rotation: 0, style: {}, structureFormat: "molfile-v2000", structure: "",
    superatoms: [], rGroups: [],
    atoms: [
      { id: "a1", element: "C", formalCharge: 0, x: 100, y: 100 },
      { id: "a2", element: label, formalCharge: 0, x: 128, y: 100 }
    ],
    bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }]
  };
  molecule.structure = moleculeToMolfileV2000(molecule, { fromDocFrame: true }).contents;
  document.pages[0]!.objects = [molecule];
  return { document, molecule };
}

// The molfile writer diagnostic surfaced by render-document on main 78f82a1e.
export const unrecognizedLabelMolfileWarning = (label = "Phe") =>
  `Atom label "${label}" is not an element symbol; written as a dummy atom (*) — the label's group is not represented in the molfile.`;

export const unrecognizedLabelSmilesWarning = (label = "Phe") =>
  `Atom label "${label}" cannot be spelled as a single SMILES atom; written as a dummy atom [*].`;

export const unrecognizedLabelCdxmlWarning = (label = "Phe") =>
  `Atom element "${label}" was exported as a CDXML element label because no atomic number mapping exists.`;
