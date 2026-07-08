import type {
  PluginAnalysisRecordInput,
  PluginCommandContext,
  PluginPanelReport,
  PluginSelectedMolecule
} from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";

import { NmrErrorCodes } from "../domain/errors";
import { FixtureHosePredictor } from "../providers/fixture/FixtureHosePredictor";
import { createNmrRegistration } from "../register";
import { nmrPredictCarbonCommandId, nmrPredictorPanelId } from "../manifest";

function molecule(): PluginSelectedMolecule {
  return { objectId: "m1", documentId: "doc1", pageId: "p1", structureFormat: "smiles", structure: "c1ccccc1", sourceFingerprint: "fp1" };
}

function makeContext(): { context: PluginCommandContext; writes: PluginAnalysisRecordInput[]; reports: PluginPanelReport[] } {
  const writes: PluginAnalysisRecordInput[] = [];
  const reports: PluginPanelReport[] = [];
  const context = {
    plugin: { id: "org.chemdraft.nmr.predictor", name: "NMR", version: "0", permissions: [] },
    documents: { getActiveDocument: async () => undefined, proposePatch: async () => ({}) as never },
    selection: { getSelection: async () => ({ objectIds: ["m1"], molecules: [molecule()] }) },
    analysis: {
      write: async (input: PluginAnalysisRecordInput) => {
        writes.push(input);
        return { ...input, id: "r", pluginId: "p", createdAt: "t" } as never;
      },
      list: async () => [],
      getLatest: async () => undefined
    },
    panels: { showReport: async (_panelId: string, report: PluginPanelReport) => void reports.push(report) },
    hasPermission: () => true,
    requirePermission: () => undefined
  } as unknown as PluginCommandContext;
  return { context, writes, reports };
}

describe("createNmrRegistration", () => {
  it("closing the NMR panel aborts the in-flight prediction (ADR-0012): not-ok, no record written", async () => {
    const registration = createNmrRegistration({ predictor: new FixtureHosePredictor() });
    const { context, writes } = makeContext();

    const promise = registration.commandHandlers[nmrPredictCarbonCommandId](context);
    // The active controller is set synchronously before the first await, so close it now.
    registration.onPanelClosed(nmrPredictorPanelId);

    const result = await promise;
    expect(result).toMatchObject({ ok: false, error: { code: NmrErrorCodes.PredictionCancelled } });
    expect(writes).toHaveLength(0);
  });

  it("ignores a close for a different panel id", async () => {
    const registration = createNmrRegistration({ predictor: new FixtureHosePredictor() });
    const { context, writes } = makeContext();

    const promise = registration.commandHandlers[nmrPredictCarbonCommandId](context);
    registration.onPanelClosed("panel.somethingElse");

    const result = await promise;
    expect(result).toMatchObject({ ok: true });
    expect(writes).toHaveLength(1);
  });
});
