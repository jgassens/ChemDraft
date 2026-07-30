/**
 * Derived interpretations (PLANS.md §1, Phase 3).
 *
 * "Parse once → preserve the source representation → derive explicitly named interpretations →
 * calculate against a specified interpretation." Phase 2 shipped the `source` end of that; this module
 * is the other end.
 *
 * **Neither derivation re-decides chemistry.** That is §7's rule, and the two mechanisms here were
 * chosen to obey it:
 *
 * - **Component selection edits RDKit's JSON and hands it back to `get_mol`.** RDKit JSON round-trips
 *   through MinimalLib preserving atom order, isotope labels, and CIP assignments exactly, so dropping
 *   a counterion is a selection over RDKit's own atom list — no valence, hydrogen count, or
 *   aromaticity is recomputed by us.
 * - **Neutralisation strips `M  CHG` from a V2000 molblock and re-parses.** It cannot go through JSON:
 *   RDKit JSON's `impHs` is authoritative rather than a hint, so zeroing charges there yields
 *   `[O]C(=O)c1[c][c][c][c][c]1` — a radical on every aromatic carbon. In a molblock the hydrogen count
 *   is implied by valence, so RDKit recomputes it, which is precisely the decision we must not make.
 *
 * The second mechanism also fails in the right direction. A quaternary ammonium and a nitro group both
 * return `null` from `get_mol` after their charges are stripped, because neither has a valid neutral
 * form. The interpretation is then simply unavailable — never fabricated.
 */
import {
  hashInterpretation,
  type MolecularInterpretation,
  type Transformation
} from "@chemdraft/analysis-core";

import { connectedComponents, elementSymbol, hillFormula, type RdkitJson } from "./composition";
import type { ElementCount } from "@chemdraft/analysis-core";

export type DerivedInterpretationId = "largest-organic-fragment" | "neutralized";

export const DERIVED_INTERPRETATION_IDS: readonly DerivedInterpretationId[] = [
  "largest-organic-fragment",
  "neutralized"
];

const TRANSFORMATION_VERSION = "1.0.0";

// --- component selection -------------------------------------------------------------------------

interface ComponentSummary {
  atoms: number[];
  formula: string;
  charge: number;
  heavyAtomCount: number;
  isOrganic: boolean;
}

function summariseComponents(json: RdkitJson): ComponentSummary[] {
  const molecule = json.molecules[0];
  if (!molecule) return [];
  const defaults = json.defaults?.atom ?? {};
  const atoms = molecule.atoms.map((atom) => ({
    z: atom.z ?? defaults.z ?? 6,
    impHs: atom.impHs ?? defaults.impHs ?? 0,
    chg: atom.chg ?? defaults.chg ?? 0,
    isotope: atom.isotope ?? defaults.isotope ?? 0
  }));

  return connectedComponents(atoms.length, molecule.bonds ?? []).map((group) => {
    const tallies = new Map<string, ElementCount>();
    let charge = 0;
    let heavyAtomCount = 0;
    let isOrganic = false;
    for (const index of group) {
      const atom = atoms[index]!;
      const symbol = elementSymbol(atom.z);
      if (symbol === "C") isOrganic = true;
      if (symbol !== "H") heavyAtomCount += 1;
      const key = atom.isotope ? `${symbol}-${atom.isotope}` : symbol;
      const existing = tallies.get(key);
      if (existing) existing.count += 1;
      else tallies.set(key, atom.isotope ? { symbol, count: 1, isotope: atom.isotope } : { symbol, count: 1 });
      if (atom.impHs > 0) {
        const hydrogens = tallies.get("H");
        if (hydrogens) hydrogens.count += atom.impHs;
        else tallies.set("H", { symbol: "H", count: atom.impHs });
      }
      charge += atom.chg;
    }
    return {
      atoms: group,
      formula: hillFormula([...tallies.values()]),
      charge,
      heavyAtomCount,
      isOrganic
    };
  });
}

export interface FragmentPlan {
  /** Source atom indices to keep, ascending. */
  keptAtoms: number[];
  keptFormula: string;
  removedFormulas: string[];
  /**
   * True when a discarded component was organic and no smaller than the kept one, so the choice of
   * "the" organic fragment was arbitrary. Ferrocene's two cyclopentadienyl rings are the case.
   */
  ambiguous: boolean;
}

/**
 * Choose the largest carbon-containing component.
 *
 * Returns `undefined` when the input is a single component (nothing to select) or contains no carbon
 * at all (there is no organic fragment — cisplatin, for instance). Both are correct absences: the
 * interpretation genuinely does not exist for that input, and offering an identity transformation or
 * an arbitrary inorganic fragment would be worse than offering nothing.
 *
 * Ties break on heavy-atom count, then on the lowest source atom index, so the choice is deterministic
 * across representations rather than dependent on component discovery order.
 */
