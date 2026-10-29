import { expect } from "vitest";
import { createEmptyDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { createNativeTextObject, createSmilesMolecule, type PastedStructureDepiction } from "@chemdraft/document-workflow-core";

export const defaultCases = [
  { bondLengthPx: 22, bondStrokeWidthPx: 2, atomLabelFontSizePx: 15, atomLabelFontFamily: "Arial, Helvetica, sans-serif" },
  { bondLengthPx: 30, bondStrokeWidthPx: 1.2, atomLabelFontSizePx: 12, atomLabelFontFamily: "Times" }
];
export const bondDepiction: PastedStructureDepiction = {
  atoms: [{ element: "C", x: 0, y: 0, charge: 0 }, { element: "O", x: 1.5, y: 0, charge: 0 }],
  bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
};
export function insertionDocument(style: typeof defaultCases[number]): ChemDraftDocument {
  const document = createEmptyDocument();
  const molecule = createSmilesMolecule(document, { x: 100, y: 100 }, bondDepiction, "CO", undefined, { bondLengthPx: 28 });
  const text = createNativeTextObject(document, { x: 100, y: 180 }, "Existing", { fontSizePx: 18 });
  document.pages[0]!.objects = [molecule, text];
  if (style.bondLengthPx !== 22) document.styles.drawing = { ...style };
  return document;
}
export function expectDrawingDefaults(object: unknown, style: typeof defaultCases[number]) {
  const molecule = object as MoleculeObject;
  expect(molecule.type).toBe("molecule");
  expect(molecule.style).toMatchObject(style);
  if (!molecule.bonds.length) return; // Standalone group labels have no geometric bond to measure.
  const atoms = new Map(molecule.atoms.map(atom => [atom.id, atom]));
  const lengths = molecule.bonds.map(bond => {
    const from = atoms.get(bond.fromAtomId)!; const to = atoms.get(bond.toAtomId)!;
    return Math.hypot(from.x - to.x, from.y - to.y);
  });
  expect(Math.abs(lengths.reduce((sum, length) => sum + length, 0) / lengths.length - style.bondLengthPx)).toBeLessThan(0.01);
}
