/**
 * Atom-label abbreviations ("nicknames"): the groups a chemist writes as a label — OMe, Ph, Boc —
 * each with the structure it stands for.
 *
 * This table is original to ChemDraft. Every entry was written here from the group's own
 * chemistry (its SMILES is the definition); no other program's nickname list was copied, and none
 * may be (AGENTS.md §12). The 2D layouts were computed from those SMILES with RDKit, then
 * normalized: the attachment atom at (0, 0), the atom the group attaches to at (−1, 0), bonds of
 * length 1, y up. Orientation is arbitrary up to that frame; no group here has stereochemistry.
 *
 * Matching is CASE-SENSITIVE (owner decision, 2026-10-10): "OMe" is methoxy; "Ome" is not a
 * group. A label that is also an element symbol is the element, so no label or alias may spell one;
 * the tests in document-workflow-core enforce that against the element table. The exception is
 * `bondedSpellings`: "Ac", "Pr" and "Ts" typed as a label on a bonded atom are acetyl, n-propyl and
 * tosyl. Unbonded, or read from a structure file rather than typed, they stay actinium,
 * praseodymium and tennessine. "CN" is free: case folding leaves it as typed (layout-engine's
 * `nativeFormulaTwoLetterLabels`), so it is cyano here, while "Cn" is still copernicium.
 *
 * Chemistry for these groups (valence, formula, expansion on export) lives in
 * `@chemdraft/document-workflow-core`; this package owns only the data.
 */

/** One atom of a group. */
export interface AbbreviationAtom {
  /** An element symbol. */
  element: string;
  /** Hydrogens on this atom inside the group. Stated, never inferred: the label spells them. */
  hydrogens: number;
  /** Formal charge inside the group (nitro's N⁺ and O⁻); omitted when zero. */
  charge?: number;
  /** Layout position in bond lengths; see the frame described above. */
  x: number;
  y: number;
}

/** A bond inside a group: atom indices into `atoms`, and a Kekulé order. */
export type AbbreviationBond = readonly [from: number, to: number, order: 1 | 2 | 3];

export interface AbbreviationDefinition {
  /** The label as written for a bond on its left ("OMe"). */
  label: string;
  /**
   * Other spellings of the same group, most often the label written for a bond on its right
   * ("MeO"), which is how chemists write a group on the left of a structure.
   */
  aliases: readonly string[];
  /**
   * Spellings that are also element symbols, and mean this group only when typed as a label on an
   * atom with bonds: "Ac" (acetyl), "Pr" (n-propyl), "Ts" (tosyl). Unbonded, or read from a
   * structure file rather than typed, they stay actinium, praseodymium and tennessine — elements win
   * everywhere else. Inside a composite label ("NHAc", "OTs") the group is bonded to the head by
   * definition. Optional; most groups have none.
   */
  bondedSpellings?: readonly string[];
  /** The group's name, for messages and documentation. */
  name: string;
  /** The group as SMILES; "*" is the atom it attaches to. Its definition, cross-checked by tests. */
  smiles: string;
  /** Hill formula of the group's own atoms, with the hydrogens it carries ("CH3O"). */
  formula: string;
  /** Bonds the group makes to the rest of a molecule — its free valence. */
  attachmentCount: number;
  /** `atoms[0]` is the attachment atom: the atom the label's bonds connect to. */
  atoms: readonly AbbreviationAtom[];
  bonds: readonly AbbreviationBond[];
}

