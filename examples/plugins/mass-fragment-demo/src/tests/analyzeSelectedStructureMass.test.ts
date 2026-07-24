import type {
  PluginAnalysisRecordInput,
  PluginCommandContext,
  PluginPanelReport,
  PluginSelectedMolecule
} from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";

import { analyzeSelectedStructureMass } from "../application/analyzeSelectedStructureMass";
import { massAnalyzeCommandId, massForwardAnalysisType } from "../manifest";
import { createMassRegistration } from "../register";

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

function makeContext(
  molecules: PluginSelectedMolecule[],
  options: { selection?: boolean; analysis?: boolean } = {}
): { context: PluginCommandContext; writes: PluginAnalysisRecordInput[]; reports: { panelId: string; report: PluginPanelReport }[] } {
  const writes: PluginAnalysisRecordInput[] = [];
  const reports: { panelId: string; report: PluginPanelReport }[] = [];
  const context = {
    plugin: { id: "org.chemdraft.mass.fragment", name: "Mass", version: "0", permissions: [] },
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
              return { ...input, id: "rec", pluginId: "org.chemdraft.mass.fragment", createdAt: "t" } as never;
            },
            list: async () => [],
            getLatest: async () => undefined
          },
    panels: {
      showReport: async (panelId: string, report: PluginPanelReport) => {
        reports.push({ panelId, report });
      }
    },
    hasPermission: () => true,
    requirePermission: () => undefined
  } as unknown as PluginCommandContext;
  return { context, writes, reports };
}

describe("analyzeSelectedStructureMass (the generic path, no NMR concepts)", () => {
  it("reads the selection, writes a mass.forward-analysis record, and shows the report", async () => {
    const harness = makeContext([molecule()]);
    const result = await analyzeSelectedStructureMass(harness.context);

    expect(result.ok).toBe(true);
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]).toMatchObject({ analysisType: massForwardAnalysisType, status: "complete" });
    expect(harness.writes[0].provenance.engineId).toBe("chemdraft.mass.ocl");
    expect(harness.reports.at(-1)?.report.title).toBe("Mass Analysis");
  });

  it("returns not-ok (and writes nothing) with no selection", async () => {
    const harness = makeContext([]);
    const result = await analyzeSelectedStructureMass(harness.context);
    expect(result.ok).toBe(false);
    expect(harness.writes).toHaveLength(0);
  });

  it("rejects a multi-molecule selection", async () => {
    const harness = makeContext([molecule(), molecule({ objectId: "m2" })]);
    expect((await analyzeSelectedStructureMass(harness.context)).ok).toBe(false);
  });

  it("fails cleanly without the required permissions", async () => {
    const harness = makeContext([molecule()], { analysis: false });
    expect((await analyzeSelectedStructureMass(harness.context)).ok).toBe(false);
  });

  it("registration exposes a handler keyed on the analyze command id", () => {
    expect(typeof createMassRegistration().commandHandlers[massAnalyzeCommandId]).toBe("function");
  });

  it("records an explicit native-ion warning for an already charged selection", async () => {
    const harness = makeContext([molecule({ structure: "C[N+](C)(C)C" })]);
    const result = await analyzeSelectedStructureMass(harness.context);

    expect(result.ok).toBe(true);
    expect(harness.writes[0].warnings).toEqual([
      expect.objectContaining({ code: "CHARGED_PRECURSOR_NATIVE_ION_ONLY", severity: "info" })
    ]);
  });
});
