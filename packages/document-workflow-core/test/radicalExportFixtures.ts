import type { MoleculeAtom, MoleculeObject } from "@chemdraft/chem-core";
import { ensureRdkit } from "../../rdkit-adapter/src/conformer";

export interface AtomState {
  radicals: number;
  hydrogens: number;
  charge: number;
  isotope: number;
}

function lone(element: string, markRadicals: number, extra: Partial<MoleculeAtom> = {}): MoleculeObject {
  return {
    id: "mol", type: "molecule", x: 0, y: 0, width: 20, height: 20, rotation: 0, style: {},
    structureFormat: "molfile-v2000", structure: "", superatoms: [], rGroups: [], bonds: [],
    atoms: [{ id: "a", element, x: 0, y: 0, formalCharge: 0, markRadicals, ...extra }]
  };
}

const state = (radicals: number, hydrogens: number, isotope = 0): AtomState =>
  ({ radicals, hydrogens, charge: 0, isotope });

const aromatic: MoleculeObject = {
  ...lone("C", 1), width: 100, height: 100,
  atoms: Array.from({ length: 6 }, (_, i) => ({
    id: `a${i}`, element: "C", x: 50 + 40 * Math.cos(i * Math.PI / 3),
    y: 50 + 40 * Math.sin(i * Math.PI / 3), formalCharge: 0, markRadicals: i === 0 ? 1 : 0
  })),
  bonds: Array.from({ length: 6 }, (_, i) => ({
    id: `b${i}`, fromAtomId: `a${i}`, toAtomId: `a${(i + 1) % 6}`, order: "aromatic"
  }))
};

export const radicalExportCases = [
  { name: "literal C / 1", molecule: lone("C", 1, { labelLiteral: true }), states: [state(1, 0)], loss: true },
  { name: "condensed CH3 / 2", molecule: lone("CH3", 2), states: [state(2, 3)], loss: true },
  { name: "Zn / 1", molecule: lone("Zn", 1), states: [state(1, 0)], loss: true },
  { name: "D / 2", molecule: lone("D", 2), states: [state(2, 0, 2)], loss: true },
  { name: "C / 3", molecule: lone("C", 3), states: [state(3, 1)], loss: false },
  { name: "C / 4", molecule: lone("C", 4), states: [state(4, 0)], loss: false },
  { name: "aromatic C / 1", molecule: aromatic, states: [state(1, 0), ...Array.from({ length: 5 }, () => state(0, 1))], loss: false },
  { name: "T / 2", molecule: lone("T", 2), states: [state(2, 0, 3)], loss: true },
  { name: "charged C / 1", molecule: lone("C", 1, { formalCharge: 1 }), states: [{ ...state(1, 2), charge: 1 }], loss: false }
];

function connected(atoms: Partial<MoleculeAtom>[], edges: [number, number][]): MoleculeObject {
  return {
    ...lone("C", 0), width: 100, height: 100,
    atoms: atoms.map((atom, index) => ({
      id: `a${index}`, element: "C", x: 28 * index, y: index % 2 * 20, formalCharge: 0, ...atom
    })),
    bonds: edges.map(([from, to], index) => ({
      id: `b${index}`, fromAtomId: `a${from}`, toAtomId: `a${to}`, order: "single"
    }))
  };
}