export const abbreviationDefinitions: readonly AbbreviationDefinition[] = [
  {
    label: "Me", aliases: [], name: "methyl", smiles: "*C", formula: "CH3", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 3, x: 0, y: 0 }
    ],
    bonds: []
  },
  {
    label: "Et", aliases: [], name: "ethyl", smiles: "*CC", formula: "C2H5", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 2, x: 0, y: 0 },
      { element: "C", hydrogens: 3, x: 0.5, y: -0.866 }
    ],
    bonds: [[0, 1, 1]]
  },
  {
    // "Pr" is also praseodymium, so it names n-propyl only on an atom with bonds.
    label: "nPr", aliases: [], bondedSpellings: ["Pr"], name: "n-propyl", smiles: "*CCC", formula: "C3H7", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 2, x: 0, y: 0 },
      { element: "C", hydrogens: 2, x: 0.5, y: -0.866 },
      { element: "C", hydrogens: 3, x: 1.5, y: -0.866 }
    ],
    bonds: [[0, 1, 1], [1, 2, 1]]
  },
  {
    label: "iPr", aliases: [], name: "isopropyl", smiles: "*C(C)C", formula: "C3H7", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 1, x: 0, y: 0 },
      { element: "C", hydrogens: 3, x: 0.5, y: -0.866 },
      { element: "C", hydrogens: 3, x: 0.5, y: 0.866 }
    ],
    bonds: [[0, 1, 1], [0, 2, 1]]
  },
  {
    // Bare "Bu" means n-butyl by convention (SnBu3, Bu3Sn); it is no element symbol.
    label: "nBu", aliases: ["Bu"], name: "n-butyl", smiles: "*CCCC", formula: "C4H9", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 2, x: 0, y: 0 },
      { element: "C", hydrogens: 2, x: 0.5, y: -0.866 },
      { element: "C", hydrogens: 2, x: 1.5, y: -0.866 },
      { element: "C", hydrogens: 3, x: 2, y: -1.732 }
    ],
    bonds: [[0, 1, 1], [1, 2, 1], [2, 3, 1]]
  },
  {
    label: "tBu", aliases: [], name: "tert-butyl", smiles: "*C(C)(C)C", formula: "C4H9", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 0, x: 0, y: 0 },
      { element: "C", hydrogens: 3, x: 1, y: 0 },
      { element: "C", hydrogens: 3, x: 0, y: -1 },
      { element: "C", hydrogens: 3, x: 0, y: 1 }
    ],
    bonds: [[0, 1, 1], [0, 2, 1], [0, 3, 1]]
  },
  {
    label: "Ph", aliases: [], name: "phenyl", smiles: "*C1=CC=CC=C1", formula: "C6H5", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 0, x: 0, y: 0 },
      { element: "C", hydrogens: 1, x: 0.5, y: 0.866 },
      { element: "C", hydrogens: 1, x: 1.5, y: 0.866 },
      { element: "C", hydrogens: 1, x: 2, y: 0 },
      { element: "C", hydrogens: 1, x: 1.5, y: -0.866 },
      { element: "C", hydrogens: 1, x: 0.5, y: -0.866 }
    ],
    bonds: [[0, 1, 2], [1, 2, 1], [2, 3, 2], [3, 4, 1], [4, 5, 2], [5, 0, 1]]
  },
  {
    label: "Bn", aliases: [], name: "benzyl", smiles: "*CC1=CC=CC=C1", formula: "C7H7", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 2, x: 0, y: 0 },
      { element: "C", hydrogens: 0, x: 0.5, y: 0.866 },
      { element: "C", hydrogens: 1, x: 0, y: 1.732 },
      { element: "C", hydrogens: 1, x: 0.5, y: 2.598 },
      { element: "C", hydrogens: 1, x: 1.5, y: 2.598 },
      { element: "C", hydrogens: 1, x: 2, y: 1.732 },
      { element: "C", hydrogens: 1, x: 1.5, y: 0.866 }
    ],
    bonds: [[0, 1, 1], [1, 2, 2], [2, 3, 1], [3, 4, 2], [4, 5, 1], [5, 6, 2], [6, 1, 1]]
  },
  {
    label: "Bz", aliases: [], name: "benzoyl", smiles: "*C(=O)C1=CC=CC=C1", formula: "C7H5O", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 0, x: 0, y: 0 },
      { element: "O", hydrogens: 0, x: 0.5, y: -0.866 },
      { element: "C", hydrogens: 0, x: 0.5, y: 0.866 },
      { element: "C", hydrogens: 1, x: 0, y: 1.732 },
      { element: "C", hydrogens: 1, x: 0.5, y: 2.598 },
      { element: "C", hydrogens: 1, x: 1.5, y: 2.598 },
      { element: "C", hydrogens: 1, x: 2, y: 1.732 },
      { element: "C", hydrogens: 1, x: 1.5, y: 0.866 }
    ],
    bonds: [[0, 1, 2], [0, 2, 1], [2, 3, 2], [3, 4, 1], [4, 5, 2], [5, 6, 1], [6, 7, 2], [7, 2, 1]]
  },
  {
    // Acetyl's own abbreviation, "Ac", is also the element actinium, so it names this group only on
    // an atom with bonds (`bondedSpellings`); "COMe"/"MeCO" name it anywhere.
    label: "COMe", aliases: ["MeCO"], bondedSpellings: ["Ac"], name: "acetyl", smiles: "*C(C)=O", formula: "C2H3O", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 0, x: 0, y: 0 },
      { element: "C", hydrogens: 3, x: 0.5, y: -0.866 },
      { element: "O", hydrogens: 0, x: 0.5, y: 0.866 }
    ],
    bonds: [[0, 1, 1], [0, 2, 2]]
  },
  {
    label: "OMe", aliases: ["MeO"], name: "methoxy", smiles: "*OC", formula: "CH3O", attachmentCount: 1,
    atoms: [
      { element: "O", hydrogens: 0, x: 0, y: 0 },
      { element: "C", hydrogens: 3, x: 0.5, y: -0.866 }
    ],
    bonds: [[0, 1, 1]]
  },
  {
    label: "OEt", aliases: ["EtO"], name: "ethoxy", smiles: "*OCC", formula: "C2H5O", attachmentCount: 1,
    atoms: [
      { element: "O", hydrogens: 0, x: 0, y: 0 },
      { element: "C", hydrogens: 2, x: 0.5, y: -0.866 },
      { element: "C", hydrogens: 3, x: 1.5, y: -0.866 }
    ],
    bonds: [[0, 1, 1], [1, 2, 1]]
  },
  {
    label: "OAc", aliases: ["AcO"], name: "acetoxy", smiles: "*OC(C)=O", formula: "C2H3O2", attachmentCount: 1,
    atoms: [
      { element: "O", hydrogens: 0, x: 0, y: 0 },
      { element: "C", hydrogens: 0, x: 0.5, y: -0.866 },
      { element: "C", hydrogens: 3, x: 1.5, y: -0.866 },
      { element: "O", hydrogens: 0, x: 0, y: -1.732 }
    ],
    bonds: [[0, 1, 1], [1, 2, 1], [1, 3, 2]]
  },
  {
    label: "OPh", aliases: ["PhO"], name: "phenoxy", smiles: "*OC1=CC=CC=C1", formula: "C6H5O", attachmentCount: 1,
    atoms: [
      { element: "O", hydrogens: 0, x: 0, y: 0 },
      { element: "C", hydrogens: 0, x: 0.5, y: 0.866 },
      { element: "C", hydrogens: 1, x: 0, y: 1.732 },
      { element: "C", hydrogens: 1, x: 0.5, y: 2.598 },
      { element: "C", hydrogens: 1, x: 1.5, y: 2.598 },
      { element: "C", hydrogens: 1, x: 2, y: 1.732 },
      { element: "C", hydrogens: 1, x: 1.5, y: 0.866 }
    ],
    bonds: [[0, 1, 1], [1, 2, 2], [2, 3, 1], [3, 4, 2], [4, 5, 1], [5, 6, 2], [6, 1, 1]]
  },
  {
    label: "CO2H", aliases: ["COOH", "HO2C", "HOOC"], name: "carboxy", smiles: "*C(=O)O", formula: "CHO2", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 0, x: 0, y: 0 },
      { element: "O", hydrogens: 0, x: 0.5, y: 0.866 },
      { element: "O", hydrogens: 1, x: 0.5, y: -0.866 }
    ],
    bonds: [[0, 1, 2], [0, 2, 1]]
  },
  {
    label: "CO2Me", aliases: ["COOMe", "MeO2C", "MeOOC"], name: "methoxycarbonyl", smiles: "*C(=O)OC", formula: "C2H3O2", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 0, x: 0, y: 0 },
      { element: "O", hydrogens: 0, x: 0.5, y: 0.866 },
      { element: "O", hydrogens: 0, x: 0.5, y: -0.866 },
      { element: "C", hydrogens: 3, x: 1.5, y: -0.866 }
    ],
    bonds: [[0, 1, 2], [0, 2, 1], [2, 3, 1]]
  },
  {
    label: "CO2Et", aliases: ["COOEt", "EtO2C", "EtOOC"], name: "ethoxycarbonyl", smiles: "*C(=O)OCC", formula: "C3H5O2", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 0, x: 0, y: 0 },
      { element: "O", hydrogens: 0, x: 0.5, y: 0.866 },
      { element: "O", hydrogens: 0, x: 0.5, y: -0.866 },
      { element: "C", hydrogens: 2, x: 1.5, y: -0.866 },
      { element: "C", hydrogens: 3, x: 2, y: -1.732 }
    ],
    bonds: [[0, 1, 2], [0, 2, 1], [2, 3, 1], [3, 4, 1]]
  },
  {
    label: "CHO", aliases: ["OHC"], name: "formyl", smiles: "*C=O", formula: "CHO", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 1, x: 0, y: 0 },
      { element: "O", hydrogens: 0, x: 0.5, y: -0.866 }
    ],
    bonds: [[0, 1, 2]]
  },
  {
    // No "NC" alias: written that way on a bond's right it reads as isocyano (-N≡C), not cyano.
    // The label's side is unknown to the reader, so "OCN" and "SCN" read as cyanato and
    // thiocyanato wherever they sit; written for a bond on their right, a chemist means isocyanate
    // and isothiocyanate (O=C=N–, S=C=N–). A known limitation.
    label: "CN", aliases: [], name: "cyano", smiles: "*C#N", formula: "CN", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 0, x: 0, y: 0 },
      { element: "N", hydrogens: 0, x: 1, y: 0 }
    ],
    bonds: [[0, 1, 3]]
  },
  {
    label: "CF3", aliases: ["F3C"], name: "trifluoromethyl", smiles: "*C(F)(F)F", formula: "CF3", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 0, x: 0, y: 0 },
      { element: "F", hydrogens: 0, x: 1, y: 0 },
      { element: "F", hydrogens: 0, x: 0, y: -1 },
      { element: "F", hydrogens: 0, x: 0, y: 1 }
    ],
    bonds: [[0, 1, 1], [0, 2, 1], [0, 3, 1]]
  },
  {
    label: "NO2", aliases: ["O2N"], name: "nitro", smiles: "*[N+](=O)[O-]", formula: "NO2", attachmentCount: 1,
    atoms: [
      { element: "N", hydrogens: 0, charge: 1, x: 0, y: 0 },
      { element: "O", hydrogens: 0, x: 0.5, y: 0.866 },
      { element: "O", hydrogens: 0, charge: -1, x: 0.5, y: -0.866 }
    ],
    bonds: [[0, 1, 2], [0, 2, 1]]
  },
  {
    label: "N3", aliases: [], name: "azido", smiles: "*N=[N+]=[N-]", formula: "N3", attachmentCount: 1,
    atoms: [
      { element: "N", hydrogens: 0, x: 0, y: 0 },
      { element: "N", hydrogens: 0, charge: 1, x: 0.5, y: -0.866 },
      { element: "N", hydrogens: 0, charge: -1, x: 1, y: -1.732 }
    ],
    bonds: [[0, 1, 2], [1, 2, 2]]
  },
  {
    label: "MgBr", aliases: ["BrMg"], name: "bromomagnesio", smiles: "*[Mg]Br", formula: "BrMg", attachmentCount: 1,
    atoms: [
      { element: "Mg", hydrogens: 0, x: 0, y: 0 },
      { element: "Br", hydrogens: 0, x: 1, y: 0 }
    ],
    bonds: [[0, 1, 1]]
  },
  {
    label: "Boc", aliases: [], name: "tert-butoxycarbonyl", smiles: "*C(=O)OC(C)(C)C", formula: "C5H9O2", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 0, x: 0, y: 0 },
      { element: "O", hydrogens: 0, x: 0.5, y: 0.866 },
      { element: "O", hydrogens: 0, x: 0.5, y: -0.866 },
      { element: "C", hydrogens: 0, x: 1.5, y: -0.866 },
      { element: "C", hydrogens: 3, x: 1.5, y: -1.866 },
      { element: "C", hydrogens: 3, x: 1.5, y: 0.134 },
      { element: "C", hydrogens: 3, x: 2.5, y: -0.866 }
    ],
    bonds: [[0, 1, 2], [0, 2, 1], [2, 3, 1], [3, 4, 1], [3, 5, 1], [3, 6, 1]]
  },
  {
    label: "Cbz", aliases: [], name: "benzyloxycarbonyl", smiles: "*C(=O)OCC1=CC=CC=C1", formula: "C8H7O2", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 0, x: 0, y: 0 },
      { element: "O", hydrogens: 0, x: 0.5, y: -0.866 },
      { element: "O", hydrogens: 0, x: 0.5, y: 0.866 },
      { element: "C", hydrogens: 2, x: 1.5, y: 0.866 },
      { element: "C", hydrogens: 0, x: 2, y: 1.732 },
      { element: "C", hydrogens: 1, x: 1.5, y: 2.598 },
      { element: "C", hydrogens: 1, x: 2, y: 3.464 },
      { element: "C", hydrogens: 1, x: 3, y: 3.464 },
      { element: "C", hydrogens: 1, x: 3.5, y: 2.598 },
      { element: "C", hydrogens: 1, x: 3, y: 1.732 }
    ],
    bonds: [[0, 1, 2], [0, 2, 1], [2, 3, 1], [3, 4, 1], [4, 5, 2], [5, 6, 1], [6, 7, 2], [7, 8, 1], [8, 9, 2], [9, 4, 1]]
  },
  {
    label: "Fmoc", aliases: [], name: "9-fluorenylmethoxycarbonyl", smiles: "*C(=O)OCC1C2=CC=CC=C2C2=CC=CC=C12", formula: "C15H11O2", attachmentCount: 1,
    atoms: [
      { element: "C", hydrogens: 0, x: 0, y: 0 },
      { element: "O", hydrogens: 0, x: 0.5, y: -0.866 },
      { element: "O", hydrogens: 0, x: 0.5, y: 0.866 },
      { element: "C", hydrogens: 2, x: 1.5, y: 0.866 },
      { element: "C", hydrogens: 1, x: 2, y: 1.732 },
      { element: "C", hydrogens: 0, x: 2.995, y: 1.837 },
      { element: "C", hydrogens: 1, x: 3.738, y: 1.168 },
      { element: "C", hydrogens: 1, x: 4.689, y: 1.477 },
      { element: "C", hydrogens: 1, x: 4.897, y: 2.455 },
      { element: "C", hydrogens: 1, x: 4.153, y: 3.124 },
      { element: "C", hydrogens: 0, x: 3.202, y: 2.815 },
      { element: "C", hydrogens: 0, x: 2.336, y: 3.315 },
      { element: "C", hydrogens: 1, x: 2.128, y: 4.293 },
      { element: "C", hydrogens: 1, x: 1.177, y: 4.602 },
      { element: "C", hydrogens: 1, x: 0.434, y: 3.933 },
      { element: "C", hydrogens: 1, x: 0.642, y: 2.955 },
      { element: "C", hydrogens: 0, x: 1.593, y: 2.646 }
    ],
    bonds: [
      [0, 1, 2], [0, 2, 1], [2, 3, 1], [3, 4, 1], [4, 5, 1], [5, 6, 2], [6, 7, 1], [7, 8, 2], [8, 9, 1], [9, 10, 2],
      [10, 11, 1], [11, 12, 2], [12, 13, 1], [13, 14, 2], [14, 15, 1], [15, 16, 2], [16, 4, 1], [10, 5, 1], [16, 11, 1]
    ]
  },
  {
    label: "TMS", aliases: [], name: "trimethylsilyl", smiles: "*[Si](C)(C)C", formula: "C3H9Si", attachmentCount: 1,
    atoms: [
      { element: "Si", hydrogens: 0, x: 0, y: 0 },
      { element: "C", hydrogens: 3, x: 1, y: 0 },
      { element: "C", hydrogens: 3, x: 0, y: -1 },
      { element: "C", hydrogens: 3, x: 0, y: 1 }
    ],
    bonds: [[0, 1, 1], [0, 2, 1], [0, 3, 1]]
  },
  {
    label: "TBS", aliases: ["TBDMS"], name: "tert-butyldimethylsilyl", smiles: "*[Si](C)(C)C(C)(C)C", formula: "C6H15Si", attachmentCount: 1,
    atoms: [
      { element: "Si", hydrogens: 0, x: 0, y: 0 },
      { element: "C", hydrogens: 3, x: 1, y: 0 },
      { element: "C", hydrogens: 3, x: 0, y: -1 },
      { element: "C", hydrogens: 0, x: 0, y: 1 },
      { element: "C", hydrogens: 3, x: 1, y: 1 },
      { element: "C", hydrogens: 3, x: -1, y: 1 },
      { element: "C", hydrogens: 3, x: 0, y: 2 }
    ],
    bonds: [[0, 1, 1], [0, 2, 1], [0, 3, 1], [3, 4, 1], [3, 5, 1], [3, 6, 1]]
  },
  {
    label: "Ms", aliases: ["SO2Me", "MeSO2"], name: "methanesulfonyl", smiles: "*S(=O)(=O)C", formula: "CH3O2S", attachmentCount: 1,
    atoms: [
      { element: "S", hydrogens: 0, x: 0, y: 0 },
      { element: "O", hydrogens: 0, x: 0, y: -1 },
      { element: "O", hydrogens: 0, x: 0, y: 1 },
      { element: "C", hydrogens: 3, x: 1, y: 0 }
    ],
    bonds: [[0, 1, 2], [0, 2, 2], [0, 3, 1]]
  },
  {
    // "Ts" is also tennessine, so it names tosyl only on an atom with bonds; "Tos" names it anywhere.
    label: "Tos", aliases: [], bondedSpellings: ["Ts"], name: "p-toluenesulfonyl (tosyl)", smiles: "*S(=O)(=O)C1=CC=C(C)C=C1", formula: "C7H7O2S", attachmentCount: 1,
    atoms: [
      { element: "S", hydrogens: 0, x: 0, y: 0 },
      { element: "O", hydrogens: 0, x: 0, y: -1 },
      { element: "O", hydrogens: 0, x: 0, y: 1 },
      { element: "C", hydrogens: 0, x: 1, y: 0 },
      { element: "C", hydrogens: 1, x: 1.5, y: 0.866 },
      { element: "C", hydrogens: 1, x: 2.5, y: 0.866 },
      { element: "C", hydrogens: 0, x: 3, y: 0 },
      { element: "C", hydrogens: 3, x: 4, y: 0 },
      { element: "C", hydrogens: 1, x: 2.5, y: -0.866 },
      { element: "C", hydrogens: 1, x: 1.5, y: -0.866 }
    ],
    bonds: [[0, 1, 2], [0, 2, 2], [0, 3, 1], [3, 4, 1], [4, 5, 2], [5, 6, 1], [6, 7, 1], [6, 8, 2], [8, 9, 1], [9, 3, 2]]
  },
  {
    label: "Tf", aliases: ["SO2CF3", "CF3SO2", "F3CSO2"], name: "trifluoromethanesulfonyl", smiles: "*S(=O)(=O)C(F)(F)F", formula: "CF3O2S", attachmentCount: 1,
    atoms: [
      { element: "S", hydrogens: 0, x: 0, y: 0 },
      { element: "O", hydrogens: 0, x: 0, y: -1 },
      { element: "O", hydrogens: 0, x: 0, y: 1 },
      { element: "C", hydrogens: 0, x: 1, y: 0 },
      { element: "F", hydrogens: 0, x: 1, y: 1 },
      { element: "F", hydrogens: 0, x: 1, y: -1 },
      { element: "F", hydrogens: 0, x: 2, y: 0 }
    ],
    bonds: [[0, 1, 2], [0, 2, 2], [0, 3, 1], [3, 4, 1], [3, 5, 1], [3, 6, 1]]
  }
];

