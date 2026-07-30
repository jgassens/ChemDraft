/**
 * The property corpus (PLANS.md §10).
 *
 * A sibling to `packages/chem-core/src/corpus.ts`, not an extension of it: that corpus is scoped to
 * 3D flatten cases and its entries carry flatten-specific expectations.
 *
 * The corpus is chosen adversarially. Its job is not to show that descriptors work on aspirin — that
 * is what the engine-regression fixtures do — but to find the structures where an engine returns a
 * confident number it should not have, or refuses one it should have given. Hence:
 *
 *   "A predictor that returns a number for everything is more dangerous than one that explicitly
 *    declines an out-of-domain structure."
 *
 * Every entry states what it is *for*. `mustDecline` is the sharp end: a method listed there and
 * returning `ok` is a test failure, not a nice-to-have.
 */

/**
 * The adversarial categories PLANS.md §10 names, as a value rather than a type alone.
 *
 * A value is what lets `propertyCorpus.test.ts` assert that every declared category has an entry —
 * the check that caught `oversize` and `stereochemistry` sitting in this list with nothing tagged
 * them, which is a coverage gap that reads exactly like coverage.
 */
export const CORPUS_TAGS = [
  "salt",
  "disconnected",
  "zwitterion",
  "radical",
  "isotope-label",
  "sulfur-phosphorus",
  "boron",
  "silicon",
  "charged-heterocycle",
  "tautomer",
  "organometallic",
  "oversize",
  "unsupported-atom",
  "stereochemistry",
  "aromaticity",
  "baseline"
] as const;

export type CorpusTag = (typeof CORPUS_TAGS)[number];

export interface PropertyCorpusEntry {
  id: string;
  name: string;
  smiles: string;
  tags: CorpusTag[];
  /** Why this structure is in the corpus — the failure it is meant to catch. */
  rationale: string;
  /**
   * Method ids that must NOT return a number for this structure. Checked against
   * `AnalysisStatus`: anything other than `unsupported` / `not-applicable` fails the suite.
   */
  mustDecline?: string[];
  /**
   * Structures whose source-preserving composition is the whole point. The expected Hill formula for
   * the `source` interpretation, where it is unambiguous and worth pinning by hand.
   */
  expectedSourceFormula?: string;
  expectedSourceCharge?: number;
  /** Number of connected components as drawn. `1` for everything that is not a salt or mixture. */
  expectedComponentCount: number;
}