/** Independently specified drawn states for the review's formerly refused, lossless exports. */
export const preservedRadicalExportCases = [
  {
    name: "typed N amine", smiles: "CN(C)C",
    molecule: connected([{}, { element: "N", labelLiteral: true }, {}, {}], [[0, 1], [1, 2], [1, 3]]),
    states: [state(0, 3), state(0, 0), state(0, 3), state(0, 3)]
  },
  {
    name: "typed O ether", smiles: "COC",
    molecule: connected([{}, { element: "O", labelLiteral: true }, {}], [[0, 1], [1, 2]]),
    states: [state(0, 3), state(0, 0), state(0, 3)]
  },
  {
    name: "typed Cl", smiles: "CCl",
    molecule: connected([{}, { element: "Cl", labelLiteral: true }], [[0, 1]]),
    states: [state(0, 3), state(0, 0)]
  },
  {
    name: "aminyl", smiles: "[NH2]", molecule: lone("N", 1, { hydrogenCount: 2 }),
    states: [state(1, 2)]
  },
  {
    name: "methoxyl", smiles: "C[O]",
    molecule: connected([{}, { element: "O", markRadicals: 1 }], [[0, 1]]),
    states: [state(0, 3), state(1, 0)]
  },
  {
    name: "nitroxide", smiles: "CN(C)[O]",
    molecule: connected([{}, { element: "N" }, {}, { element: "O", markRadicals: 1 }], [[0, 1], [1, 2], [1, 3]]),
    states: [state(0, 3), state(0, 0), state(0, 3), state(1, 0)]
  },
  {
    name: "charged carbon radical", smiles: "[CH2+]", molecule: lone("C", 1, { formalCharge: 1 }),
    states: [{ ...state(1, 2), charge: 1 }]
  },
  {
    name: "typed NH2 amine", smiles: "CN",
    molecule: connected([{}, { element: "NH2", labelLiteral: true }], [[0, 1]]),
    states: [state(0, 3), state(0, 2)]
  },
  {
    name: "typed OH alcohol", smiles: "CO",
    molecule: connected([{}, { element: "OH", labelLiteral: true }], [[0, 1]]),
    states: [state(0, 3), state(0, 1)]
  },
  {
    name: "typed CH3", smiles: "CC",
    molecule: connected([{}, { element: "CH3", labelLiteral: true }], [[0, 1]]),
    states: [state(0, 3), state(0, 3)]
  },
  {
    name: "typed NH amine", smiles: "CNC",
    molecule: connected([{}, { element: "NH", labelLiteral: true }, {}], [[0, 1], [1, 2]]),
    states: [state(0, 3), state(0, 1), state(0, 3)]
  },
  {
    name: "typed Na+ counterion", smiles: "[Na+]",
    molecule: lone("Na", 0, { labelLiteral: true, formalCharge: 1 }),
    states: [{ ...state(0, 0), charge: 1 }]
  },
  {
    name: "Na / 1", smiles: "[Na]", molecule: lone("Na", 1), states: [state(1, 0)],
    fallbackNeedsEngine: true
  },
  ...["Pd", "Pt", "Ni", "Fe", "Zn"].map((element) => ({
    name: `typed ${element}`, smiles: `[${element}]`,
    molecule: lone(element, 0, { labelLiteral: true }), states: [state(0, 0)], fallbackNeedsEngine: true
  })),
  ...["Pt", "Ni"].map((element) => ({
    name: `bonded typed ${element} centre`, smiles: `[Cl][${element}][Cl]`,
    molecule: connected([{ element: "Cl" }, { element, labelLiteral: true }, { element: "Cl" }], [[0, 1], [1, 2]]),
    states: [state(0, 0), state(0, 0), state(0, 0)], fallbackNeedsEngine: true
  }))
];

/** These drawings state neither hydrides nor radicals; a bracketed metal is not proof of that. */
export const metalHydrogenLossCases = [
  ...["Li", "Na", "K", "Cu", "Ag", "Tl", "Mg", "Ca", "Ga", "In", "Sb", "Bi", "Pb"].map((element) => ({
    name: `${element} / 0`, molecule: lone(element, 0), states: [state(0, 0)]
  })),
  {
    name: "C-Mg / 0",
    molecule: connected([{ element: "Mg", markRadicals: 0 }, {}], [[0, 1]]),
    states: [state(0, 0), state(0, 3)]
  },
  {
    name: "typed Na / 0", molecule: lone("Na", 0, { labelLiteral: true }), states: [state(0, 0)]
  }
];

export const metalCounterionCases = [
  { element: "Na", charge: 1 }, { element: "Mg", charge: 2 },
  { element: "Zn", charge: 2 }, { element: "Pd", charge: 2 }
].map(({ element, charge }) => ({
  name: `${element}+${charge}`, molecule: lone(element, 0, { formalCharge: charge }),
  states: [{ ...state(0, 0), charge }]
}));

/** Defaults in RDKit JSON apply to every omitted atom property. Count bonded H as well as
 * bracket/implicit H so the assertion does not depend on the engine's hydrogen storage choice.
 */
export async function readAtomStates(structure: string, canonicalOrder = false): Promise<AtomState[]> {
  const rdkit = await ensureRdkit();
  const mol = rdkit.get_mol(structure);
  if (!mol) throw new Error(`RDKit could not parse exported structure: ${structure}`);
  try {
    // Graph writers choose different branch orders; reparse canonical SMILES to align atom indices.
    if (canonicalOrder) return await readAtomStates(mol.get_smiles!());
    const json = JSON.parse((mol as unknown as { get_json(): string }).get_json()) as {
      defaults: { atom: Record<string, number> };
      molecules: { atoms: Record<string, number>[]; bonds: { atoms: [number, number] }[] }[];
    };
    const graph = json.molecules[0]!;
    const atoms = graph.atoms.map((atom) => ({ ...json.defaults.atom, ...atom }));
    return atoms.map((atom, i) => ({
      radicals: atom.nRad!, hydrogens: atom.impHs! + graph.bonds.filter((bond) =>
        (bond.atoms[0] === i && atoms[bond.atoms[1]]!.z === 1) ||
        (bond.atoms[1] === i && atoms[bond.atoms[0]]!.z === 1)).length,
      charge: atom.chg!, isotope: atom.isotope!
    }));
  } finally { mol.delete(); }
}