export function largestOrganicFragmentPlan(json: RdkitJson): FragmentPlan | undefined {
  const components = summariseComponents(json);
  if (components.length <= 1) return undefined;

  const organic = components.filter((component) => component.isOrganic);
  if (organic.length === 0) return undefined;

  const best = organic.reduce((chosen, candidate) => {
    if (candidate.heavyAtomCount !== chosen.heavyAtomCount) {
      return candidate.heavyAtomCount > chosen.heavyAtomCount ? candidate : chosen;
    }
    return (candidate.atoms[0] ?? 0) < (chosen.atoms[0] ?? 0) ? candidate : chosen;
  });

  const removed = components.filter((component) => component !== best);
  return {
    keptAtoms: [...best.atoms],
    keptFormula: best.formula,
    removedFormulas: removed.map((component) => component.formula),
    ambiguous: removed.some(
      (component) => component.isOrganic && component.heavyAtomCount >= best.heavyAtomCount
    )
  };
}

/**
 * An RDKit JSON document containing only `keepAtoms`, in source order, with bonds reindexed.
 *
 * Every atom object is passed through untouched — `impHs`, `chg`, `nRad`, `isotope`, `stereo` are
 * RDKit's own values, and `defaults` travels with them so the omitted-field convention still holds.
 */
export function subsetRdkitJson(json: RdkitJson, keepAtoms: readonly number[]): string {
  const molecule = json.molecules[0];
  if (!molecule) throw new Error("RDKit JSON carried no molecule.");
  const remap = new Map(keepAtoms.map((sourceIndex, derivedIndex) => [sourceIndex, derivedIndex]));

  // Only `atoms` and `bonds` carry across. RDKit also writes an `extensions` block holding
  // `rdkitRepresentation` — aromatic atom and bond indices, CIP ranks, ring membership — all keyed by
  // the *original* atom numbering. Carrying it onto a subset points it at atoms that no longer exist,
  // and `get_mol` returns null rather than guessing. Dropping it is also the right call on the merits:
  // re-perceiving aromaticity and rings on the fragment is RDKit's job, not a record to be patched up.
  const rdkitjson = (json as { rdkitjson?: unknown }).rdkitjson;

  return JSON.stringify({
    ...(rdkitjson !== undefined ? { rdkitjson } : {}),
    ...(json.defaults ? { defaults: json.defaults } : {}),
    molecules: [
      {
        atoms: keepAtoms.map((index) => molecule.atoms[index]),
        bonds: (molecule.bonds ?? [])
          .filter((bond) => remap.has(bond.atoms[0]) && remap.has(bond.atoms[1]))
          .map((bond) => ({ ...bond, atoms: [remap.get(bond.atoms[0])!, remap.get(bond.atoms[1])!] }))
      }
    ]
  });
}

// --- neutralisation ------------------------------------------------------------------------------

export interface ChargeStripResult {
  molblock: string;
  /** How many atoms carried a formal charge before stripping. */
  chargedAtomCount: number;
  /** Net formal charge removed, signed. */
  netChargeRemoved: number;
}

/**
 * Remove every `M  CHG` record from a V2000 molblock.
 *
 * Deliberately whole-molecule rather than selective: within a largest-organic-fragment there is no
 * counterion left to protect, and a rule for which charges "deserve" neutralising would be exactly the
 * chemistry judgement this module refuses to make. RDKit decides whether the result is a molecule at
 * all — a nitro group and a quaternary ammonium both come back `null`.
 */
export function stripMolblockCharges(molblock: string): ChargeStripResult {
  const lines = molblock.split("\n");
  let chargedAtomCount = 0;
  let netChargeRemoved = 0;

  const kept = lines.filter((line) => {
    if (!line.startsWith("M  CHG")) return true;
    // "M  CHG  2   4  -1   7   1" — a count followed by (atom, charge) pairs in fixed-width fields.
    const fields = line.slice(6).trim().split(/\s+/).map(Number);
    const pairCount = fields[0] ?? 0;
    for (let pair = 0; pair < pairCount; pair += 1) {
      const charge = fields[2 + pair * 2];
      if (typeof charge === "number" && Number.isFinite(charge) && charge !== 0) {
        chargedAtomCount += 1;
        netChargeRemoved += charge;
      }
    }
    return false;
  });

  return { molblock: kept.join("\n"), chargedAtomCount, netChargeRemoved };
}

// --- ledger construction -------------------------------------------------------------------------

function identityMapping(count: number): Transformation["atomMapping"] {
  return Array.from({ length: count }, (_unused, index) => [index, index] as const);
}

