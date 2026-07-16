import type {
  PluginAnalysisWarning,
  PluginCommandContext,
  PluginCommandResult,
  PluginPanelReport
} from "@chemdraft/plugin-api";

import type { NmrNucleus, NmrPredictionRequest, NmrPredictionResult, NmrPredictor } from "../domain/contracts";
import { NmrErrorCodes } from "../domain/errors";
import type { NmrPredictionWarning } from "../domain/warnings";
import {
  nmrForwardPredictionAnalysisType,
  nmrPredictCarbonCommandId,
  nmrPredictProtonCommandId,
  nmrPredictorPanelId
} from "../manifest";
import {
  composeErrorReport,
  composePendingReport,
  composePredictionReport
} from "../report/composePredictionReport";
import { determineAnalysisStatus } from "./determineAnalysisStatus";
import { isCancellationError, mapSelectedMoleculeToPredictionInput, toCommandError } from "./mapSelection";

export interface NmrCommandServices {
  predictor: NmrPredictor;
}

export interface NmrCommandConfig {
  nuclei: readonly NmrNucleus[];
  statistic?: "median" | "mean";
  hoseLevels?: readonly number[];
  ignoreLabileHydrogens?: boolean;
}

/**
 * The NMR prediction command. Validates the selection, maps it to a prediction input, drives the
 * predictor (worker-backed in the desktop), writes an `nmr.forward-prediction` record to the generic
 * analysis store, and updates the panel. Returns a `PluginCommandResult` (never throws for expected
 * conditions) so the desktop can surface failures uniformly (ADR-0010). A cancelled/superseded run
 * returns not-ok and writes no record (the panel is left as-is for the superseding run to replace).
 */
export async function predictSelectedStructure(
  context: PluginCommandContext,
  services: NmrCommandServices,
  config: NmrCommandConfig,
  signal?: AbortSignal
): Promise<PluginCommandResult<NmrPredictionResult>> {
  const { selection, panels, analysis } = context;

  // "Run again" must re-run the nucleus the user is viewing — not the panel's default (¹³C) command.
  const rerunCommandId = config.nuclei.includes("1H") ? nmrPredictProtonCommandId : nmrPredictCarbonCommandId;
  const withRerun = (report: PluginPanelReport): PluginPanelReport => ({ ...report, rerunCommandId });

  if (!selection || !analysis) {
    return {
      ok: false,
      error: { code: NmrErrorCodes.PermissionUnavailable, message: "NMR prediction requires selection.read and analysis.write." }
    };
  }

  const snapshot = await selection.getSelection();
  const molecules = snapshot.molecules;

  if (molecules.length === 0) {
    return {
      ok: false,
      error: { code: NmrErrorCodes.NoSelectedStructure, message: "Select one molecule before predicting an NMR spectrum." }
    };
  }
  if (molecules.length > 1) {
    return {
      ok: false,
      error: { code: NmrErrorCodes.MultipleSelectedStructures, message: "Select exactly one molecule." }
    };
  }

  const source = molecules[0];
  const mapped = mapSelectedMoleculeToPredictionInput(source);
  if (!mapped.ok) {
    await panels?.showReport(nmrPredictorPanelId, withRerun(composeErrorReport(source, mapped.error)));
    return { ok: false, error: mapped.error };
  }

  await panels?.showReport(nmrPredictorPanelId, withRerun(composePendingReport(source, config.nuclei)));

  const request: NmrPredictionRequest = {
    structure: mapped.value,
    nuclei: config.nuclei,
    options: {
      statistic: config.statistic ?? "median",
      hoseLevels: config.hoseLevels ?? [4, 3, 2, 1],
      ignoreLabileHydrogens: config.ignoreLabileHydrogens ?? true
    },
    sourceFingerprint: source.sourceFingerprint
  };

  try {
    const result = await services.predictor.predict(request, signal);
    if (signal?.aborted) {
      // The panel closed (or a rerun superseded) while predicting: write nothing and do not reopen
      // the panel with a late result (ADR-0012).
      return { ok: false, error: { code: NmrErrorCodes.PredictionCancelled, message: "Prediction was cancelled." } };
    }
    const status = determineAnalysisStatus(result);

    await analysis.write<NmrPredictionResult>({
      analysisType: nmrForwardPredictionAnalysisType,
      schemaVersion: "1",
      source: {
        documentId: source.documentId ?? "",
        pageId: source.pageId ?? "",
        objectId: source.objectId,
        sourceFingerprint: source.sourceFingerprint
      },
      status,
      payload: result,
      warnings: result.warnings.map(toAnalysisWarning),
      provenance: {
        engineId: result.backend.id,
        engineVersion: result.backend.version,
        dataVersion: result.backend.dataVersion,
        method: analysisProvenanceMethod(result)
      }
    });

    await panels?.showReport(nmrPredictorPanelId, withRerun(composePredictionReport(source, result)));
    return { ok: true, data: result };
  } catch (error) {
    if (isCancellationError(error)) {
      // Superseded/cancelled: write nothing and leave the panel for the superseding run.
      return { ok: false, error: { code: NmrErrorCodes.PredictionCancelled, message: "Prediction was cancelled." } };
    }
    const normalized = toCommandError(error);
    await panels?.showReport(nmrPredictorPanelId, withRerun(composeErrorReport(source, normalized)));
    return { ok: false, error: normalized };
  }
}

/** The generic record has one method string, while the payload can mix measured HOSE values with
 * per-resonance rules. Keep the summary honest and leave exact IDs/versions on nested estimates. */
function analysisProvenanceMethod(result: NmrPredictionResult): string {
  const methods = [result.backend.method];
  const hasAdditiveIncrement = result.resonances.some(
    (resonance) =>
      resonance.crossCheck !== undefined ||
      resonance.evidence?.estimator?.id === "chemdraft.h1-additive-increment"
  );
  const hasRuleEstimate = result.resonances.some((resonance) => resonance.evidence?.method === "rule-estimated");
  if (hasAdditiveIncrement) methods.push("additive-increment");
  if (hasRuleEstimate) methods.push("rule-estimated");
  return methods.join("+");
}

function toAnalysisWarning(warning: NmrPredictionWarning): PluginAnalysisWarning {
  const details = warning.atomIndices
    ? { ...(warning.details ?? {}), atomIndices: warning.atomIndices }
    : warning.details;
  return {
    code: warning.code,
    message: warning.message,
    severity: warning.severity,
    ...(details ? { details } : {})
  };
}
