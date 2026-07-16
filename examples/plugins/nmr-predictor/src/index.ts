/**
 * @chemdraft/plugin-nmr-predictor — public surface.
 *
 * M6 ships the provider core (domain contracts, normalization, fixture provider) and the manifest.
 * The worker (M7), command + analysis wiring (M8), and declarative panel report (M9) attach later.
 */
export * from "./domain/contracts";
export { NmrError, NmrErrorCodes, isNmrError, type NmrErrorCode } from "./domain/errors";
export {
  NmrWarningCodes,
  nmrWarning,
  type NmrWarningCode,
  type NmrWarningSeverity,
  type NmrPredictionWarning
} from "./domain/warnings";
export {
  NmrNucleusSchema,
  ChemicalStructureInputSchema,
  NmrPredictionOptionsSchema,
  NmrPredictionRequestSchema,
  NmrPredictionResultSchema
} from "./domain/schemas";
export { createStructureSourceFingerprint, fingerprintStructureInput } from "./domain/fingerprint";

export {
  normalizeStructure,
  toChemicalStructureInput,
  type NormalizedStructure
} from "./application/normalizeStructure";

export {
  FixtureHosePredictor,
  type FixtureHosePredictorOptions
} from "./providers/fixture/FixtureHosePredictor";
export {
  FIXTURE_DATABASE,
  FIXTURE_DATA_VERSION,
  type FixtureShift,
  type FixtureEnvironmentEntry
} from "./providers/fixture/fixtureDatabase";
export {
  describeAtomEnvironment,
  collectCarbonEnvironments,
  collectProtonEnvironments,
  elementSymbol,
  type AtomEnvironment,
  type ProtonEnvironment
} from "./providers/fixture/fixtureEnvironment";

export { OclHosePredictor, type OclHosePredictorOptions } from "./providers/ocl/OclHosePredictor";
export {
  estimateProtonIncrement,
  PROTON_INCREMENT_ESTIMATOR_ID,
  PROTON_INCREMENT_ESTIMATOR_VERSION,
  type ProtonIncrementEstimate,
  type ProtonIncrementUnavailableReason
} from "./providers/ocl/incrementEstimator";
export { buildNmrDatabase, type BuildDatabaseOptions } from "./providers/ocl/buildDatabase";
export {
  atomEnvironmentCodes,
  environmentKey,
  sphereDepthOf,
  MAX_SPHERES
} from "./providers/ocl/environmentCode";
export {
  summarizeShifts,
  type CompiledNmrDatabase,
  type NmrDatabaseEntry,
  type NmrDatabaseProvenance
} from "./providers/ocl/localDatabase";

export {
  nmrPredictorManifest,
  nmrPredictorPluginId,
  nmrPredictCarbonCommandId,
  nmrPredictProtonCommandId,
  nmrPredictorPanelId,
  nmrPredictorAnalyzerId,
  nmrForwardPredictionAnalysisType
} from "./manifest";

export type { NmrWorkerRequest, NmrWorkerResponse, NmrWorkerErrorPayload } from "./worker/protocol";
export { createNmrWorkerHandler, type NmrWorkerHandlerDeps } from "./worker/nmrWorkerCore";
export { createNmrWorkerClient, type NmrWorkerClient } from "./worker/nmrWorkerClient";

export {
  predictSelectedStructure,
  type NmrCommandServices,
  type NmrCommandConfig
} from "./application/predictSelectedStructure";
export { determineAnalysisStatus, type NmrAnalysisStatus } from "./application/determineAnalysisStatus";
export {
  mapSelectedMoleculeToPredictionInput,
  toCommandError,
  isCancellationError,
  type CommandError,
  type MappedStructure
} from "./application/mapSelection";
export { createWorkerBackedPredictor } from "./application/workerPredictor";
export { createNmrRegistration, createNmrCommandHandlers, type NmrPluginRegistration } from "./register";
export {
  composePendingReport,
  composePredictionReport,
  composeErrorReport
} from "./report/composePredictionReport";
export { renderStickSpectrumSvg, type StickSpectrumOptions } from "./report/stickSpectrumSvg";
