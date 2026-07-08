import type { PluginSelectedMolecule } from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";

import type { NmrPredictionResult } from "../domain/contracts";
import {
  composeErrorReport,
  composePendingReport,
  composePredictionReport
} from "../report/composePredictionReport";

const source: PluginSelectedMolecule = {
  objectId: "m1",
  documentId: "doc1",
  pageId: "p1",
  structureFormat: "smiles",
  structure: "c1ccccc1",
  sourceFingerprint: "fp1"
};

const result: NmrPredictionResult = {
  schemaVersion: "1",
  sourceFingerprint: "fp1",
  backend: { id: "chemdraft.fixture-hose", version: "1.0.0", dataVersion: "fixture-2026-07-synthetic", method: "fixture-fragment" },
  resonances: [
    {
      id: "c-0",
      nucleus: "13C",
      deltaPpm: 128.5,
      atomRefs: [{ sourceAtomIndex: 0, element: "C", equivalentCount: 1 }],
      equivalentNuclei: 6,
      uncertainty: { standardDeviationPpm: 0.4 },
      evidence: { method: "fixture-fragment", environmentCode: "Caq0h1(...)" },
      flags: []
    }
  ],
  warnings: [{ code: "NMR_NO_FRAGMENT_MATCH", message: "no match for X", severity: "warning" }],
  generatedAt: "t"
};

function textBodies(report: { sections: { kind: string }[] }): string {
  return JSON.stringify(report.sections);
}

describe("composePredictionReport", () => {
  it("pending report announces the nuclei being predicted", () => {
    const report = composePendingReport(source, ["13C"]);
    expect(report.title).toBe("NMR Prediction");
    expect(textBodies(report)).toContain("¹³C");
  });

  it("error report carries the code and message under a failure heading", () => {
    const report = composeErrorReport(source, { code: "NMR_EMPTY_STRUCTURE", message: "empty" });
    const failure = report.sections.find((section) => section.kind === "text" && "title" in section && section.title === "Prediction failed");
    expect(failure).toBeDefined();
    expect(textBodies(report)).toContain("NMR_EMPTY_STRUCTURE");
  });

  it("result report includes provenance, a shift table, notices, and the synthetic-data disclaimer", () => {
    const report = composePredictionReport(source, result);
    const kinds = report.sections.map((section) => section.kind);
    expect(kinds).toContain("keyValue");
    expect(kinds).toContain("table");
    const table = report.sections.find((section) => section.kind === "table");
    expect(table && table.kind === "table" && table.rows[0]).toEqual(["¹³C", "128.50", "6", "0.40", "0", "Caq0h1(...)"]);
    expect(textBodies(report)).toContain("Synthetic fixture values");
    expect(textBodies(report)).toContain("NMR_NO_FRAGMENT_MATCH");
  });
});
