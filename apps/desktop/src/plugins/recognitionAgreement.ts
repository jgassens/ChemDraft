import type {
  RecognitionConfidenceTier,
  RecognitionProposalReview,
  RecognitionWarning
} from "@chemdraft/plugin-api";

import type { StructureRecognitionAgreement } from "./structureRecognitionEngine";

/**
 * The engine recognizes every image at many sizes and votes (docs/architecture/ocsr-engine.md).
 * MolScribe's confidence was measured to be as high on wrong answers as on right ones (0.77 on a wrong
 * brevetoxin A at 500 px, 0.33 on a right one at 1200 px), so the only evidence the host trusts for a
 * "high" review tier is that every size gave the same structure. The plugin picks the tier from the
 * confidence number; the host caps it here, because the plugin never sees the agreement.
 *
 * - `unanimous`: more than one run, and every run gave the returned structure; the plugin's tier stands.
 * - `single`: the image was too small to read at more than one size, so there is no cross-size
 *   evidence at all — one reading agreeing with itself is not agreement; at most medium.
 * - `supermajority`: at least two thirds of all runs (unparsable ones included) agreed; at most medium.
 * - `split`: anything less; low.
 */
export type RecognitionAgreementLevel = "unanimous" | "single" | "supermajority" | "split";

export const RECOGNITION_SCALE_DISAGREEMENT_CODE = "recognition.scale-disagreement";
export const RECOGNITION_SINGLE_SIZE_CODE = "recognition.single-size";

/** The warning for a recognition read at only one size: nothing corroborated it. */
export function recognitionSingleSizeWarning(): RecognitionWarning {
  return {
    code: RECOGNITION_SINGLE_SIZE_CODE,
    message: "This image was too small to check at several sizes; check the structure carefully."
  };
}

/** The warning a recognition carries for its agreement level, or none when every size agreed. */
export function recognitionAgreementWarning(agreement: StructureRecognitionAgreement): RecognitionWarning | undefined {
  const level = recognitionAgreementLevel(agreement);
  if (level === "unanimous") return undefined;
  if (level === "single") return recognitionSingleSizeWarning();
  return recognitionDisagreementWarning(agreement);
}

/** The warning for a non-unanimous recognition, naming how many of the engine's readings agreed. */
export function recognitionDisagreementWarning(agreement: StructureRecognitionAgreement): RecognitionWarning {
  return {
    code: RECOGNITION_SCALE_DISAGREEMENT_CODE,
    message:
      "Recognition gave different answers at different image sizes; check the structure carefully. " +
      `Only ${agreement.agreeing} of ${agreement.runs} readings agreed.`
  };
}

export function recognitionAgreementLevel(agreement: StructureRecognitionAgreement): RecognitionAgreementLevel {
  if (agreement.agreeing >= agreement.runs) return agreement.runs > 1 ? "unanimous" : "single";
  if (agreement.agreeing * 3 >= agreement.runs * 2) return "supermajority";
  return "split";
}

/** Unanimous keeps the confidence tier; a single reading or a two-thirds agreement is at most medium;
 * anything less is low. */
export function capRecognitionConfidenceTier(
  tier: RecognitionConfidenceTier,
  level: RecognitionAgreementLevel
): RecognitionConfidenceTier {
  if (level === "unanimous") return tier;
  if (level === "split") return "low";
  return tier === "high" ? "medium" : tier;
}

// Recognitions this host produced, keyed by the exact molfile it handed the plugin. Bounded: a
// review queue never holds more than a handful, and an evicted entry only matters for a proposal
// that has sat unreviewed through this many later recognitions.
const MAX_REMEMBERED = 64;
const agreementByMolfile = new Map<string, StructureRecognitionAgreement>();

/** Called by the host when it builds a recognition result, so the later review can be capped. */
export function rememberRecognitionAgreement(molfile: string, agreement: StructureRecognitionAgreement): void {
  agreementByMolfile.delete(molfile);
  agreementByMolfile.set(molfile, { ...agreement, scalesPx: [...agreement.scalesPx] });
  while (agreementByMolfile.size > MAX_REMEMBERED) {
    const oldest = agreementByMolfile.keys().next().value;
    if (oldest === undefined) break;
    agreementByMolfile.delete(oldest);
  }
}

/** Test-only: forget every remembered recognition. */
export function resetRecognitionAgreementsForTesting(): void {
  agreementByMolfile.clear();
}

/**
 * The review as the host shows it: the plugin's tier capped by the host's own record of how far the
 * engine's runs agreed, plus the disagreement warning whether or not the plugin passed it on. A
 * proposal whose structure this host did not recognize is shown as the plugin sent it.
 */
export function reviewedRecognition(
  recognition: RecognitionProposalReview | undefined,
  warnings: readonly RecognitionWarning[]
): { recognition: RecognitionProposalReview | undefined; warnings: RecognitionWarning[] } {
  const copied = warnings.map(({ code, message }) => ({ code, message }));
  if (!recognition) return { recognition, warnings: copied };
  const agreement = agreementByMolfile.get(recognition.proposedMolfile);
  if (!agreement) return { recognition, warnings: copied };
  const level = recognitionAgreementLevel(agreement);
  if (level === "unanimous") return { recognition, warnings: copied };
  const confidenceTier = capRecognitionConfidenceTier(recognition.confidenceTier, level);
  const warning = recognitionAgreementWarning(agreement);
  if (warning && !copied.some((existing) => existing.code === warning.code)) {
    copied.unshift(warning);
  }
  return { recognition: { ...recognition, confidenceTier }, warnings: copied };
}
