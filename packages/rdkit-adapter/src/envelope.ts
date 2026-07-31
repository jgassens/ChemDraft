/**
 * The isotope envelope (PLANS.md §9 Release 2): the theoretical isotopic distribution of the
 * structure's composition, computed by the vendored IsoSpec build.
 *
 * **Why this lives with the analysis wiring rather than in `isospec-adapter`.** The envelope needs two
 * engines: RDKit supplies the composition (the Hill formula, and the isotope labels already baked into
 * it), IsoSpec supplies the distribution. Neither adapter owns the method, so it sits where the run is
 * assembled — the same place the method contracts, classification, and result construction already
 * live (AGENTS.md §6.18).
 *
 * **The intensities are a convention, and an unusually load-bearing one.** IsoSpec's element tables
 * carry no provenance upstream, and its ¹³C abundance is 0.82% relatively above the commonly quoted
 * CIAAW representative value. That is not an error — CIAAW publishes carbon as an interval because it
 * varies by source — but it means a reader reproducing M+1 from a textbook table will not match, so
 * the contract says which set produced the number.
 *
 * **This is not a predicted mass spectrum.** It is where the isotopologues sit and how abundant they
 * are, for a molecule with no adduct, no charge, no fragmentation, and no instrument. §9 Release 2 is
 * explicit that the mass tooling makes no intensity claims about observed spectra, and the same rule
 * applies to a distribution that happens to have intensities in it.
 */
import type { Classification, DistributionResult, MethodContract } from "@chemdraft/analysis-core";
import {
  ISOSPEC_ISOTOPIC_ENTRY_COUNT,
  PINNED_ISOSPEC_COMMIT,
  PINNED_ISOSPEC_VERSION,
  envelopeFromThreshold,
  explicitFormulaCounts,
  type IsoSpecModule
} from "@chemdraft/isospec-adapter";

export const ISOTOPE_ENVELOPE_METHOD_ID = "isospec.isotope-envelope";

/**
 * Peaks below this fraction of the base peak are dropped.
 *
 * 1e-4 rather than something tighter: it keeps every isotopologue a reader would look for (M+1 and M+2
 * are percent-scale for ordinary organics, and a bromine or sulfur pattern is far above it) while
 * keeping the retained set small enough to render. The value is not a detail — it is recorded on the
 * result as `truncation.threshold` and named in the contract's conventions, because a truncated
 * distribution whose truncation is not stated is indistinguishable from a complete one.
 */
export const DEFAULT_ENVELOPE_RELATIVE_THRESHOLD = 1e-4;

const ISOSPEC_ENGINE = "isospec-wasm";

/**
 * The abundance-set disclosure, shared by the contract and by the run-level notice.
 *
 * Written out rather than summarised because the number it qualifies is the one on screen: an M+1 that
 * is 0.82% relatively higher than a textbook calculation is not a rounding difference a reader should
 * have to rediscover.
 */
export const ISOSPEC_ABUNDANCE_CONVENTION =
  "natural abundances from IsoSpec's built-in tables (292 isotopic entries, each element normalised to " +
  "sum to 1). These differ from the commonly quoted CIAAW representative values — ¹³C is 0.010788 " +
  "against CIAAW's 0.0107, 0.82% relatively higher, which raises M+1 by the same fraction. IsoSpec " +
  "records no provenance for these tables upstream; the values are read back from the shipped binary.";

