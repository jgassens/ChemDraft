interface FixtureRequest {
  nuclei: readonly ("1H" | "13C")[];
}

export class OclHosePredictor {
  async predict(request: FixtureRequest) {
    const resonances: object[] = [];
    for (const nucleus of request.nuclei) {
      if (nucleus === "1H") resonances.push({
          nucleus,
          deltaPpm: 3.62,
          atomRefs: [{ sourceAtomIndex: 1, equivalentCount: 2 }],
          equivalentNuclei: 2,
          evidence: {
            method: "hose-fragment",
            matchedSphere: 3,
            sampleCount: 12,
            estimator: { id: "fixture-estimator", version: "1", method: "median" }
          },
          multiplet: { label: "q", couplings: [{ jHz: 7.1 }] },
          flags: ["fixture"]
        });
      else resonances.push({
          nucleus,
          deltaPpm: 58.1,
          atomRefs: [{ sourceAtomIndex: 1 }],
          evidence: { method: "hose-fragment", matchedSphere: 2, sampleCount: 8 },
          multiplet: null,
          flags: []
        });
    }
    return {
      backend: {
        id: "fixture-ocl-hose",
        version: "1.0.0",
        dataVersion: "fixture-db",
        method: "HOSE fixture predictor",
        license: "test-only",
        attribution: "ChemDraft CLI test fixture",
        source: "local fixture"
      },
      resonances,
      warnings: [{ code: "NMR_FIXTURE", message: "fixture prediction", severity: "info" }],
      // Deliberately mismatched so the CLI's atom-order warning path runs in CI.
      depiction: { atoms: [{ index: 0, element: "N" }] }
    };
  }
}

export function renderStickSpectrumSvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><text>1H — synthetic fixture</text></svg>';
}