const abbreviationBySpelling: ReadonlyMap<string, AbbreviationDefinition> = new Map(
  abbreviationDefinitions.flatMap((definition) =>
    [definition.label, ...definition.aliases].map((spelling) => [spelling, definition] as const)
  )
);

/** Every spelling the table answers to (labels and aliases), longest first — for tokenizing. */
export const abbreviationSpellings: readonly string[] = [...abbreviationBySpelling.keys()]
  .sort((left, right) => right.length - left.length || left.localeCompare(right));

/** The group a label spells, matched exactly and case-sensitively ("OMe" yes, "Ome" no). */
export function abbreviationForLabel(label: string): AbbreviationDefinition | undefined {
  return abbreviationBySpelling.get(label.trim());
}

const abbreviationByBondedSpelling: ReadonlyMap<string, AbbreviationDefinition> = new Map(
  abbreviationDefinitions.flatMap((definition) =>
    (definition.bondedSpellings ?? []).map((spelling) => [spelling, definition] as const)
  )
);

/** Every bonded-only spelling ("Ac", "Pr", "Ts"), longest first — for tokenizing composites. */
export const abbreviationBondedSpellings: readonly string[] = [...abbreviationByBondedSpelling.keys()]
  .sort((left, right) => right.length - left.length || left.localeCompare(right));

/**
 * The group an element-symbol label names when its atom has bonds ("Ac" → acetyl), matched exactly.
 * The caller decides whether the atom is bonded; unbonded, these labels are their elements.
 */
export function abbreviationForBondedElementLabel(label: string): AbbreviationDefinition | undefined {
  return abbreviationByBondedSpelling.get(label.trim());
}

/**
 * The spelling a label was probably meant to be, when it matches one only by ignoring case
 * ("Ome" → "OMe", "meo" → "MeO"). Only a suggestion for a message: matching itself never ignores
 * case. Undefined when nothing matches that way, or when the match is ambiguous.
 */
export function abbreviationSpellingSuggestion(label: string): string | undefined {
  const folded = label.trim().toLowerCase();
  const matches = abbreviationSpellings.filter((spelling) => spelling.toLowerCase() === folded);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Hill-order element counts of a group, hydrogens included. */
export function abbreviationElementCounts(definition: AbbreviationDefinition): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (element: string, count: number) => {
    if (count > 0) counts.set(element, (counts.get(element) ?? 0) + count);
  };
  for (const atom of definition.atoms) {
    add(atom.element, 1);
    add("H", atom.hydrogens);
  }
  return counts;
}
