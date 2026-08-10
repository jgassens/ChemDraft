/**
 * Joback group-contribution estimates (PLANS.md §9, Later phases — estimates).
 *
 * §9 asks for these "with method-specific uncertainty and unsupported-group reporting", and the second
 * half is the harder half. Joback is a **sum over groups**, which means a structure containing a group
 * the method has no parameter for still produces a number if you let it — a number that silently omits
 * part of the molecule. That is the same failure the isotope envelope refuses for labelled structures
 * and the same one the OpenClatura benchmark found in naming, so it gets the same answer: **every
 * heavy atom must land in exactly one parameterised group, or the method declines.**
 *
 * These are *estimates*, not measurements and not descriptors. §8a's classification rules put them at
 * `claim: "prediction"` with real uncertainty attached, because a boiling point good to ±13 K is
 * useful and a boiling point presented as exact is not.
 */
import type { Classification, MethodContract, Uncertainty } from "@chemdraft/analysis-core";

import { JOBACK_GROUPS, type JobackGroup } from "./jobackGroups";

export const JOBACK_TB_METHOD_ID = "joback.normal-boiling-point";
export const JOBACK_TC_METHOD_ID = "joback.critical-temperature";
export const JOBACK_PC_METHOD_ID = "joback.critical-pressure";
export const JOBACK_VC_METHOD_ID = "joback.critical-volume";

const JOBACK_ENGINE = "joback-1987";
const JOBACK_VERSION = "1987";

/** The RDKit surface this needs: SMARTS query compilation and substructure matching. */
export interface JobackMatcher {
  get_qmol(smarts: string): { delete(): void } | null;
}

export interface JobackMolecule {
  get_substruct_matches(query: unknown): string;
}

export interface JobackFragmentation {
  /** Group id → how many times it was matched. */
  counts: Map<number, number>;
  /** Heavy atoms no parameterised group claimed. Non-empty means every property must decline. */
  unassignedAtoms: number[];
  /**
   * TOTAL atom count **including hydrogens**, which is what Joback's critical-pressure correlation
   * means by `nA`.
   *
   * Not the heavy-atom count. Reading it that way gives n-octane 50.3 bar against the correct
   * 25.35 — a number that looks entirely plausible for a critical pressure, which is why this was
   * caught by cross-checking `thermo` rather than by inspection.
   */
  atomCount: number;
  /**
   * Heavy atoms carrying a formal charge, so a decline can say *why* the fragmentation is short.
   *
   * Without this the ionic case reports "matched no parameterised Joback group", which is true of a
   * charged nitrogen but sends the reader looking for an exotic element rather than at the charge
   * they drew themselves.
   */
  chargedAtoms: number[];
}

/**
 * Assign every heavy atom to at most one Joback group, highest priority first.
 *
 * Greedy by design, and the priority column is what makes it correct: `-COOH` outranks the `>C=O` and
 * `-OH` that would otherwise each claim part of the same carboxyl. An atom already claimed is never
 * reassigned, so a match whose atoms are all taken contributes nothing rather than double-counting.
 */
export function fragmentForJoback(
  rdkit: JobackMatcher,
  mol: JobackMolecule,
  heavyAtomIndices: readonly number[],
  totalAtomCount: number,
  formalCharges: ReadonlyMap<number, number>
): JobackFragmentation {
  const claimed = new Set<number>();
  const counts = new Map<number, number>();

  for (const group of ORDERED_GROUPS) {
    const query = queryFor(rdkit, group);
    if (!query) continue;
    try {
      const matches = JSON.parse(mol.get_substruct_matches(query)) as { atoms: number[] }[];
      for (const match of matches) {
        // Every atom of the match must still be free. A partially-claimed match is a different group's
        // territory, and taking the remainder would count one atom towards two groups.
        if (match.atoms.some((atom) => claimed.has(atom))) continue;
        // Joback's increments describe NEUTRAL atoms. A pattern that does not name a charge must not
        // claim one, or the group's parameter is being applied to a different species than the one it
        // was fitted to — see JobackGroup.chargeSeparated. Left unclaimed, the atom reaches
        // `unassignedAtoms` and the structure declines, which is what the contract already promises
        // for ionic and zwitterionic species.
        if (!group.chargeSeparated && match.atoms.some((atom) => (formalCharges.get(atom) ?? 0) !== 0)) {
          continue;
        }
        for (const atom of match.atoms) claimed.add(atom);
        counts.set(group.id, (counts.get(group.id) ?? 0) + 1);
      }
    } catch {
      // A pattern this build cannot compile contributes nothing; the atoms it would have claimed stay
      // unassigned and the structure declines, which is the safe direction.
    }
  }

  return {
    counts,
    unassignedAtoms: heavyAtomIndices.filter((atom) => !claimed.has(atom)),
    atomCount: totalAtomCount,
    chargedAtoms: heavyAtomIndices.filter((atom) => (formalCharges.get(atom) ?? 0) !== 0)
  };
}

