import { ChemDraftSyntheticStylePreset, stylePresetToObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";

/** Mixed stereo ink precedes ordinary bonds to catch changes to rough.js's random stream. */
export function sketchRegressionMolecule(sketch: boolean): MoleculeObject {
  return {
    id: "sketch-regression", type: "molecule", x: 0, y: 0, width: 400, height: 400, rotation: 0,
    structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
    style: {
      ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset), source: "chemdraft-native-drawing",
      ...(sketch ? { visualEffects: [{ kind: "sketch", seed: 7, roughness: 1.25, bowing: 1 }] } : {})
    },
    atoms: [
      { id: "a", element: "C", x: 40, y: 40, formalCharge: 0 },
      { id: "b", element: "C", x: 100, y: 40, formalCharge: 0 },
      { id: "c", element: "N", x: 160, y: 40, formalCharge: 0 },
      { id: "d", element: "C", x: 40, y: 120, formalCharge: 0 },
      { id: "e", element: "C", x: 100, y: 120, formalCharge: 0 },
      { id: "f", element: "C", x: 160, y: 120, formalCharge: 0 },
      { id: "g", element: "O", x: 220, y: 120, formalCharge: 0 },
      { id: "h", element: "C", x: 40, y: 200, formalCharge: 0 },
      { id: "i", element: "C", x: 100, y: 200, formalCharge: 0 },
      { id: "j", element: "C", x: 70, y: 252, formalCharge: 0 }
    ],
    bonds: [
      { id: "hash", fromAtomId: "a", toAtomId: "b", order: "single", display: { bondStyle: "hashed" } },
      { id: "dash", fromAtomId: "b", toAtomId: "c", order: "single", display: { bondStyle: "dashed" } },
      { id: "wedge", fromAtomId: "d", toAtomId: "e", order: "single", display: { bondStyle: "wedge" } },
      { id: "double", fromAtomId: "e", toAtomId: "f", order: "double" },
      { id: "triple", fromAtomId: "f", toAtomId: "g", order: "triple" },
      { id: "ring1", fromAtomId: "h", toAtomId: "i", order: "double" },
      { id: "ring2", fromAtomId: "i", toAtomId: "j", order: "single" },
      { id: "ring3", fromAtomId: "j", toAtomId: "h", order: "single" }
    ],
    chemistry: { atomCount: 10, bondCount: 8, totalCharge: 0, radicalCount: 0, isotopeLabels: [], stereochemistry: [], warnings: [] }
  };
}