export function isotopeEnvelopeContract(
  isospecVersion: string = PINNED_ISOSPEC_VERSION,
  threshold: number = DEFAULT_ENVELOPE_RELATIVE_THRESHOLD
): MethodContract {
  const classification: Classification = {
    derivation: "convention",
    claim: "composition",
    determinism: "deterministic",
    flags: { conventionDependent: true, experimentallyCalibrated: false, trainedOnExperimentalData: false }
  };

  return {
    id: ISOTOPE_ENVELOPE_METHOD_ID,
    publicName: "Isotope envelope",
    version: "1.0.0",
    implementation: {
      engine: ISOSPEC_ENGINE,
      engineVersion: isospecVersion,
      symbol: "IsoSpec::FixedEnvelope::FromThreshold",
      parameters: {
        relativeIntensityThreshold: threshold,
        isotopicEntries: ISOSPEC_ISOTOPIC_ENTRY_COUNT,
        sourceCommit: PINNED_ISOSPEC_COMMIT
      }
    },
    defaultInterpretationId: "source",
    resultKind: "distribution",
    unit: "dalton",
    conventions: [
      ISOSPEC_ABUNDANCE_CONVENTION,
      `truncated at a relative-intensity threshold of ${threshold}: peaks below that fraction of the ` +
        "base peak are dropped, and the probability the retained peaks account for is reported alongside them",
      "intensities are normalised to the base peak at 100%, not absolute probabilities — the covered " +
        "probability is what carries the absolute scale",
      "positions are neutral-molecule masses in daltons, NOT m/z: no adduct, no charge, no electron " +
        "bookkeeping. The Ions (m/z) section is where charged species live.",
      "A THEORETICAL DISTRIBUTION, NOT A PREDICTED SPECTRUM — no instrument response, no fragmentation, " +
        "and no claim that any of these peaks would be observed at these ratios",
      "every element is taken at natural abundance: IsoSpec's formula API accepts bare element symbols " +
        "only and has no syntax for a site-specific isotope label, so a labelled structure is declined " +
        "rather than computed as though the label were not there"
    ],
    classification,
    supportedChemistry: ["any composition whose elements IsoSpec's tables cover"],
    knownUnsupportedChemistry: [
      "structures carrying a formal charge — see declinesWhen",
      "elements absent from IsoSpec's isotope tables"
    ],
    declinesWhen: [
      "the structure carries a formal charge: the envelope is computed from the formula alone, which " +
        "has no electron bookkeeping, so an ion's masses would be wrong by one electron per charge",
      "the structure carries an explicit isotope label: IsoSpec's formula parser rejects any " +
        "non-alphanumeric character and resolves elements by bare symbol, so there is no way to express " +
        "[13C] to it. Passing the unlabelled formula would silently return the natural-abundance " +
        "envelope of a different molecule.",
      "IsoSpec does not recognise an element in the formula"
    ],
    accuracyClaims: [],
    citations: [
      {
        id: "isospec-2017",
        kind: "journal",
        authors: "Mateusz K. Łącki, Michał Startek, Dirk Valkenborg, Anna Gambin",
        title: "IsoSpec: Hyperfast Fine Structure Calculator",
        year: 2017,
        doi: "10.1021/acs.analchem.7b00840"
      },
      {
        id: "isospec-software",
        kind: "software",
        title: "IsoSpec",
        version: PINNED_ISOSPEC_VERSION,
        url: "https://github.com/MatteoLacki/IsoSpec"
      }
    ],
    datasets: [],
    versionIncrementTriggers: [
      "any change to the relative-intensity threshold",
      "an IsoSpec release that revises the isotope tables",
      "a change in how intensities are normalised"
    ],
    tautomerSensitive: false
  };
}

export interface EnvelopeInput {
  /** Hill formula from the RDKit composition, e.g. `C10H11N3O3S`. */
  formula: string;
  formalCharge: number;
  /** RDKit writes a labelled atom as `[13C]`, which IsoSpec's formula parser cannot express. */
  hasExplicitIsotopes: boolean;
}

export type EnvelopeOutcome =
  | { ok: true; positions: Float64Array; intensities: Float64Array; coveredProbability: number; peakCount: number }
  | { ok: false; reason: string; unsupportedFeature?: string };

/**
 * Compute the envelope, or say why not.
 *
 * Returns an outcome rather than throwing so the caller can turn a decline into a result with a reason
 * — a method that cannot answer still has to appear in the run (§10).
 */