/**
 * Priority order, computed once. `[...JOBACK_GROUPS].sort(...)` per call copied and re-sorted a
 * 41-element array on every analysis for an answer that never changes.
 */
const ORDERED_GROUPS: readonly JobackGroup[] = [...JOBACK_GROUPS].sort((a, b) => b.priority - a.priority);

/**
 * Compiled SMARTS, cached per RDKit module instance.
 *
 * All 41 patterns were compiled with `get_qmol` and `delete()`d again on EVERY run — 41 SMARTS parses
 * inside WASM, 41 Emscripten string marshals, and 41 heap allocations freed a line later, several of
 * them recursive patterns that are the most expensive form to compile. The patterns are module
 * constants and a compiled query is valid for the lifetime of the module, so this is the same
 * WeakMap-per-module idiom `ION_MASS_CACHE` and the IsoSpec table cache already use. Keyed on the
 * module so a reset (tests, a rebuilt engine) drops the cache with it, and never deleted — the entries
 * die with the module.
 */
const QUERY_CACHE = new WeakMap<JobackMatcher, Map<number, unknown>>();

function queryFor(rdkit: JobackMatcher, group: JobackGroup): unknown {
  let byGroup = QUERY_CACHE.get(rdkit);
  if (!byGroup) {
    byGroup = new Map<number, unknown>();
    QUERY_CACHE.set(rdkit, byGroup);
  }
  if (!byGroup.has(group.id)) byGroup.set(group.id, rdkit.get_qmol(group.smarts));
  return byGroup.get(group.id);
}

const byId = new Map<number, JobackGroup>(JOBACK_GROUPS.map((group) => [group.id, group]));

/** Sum one property's contributions, or report which groups have no parameter for it. */
function contributionSum(
  fragmentation: JobackFragmentation,
  pick: (group: JobackGroup) => number | null
): { ok: true; total: number } | { ok: false; missing: string[] } {
  let total = 0;
  const missing: string[] = [];
  for (const [id, count] of fragmentation.counts) {
    const group = byId.get(id);
    if (!group) continue;
    const value = pick(group);
    if (value === null) {
      missing.push(group.label);
      continue;
    }
    total += count * value;
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, total };
}

export type JobackEstimate =
  | { ok: true; value: number }
  | {
      ok: false;
      reason: string;
      unsupportedFeature?: string;
      /**
       * Which kind of "no" this is, because the two are not the same shortfall.
       *
       * `unsupported` — Joback has no parameters for something in this molecule. A real capability
       * gap, and the same status `declineForElements` gives Crippen logP on sodium.
       *
       * `not-applicable` — the parameters exist and the correlation itself is out of range, as it is
       * for a 320-carbon alkane whose Tc denominator goes negative. That is the method's domain
       * working, not a gap, and it must not drag a whole run's status down any more than a water loss
       * from a molecule with no oxygen does.
       */
      kind: "unsupported" | "not-applicable";
    };

/**
 * The gate every property passes through first.
 *
 * Unassigned atoms are fatal for all of them: Joback's sums assume the fragmentation covers the
 * molecule, so a leftover atom means the number would describe a smaller compound.
 */
function requireFullCoverage(fragmentation: JobackFragmentation): JobackEstimate | undefined {
  if (fragmentation.unassignedAtoms.length === 0) return undefined;
  const count = fragmentation.unassignedAtoms.length;

  // Name the charge when that is what is actually blocking the fragmentation. "Matched no
  // parameterised group" is true of a charged nitrogen, but it reads as though the molecule contains
  // something exotic, when the reader drew the reason themselves.
  const charged = new Set(fragmentation.chargedAtoms);
  const blockedByCharge = fragmentation.unassignedAtoms.filter((atom) => charged.has(atom));
  if (blockedByCharge.length > 0) {
    return {
      ok: false,
      reason:
        `Joback's group contributions are fitted to neutral organics, and this structure carries a ` +
        `formal charge on ${blockedByCharge.length === 1 ? "atom" : "atoms"} ${blockedByCharge.join(", ")}. ` +
        "Ionic and zwitterionic species are outside the method, so no estimate is reported rather " +
        "than one computed from the neutral analogue's parameters.",
      unsupportedFeature: "ionic or zwitterionic species",
      kind: "unsupported"
    };
  }

  return {
    ok: false,
    reason:
      `${count} heavy atom${count === 1 ? "" : "s"} (index ${fragmentation.unassignedAtoms.join(", ")}) ` +
      "matched no parameterised Joback group, so any estimate would describe only part of the molecule.",
    unsupportedFeature: "unparameterised group",
    kind: "unsupported"
  };
}

