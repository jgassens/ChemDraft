import type {
  PluginCommandContext,
  PluginCommandResult,
  PluginIsotopeEnvelopeResult
} from "@chemdraft/plugin-api";

import { composeMassErrorReport, composeMassReport } from "../composeMassReport";
import { massForwardAnalysisType, massFragmentPanelId } from "../manifest";
import type { MassReport } from "../massAnalysis";

/**
 * The mass-analysis command. It walks exactly the same generic path as the NMR plugin — read the
 * selection, validate a single molecule, compute, write an analysis record, render a declarative
 * report — with none of the NMR machinery (no worker, no reference database). That contrast is the
 * point: the host/analysis/panel APIs carry a second, unrelated analyzer unchanged.
 *
 * OpenChemLib is pulled in via a dynamic import so it is code-split out of the desktop's main bundle
 * (mirrors the NMR predictor's lazy path); computation is fast and runs in-thread.
 */
export async function analyzeSelectedStructureMass(
  context: PluginCommandContext
): Promise<PluginCommandResult<MassReport>> {
  const { selection, panels, analysis, chemistry } = context;

  if (!selection || !analysis) {
    return {
      ok: false,
      error: { code: "MASS_PERMISSION_UNAVAILABLE", message: "Mass analysis requires selection.read and analysis.write." }
    };
  }

  const molecules = (await selection.getSelection()).molecules;
  if (molecules.length === 0) {
    return { ok: false, error: { code: "MASS_NO_SELECTION", message: "Select one molecule before analyzing its mass." } };
  }
  if (molecules.length > 1) {
    return { ok: false, error: { code: "MASS_MULTIPLE_SELECTION", message: "Select exactly one molecule." } };
  }

  const source = molecules[0];
  const format = source.structureFormat;
  if (format !== "smiles" && format !== "molfile-v2000" && format !== "molfile-v3000") {
    const message = `Unsupported structure format: ${format}.`;
    await panels?.showReport(massFragmentPanelId, composeMassErrorReport(source, message));
    return { ok: false, error: { code: "MASS_UNSUPPORTED_FORMAT", message } };
  }

  try {
    const { analyzeMass } = await import("../massAnalysis");
    const report = analyzeMass({ format, value: source.structure });

    // The isotope envelope comes from the host, not from this plugin, and its absence must never cost
    // the reader the formula, masses, and ions — those are computed here and are perfectly good.
    //
    // Two ways it can be missing, and both end as a stated reason rather than a failed command:
    // `chemistry` is undefined in-process when the host has no engine, and across the worker bridge the
    // stub exists whenever the permission is declared, so an engine-less host rejects the call instead.
    // The plugin does NOT fall back to estimating a pattern itself — that is the approximation this
    // change retired, and reinstating it as a fallback would undo the point.
    let envelope: PluginIsotopeEnvelopeResult | undefined;
    if (chemistry) {
      try {
        envelope = await chemistry.isotopeEnvelope({ format, structure: source.structure });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "the host could not compute an isotope envelope.";
        envelope = { available: false, reason };
      }
    }

    await analysis.write<MassReport>({
      analysisType: massForwardAnalysisType,
      schemaVersion: "1",
      source: {
        documentId: source.documentId ?? "",
        pageId: source.pageId ?? "",
        objectId: source.objectId,
        sourceFingerprint: source.sourceFingerprint
      },
      status: "complete",
      payload: report,
      warnings: report.netCharge === 0
        ? []
        : [
            {
              code: "CHARGED_PRECURSOR_NATIVE_ION_ONLY",
              message: "The selected structure is already charged, so only its native ion is reported.",
              severity: "info"
            }
          ],
      provenance: { engineId: "chemdraft.mass.ocl", engineVersion: "0.0.0", method: "formula-mass" }
    });

    await panels?.showReport(massFragmentPanelId, composeMassReport(source, report, envelope));
    return { ok: true, data: report };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mass analysis failed.";
    await panels?.showReport(massFragmentPanelId, composeMassErrorReport(source, message));
    return { ok: false, error: { code: "MASS_ANALYSIS_FAILED", message } };
  }
}
