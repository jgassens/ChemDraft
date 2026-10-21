import type { MoleculeObject } from "@chemdraft/chem-core";

export const chargeSeparationCases = [
  { name: "perchlorate", center: "Cl", neighbors: ["O", "O", "O", "O"],
    orders: ["double", "double", "double", "single"], charges: [0, 0, 0, -1],
    smiles: "[O-][Cl+3]([O-])([O-])[O-]", formula: "ClO4", charge: -1, changedAtoms: 4 },
  { name: "nitro", center: "N", neighbors: ["O", "O", "C"],
    orders: ["double", "double", "single"], charges: [0, 0, 0],
    smiles: "C[N+](=O)[O-]", formula: "CH3NO2", charge: 0, changedAtoms: 2 }
].map(({ center, neighbors, orders, charges, ...entry }) => ({
  ...entry,
  molecule: {
    id: entry.name, type: "molecule", x: 0, y: 0, width: 100, height: 100,
    rotation: 0, style: {}, structureFormat: "molfile-v2000", structure: "",
    superatoms: [], rGroups: [],
    atoms: [center, ...neighbors].map((element, i) => ({
      id: `a${i}`, element, x: i * 20, y: i % 2 * 20,
      formalCharge: i === 0 ? 0 : charges[i - 1]!
    })),
    bonds: orders.map((order, i) => ({
      id: `b${i}`, fromAtomId: "a0", toAtomId: `a${i + 1}`, order
    }))
  } as MoleculeObject
}));