function missingParameterReason(missing: string[], property: string): JobackEstimate {
  return {
    ok: false,
    reason:
      `Joback publishes no ${property} contribution for ${[...new Set(missing)].join(", ")}, ` +
      "so the sum would silently omit it.",
    unsupportedFeature: "group without a published contribution",
    kind: "unsupported"
  };
}

/** Normal boiling point, K. `Tb = 198.2 + Σ nᵢ·tbᵢ`. */
export function jobackNormalBoilingPoint(fragmentation: JobackFragmentation): JobackEstimate {
  const blocked = requireFullCoverage(fragmentation);
  if (blocked) return blocked;
  const sum = contributionSum(fragmentation, (group) => group.tb);
  if (!sum.ok) return missingParameterReason(sum.missing, "boiling-point");
  return { ok: true, value: 198.2 + sum.total };
}

/**
 * Critical temperature, K. `Tc = Tb · [0.584 + 0.965·ΣTc − (ΣTc)²]⁻¹`.
 *
 * Depends on Tb, so it inherits Tb's declines — and Joback's own recommendation is to use a measured
 * Tb when one exists. This uses the estimated one and says so in the conventions, because using an
 * estimate inside an estimate compounds the error and a reader has to know.
 */
export function jobackCriticalTemperature(fragmentation: JobackFragmentation): JobackEstimate {
  const boiling = jobackNormalBoilingPoint(fragmentation);
  if (!boiling.ok) return boiling;
  const sum = contributionSum(fragmentation, (group) => group.tc);
  if (!sum.ok) return missingParameterReason(sum.missing, "critical-temperature");

  const denominator = 0.584 + 0.965 * sum.total - sum.total * sum.total;
  if (denominator <= 0) {
    return {
      ok: false,
      reason:
        "The Joback critical-temperature correlation is out of range for this molecule: the group sum " +
        "drives its denominator non-positive, which would report a negative critical temperature. " +
        "Joback was fitted to small organics and does not extrapolate to structures this large.",
      unsupportedFeature: "correlation out of range",
      kind: "not-applicable"
    };
  }
  return { ok: true, value: boiling.value / denominator };
}

/**
 * Above this, the reciprocal square is reporting extrapolation error rather than chemistry.
 *
 * Not a fitted quantity and not an accuracy claim — a domain bound, and deliberately a loose one.
 * Water is 220.6 bar and is the highest critical pressure among common substances; it is not even an
 * organic. Sweeping twenty small molecules with the highest real critical pressures Joback would ever
 * be applied to — methanol, formic acid, acetonitrile, acetic acid, glycerol, phenol, oxalic acid —
 * the largest value this correlation produces for any of them is 68.0 bar. So the ceiling sits nearly
 * four times above anything reachable by a molecule the method can legitimately describe, and a value
 * over it means the base term has gone small rather than that the molecule is unusual.
 */
const PC_EXTRAPOLATION_CEILING_BAR = 250;