function transformation(overrides: Partial<Transformation> & Pick<Transformation, "name">): Transformation {
  return {
    version: TRANSFORMATION_VERSION,
    atomMapping: [],
    componentsRemoved: [],
    componentsRetained: [],
    componentsNeutralized: [],
    bondOrderChanges: 0,
    aromaticityChanges: 0,
    hydrogenChanges: 0,
    tautomerChanged: false,
    chargeChanges: 0,
    unrepresentableFeatures: [],
    ...overrides
  };
}

/** The ledger entry for dropping every component but the largest organic one. */
export function fragmentTransformation(plan: FragmentPlan): Transformation {
  return transformation({
    name: "largest-organic-fragment",
    atomMapping: plan.keptAtoms.map((sourceIndex, derivedIndex) => [sourceIndex, derivedIndex] as const),
    componentsRemoved: plan.removedFormulas,
    componentsRetained: [plan.keptFormula],
    unrepresentableFeatures: plan.ambiguous
      ? [
          "another organic component was no smaller than the one kept, so the choice of fragment is " +
            "arbitrary; the discarded component is named in componentsRemoved"
        ]
      : []
  });
}

/**
 * The ledger entry for neutralisation.
 *
 * `chargeChanges` counts the **atoms** whose formal charge was removed, not the net charge — matching
 * how `bondOrderChanges` and `aromaticityChanges` read, and for a concrete reason: a zwitterion's net
 * charge change is zero while two of its atoms were neutralised, so a net would report "nothing
 * happened" about the one case where the derivation matters most.
 *
 * `hydrogenChanges` stays a signed delta, because the direction is the chemistry: neutralising an
 * anion adds hydrogen and a cation loses it. It is read back off the derived molecule rather than
 * predicted — RDKit decided the hydrogen count, and working it out here would be the interpretation
 * this module refuses to make.
 */
export function neutralizeTransformation(input: {
  atomCount: number;
  neutralizedFormula: string;
  chargedAtomCount: number;
  netChargeRemoved: number;
  hydrogenChanges: number;
}): Transformation {
  return transformation({
    name: "neutralize",
    atomMapping: identityMapping(input.atomCount),
    componentsNeutralized: [input.neutralizedFormula],
    componentsRetained: [input.neutralizedFormula],
    chargeChanges: input.chargedAtomCount,
    hydrogenChanges: input.hydrogenChanges
  });
}

/**
 * Build a derived interpretation from a base one plus the step that produced it.
 *
 * The label is generated from the composed ledger rather than passed in, so a description can never
 * drift from the transformations it claims to describe.
 */
export function deriveInterpretation(input: {
  id: DerivedInterpretationId;
  base: MolecularInterpretation;
  step: Transformation;
  componentPolicy?: MolecularInterpretation["componentPolicy"];
}): MolecularInterpretation {
  const policy = {
    id: input.id,
    sourceHash: input.base.sourceHash,
    componentPolicy: input.componentPolicy ?? input.base.componentPolicy,
    explicitHydrogenPolicy: input.base.explicitHydrogenPolicy,
    isotopePolicy: input.base.isotopePolicy,
    aromaticityModel: input.base.aromaticityModel,
    ...(input.base.tautomerPolicy ? { tautomerPolicy: input.base.tautomerPolicy } : {}),
    ...(input.base.protomerPolicy ? { protomerPolicy: input.base.protomerPolicy } : {}),
    transformations: [...input.base.transformations, input.step]
  };
  return {
    ...policy,
    label: describeInterpretation({ ...policy, label: "", interpretationHash: "" }),
    interpretationHash: hashInterpretation(policy)
  };
}

/**
 * The disclosure line §1 asks the UI to show: *"largest organic fragment · counterion removed"*.
 *
 * Built from the ledger rather than written per call site, so a transformation that starts doing
 * something new cannot keep an old description.
 */
export function describeInterpretation(interpretation: MolecularInterpretation): string {
  if (interpretation.transformations.length === 0) return "as drawn";
  return interpretation.transformations
    .map((step) => {
      if (step.name === "largest-organic-fragment") {
        const removed = step.componentsRemoved;
        if (removed.length === 0) return "largest organic fragment";
        const list = removed.length <= 2 ? removed.join(" and ") : `${removed.length} components`;
        return `largest organic fragment · ${list} removed`;
      }
      if (step.name === "neutralize") {
        const magnitude = Math.abs(step.chargeChanges);
        return magnitude === 0
          ? "neutralised"
          : `neutralised · ${magnitude} charge${magnitude === 1 ? "" : "s"} removed`;
      }
      return step.name;
    })
    .join(" · ");
}
