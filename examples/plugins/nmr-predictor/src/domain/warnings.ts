/**
 * Non-fatal warning codes attached to a produced {@link NmrPredictionResult}. Unlike errors, these
 * never abort prediction — they record where the fixture provider under-delivered (unmatched
 * environments, small reference populations, omitted labile protons) so the desktop can disclose it.
 */
export const NmrWarningCodes = {
  UnsupportedElement: "NMR_UNSUPPORTED_ELEMENT",
  ChargedStructure: "NMR_CHARGED_STRUCTURE",
  IsotopeNotSupported: "NMR_ISOTOPE_NOT_SUPPORTED",
  LabileProtonOmitted: "NMR_LABILE_PROTON_OMITTED",
  NoFragmentMatch: "NMR_NO_FRAGMENT_MATCH",
  LowHoseSphereMatch: "NMR_LOW_HOSE_SPHERE_MATCH",
  SmallReferencePopulation: "NMR_SMALL_REFERENCE_POPULATION",
  PartialPrediction: "NMR_PARTIAL_PREDICTION",
  RuleEstimated: "NMR_RULE_ESTIMATED"
} as const;

export type NmrWarningCode = (typeof NmrWarningCodes)[keyof typeof NmrWarningCodes];

export type NmrWarningSeverity = "info" | "warning" | "error";

export interface NmrPredictionWarning {
  code: string;
  message: string;
  severity: NmrWarningSeverity;
  atomIndices?: readonly number[];
  details?: Readonly<Record<string, unknown>>;
}

export function nmrWarning(
  code: NmrWarningCode,
  message: string,
  options: {
    severity?: NmrWarningSeverity;
    atomIndices?: readonly number[];
    details?: Readonly<Record<string, unknown>>;
  } = {}
): NmrPredictionWarning {
  const warning: NmrPredictionWarning = {
    code,
    message,
    severity: options.severity ?? "warning"
  };
  if (options.atomIndices !== undefined) {
    warning.atomIndices = options.atomIndices;
  }
  if (options.details !== undefined) {
    warning.details = options.details;
  }
  return warning;
}