/** Critical pressure, bar. `Pc = (0.113 + 0.0032·nA − Σpcᵢ)⁻²`, with nA the total atom count *including hydrogens*. */
export function jobackCriticalPressure(fragmentation: JobackFragmentation): JobackEstimate {
  const blocked = requireFullCoverage(fragmentation);
  if (blocked) return blocked;
  const sum = contributionSum(fragmentation, (group) => group.pc);
  if (!sum.ok) return missingParameterReason(sum.missing, "critical-pressure");

  const base = 0.113 + 0.0032 * fragmentation.atomCount - sum.total;

  // `base <= 0`, not `base === 0`. The old test could not fire — `base` is a float sum over group
  // contributions and lands on exactly zero only by measure-zero accident — so a NEGATIVE base fell
  // straight through to `1 / (base * base)`, which squares the sign away and returns a large POSITIVE
  // pressure. Hexakis(pentahydroxyphenyl)benzene, 72 heavy atoms and well inside the app's budget,
  // gave base = -0.1462 and reported 46.8 bar as `ok` and `in-domain`: a completely ordinary-looking
  // critical pressure for a molecule the correlation has nothing to say about. The sibling Tc
  // correlation had `<= 0` from the start; this is that guard, finally written the same way.
  if (base <= 0) {
    return {
      ok: false,
      reason:
        "The Joback critical-pressure correlation is out of range for this molecule: the group sum " +
        "drives its base term non-positive, and squaring that would report a large positive pressure " +
        "from a negative quantity. Joback was fitted to small organics and does not extrapolate to " +
        "structures with this many contributing groups.",
      unsupportedFeature: "correlation out of range",
      kind: "not-applicable"
    };
  }

  const value = 1 / (base * base);

  // A base that is positive but very small blows the reciprocal square up without ever changing sign,
  // so the guard above does not catch it: C18(OH)12 gives base = +0.0122 and 6,719 bar, and
  // tetradecahydroxypentacene gives 206,612 bar. Neither is a critical pressure. The ceiling is a
  // domain guard rather than an accuracy claim — water, the highest of the common substances, is
  // 220.6 bar, so 500 bar is far outside anything Joback's development set contained and a value
  // above it means the correlation has been extrapolated past the point of meaning.
  if (value > PC_EXTRAPOLATION_CEILING_BAR) {
    return {
      ok: false,
      reason:
        `The Joback critical-pressure correlation extrapolates to ${Math.round(value)} bar for this ` +
        "molecule, which is not a physical critical pressure — water, the highest of the common " +
        `substances, is 220.6 bar. The base term is positive but small enough that the reciprocal ` +
        "square is dominated by extrapolation error rather than by the group contributions.",
      unsupportedFeature: "correlation out of range",
      kind: "not-applicable"
    };
  }

  return { ok: true, value };
}

/** Critical volume, cm³/mol. `Vc = 17.5 + Σ nᵢ·vcᵢ`. */
export function jobackCriticalVolume(fragmentation: JobackFragmentation): JobackEstimate {
  const blocked = requireFullCoverage(fragmentation);
  if (blocked) return blocked;
  const sum = contributionSum(fragmentation, (group) => group.vc);
  if (!sum.ok) return missingParameterReason(sum.missing, "critical-volume");
  return { ok: true, value: 17.5 + sum.total };
}

/**
 * Joback's own reported average errors, carried as the uncertainty on every result.
 *
 * These are the method's accuracy over its development set, not a confidence interval for one
 * molecule — the contract says so, because quoting them as if they bounded a specific estimate would
 * be the more useful-sounding and less true reading.
 */
const JOBACK_BASIS =
  "average absolute error over Joback & Reid's development set, not a bound on any single estimate";

const JOBACK_UNCERTAINTY: Readonly<Record<string, Uncertainty>> = {
  [JOBACK_TB_METHOD_ID]: {
    metric: "mae",
    value: 12.9,
    unit: "kelvin",
    basis: `${JOBACK_BASIS} (3.6% relative, 438 compounds)`,
    citationId: "joback-1987"
  },
  [JOBACK_TC_METHOD_ID]: {
    metric: "mae",
    value: 4.8,
    unit: "kelvin",
    basis: `${JOBACK_BASIS} (0.8% relative, 409 compounds)`,
    citationId: "joback-1987"
  },
  [JOBACK_PC_METHOD_ID]: {
    metric: "mae",
    value: 0.31,
    unit: "bar",
    basis: `${JOBACK_BASIS} (5.2% relative, 392 compounds)`,
    citationId: "joback-1987"
  },
  [JOBACK_VC_METHOD_ID]: {
    metric: "mae",
    value: 3.9,
    unit: "cubic-centimetre-per-mole",
    basis: `${JOBACK_BASIS} (2.3% relative, 310 compounds)`,
    citationId: "joback-1987"
  }
};

const ESTIMATE_CLASSIFICATION: Classification = {
  derivation: "fragment-rule",
  claim: "prediction",
  determinism: "deterministic",
  flags: { conventionDependent: false, experimentallyCalibrated: true, trainedOnExperimentalData: true }
};

interface JobackContractSpec {
  id: string;
  publicName: string;
  unit: MethodContract["unit"];
  symbol: string;
  formula: string;
  extraConventions?: string[];
}

