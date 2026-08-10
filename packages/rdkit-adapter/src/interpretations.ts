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

export type DerivedInterpretationId =
  | "largest-organic-fragment"
  | "neutralized"
  | "reference-protomer"
  | "reference-tautomer";

export const DERIVED_INTERPRETATION_IDS: readonly DerivedInterpretationId[] = [
  "largest-organic-fragment",
  "neutralized",
  "reference-protomer",
  "reference-tautomer"
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

/** The bonded atom pairs a V2000 molblock's bond block carries. Atom numbers are 1-based. */
export function molblockBonds(molblock: string): [number, number][] {
  const lines = molblock.split("\n");
  const counts = lines[3];
  if (!counts) return [];
  const atomCount = Number.parseInt(counts.slice(0, 3), 10);
  const bondCount = Number.parseInt(counts.slice(3, 6), 10);
  if (!Number.isFinite(atomCount) || !Number.isFinite(bondCount)) return [];
  const out: [number, number][] = [];
  for (let i = 0; i < bondCount; i += 1) {
    const line = lines[4 + atomCount + i];
    if (!line) break;
    const from = Number.parseInt(line.slice(0, 3), 10);
    const to = Number.parseInt(line.slice(3, 6), 10);
    if (Number.isFinite(from) && Number.isFinite(to)) out.push([from, to]);
  }
  return out;
}

/** The `(atom, charge)` pairs a V2000 molblock's `M  CHG` records carry. Atom numbers are 1-based. */
export function molblockCharges(molblock: string): { atom: number; charge: number }[] {
  const out: { atom: number; charge: number }[] = [];
  for (const line of molblock.split("\n")) {
    if (!line.startsWith("M  CHG")) continue;
    const fields = line.slice(6).trim().split(/\s+/).map(Number);
    const pairCount = fields[0] ?? 0;
    for (let pair = 0; pair < pairCount; pair += 1) {
      const atom = fields[1 + pair * 2];
      const charge = fields[2 + pair * 2];
      if (typeof atom === "number" && typeof charge === "number" && Number.isFinite(charge) && charge !== 0) {
        out.push({ atom, charge });
      }
    }
  }
  return out.sort((a, b) => a.atom - b.atom);
}

/** The same molblock carrying exactly `charges` and no others. */
export function withMolblockCharges(
  molblock: string,
  charges: readonly { atom: number; charge: number }[]
): string {
  const lines = molblock.split("\n").filter((line) => !line.startsWith("M  CHG"));
  if (charges.length === 0) return lines.join("\n");
  // Eight pairs per record is the V2000 limit.
  const records: string[] = [];
  for (let start = 0; start < charges.length; start += 8) {
    const chunk = charges.slice(start, start + 8);
    records.push(
      `M  CHG${String(chunk.length).padStart(3)}` +
        chunk.map((entry) => `${String(entry.atom).padStart(4)}${String(entry.charge).padStart(4)}`).join("")
    );
  }
  const end = lines.findIndex((line) => line.startsWith("M  END"));
  const at = end === -1 ? lines.length : end;
  return [...lines.slice(0, at), ...records, ...lines.slice(at)].join("\n");
}

/**
 * The protomer this molecule's pKa ladder is built outward from, independent of how it was drawn.
 *
 * A pKa is a property of a molecular FAMILY, not of one member of it, so four drawings of glycine must
 * give one answer. They did not: the neutral form gave 2.13/9.07, the zwitterion — the form a chemist
 * actually draws at pH 7 — gave nothing at all, and each singly-charged form gave one of the two
 * values. Acetate likewise gave nothing while acetic acid gave 4.50.
 *
 * `stripMolblockCharges` cannot serve here. It is whole-molecule and all-or-nothing by design, so on
 * p-nitrobenzoate it removes the nitro charges along with the carboxylate, RDKit rejects the result,
 * and the molecule gets no canonicalization at all — which lands precisely on the substituted
 * benzoates and phenolates the Hammett series exists for.
 *
 * So charges come off ONE AT A TIME, in atom order, and a strip is kept only if what remains is still a
 * molecule. No table of which charges are "real" is involved: a lone nitro nitrogen is five-valent, a
 * lone nitro oxygen leaves a five-valent nitrogen, and a quaternary ammonium is five-valent, so RDKit
 * refuses all three and those charges stay. A carboxylate oxygen alone parses, so it goes. The result
 * for p-nitrobenzoate is p-nitrobenzoic acid with its nitro group intact.
 *
 * Returns `undefined` when there was nothing to strip, which the caller reads as "already canonical".
 */
export function referenceProtomerMolblock(
  molblock: string,
  parses: (candidate: string) => boolean
): { molblock: string; chargesRemoved: number; netChargeRemoved: number } | undefined {
  const charges = molblockCharges(molblock);
  if (charges.length === 0) return undefined;

  // A charge balanced by an opposite charge on a BONDED neighbour is not a protonation state at all —
  // it is what the valence requires. Nitro, N-oxides, azides and diazo groups are all drawn this way,
  // and none of them has a protonation state to canonicalize toward.
  //
  // RDKit alone does not catch this, which is how 4-nitrophenol found the hole: removing the nitro
  // oxygen's charge yields `O=[N+](O)Ar`, a perfectly valid molecule that is simply a different
  // compound. The Hammett phenol series then saw a substituent that was no longer a nitro group and
  // stopped firing. The parse test stays as the second gate — it is what refuses a lone quaternary
  // ammonium — but this local check runs first.
  const byAtom = new Map(charges.map((entry) => [entry.atom, entry.charge]));
  const dipolar = new Set<number>();
  for (const [from, to] of molblockBonds(molblock)) {
    const a = byAtom.get(from);
    const b = byAtom.get(to);
    if (a !== undefined && b !== undefined && Math.sign(a) === -Math.sign(b)) {
      dipolar.add(from);
      dipolar.add(to);
    }
  }

  let kept = charges;
  for (const entry of charges) {
    if (dipolar.has(entry.atom)) continue;
    const trial = kept.filter((other) => other.atom !== entry.atom);
    if (trial.length === kept.length) continue;
    if (parses(withMolblockCharges(molblock, trial))) kept = trial;
  }

  const removed = charges.length - kept.length;
  if (removed === 0) return undefined;
  return {
    molblock: withMolblockCharges(molblock, kept),
    chargesRemoved: removed,
    netChargeRemoved: charges.reduce((sum, entry) => sum + entry.charge, 0) -
      kept.reduce((sum, entry) => sum + entry.charge, 0)
  };
}

/** The ledger entry for building the reference protomer. */
export function referenceProtomerTransformation(input: {
  atomCount: number;
  formula: string;
  chargesRemoved: number;
  hydrogenChanges: number;
}): Transformation {
  return transformation({
    name: "reference-protomer",
    atomMapping: identityMapping(input.atomCount),
    componentsNeutralized: [input.formula],
    componentsRetained: [input.formula],
    chargeChanges: input.chargesRemoved,
    hydrogenChanges: input.hydrogenChanges
  });
}

/** The ledger entry for canonicalising the tautomer. */
export function referenceTautomerTransformation(input: {
  atomCount: number;
  formula: string;
  hydrogenChanges: number;
}): Transformation {
  return transformation({
    name: "reference-tautomer",
    atomMapping: identityMapping(input.atomCount),
    componentsRetained: [input.formula],
    // A tautomer shift moves a hydrogen between heavy atoms; the molecular formula is unchanged, so
    // this is normally zero and is read back off the derived molecule rather than assumed.
    hydrogenChanges: input.hydrogenChanges
  });
}

/**
 * What `tautomerPolicy` says once the tautomer is canonicalised rather than taken as drawn.
 *
 * The axis this closes is narrower than "tautomerism" and worth stating precisely. 4-methylimidazole and
 * 5-methylimidazole are ONE substance — the 1,3-H shift is faster than any titration, and they share a
 * single tabulated pKa — yet as-drawn scoring gave them 7.48 and 7.69, with their N-H values 0.39 apart.
 * That is the same defect the protomer canonicalisation exists to prevent, on a different axis: an answer
 * that depends on which of two equivalent drawings a chemist happened to pick.
 *
 * RDKit's MolStandardize picks the representative, scored by Sitzmann et al. (JCAMD 24:521, 2010). It is
 * a published heuristic rather than a free-energy calculation, and it is DETERMINISTIC, which is the
 * property being bought here: one substance, one answer.
 */
export const REFERENCE_TAUTOMER_POLICY =
  "reference-tautomer — the tautomer RDKit's MolStandardize scores as canonical (Sitzmann et al. 2010), " +
  "so two drawings of one tautomeric family give one answer. A published heuristic, not a free-energy " +
  "weighting: it chooses a representative rather than averaging over the population.";

/**
 * What `protomerPolicy` says, for the ledger a reader actually sees.
 *
 * The field has existed on `MolecularInterpretation` since the ledger was written and nothing has ever
 * populated it. `hashInterpretation` already folds it into the cache key, so setting it separates the
 * cache entries correctly with no further work.
 */
export const REFERENCE_PROTOMER_POLICY =
  "reference-protomer — every formal charge RDKit accepts removing is removed, one atom at a time; a " +
  "charge whose removal leaves no valid molecule (nitro, quaternary ammonium, N-oxide) stays. The pKa " +
  "ladder is built outward from this form, so every drawing of one molecular family gives one answer.";

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
      if (step.name === "reference-protomer") {
        const magnitude = Math.abs(step.chargeChanges);
        return magnitude === 0
          ? "reference protomer"
          : `reference protomer · ${magnitude} charge${magnitude === 1 ? "" : "s"} removed`;
      }
      // A canonical tautomer usually leaves the formula untouched, so there is no count worth showing —
      // the useful disclosure is simply that the drawn tautomer was not the one scored.
      if (step.name === "reference-tautomer") return "canonical tautomer";
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
