/**
 * Hard-failure error codes: conditions that abort prediction before a result exists (as opposed to
 * warnings, which annotate a produced result — see warnings.ts). Codes are the stable contract that
 * the command layer (M8) maps to user-facing messages.
 */
export const NmrErrorCodes = {
  UnsupportedStructureFormat: "NMR_UNSUPPORTED_STRUCTURE_FORMAT",
  EmptyStructure: "NMR_EMPTY_STRUCTURE",
  StructureParseFailed: "NMR_STRUCTURE_PARSE_FAILED",
  ProviderInitializationFailed: "NMR_PROVIDER_INITIALIZATION_FAILED",
  ProviderFailure: "NMR_PROVIDER_FAILURE"
} as const;

export type NmrErrorCode = (typeof NmrErrorCodes)[keyof typeof NmrErrorCodes];

/** Typed domain error carrying a stable {@link NmrErrorCode}. Serializable-friendly: the code and
 *  optional details survive structured cloning even though the Error instance itself does not. */
export class NmrError extends Error {
  readonly code: NmrErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: NmrErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "NmrError";
    this.code = code;
    this.details = details;
  }
}

export function isNmrError(value: unknown): value is NmrError {
  return value instanceof NmrError;
}