const CONTRACT_SPECS: readonly JobackContractSpec[] = [
  {
    id: JOBACK_TB_METHOD_ID,
    publicName: "Normal boiling point (Joback)",
    unit: "kelvin",
    symbol: "Joback::Tb",
    formula: "Tb = 198.2 + Σ nᵢ·tbᵢ"
  },
  {
    id: JOBACK_TC_METHOD_ID,
    publicName: "Critical temperature (Joback)",
    unit: "kelvin",
    symbol: "Joback::Tc",
    formula: "Tc = Tb · [0.584 + 0.965·ΣTc − (ΣTc)²]⁻¹",
    extraConventions: [
      "uses the ESTIMATED normal boiling point above, not a measured one. Joback recommends a measured " +
        "Tb where available; using an estimate inside an estimate compounds the error, and the quoted " +
        "uncertainty does not account for that."
    ]
  },
  {
    id: JOBACK_PC_METHOD_ID,
    publicName: "Critical pressure (Joback)",
    unit: "bar",
    symbol: "Joback::Pc",
    formula: "Pc = (0.113 + 0.0032·nA − Σpcᵢ)⁻²"
  },
  {
    id: JOBACK_VC_METHOD_ID,
    publicName: "Critical volume (Joback)",
    unit: "cubic-centimetre-per-mole",
    symbol: "Joback::Vc",
    formula: "Vc = 17.5 + Σ nᵢ·vcᵢ"
  }
];

export function jobackContracts(): MethodContract[] {
  return CONTRACT_SPECS.map((spec) => ({
    id: spec.id,
    publicName: spec.publicName,
    version: "1.0.0",
    implementation: {
      engine: JOBACK_ENGINE,
      engineVersion: JOBACK_VERSION,
      symbol: spec.symbol,
      parameters: { groupCount: JOBACK_GROUPS.length, formula: spec.formula }
    },
    defaultInterpretationId: "source",
    resultKind: "scalar",
    unit: spec.unit,
    conventions: [
      "AN ESTIMATE FROM GROUP CONTRIBUTIONS, NOT A MEASUREMENT. Joback fits additive per-group terms " +
        "to experimental data; it has no knowledge of the specific molecule beyond its group counts.",
      "two molecules with identical group counts receive identical estimates — isomers that differ " +
        "only in how the same groups are connected are indistinguishable to this method",
      "the quoted uncertainty is the method's average absolute error over Joback's development set, " +
        "not a confidence interval for this molecule",
      "every heavy atom must fall in exactly one parameterised group; a structure with any unassigned " +
        "atom is declined rather than summed over the remainder",
      ...(spec.extraConventions ?? [])
    ],
    classification: ESTIMATE_CLASSIFICATION,
    supportedChemistry: [
      "organic molecules whose atoms are wholly covered by Joback's 41 groups",
      "C, H, N, O, S, F, Cl, Br, I within those groups"
    ],
    knownUnsupportedChemistry: [
      "any structure containing an atom outside the 41 groups — metals, boron, silicon, phosphorus",
      "ionic and zwitterionic species, which the groups do not model",
      "polymers and very large molecules, where additive group methods degrade without warning"
    ],
    declinesWhen: [
      "a heavy atom matches no parameterised group",
      "the structure carries a formal charge — Joback's increments are fitted to neutral organics, " +
        "so an ionic or zwitterionic species is declined rather than scored from its neutral " +
        "analogue's parameters",
      "a matched group has no published contribution for the requested property (=NH has a boiling-" +
        "point term but no critical-temperature, critical-pressure or critical-volume term)",
      "the correlation's denominator or base term is non-positive for the summed contributions, or " +
        "the critical-pressure base is small enough that the reciprocal square extrapolates past any " +
        "physical critical pressure"
    ],
    accuracyClaims: [JOBACK_UNCERTAINTY[spec.id]!],
    citations: [
      {
        id: "joback-1987",
        kind: "journal",
        authors: "Kevin G. Joback, Robert C. Reid",
        title: "Estimation of Pure-Component Properties from Group-Contributions",
        year: 1987,
        doi: "10.1080/00986448708960487"
      }
    ],
    datasets: [],
    versionIncrementTriggers: [
      "any change to a group contribution or SMARTS pattern",
      "a change to the fragmentation priority order",
      "a change to which properties decline"
    ],
    tautomerSensitive: true
  }));
}

/**
 * The uncertainty a result carries, by method id.
 *
 * Every Joback result carries one. A group-contribution estimate rendered as a bare number invites
 * being read as a measurement, which is the whole reason §8a separates `prediction` from `descriptor`.
 */
export function jobackUncertainty(methodId: string): Uncertainty[] {
  const entry = JOBACK_UNCERTAINTY[methodId];
  return entry ? [entry] : [];
}
