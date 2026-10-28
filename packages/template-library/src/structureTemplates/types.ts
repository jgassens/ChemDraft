export type StructureTemplateFamily =
  | "crown-ethers-cryptands"
  | "cyclodextrins"
  | "cucurbiturils"
  | "calixarenes-pillararenes"
  | "cyclophanes"
  | "porphyrins"
  | "fullerenes";

/** Original coordinates in bond lengths, y up; the bounding box is centred on (0, 0). */
export interface StructureTemplateAtom {
  element: string;
  charge?: number;
  x: number;
  y: number;
}

/** Zero-based indices, Kekulé orders. Wedge/hash starts at the stereocentre (first atom). */
export type StructureTemplateBond = readonly [
  from: number,
  to: number,
  order: 1 | 2 | 3,
  display?: "wedge" | "hash"
];

export interface StructureTemplate {
  /** Stable kebab-case identifier, independent of the display name. */
  id: string;
  name: string;
  synonyms: readonly string[];
  family: StructureTemplateFamily;
  category: "supramolecular";
  /** Vetted isomeric identity, not a source of drawing coordinates. */
  smiles: string;
  /** Hill formula; hydrogens in the layout are implicit under standard valence. */
  formula: string;
  charge: number;
  source: { database: "PubChem"; cid: number };
  layout: {
    atoms: readonly StructureTemplateAtom[];
    bonds: readonly StructureTemplateBond[];
  };
  /** Only for unavoidable crossings in a family's 2D projection; document the reason at source. */
  allowedCrossings?: number;
}
