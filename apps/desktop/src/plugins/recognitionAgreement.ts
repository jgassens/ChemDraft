import type {
  RecognitionConfidenceTier,
  RecognitionProposalReview,
  RecognitionWarning
} from "@chemdraft/plugin-api";

import { recognitionConfidenceTierFromScore } from "@chemdraft/plugin-host";

import type { StructureRecognitionAgreement } from "./structureRecognitionEngine";

/**
 * The engine recognizes every image at many sizes and votes (docs/architecture/ocsr-engine.md).
 * MolScribe's confidence was measured to be as high on wrong answers as on right ones (0.77 on a wrong
 * brevetoxin A at 500 px, 0.33 on a right one at 1200 px), so the only evidence the host trusts for a
 * "high" review tier is that every size gave the same structure. The host takes a tier from the
 * confidence number and caps it here; the plugin never sees the agreement and cannot raise the result.
 *
 * - `unanimous`: more than one run, and every run gave the returned structure; the score's tier stands.
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

/**
 * The tier the host shows for a recognition: its own tier for the engine's confidence score, capped by
 * how far the engine's runs agreed. Computed when the host builds the result and kept by the plugin host
 * with that recognition (`HostRecognitionReview`), so the review never depends on the plugin's claim.
 */
export function hostRecognitionConfidenceTier(
  confidence: number | null,
  agreement: StructureRecognitionAgreement
): RecognitionConfidenceTier {
  return capRecognitionConfidenceTier(recognitionConfidenceTierFromScore(confidence), recognitionAgreementLevel(agreement));
}

/**
 * The review as the host shows it. The plugin host already replaced a recognition proposal's review
 * block, reason, and leading warnings with its own record of that recognition when the proposal was
 * queued (it refuses a review block it has no recognition for), so this only hands out independent
 * copies — there is nothing left for a plugin to have overstated.
 */
export function reviewedRecognition(
  recognition: RecognitionProposalReview | undefined,
  warnings: readonly RecognitionWarning[]
): { recognition: RecognitionProposalReview | undefined; warnings: RecognitionWarning[] } {
  return {
    recognition: recognition ? { ...recognition } : undefined,
    warnings: warnings.map(({ code, message }) => ({ code, message }))
  };
}
