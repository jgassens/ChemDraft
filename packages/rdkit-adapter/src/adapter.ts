/**
 * The legacy `ChemistryAdapter` shim, in its own entry point.
 *
 * Split out of the barrel so `MainWindow` can build an adapter without `export * from "./analysis"`
 * dragging the pKa network's 4.2 MB of JSON into the app's startup chunk. Every method here is async
 * and loads the engine on demand, so nothing is lost by the separation — the model arrives when
 * someone asks for chemistry, not before the first frame.
 *
 * Import as `@chemdraft/rdkit-adapter/adapter`. The barrel re-exports it for existing callers.
 */
import type {
  ChemistryAdapter,
  ChemistryAdapterCapabilities,
  ChemistryStructureFormat,
  ChemistryStructureInput,
  ChemistryWarning,
  StructureProperties,
  StructureValidationResult
} from "@chemdraft/chemistry-adapter";
import type { AnalysisResult, AnalysisRun } from "@chemdraft/analysis-core";

import type { AnalysisInputFormat, DetailedAnalysis } from "./analysis";
import { PINNED_RDKIT_VERSION } from "./methods";

export const rdkitAdapterStatus = "real" as const;

const SUPPORTED_FORMATS: readonly ChemistryStructureFormat[] = ["smiles", "molfile-v2000", "molfile-v3000"];

export const rdkitAdapterCapabilities: ChemistryAdapterCapabilities = {
  implementationName: "RDKit MinimalLib (WASM)",
  implementationVersion: PINNED_RDKIT_VERSION,
  supportedFormats: SUPPORTED_FORMATS,
  canValidateStructure: true,
  canCalculateFormula: true,
  canCalculateAverageMass: true,
  canCalculateExactMass: true,
  canCalculateTotalCharge: true,
  canReportStereochemistryWarnings: true,
  warnings: []
};

/**
 * What `validateStructure` needs: is it parseable, and the three numbers `StructureProperties` holds.
 *
 * Composition also carries the parse-level warnings a validation result is actually about, so
 * restricting to these loses nothing the caller reads.
 */
const VALIDATION_METHOD_IDS: readonly string[] = [
  "rdkit.composition",
  "rdkit.average-mass",
  "rdkit.monoisotopic-mass"
];

function isSupportedFormat(format: ChemistryStructureFormat): format is AnalysisInputFormat {
  return (SUPPORTED_FORMATS as readonly string[]).includes(format);
}

function scalarValue(run: AnalysisRun, methodId: string): number | undefined {
  const result = run.results.find((candidate) => candidate.id === methodId);
  if (!result || result.kind !== "scalar" || result.value === null) return undefined;
  return result.value;
}

function compositionResult(run: AnalysisRun): Extract<AnalysisResult, { kind: "composition" }> | undefined {
  const result = run.results.find((candidate) => candidate.kind === "composition");
  return result?.kind === "composition" ? result : undefined;
}

/**
 * Translate a run into the older `ChemistryAdapter` vocabulary.
 *
 * Deliberately lossy: `StructureProperties` has no room for per-method provenance, declines, or the
 * interpretation a number was computed against, so the richer surface stays on `analyzeStructure`.
 * Every decline still travels out as a warning rather than vanishing — a caller reading only
 * `properties` must still be able to see that Crippen logP refused and why.
 */
function toStructureProperties(detailed: DetailedAnalysis): StructureProperties {
  const composition = compositionResult(detailed.run);
  const averageMass = scalarValue(detailed.run, "rdkit.average-mass");
  const exactMass = scalarValue(detailed.run, "rdkit.monoisotopic-mass");
  return {
    ...(composition?.formula ? { formula: composition.formula } : {}),
    ...(averageMass !== undefined ? { averageMass } : {}),
    ...(exactMass !== undefined ? { exactMass } : {}),
    ...(composition?.formalCharge != null ? { totalCharge: composition.formalCharge } : {}),
    ...(detailed.composition
      ? { atomCount: detailed.composition.atomCount, bondCount: detailed.composition.bondCount }
      : {}),
    stereochemistry: detailed.stereochemistry
  };
}