export const propertyCorpus: readonly PropertyCorpusEntry[] = [
  {
    id: "aspirin",
    name: "Aspirin",
    smiles: "CC(=O)Oc1ccccc1C(=O)O",
    tags: ["baseline", "aromaticity"],
    rationale:
      "The engine-regression anchor. Every descriptor in Release 1 has a pinned value for this molecule, " +
      "so a vendor bump shows up as a diff rather than a drift.",
    expectedSourceFormula: "C9H8O4",
    expectedSourceCharge: 0,
    expectedComponentCount: 1
  },
  {
    id: "sodium-benzoate",
    name: "Sodium benzoate",
    smiles: "[Na+].[O-]C(=O)c1ccccc1",
    tags: ["salt", "disconnected"],
    rationale:
      "The §1 case in one line. Composition and mass must describe the salt; a logP that wants the " +
      "neutralised acid must say so as a separate result against a named interpretation, never in place " +
      "of this one.",
    expectedSourceFormula: "C7H5NaO2",
    expectedSourceCharge: 0,
    expectedComponentCount: 2
  },
  {
    id: "glycine-zwitterion",
    name: "Glycine (zwitterion)",
    smiles: "[NH3+]CC(=O)[O-]",
    tags: ["zwitterion"],
    rationale:
      "Formal charge sums to zero over two charged atoms. A charge implementation that reports the sum " +
      "and stops loses the fact that the molecule is charge-separated; the per-component breakdown must " +
      "not silently neutralise it either.",
    expectedSourceFormula: "C2H5NO2",
    expectedSourceCharge: 0,
    expectedComponentCount: 1
  },
  {
    id: "tempo-radical",
    name: "TEMPO (nitroxide radical)",
    smiles: "CC1(C)CCCC(C)(C)N1[O]",
    tags: ["radical"],
    rationale:
      "An unpaired electron the formula must account for and most fragment methods have no parameters " +
      "for. Crippen logP silently treats the radical oxygen as an ordinary one.",
    expectedComponentCount: 1
  },
  {
    id: "acetic-acid-13c",
    name: "Acetic acid, ¹³C-labelled methyl",
    smiles: "[13CH3]C(=O)O",
    tags: ["isotope-label"],
    rationale:
      "Monoisotopic mass must move by ~1 Da and the formula must record the label; average molar mass " +
      "must NOT, since natural-abundance weighting no longer applies to a labelled position. The single " +
      "clearest test that `dalton` and `gram-per-mole` are not aliases.",
    expectedComponentCount: 1
  },
  {
    id: "sulfamethoxazole",
    name: "Sulfamethoxazole",
    smiles: "Cc1onc(c1)NS(=O)(=O)c1ccc(N)cc1",
    tags: ["sulfur-phosphorus", "charged-heterocycle"],
    rationale:
      "The tPSA `includeSandP` case: RDKit returns 98.22 with sulfur excluded, OpenChemLib 106.60 with " +
      "it included. Pinned so patch #6 is a visible change in the expected number rather than a silent one.",
    expectedComponentCount: 1
  },
  {
    id: "ethyl-phosphate",
    name: "Ethyl phosphate",
    smiles: "CCOP(=O)(O)O",
    tags: ["sulfur-phosphorus"],
    rationale:
      "The 3.3 log-unit logP disagreement between Crippen (0.116) and OpenChemLib (−3.193). Proof that " +
      "the two values cannot be averaged or shown interchangeably.",
    expectedComponentCount: 1
  },
  {
    id: "boronic-acid",
    name: "Phenylboronic acid",
    smiles: "OB(O)c1ccccc1",
    tags: ["boron"],
    rationale:
      "Crippen's atom-contribution tables have no boron parameters. The correct behaviour is to decline, " +
      "not to fall through to a default contribution.",
    mustDecline: ["rdkit.crippen-logp", "rdkit.crippen-mr"],
    expectedComponentCount: 1
  },
  {
    id: "tms",
    name: "Tetramethylsilane",
    smiles: "C[Si](C)(C)C",
    tags: ["silicon"],
    rationale:
      "The NMR reference compound, and a silicon-parameter gap in most fragment methods. Composition and " +
      "mass must work; fragment-rule descriptors should say when they cannot.",
    expectedSourceFormula: "C4H12Si",
    expectedComponentCount: 1
  },
  {
    id: "ferrocene",
    name: "Ferrocene",
    smiles: "[Fe+2].c1cc[cH-]c1.c1cc[cH-]c1",
    tags: ["organometallic", "disconnected", "salt"],
    rationale:
      "Coordination drawn as three disconnected components with formal charges. Composition must report " +
      "what was drawn; every fragment and force-field method must decline rather than treat the iron as " +
      "an ordinary heteroatom.",
    mustDecline: ["rdkit.crippen-logp", "rdkit.crippen-mr"],
    expectedComponentCount: 3
  },
  {
    id: "acetylacetone-keto",
    name: "Acetylacetone (keto tautomer)",
    // 2,4-pentanedione. This entry was originally filed as "-enol" while carrying the keto SMILES;
    // the pair below is what made the mislabelling visible.
    smiles: "CC(=O)CC(C)=O",
    tags: ["tautomer"],
    rationale:
      "Half of the tautomer-policy test: any tautomer-sensitive method must refuse to run against an " +
      "interpretation that declares no `tautomerPolicy`, because which of these two it was handed " +
      "changes the answer.",
    expectedSourceFormula: "C5H8O2",
    expectedComponentCount: 1
  },
  {
    id: "acetylacetone-enol",
    name: "Acetylacetone (enol tautomer)",
    smiles: "CC(O)=CC(C)=O",
    tags: ["tautomer"],
    rationale:
      "The other half of the pair. Same formula and same heavy-atom count as the keto form, different " +
      "hydrogen positions — so a method whose answer differs between the two is tautomer-sensitive by " +
      "demonstration rather than by assertion.",
    expectedSourceFormula: "C5H8O2",
    expectedComponentCount: 1
  },
  {
    id: "threonine-partial-stereo",
    name: "Threonine, one centre unspecified",
    smiles: "CC(O)[C@@H](N)C(=O)O",
    tags: ["stereochemistry"],
    rationale:
      "Two stereocentres, one assigned and one not. The unspecified centre is where a predictor is " +
      "most tempted to quietly assume a configuration; the run must report it as unspecified rather " +
      "than silently picking one, and the CIP labels must name only the centre that was drawn.",
    expectedSourceFormula: "C4H9NO3",
    expectedComponentCount: 1
  },
  {
    id: "oversize-alkane",
    name: "Linear C320 alkane",
    smiles: "C".repeat(320),
    tags: ["oversize"],
    rationale:
      "Deliberately synthetic: it carries no chemistry worth predicting and exists only to prove the " +
      "pipeline survives a structure far larger than anything drawn by hand — no quadratic blowup, no " +
      "truncated formula, and a clean decline once it crosses a caller's heavy-atom limit.",
    expectedSourceFormula: "C320H642",
    expectedComponentCount: 1
  },
  {
    id: "imidazolium",
    name: "1-Methyl-1H-imidazol-3-ium",
    // Written with the explicit [nH+] rather than C[n+]1ccnc1, which RDKit rejects outright: the
    // neutral ring nitrogen has no hydrogen to kekulise around. Caught by the corpus parse check.
    smiles: "Cn1cc[nH+]c1",
    tags: ["charged-heterocycle", "aromaticity"],
    rationale:
      "Aromatic nitrogen carrying a formal charge. Aromaticity model and charge handling interact here; " +
      "a Kekulé/aromatic round trip must not change any descriptor.",
    expectedSourceCharge: 1,
    expectedComponentCount: 1
  },
  {
    id: "cisplatin",
    name: "Cisplatin",
    smiles: "N.N.Cl[Pt]Cl",
    tags: ["organometallic", "disconnected", "unsupported-atom"],
    rationale:
      "Platinum coordination with dative bonds drawn as covalent. Nothing beyond composition should " +
      "claim a number, and even composition must not invent hydrogens on the platinum.",
    mustDecline: ["rdkit.crippen-logp", "rdkit.crippen-mr", "rdkit.tpsa"],
    expectedComponentCount: 3
  }
] as const;

export function corpusEntriesTagged(...tags: CorpusTag[]): PropertyCorpusEntry[] {
  return propertyCorpus.filter((entry) => tags.some((tag) => entry.tags.includes(tag)));
}

export function corpusEntry(id: string): PropertyCorpusEntry {
  const entry = propertyCorpus.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`No property-corpus entry with id "${id}".`);
  return entry;
}

/** Every method id any entry expects to decline — the checklist Phase 2 must satisfy. */
export function methodsExpectedToDecline(): string[] {
  return [...new Set(propertyCorpus.flatMap((entry) => entry.mustDecline ?? []))].sort();
}
