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
import type { Classification, DistributionResult, MethodContract, UnitId } from "@chemdraft/analysis-core";
import {
  ISOSPEC_ISOTOPIC_ENTRY_COUNT,
  PINNED_ISOSPEC_COMMIT,
  PINNED_ISOSPEC_VERSION,
  electronMass,
  envelopeFromThreshold,
  envelopeFromThresholdIsotopes,
  explicitFormulaCounts,
  isotopeMass,
  isotopesOf,
  type IsoSpecDimension,
  type IsoSpecEnvelope,
  type IsoSpecFailure,
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

/**
 * What an ion's envelope is reported in, and why it is not the same axis a neutral gets.
 *
 * A drawn ion already *is* the species a spectrometer would see, so the useful positions are m/z —
 * and at charge 2+ that is not cosmetic: the isotope spacing halves to ~0.5, which is how a reader
 * reads charge state off a pattern. Reporting the ion's mass instead would draw 1.0 spacing and
 * quietly misstate the charge. The unit on the result (`thomson` vs `dalton`) is what says which axis
 * is in play, so the two can never be confused by a renderer that only reads numbers.
 */
export const ION_ENVELOPE_CONVENTION =
  "for a structure drawn as an ion the positions are m/z, not mass: each isotopologue's neutral-atom " +
  "mass has z electron masses subtracted (added, for an anion) and is then divided by |z|. The " +
  "electron mass is IsoSpec's own table entry, 0.000548579909065 Da, which agrees with the value " +
  "RDKit's [H+] implies. A neutral structure's positions stay masses in daltons — the result's " +
  "positionUnit says which.";

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
    // 2.0.0: positions used to be daltons unconditionally, and a charged structure declined outright.
    // An ion now computes and reports m/z, so the same method id can return a number on a different
    // axis than it did at 1.0.0 — a major change by any reading, and one that has to invalidate the
    // cache rather than serve a dalton position under a thomson unit (the version is part of methodKey).
    //
    // 2.1.0 adds the labelled structures that used to decline. Additive: no number a 2.0.0 build
    // produced moves, because the explicit-isotope path only runs where the old one refused to answer.
    version: "2.1.0",
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
      ION_ENVELOPE_CONVENTION,
      "no adduct and no fragmentation. An ion's envelope is the drawn ion's own isotope pattern; it is " +
        "not a prediction of what ionising the neutral would produce. The Ions (m/z) section is where " +
        "adducts of a neutral molecule live.",
      "A THEORETICAL DISTRIBUTION, NOT A PREDICTED SPECTRUM — no instrument response, no fragmentation, " +
        "and no claim that any of these peaks would be observed at these ratios",
      "an atom the drawing labels is taken as that isotope with certainty, not as an enrichment: " +
        "[13C] contributes one isotope at probability 1. Unlabelled atoms of the same element keep " +
        "their natural abundances, so a partially labelled molecule still shows the satellites of the " +
        "positions that were left alone. Isotopic purity is not modelled — a 99% ¹³C reagent is " +
        "reported as if it were 100%."
    ],
    classification,
    supportedChemistry: [
      "any composition whose elements IsoSpec's tables cover",
      "structures carrying a formal charge, reported as m/z with the electron bookkeeping done",
      "site-specific isotope labels, computed through IsoSpec's explicit-isotope constructor"
    ],
    knownUnsupportedChemistry: [
      "elements absent from IsoSpec's isotope tables",
      "isotopes absent from those tables, including any the drawing invents"
    ],
    declinesWhen: [
      "IsoSpec does not recognise an element in the formula",
      "a labelled atom names an isotope IsoSpec's tables do not carry: it cannot be given a mass, and " +
        "reporting the unlabelled envelope instead would describe a different molecule"
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
      "a change in how intensities are normalised",
      "a change in what the positions mean — mass against m/z, or the electron bookkeeping behind either"
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
  /**
   * The composition's per-element tallies, already split so a labelled atom counts apart from its
   * unlabelled neighbours. Only read when a label is present — the formula path handles the rest.
   */
  elements: readonly { symbol: string; count: number; isotope?: number }[];
}

/**
 * Turn the composition's tallies into IsoSpec dimensions, or name what stopped it.
 *
 * The mapping is the whole trick, and it is a small one: an unlabelled element becomes a dimension
 * over its natural isotopes, and a labelled tally becomes a dimension holding exactly one isotope at
 * probability 1. Convolving those gives the labelled molecule's real envelope — ¹³C-acetic acid keeps
 * its remaining carbon's natural ¹³C satellite rather than losing it.
 *
 * RDKit has already done the hard part by tallying `[13C]` separately from `C` (see `composition.ts`),
 * so nothing here re-decides chemistry.
 */
