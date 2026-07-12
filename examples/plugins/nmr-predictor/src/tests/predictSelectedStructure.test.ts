import type {
  PluginAnalysisRecordInput,
  PluginCommandContext,
  PluginPanelReport,
  PluginSelectedMolecule
} from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";

import type { NmrPredictionRequest, NmrPredictionResult, NmrPredictor } from "../domain/contracts";
import { NmrError, NmrErrorCodes } from "../domain/errors";
import { FixtureHosePredictor } from "../providers/fixture/FixtureHosePredictor";
import { predictSelectedStructure } from "../application/predictSelectedStructure";
import { createNmrCommandHandlers } from "../register";
import { nmrPredictCarbonCommandId, nmrPredictProtonCommandId } from "../manifest";

function molecule(overrides: Partial<PluginSelectedMolecule> = {}): PluginSelectedMolecule {
  return {
    objectId: "m1",
    documentId: "doc1",
    pageId: "p1",
    structureFormat: "smiles",
    structure: "c1ccccc1",
    sourceFingerprint: "fp1",
    ...overrides
  };
}

interface Harness {
  context: PluginCommandContext;
  writes: PluginAnalysisRecordInput[];
  reports: { panelId: string; report: PluginPanelReport }[];
}

function makeContext(
  molecules: PluginSelectedMolecule[],
  options: { selection?: boolean; analysis?: boolean; panels?: boolean } = {}
): Harness {
  const writes: PluginAnalysisRecordInput[] = [];
  const reports: { panelId: string; report: PluginPanelReport }[] = [];
  const context = {
    plugin: { id: "org.chemdraft.nmr.predictor", name: "NMR", version: "0", permissions: [] },
    documents: { getActiveDocument: async () => undefined, proposePatch: async () => ({}) as never },
    selection:
      options.selection === false
        ? undefined
        : { getSelection: async () => ({ objectIds: molecules.map((m) => m.objectId), molecules }) },
    analysis:
      options.analysis === false
        ? undefined
        : {
            write: async (input: PluginAnalysisRecordInput) => {
              writes.push(input);
              return { ...input, id: "rec", pluginId: "org.chemdraft.nmr.predictor", createdAt: "t" } as never;
            },
            list: async () => [],
            getLatest: async () => undefined
          },
    panels:
      options.panels === false
        ? undefined
        : {
            showReport: async (panelId: string, report: PluginPanelReport) => {
              reports.push({ panelId, report });
            }
          },
    hasPermission: () => true,
    requirePermission: () => undefined
  } as unknown as PluginCommandContext;
  return { context, writes, reports };
}

const services = { predictor: new FixtureHosePredictor({ now: () => "2026-07-08T00:00:00.000Z" }) };
const CARBON = { nuclei: ["13C"] as const };

