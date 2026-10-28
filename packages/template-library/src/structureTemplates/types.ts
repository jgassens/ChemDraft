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

interface StructureTemplateData {
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
  layout: {
    atoms: readonly StructureTemplateAtom[];
    bonds: readonly StructureTemplateBond[];
  };
  /** Only for unavoidable crossings in a family's 2D projection; document the reason at source. */
  allowedCrossings?: number;
}

/** Missing PubChem records require an explicit identity/source explanation. */
export type StructureTemplate = StructureTemplateData & (
  // note explains non-obvious identity choices (including the chosen PubChem record).
  | { source: { database: "PubChem"; cid: number }; note?: string }
  | { source: { database: "PubChem"; cid: null }; note: string }
);
