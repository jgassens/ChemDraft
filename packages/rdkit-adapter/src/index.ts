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

// Real RDKit ETKDGv3 3D conformer engine (custom MinimalLib WASM — see vendor/BUILD.md).
export * from "./conformer";

// Real RDKit structure analysis: composition, masses, identifiers, and named descriptors, each behind
// a method contract (PLANS.md §9 Release 1). Replaces the fixture-backed placeholder that shipped ten
// hardcoded SMILES with hand-entered masses — "a second implementation by another name" (§7).
export * from "./analysis";
export * from "./composition";
export * from "./methods";

import { analyzeStructureDetailed, type AnalysisInputFormat, type DetailedAnalysis } from "./analysis";
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
  const analyze = async (input: ChemistryStructureInput): Promise<DetailedAnalysis | ChemistryWarning> => {
    if (!isSupportedFormat(input.format)) return unsupportedFormatError(input.format);
    runCounter += 1;
    return analyzeStructureDetailed({
      format: input.format,
      value: input.value,
      runId: `chemistry-adapter-${runCounter}`,
      startedAt: new Date().toISOString()
    });
  };

  return {
    id: "rdkit-minimallib-wasm",
    getCapabilities() {
      return rdkitAdapterCapabilities;
    },
    async validateStructure(input): Promise<StructureValidationResult> {
      const outcome = await analyze(input);
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