describe("predictSelectedStructure", () => {
  it("fails without selection.read / analysis.write", async () => {
    const { context, writes } = makeContext([molecule()], { analysis: false });
    const result = await predictSelectedStructure(context, services, CARBON);
    expect(result).toMatchObject({ ok: false, error: { code: NmrErrorCodes.PermissionUnavailable } });
    expect(writes).toHaveLength(0);
  });

  it("requires exactly one selected molecule", async () => {
    const none = await predictSelectedStructure(makeContext([]).context, services, CARBON);
    expect(none).toMatchObject({ ok: false, error: { code: NmrErrorCodes.NoSelectedStructure } });

    const many = await predictSelectedStructure(makeContext([molecule(), molecule({ objectId: "m2" })]).context, services, CARBON);
    expect(many).toMatchObject({ ok: false, error: { code: NmrErrorCodes.MultipleSelectedStructures } });
  });

  it("tags each report with the nucleus's rerun command so Run again repeats the same nucleus", async () => {
    const carbon = makeContext([molecule()]);
    await predictSelectedStructure(carbon.context, services, { nuclei: ["13C"] });
    expect(carbon.reports.at(-1)?.report.rerunCommandId).toBe(nmrPredictCarbonCommandId);

    const proton = makeContext([molecule()]);
    await predictSelectedStructure(proton.context, services, { nuclei: ["1H"], ignoreLabileHydrogens: true });
    expect(proton.reports.at(-1)?.report.rerunCommandId).toBe(nmrPredictProtonCommandId);
  });

  it("rejects an unknown structure format and shows an error panel", async () => {
    const { context, reports, writes } = makeContext([molecule({ structureFormat: "unknown" })]);
    const result = await predictSelectedStructure(context, services, CARBON);
    expect(result).toMatchObject({ ok: false, error: { code: NmrErrorCodes.UnsupportedStructureFormat } });
    expect(writes).toHaveLength(0);
    expect(reports.at(-1)?.report.sections.some((section) => section.kind === "text" && "title" in section && section.title === "Prediction failed")).toBe(true);
  });

  it("predicts benzene, writes a complete analysis record, and updates the panel", async () => {
    const { context, writes, reports } = makeContext([molecule()]);
    const result = await predictSelectedStructure(context, services, CARBON);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.resonances).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      analysisType: "nmr.forward-prediction",
      status: "complete",
      source: { objectId: "m1", documentId: "doc1", pageId: "p1", sourceFingerprint: "fp1" },
      provenance: { method: "fixture-fragment" }
    });
    // Pending report then result report.
    expect(reports).toHaveLength(2);
    expect(reports.every((entry) => entry.panelId === "panel.nmrPredictor.review")).toBe(true);
  });

  it("records status \"partial\" for a partially-covered molecule", async () => {
    const { context, writes } = makeContext([molecule({ structure: "CCc1ccccc1" })]);
    const result = await predictSelectedStructure(context, services, CARBON);
    expect(result.ok).toBe(true);
    expect(writes[0]?.status).toBe("partial");
  });

  it("summarizes additive-increment involvement in generic analysis provenance", async () => {
    const mixedResult: NmrPredictionResult = {
      schemaVersion: "1",
      sourceFingerprint: "fp1",
      backend: { id: "chemdraft.ocl-hose", version: "1", method: "hose-fragment" },
      resonances: [
        {
          id: "h-0",
          nucleus: "1H",
          deltaPpm: 2.5,
          atomRefs: [{ sourceAtomIndex: 0, element: "H", equivalentCount: 1 }],
          crossCheck: {
            incrementPpm: 0.7,
            disagrees: true,
            reason: "weak-applicability",
            estimator: {
              id: "chemdraft.h1-additive-increment",
              version: "1.3.0",
              method: "shoolery-alpha-beta-gamma"
            }
          },
          flags: []
        }
      ],
      warnings: [],
      generatedAt: "t"
    };
    const predictor: NmrPredictor = {
      getCapabilities: () => services.predictor.getCapabilities(),
      predict: async () => mixedResult
    };
    const { context, writes } = makeContext([molecule({ structure: "CC" })]);
    await predictSelectedStructure(context, { predictor }, { nuclei: ["1H"] });
    expect(writes[0]?.provenance.method).toBe("hose-fragment+additive-increment");
  });

  it("returns not-ok and writes nothing when the prediction is cancelled", async () => {
    const cancelling: NmrPredictor = {
      getCapabilities: () => services.predictor.getCapabilities(),
      predict: () => Promise.reject(new NmrError(NmrErrorCodes.PredictionCancelled, "cancelled"))
    };
    const { context, writes, reports } = makeContext([molecule()]);
    const result = await predictSelectedStructure(context, { predictor: cancelling }, CARBON);
    expect(result).toMatchObject({ ok: false, error: { code: NmrErrorCodes.PredictionCancelled } });
    expect(writes).toHaveLength(0);
    // Only the pending report — a cancelled run does not overwrite the panel with an error.
    expect(reports).toHaveLength(1);
  });

  it("surfaces a provider failure as an error result and error panel", async () => {
    const failing: NmrPredictor = {
      getCapabilities: () => services.predictor.getCapabilities(),
      predict: () => Promise.reject(new NmrError(NmrErrorCodes.ProviderFailure, "boom"))
    };
    const { context, writes, reports } = makeContext([molecule()]);
    const result = await predictSelectedStructure(context, { predictor: failing }, CARBON);
    expect(result).toMatchObject({ ok: false, error: { code: NmrErrorCodes.ProviderFailure } });
    expect(writes).toHaveLength(0);
    expect(reports.at(-1)?.report.sections.some((section) => section.kind === "text" && "title" in section && section.title === "Prediction failed")).toBe(true);
  });

  it("wires ¹³C and ¹H as separate command handlers (ADR-0011)", async () => {
    const seen: NmrPredictionRequest[] = [];
    const spy: NmrPredictor = {
      getCapabilities: () => services.predictor.getCapabilities(),
      predict: (request) => {
        seen.push(request);
        return services.predictor.predict(request);
      }
    };
    const handlers = createNmrCommandHandlers({ predictor: spy });
    await handlers[nmrPredictCarbonCommandId](makeContext([molecule()]).context);
    await handlers[nmrPredictProtonCommandId](makeContext([molecule()]).context);
    expect(seen.map((request) => request.nuclei)).toEqual([["13C"], ["1H"]]);
  });
});