function toWarnings(run: AnalysisRun): ChemistryWarning[] {
  return [
    ...run.warnings.map((entry) => ({ code: entry.code, message: entry.message, severity: entry.severity })),
    ...run.results.flatMap((result) =>
      result.warnings.map((entry) => ({ code: entry.code, message: entry.message, severity: entry.severity }))
    )
  ];
}

function unsupportedFormatError(format: ChemistryStructureFormat): ChemistryWarning {
  return {
    code: "structure.unsupported_format",
    message: `The RDKit adapter accepts ${SUPPORTED_FORMATS.join(", ")}; received "${format}".`,
    severity: "error"
  };
}

let runCounter = 0;

/**
 * The real chemistry adapter. Each call is one `AnalysisRun`.
 *
 * Callers that want provenance — which interpretation a number describes, which method produced it,
 * why a method declined — should call `analyzeStructure` directly rather than through this narrower
 * contract, which predates the run model.
 */
export function createRdkitAdapter(): ChemistryAdapter {
  const analyze = async (
    input: ChemistryStructureInput,
    methodIds?: readonly string[]
  ): Promise<DetailedAnalysis | ChemistryWarning> => {
    if (!isSupportedFormat(input.format)) return unsupportedFormatError(input.format);
    runCounter += 1;
    // Loaded HERE rather than at module scope. `analyzeStructureDetailed` reaches the pKa network's
    // 4.2 MB of JSON, and every method on this adapter is already async, so there is nothing to gain
    // by having it resident before the user asks for an analysis. Paired with the `/adapter` subpath
    // export, this is what keeps the model out of the app's startup chunk.
    const { analyzeStructureDetailed } = await import("./analysis");
    return analyzeStructureDetailed({
      format: input.format,
      value: input.value,
      runId: `chemistry-adapter-${runCounter}`,
      startedAt: new Date().toISOString(),
      ...(methodIds ? { methodIds: [...methodIds] } : {})
    });
  };

  return {
    id: "rdkit-minimallib-wasm",
    getCapabilities() {
      return rdkitAdapterCapabilities;
    },
    async validateStructure(input): Promise<StructureValidationResult> {
      // Only the methods this answer actually reads. Validation ran the whole ~62-method suite —
      // the pKa network, the 2^n-microstate macroscopic fold, Joback's 41-SMARTS fragmentation — to
      // report what the placeholder reported from a formula and a mass, and it is unbounded on a
      // many-site molecule. `analyzeStructure` below deliberately keeps the full suite, because its
      // documented contract is that every decline travels out as a warning; validation makes no such
      // promise, and its result carries only errors and warnings about the structure itself.
      const outcome = await analyze(input, VALIDATION_METHOD_IDS);
      if ("severity" in outcome) return { valid: false, errors: [outcome], warnings: [] };

      const warnings = toWarnings(outcome.run);
      const errors = warnings.filter((entry) => entry.severity === "error");
      return {
        valid: errors.length === 0,
        errors,
        warnings: warnings.filter((entry) => entry.severity !== "error")
      };
    },
    async analyzeStructure(input) {
      const outcome = await analyze(input);
      if ("severity" in outcome) {
        return {
          input,
          validation: { valid: false, errors: [outcome], warnings: [] },
          properties: { stereochemistry: [] },
          warnings: [outcome]
        };
      }

      const warnings = toWarnings(outcome.run);
      const errors = warnings.filter((entry) => entry.severity === "error");
      const nonErrors = warnings.filter((entry) => entry.severity !== "error");
      return {
        input,
        validation: { valid: errors.length === 0, errors, warnings: nonErrors },
        properties: errors.length === 0 ? toStructureProperties(outcome) : { stereochemistry: [] },
        warnings
      };
    }
  };
}
