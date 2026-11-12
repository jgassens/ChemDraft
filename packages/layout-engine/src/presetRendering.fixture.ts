import { NativeStylePresets, stylePresetToObjectStyle, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";

export const presetRenderingCases = [
  { name: "default", style: {} },
  ...NativeStylePresets.map(preset => ({ name: preset.name, style: stylePresetToObjectStyle(preset) }))
];

/** Disjoint bonds keep each bond's ink identifiable even after roughening flattens the paths. */
export function presetRenderingMolecule(style: MoleculeObject["style"], display?: MoleculeBond["display"], order: MoleculeBond["order"] = "single"): MoleculeObject {
  return {
    id: "preset-colours", type: "molecule", x: 100, y: 140, width: 280, height: 150, rotation: 0,
    structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
    style: { ...style, bondColor: "#126082", atomLabelColor: "#126082",
      bondColors: { b0: "#c03080" }, atomLabelColors: { o: "#267a38" } },
    atoms: [
      ...[120, 220, 320].flatMap((x, i) => [
        { id: `c${i}a`, element: "C", x, y: 160, formalCharge: 0 },
        { id: `c${i}b`, element: "C", x: x + 44, y: 160, formalCharge: 0 }
      ]),
      { id: "o", element: "O", x: 140, y: 260, formalCharge: 0 },
      { id: "n", element: "N", x: 240, y: 260, formalCharge: 0 }
    ],
    bonds: [0, 1, 2].map(i => ({ id: `b${i}`, fromAtomId: `c${i}a`, toAtomId: `c${i}b`, order, ...(display ? { display } : {}) }))
  };
}
