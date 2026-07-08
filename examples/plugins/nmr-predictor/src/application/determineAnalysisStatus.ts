import type { NmrPredictionResult } from "../domain/contracts";
import { NmrWarningCodes } from "../domain/warnings";

export type NmrAnalysisStatus = "complete" | "partial" | "failed";

/**
 * Classify a produced result for the analysis record: nothing predicted → failed; some environment
 * unmatched (no-match / partial warning) → partial; otherwise complete. Cancellation never reaches
 * here (it throws and writes no record).
 */
export function determineAnalysisStatus(result: NmrPredictionResult): NmrAnalysisStatus {
  if (result.resonances.length === 0) {
    return "failed";
  }
  const partial = result.warnings.some(
    (warning) =>
      warning.code === NmrWarningCodes.NoFragmentMatch || warning.code === NmrWarningCodes.PartialPrediction
  );
  return partial ? "partial" : "complete";
}
