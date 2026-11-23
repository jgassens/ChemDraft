import type { ChemDraftDocument, MoleculeBond, MoleculeObject } from "@chemdraft/chem-core";
import { chemicalIdentityMolfile } from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { expect } from "vitest";
import { inspectStructureOffThread } from "../depiction2d/identityClient";
import { createNativeMolfileMolecule } from "../documentWorkflow";

export const pluginGraphEdits = [
  { name: "element", source: "CC", product: "CO", atomCount: 2, bondCount: 1 },
  { name: "bond order", source: "CC", product: "C=C", atomCount: 2, bondCount: 1 },
  { name: "add atom", source: "CC", product: "CCO", atomCount: 3, bondCount: 2 },
  { name: "remove atom", source: "CCO", product: "CC", atomCount: 2, bondCount: 1 },
  { name: "isotopic E/Z", source: "[2H]/C=C/Cl", product: "[2H]/C=C/F", atomCount: 4, bondCount: 3 },
  { name: "coordinate-only E/Z", source: "C/C=C/C", product: "C/C=C\\C", atomCount: 4, bondCount: 3 },
  { name: "stale wedge", source: "CC", product: "C=C", atomCount: 2, bondCount: 1 },
  { name: "symmetric alkene", source: "C/C(F)=C/F", product: "CC(C)=CF", atomCount: 5, bondCount: 4 },
  { name: "charge and isotope", source: "[13CH3]CO", product: "[13CH3]C[O-]", atomCount: 3, bondCount: 2,
    totalCharge: -1, isotopeLabels: ["13C"] }
] as const;

type GraphEdit = typeof pluginGraphEdits[number];

export function graphEditFixture(document: ChemDraftDocument, edit: Pick<GraphEdit, "name"> & { source: string }, storeMolfile = false) {
  const molfile = depictSmiles2D(edit.source).molfile;
  const molecule = createNativeMolfileMolecule(document, { x: 300, y: 250 }, molfile, "molfile-v2000");
  if (!storeMolfile) {
    molecule.structure = edit.source;
    molecule.structureFormat = "smiles";
  }
  if (edit.name === "stale wedge") molecule.bonds[0]!.display = { bondStyle: "wedge" };
  molecule.compatibility!.unknown.smiles = edit.source;
  return molecule;
}

export function graphEditChanges(molecule: MoleculeObject, { name }: GraphEdit): Partial<MoleculeObject> {
  const { atoms, bonds } = molecule;
  const oxygen = atoms.find(atom => atom.element === "O");
  switch (name) {
    case "element": return { atoms: atoms.map((atom, index) => index === 1 ? { ...atom, element: "O" } : atom) };
    case "bond order": case "stale wedge": return { bonds: [{ ...bonds[0]!, order: "double" }] };
    case "add atom": {
      const end = atoms[1]!;
      const addedBond: MoleculeBond = { id: "new-bond", fromAtomId: end.id, toAtomId: "new-oxygen", order: "single" };
      return { atoms: [...atoms, { id: "new-oxygen", element: "O", x: end.x + 18, y: end.y + 12, formalCharge: 0 }],
        bonds: [...bonds, addedBond] };
    }
    case "remove atom": return { atoms: atoms.filter(atom => atom !== oxygen),
      bonds: bonds.filter(bond => bond.fromAtomId !== oxygen!.id && bond.toAtomId !== oxygen!.id) };
    case "isotopic E/Z": return { atoms: atoms.map(atom => atom.element === "Cl" ? { ...atom, element: "F" } : atom) };
    case "coordinate-only E/Z": {
      const alkene = bonds.find(bond => bond.order === "double")!;
      const start = atoms.find(atom => atom.id === alkene.fromAtomId)!;
      const end = atoms.find(atom => atom.id === alkene.toAtomId)!;
      const terminal = atoms.find(atom => atom !== start && atom !== end)!;
      const dx = end.x - start.x, dy = end.y - start.y;
      const along = ((terminal.x - start.x) * dx + (terminal.y - start.y) * dy) / (dx * dx + dy * dy);
      return { atoms: atoms.map(atom => atom === terminal ? {
        ...atom, x: 2 * (start.x + along * dx) - atom.x, y: 2 * (start.y + along * dy) - atom.y
      } : atom) };
    }
    case "symmetric alkene": {
      const substitutedEnd = atoms.find(atom => bonds.filter(bond => bond.fromAtomId === atom.id || bond.toAtomId === atom.id).length === 3)!;
      const fluorine = atoms.find(atom => atom.element === "F" && bonds.some(bond =>
        [bond.fromAtomId, bond.toAtomId].includes(atom.id) && [bond.fromAtomId, bond.toAtomId].includes(substitutedEnd.id)));
      return { atoms: atoms.map(atom => atom === fluorine ? { ...atom, element: "C" } : atom) };
    }
    case "charge and isotope": return { atoms: atoms.map(atom => atom === oxygen ? { ...atom, formalCharge: -1 } : atom) };
  }
}

export async function expectStoredGraph(molecule: MoleculeObject, edit: GraphEdit) {
  async function inspect(format: "molfile" | "smiles", value: string) {
    const result = await inspectStructureOffThread(format, value, undefined, undefined, "writeIdentity");
    if (!result.valid) throw new Error(result.reason);
    return { smiles: result.identitySmiles, formula: result.formula,
      stereo: result.stereoTags?.CIP_bonds?.map(([, , tag]) => tag) ?? [] };
  }
  const expected = await inspect("smiles", edit.product);
  expect(await inspect("molfile", chemicalIdentityMolfile(molecule))).toEqual(expected);
  expect(await inspect(molecule.structureFormat === "smiles" ? "smiles" : "molfile", molecule.structure)).toEqual(expected);
  expect(molecule.compatibility?.unknown.smiles).toBe(expected.smiles);
  expect(molecule.chemistry?.stereochemistry.map(label => label.split(" ").at(-1))).toEqual(expected.stereo);
  expect(molecule.chemistry).toMatchObject({ formula: expected.formula, atomCount: edit.atomCount, bondCount: edit.bondCount,
    totalCharge: "totalCharge" in edit ? edit.totalCharge : 0,
    isotopeLabels: "isotopeLabels" in edit ? edit.isotopeLabels : edit.name === "isotopic E/Z" ? ["2H"] : [] });
  expect(molecule.atoms).toHaveLength(edit.atomCount);
  expect(molecule.bonds).toHaveLength(edit.bondCount);
}
