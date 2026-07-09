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

  it("result report includes an interactive linked figure, provenance, a shift table, notices, and the disclaimer", () => {
    const report = composePredictionReport(source, result);
    const kinds = report.sections.map((section) => section.kind);
    expect(kinds).toContain("linkedFigure");
    expect(kinds).toContain("keyValue");
    expect(kinds).toContain("table");

    const figure = report.sections.find((section) => section.kind === "linkedFigure");
    expect(figure).toBeDefined();
    if (!figure || figure.kind !== "linkedFigure") throw new Error("expected a linkedFigure section");
    expect(figure.spectrum.peaks).toHaveLength(1);
    expect(figure.spectrum.peaks[0].atomIndices).toEqual([0]);
    expect(figure.spectrum.reversed).toBe(true);
    // A fixture result carries no molecule geometry — the spectrum still renders, without structure.
    expect(figure.structure).toBeUndefined();

    const table = report.sections.find((section) => section.kind === "table");
    expect(table && table.kind === "table" && table.rows[0]).toEqual(["¹³C", "128.50", "6", "0.40", "0", "Caq0h1(...)"]);
    expect(textBodies(report)).toContain("Synthetic fixture values");
    expect(textBodies(report)).toContain("NMR_NO_FRAGMENT_MATCH");
  });

  it("carries the 2D depiction into the figure when the backend supplies one", () => {
    const withDepiction: NmrPredictionResult = {
      ...result,
      depiction: {
        atoms: [
          { index: 0, x: 0, y: 0, element: "C" },
          { index: 1, x: 1, y: 0, element: "O" }
        ],
        bonds: [{ from: 0, to: 1, order: 2 }]
      }
    };
    const report = composePredictionReport(source, withDepiction);
    const figure = report.sections.find((section) => section.kind === "linkedFigure");
    if (!figure || figure.kind !== "linkedFigure") throw new Error("expected a linkedFigure section");
    expect(figure.structure?.atoms).toHaveLength(2);
    expect(figure.structure?.bonds[0].order).toBe(2);
  });

  it("stamps the report source for staleness detection (D-09)", () => {
    const report = composePredictionReport(source, result);
    expect(report.source).toEqual({ objectId: "m1", sourceFingerprint: "fp1" });
  });
});