export function computeEnvelope(
  module: IsoSpecModule,
  input: EnvelopeInput,
  threshold: number = DEFAULT_ENVELOPE_RELATIVE_THRESHOLD
): EnvelopeOutcome {
  if (input.formalCharge !== 0) {
    return {
      ok: false,
      reason:
        `${input.formula} carries a formal charge of ${input.formalCharge}. The envelope is computed from ` +
        "the formula alone, which carries no electron bookkeeping, so the masses would be wrong by one " +
        "electron per charge.",
      unsupportedFeature: "charged structure"
    };
  }

  if (input.hasExplicitIsotopes) {
    // Measured against the parser, not assumed: `parse_formula` throws on any non-alphanumeric
    // character and matches elements by bare symbol, so `[13C]` cannot be expressed. Stripping the
    // label to make it parse would return the natural-abundance envelope of a different molecule —
    // a confident wrong number, which is the one outcome this suite exists to prevent.
    return {
      ok: false,
      reason:
        `${input.formula} carries an explicit isotope label. IsoSpec's formula API has no syntax for ` +
        "one, and computing without it would report the natural-abundance envelope of a different molecule.",
      unsupportedFeature: "explicit isotope label"
    };
  }

  // IsoSpec requires an explicit count on every element: `H2O1`, never `H2O`. RDKit's Hill formula is
  // the latter, and IsoSpec rejects it rather than mis-parsing — but only the expansion makes it run.
  const envelope = envelopeFromThreshold(module, explicitFormulaCounts(input.formula), threshold);
  if (!envelope.ok) {
    return { ok: false, reason: `IsoSpec could not compute an envelope for ${input.formula}: ${envelope.error}` };
  }
  if (envelope.peakCount === 0) {
    return { ok: false, reason: `IsoSpec returned no peaks for ${input.formula}.` };
  }

  // Sort by mass and normalise to the base peak. IsoSpec returns peaks in its own traversal order, and
  // a distribution whose positions are unordered is a plotting bug waiting to happen.
  const order = envelope.masses
    .map((mass, index) => ({ mass, probability: envelope.probabilities[index]! }))
    .sort((a, b) => a.mass - b.mass);
  const base = Math.max(...order.map((peak) => peak.probability));

  return {
    ok: true,
    positions: Float64Array.from(order.map((peak) => peak.mass)),
    intensities: Float64Array.from(order.map((peak) => (peak.probability / base) * 100)),
    coveredProbability: envelope.coveredProbability,
    peakCount: envelope.peakCount
  };
}

/** The shared fields `resultBase` supplies; everything a distribution adds is filled in below. */
export type EnvelopeResultBase = Omit<
  DistributionResult,
  | "kind"
  | "status"
  | "positions"
  | "intensities"
  | "positionUnit"
  | "intensityUnit"
  | "truncation"
  | "applicability"
  | "warnings"
>;

/** Build the `DistributionResult` (or its decline) from an outcome. */
export function envelopeResult(
  base: EnvelopeResultBase,
  outcome: EnvelopeOutcome,
  threshold: number = DEFAULT_ENVELOPE_RELATIVE_THRESHOLD
): DistributionResult {
  if (!outcome.ok) {
    return {
      ...base,
      kind: "distribution",
      status: "not-applicable",
      positions: new Float64Array(0),
      intensities: new Float64Array(0),
      positionUnit: "dalton",
      intensityUnit: "relative-abundance",
      truncation: { policy: "none", threshold: 0 },
      // AnalysisRunSchema requires a non-ok result to carry a warning explaining itself, so the reason
      // travels twice on purpose: `applicability.reasons` is the structured record and the warning is
      // what a reader sees in Notices.
      warnings: [
        {
          code: "envelope.declined",
          severity: "info" as const,
          message: outcome.reason,
          affectedResultIds: [base.id]
        }
      ],
      applicability: {
        status: "out-of-domain",
        reasons: [outcome.reason],
        unsupportedFeatures: outcome.unsupportedFeature ? [outcome.unsupportedFeature] : []
      }
    };
  }

  return {
    ...base,
    kind: "distribution",
    status: "ok",
    positions: outcome.positions,
    intensities: outcome.intensities,
    positionUnit: "dalton",
    intensityUnit: "relative-abundance",
    truncation: {
      policy: "relative-intensity-threshold",
      threshold,
      coveredProbability: outcome.coveredProbability
    },
    applicability: { status: "in-domain", reasons: [], unsupportedFeatures: [] },
    warnings: []
  };
}
