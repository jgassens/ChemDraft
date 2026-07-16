import { describe, expect, it } from "vitest";

import type { NmrPredictionResult, NmrResonance } from "../domain/contracts";
import { determineAnalysisStatus } from "../application/determineAnalysisStatus";

function result(resonances: NmrResonance[], warningCodes: string[] = []): NmrPredictionResult {
  return {
    schemaVersion: "1",
    sourceFingerprint: "fp",
    backend: { id: "x", version: "1", method: "fixture-fragment" },
    resonances,
    warnings: warningCodes.map((code) => ({ code, message: code, severity: "warning" as const })),
    generatedAt: "t"
  };
}

const resonance: NmrResonance = { id: "c-0", nucleus: "13C", deltaPpm: 128.5, atomRefs: [], flags: [] };

describe("determineAnalysisStatus", () => {
  it("is failed when no resonances were produced", () => {
    expect(determineAnalysisStatus(result([]))).toBe("failed");
    expect(determineAnalysisStatus(result([], ["NMR_NO_FRAGMENT_MATCH"]))).toBe("failed");
  });

  it("is partial when some environment was unmatched", () => {
    expect(determineAnalysisStatus(result([resonance], ["NMR_NO_FRAGMENT_MATCH"]))).toBe("partial");
    expect(determineAnalysisStatus(result([resonance], ["NMR_PARTIAL_PREDICTION"]))).toBe("partial");
  });

  it("is partial when any resonance is a disclosed rule estimate", () => {
    const estimated: NmrResonance = {
      ...resonance,
      evidence: {
        method: "rule-estimated",
        estimator: { id: "rules", version: "1", method: "generic-sp3-carbon" }
      },
      flags: ["rule-estimated"]
    };
    expect(determineAnalysisStatus(result([estimated]))).toBe("partial");
    expect(determineAnalysisStatus(result([resonance], ["NMR_RULE_ESTIMATED"]))).toBe("partial");
  });

  it("is complete when everything matched", () => {
    expect(determineAnalysisStatus(result([resonance]))).toBe("complete");
    expect(determineAnalysisStatus(result([resonance], ["NMR_SMALL_REFERENCE_POPULATION"]))).toBe("complete");
  });
});
