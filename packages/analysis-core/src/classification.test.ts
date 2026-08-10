import { describe, expect, it } from "vitest";

import {
  ClassificationSchema,
  isMeasuredValue,
  requiresConventionDisclosure,
  requiresEmpiricalProvenance,
  requiresProvenanceOnExport,
  type ClaimClass,
  type Classification,
  type ClassificationFlags,
  type DerivationClass,
  type Determinism
} from "./classification";

const DERIVATIONS: DerivationClass[] = [
  "graph-derived",
  "convention",
  "fragment-rule",
  "database-lookup",
  "statistical-model",
  "force-field",
  "electronic-structure"
];
const CLAIMS: ClaimClass[] = ["identity", "composition", "descriptor", "prediction", "simulated-observable"];
const DETERMINISMS: Determinism[] = ["deterministic", "seeded", "stochastic"];

const FLAG_COMBINATIONS: ClassificationFlags[] = [false, true].flatMap((conventionDependent) =>
  [false, true].flatMap((experimentallyCalibrated) =>
    [false, true].map((trainedOnExperimentalData) => ({
      conventionDependent,
      experimentallyCalibrated,
      trainedOnExperimentalData
    }))
  )
);

function classification(flags: ClassificationFlags, overrides: Partial<Classification> = {}): Classification {
  return {
    derivation: "graph-derived",
    claim: "descriptor",
    determinism: "deterministic",
    flags,
    ...overrides
  };
}

describe("classification predicates", () => {
  it("branches on flags only — the display axes cannot change behaviour", () => {
    // PLANS.md §2: "the enums are for display and grouping; the flags are what code branches on."
    // Every enum permutation with identical flags must produce identical answers. This is the test
    // that fails the moment someone reaches for `claim === "prediction"` inside a predicate.
    for (const flags of FLAG_COMBINATIONS) {
      const baseline = classification(flags);
      const expected = {
        convention: requiresConventionDisclosure(baseline),
        empirical: requiresEmpiricalProvenance(baseline),
        export: requiresProvenanceOnExport(baseline),
        measured: isMeasuredValue(baseline)
      };

      for (const derivation of DERIVATIONS) {
        for (const claim of CLAIMS) {
          for (const determinism of DETERMINISMS) {
            const variant = classification(flags, { derivation, claim, determinism });
            expect({
              convention: requiresConventionDisclosure(variant),
              empirical: requiresEmpiricalProvenance(variant),
              export: requiresProvenanceOnExport(variant),
              measured: isMeasuredValue(variant)
            }).toEqual(expected);
          }
        }
      }
    }
  });

  it("requires empirical provenance for calibrated or trained methods", () => {
    const calibrated = classification({
      conventionDependent: false,
      experimentallyCalibrated: true,
      trainedOnExperimentalData: false
    });
    const trained = classification({
      conventionDependent: false,
      experimentallyCalibrated: false,
      trainedOnExperimentalData: true
    });
    const neither = classification({
      conventionDependent: false,
      experimentallyCalibrated: false,
      trainedOnExperimentalData: false
    });

    expect(requiresEmpiricalProvenance(calibrated)).toBe(true);
    expect(requiresEmpiricalProvenance(trained)).toBe(true);
    expect(requiresEmpiricalProvenance(neither)).toBe(false);
  });

  it("gates export on any convention or fit, and lets a pure graph descriptor through", () => {
    const tpsa = classification({
      conventionDependent: true,
      experimentallyCalibrated: false,
      trainedOnExperimentalData: false
    });
    const heavyAtomCount = classification({
      conventionDependent: false,
      experimentallyCalibrated: false,
      trainedOnExperimentalData: false
    });

    expect(requiresProvenanceOnExport(tpsa)).toBe(true);
    expect(requiresProvenanceOnExport(heavyAtomCount)).toBe(false);
  });

  it("never calls a computed value a measurement", () => {
    for (const flags of FLAG_COMBINATIONS) {
      expect(isMeasuredValue(classification(flags))).toBe(false);
    }
  });

  it("rejects unknown members and extra keys", () => {
    expect(
      ClassificationSchema.safeParse({
        derivation: "vibes",
        claim: "descriptor",
        determinism: "deterministic",
        flags: { conventionDependent: false, experimentallyCalibrated: false, trainedOnExperimentalData: false }
      }).success
    ).toBe(false);

    expect(
      ClassificationSchema.safeParse({
        derivation: "graph-derived",
        claim: "descriptor",
        determinism: "deterministic",
        flags: {
          conventionDependent: false,
          experimentallyCalibrated: false,
          trainedOnExperimentalData: false,
          vibesBased: true
        }
      }).success
    ).toBe(false);
  });
});
