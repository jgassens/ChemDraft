interface FixtureRequest {
  structure: { value: string };
  nuclei: readonly ("1H" | "13C")[];
}

/** Element symbols from a V2000 atom block, so the fixture can recognise the structure it was given. */
function molfileElements(molfile: string): string[] {
  const lines = molfile.split(/\r?\n/);
  const atomCount = Number((lines[3] ?? "").slice(0, 3));
  return lines.slice(4, 4 + (Number.isInteger(atomCount) ? atomCount : 0)).map((line) => line.slice(31, 34).trim());
}

const BACKEND = {
  id: "fixture-ocl-hose",
  version: "1.0.0",
  dataVersion: "fixture-db",
  method: "HOSE fixture predictor",
  license: "test-only",
  attribution: "ChemDraft CLI test fixture",
  source: "local fixture"
};

function carbon(deltaPpm: number, atoms: number[]) {
  return {
    nucleus: "13C",
    deltaPpm,
    atomRefs: atoms.map((sourceAtomIndex) => ({ sourceAtomIndex })),
    evidence: { method: "hose-fragment", matchedSphere: 3, sampleCount: 5 },
    multiplet: null,
    flags: []
  };
}

function proton(deltaPpm: number, atoms: number[], equivalentNuclei: number) {
  return {
    nucleus: "1H",
    deltaPpm,
    atomRefs: atoms.map((sourceAtomIndex) => ({ sourceAtomIndex })),
    equivalentNuclei,
    evidence: { method: "hose-fragment", matchedSphere: 3, sampleCount: 5 },
    multiplet: null,
    flags: []
  };
}

/**
 * Toluene (Cc1ccccc1: C0 methyl, C1 ipso, C2/C6 ortho, C3/C5 meta, C4 para), with topologically
 * equivalent atoms grouped into one resonance each (nEquivalent 2 for the ortho/meta pairs).
 */
function tolueneResult(request: FixtureRequest, elements: string[]) {
  const resonances: object[] = [];
  if (request.nuclei.includes("13C")) {
    resonances.push(
      carbon(142.1, [1]),
      carbon(129.0, [2, 6]),
      carbon(128.5, [3, 5]),
      carbon(125.6, [4]),
      carbon(21.4, [0])
    );
  }
  if (request.nuclei.includes("1H")) {
    resonances.push(
      proton(7.4, [3, 5], 2),
      proton(7.35, [4], 1),
      proton(7.06, [2, 6], 2),
      proton(2.3, [0], 3)
    );
  }
  return {
    backend: BACKEND,
    resonances,
    warnings: [{ code: "NMR_FIXTURE", message: "fixture prediction", severity: "info" }],
    depiction: { atoms: elements.map((element, index) => ({ index, element })) }
  };
}

export class OclHosePredictor {
  async predict(request: FixtureRequest) {
    const elements = molfileElements(request.structure.value);
    if (elements.length === 7 && elements.every((element) => element === "C")) {
      return tolueneResult(request, elements);
    }
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
      backend: BACKEND,
      resonances,
      warnings: [{ code: "NMR_FIXTURE", message: "fixture prediction", severity: "info" }],
      // Deliberately mismatched so the CLI's atom-order warning path runs in CI.
      depiction: { atoms: [{ index: 0, element: "N" }] }
    };
  }
}

/** Mirrors the real plugin's caption convention for real predictions. */
export function renderStickSpectrumSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><text>1H δ (ppm) — predicted</text></svg>`;
}