export function dimensionsForComposition(
  module: IsoSpecModule,
  elements: readonly { symbol: string; count: number; isotope?: number }[]
): { ok: true; dimensions: IsoSpecDimension[] } | { ok: false; reason: string; unsupportedFeature?: string } {
  const dimensions: IsoSpecDimension[] = [];

  for (const element of elements) {
    if (element.count <= 0) continue;

    if (element.isotope) {
      const mass = isotopeMass(module, element.symbol, element.isotope);
      if (mass === undefined) {
        return {
          ok: false,
          reason:
            `IsoSpec's tables carry no ${element.isotope}${element.symbol}, so the labelled atoms cannot ` +
            "be given a mass. Reporting the unlabelled envelope instead would describe a different molecule.",
          unsupportedFeature: `unknown isotope ${element.isotope}${element.symbol}`
        };
      }
      // Probability 1: the drawing asserts *this* isotope at *this* position. That is the difference
      // between a labelled compound and an unlabelled one, and it is not a natural abundance.
      dimensions.push({ atomCount: element.count, isotopes: [{ mass, abundance: 1 }] });
      continue;
    }

    const isotopes = isotopesOf(module, element.symbol);
    if (!isotopes) {
      return {
        ok: false,
        reason: `IsoSpec's tables do not cover ${element.symbol}.`,
        unsupportedFeature: `unsupported element ${element.symbol}`
      };
    }
    dimensions.push({ atomCount: element.count, isotopes });
  }

  if (dimensions.length === 0) return { ok: false, reason: "The structure carries no atoms to distribute." };
  return { ok: true, dimensions };
}

export type EnvelopeOutcome =
  | {
      ok: true;
      positions: Float64Array;
      intensities: Float64Array;
      coveredProbability: number;
      peakCount: number;
      /** `dalton` for a neutral structure, `thomson` for an ion — see `ION_ENVELOPE_CONVENTION`. */
      positionUnit: UnitId;
    }
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
  // Two routes to the same distribution, and which one runs is decided by the drawing.
  //
  // The formula path stays the default because it is the one IsoSpec resolves itself, by its own
  // element names — it needs no symbol table of ours and so cannot be narrowed by one. The explicit
  // path exists only because the formula parser rejects every non-alphanumeric character and matches
  // elements by bare symbol, so `[13C]` cannot be spelled to it at all. A test pins the two together
  // on an unlabelled molecule, because two routes that could disagree eventually would.
  let envelope: IsoSpecEnvelope | IsoSpecFailure;
  if (input.hasExplicitIsotopes) {
    const built = dimensionsForComposition(module, input.elements);
    if (!built.ok) return built;
    envelope = envelopeFromThresholdIsotopes(module, built.dimensions, threshold);
  } else {
    // IsoSpec requires an explicit count on every element: `H2O1`, never `H2O`. RDKit's Hill formula is
    // the latter, and IsoSpec rejects it rather than mis-parsing — but only the expansion makes it run.
    envelope = envelopeFromThreshold(module, explicitFormulaCounts(input.formula), threshold);
  }

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

  // Charge bookkeeping. IsoSpec computed over neutral atoms, so an ion is that sum less one electron
  // per unit of positive charge (plus one per unit of negative), and what a spectrometer places it at
  // is that mass over |z|. Both steps are arithmetic on IsoSpec's own numbers — no second mass table
  // and no constant of ours, which is the same rule the adduct masses follow.
  const charge = input.formalCharge;
  const shift = charge === 0 ? 0 : charge * electronMass(module);
  const divisor = charge === 0 ? 1 : Math.abs(charge);

  return {
    ok: true,
    positions: Float64Array.from(order.map((peak) => (peak.mass - shift) / divisor)),
    intensities: Float64Array.from(order.map((peak) => (peak.probability / base) * 100)),
    coveredProbability: envelope.coveredProbability,
    peakCount: envelope.peakCount,
    positionUnit: charge === 0 ? "dalton" : "thomson"
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
    // `dalton` or `thomson` depending on whether the structure was drawn as an ion. Carried on the
    // result rather than assumed by the renderer, so an axis can never be labelled from the wrong one.
    positionUnit: outcome.positionUnit,
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
