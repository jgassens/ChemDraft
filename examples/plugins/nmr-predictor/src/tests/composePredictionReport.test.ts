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
    // ¹³C fixture resonance carries no multiplet → Mult./J columns are "—"; no sphere/n → Confidence "—".
    expect(table && table.kind === "table" && table.rows[0]).toEqual([
      "¹³C",
      "128.50",
      "6",
      "—",
      "—",
      "0.40",
      "—",
      "0",
      "Caq0h1(...)"
    ]);
    expect(textBodies(report)).toContain("Synthetic fixture values");
    expect(textBodies(report)).toContain("NMR_NO_FRAGMENT_MATCH");
  });

  it("labels per-peak confidence from match applicability (sphere depth + reference n)", () => {
    const mkRes = (
      id: string,
      deltaPpm: number,
      evidence: NmrPredictionResult["resonances"][number]["evidence"],
      flags: string[] = []
    ): NmrPredictionResult["resonances"][number] => ({
      id,
      nucleus: "1H",
      deltaPpm,
      atomRefs: [{ sourceAtomIndex: 0, element: "H", equivalentCount: 1 }],
      equivalentNuclei: 1,
      evidence,
      flags
    });
    const tiered: NmrPredictionResult = {
      ...result,
      backend: { id: "chemdraft.ocl-hose", version: "1", method: "hose-fragment" },
      resonances: [
        mkRes("r1", 8, { method: "hose-fragment", matchedSphere: 4, sampleCount: 42, environmentCode: "A" }),
        mkRes("r2", 7, { method: "hose-fragment", matchedSphere: 2, sampleCount: 5, environmentCode: "B" }),
        mkRes("r3", 6, { method: "hose-fragment", matchedSphere: 1, sampleCount: 30, environmentCode: "C" }), // shallow → low
        mkRes("r4", 5, { method: "hose-fragment", matchedSphere: 4, sampleCount: 2, environmentCode: "D" }), // sparse → low
        mkRes("r5", 4, { method: "rule-estimated", environmentCode: "E" }, ["rule-estimated"])
      ],
      warnings: []
    };
    const report = composePredictionReport(source, tiered);
    const table = report.sections.find((section) => section.kind === "table");
    if (!table || table.kind !== "table") throw new Error("expected a table section");
    // Confidence is column index 6 (after ± σ); rows are sorted by δ descending, matching input order.
    expect(table.rows.map((row) => row[6])).toEqual([
      "high · s4, n=42",
      "med · s2, n=5",
      "low · s1, n=30",
      "low · s4, n=2",
      "est."
    ]);

    // The same tier reaches the figure peak so the spectrum can mute low/estimated ones (M17a2).
    const figure = report.sections.find((section) => section.kind === "linkedFigure");
    if (!figure || figure.kind !== "linkedFigure") throw new Error("expected a linkedFigure section");
    expect(figure.spectrum.peaks.map((peak) => peak.confidence)).toEqual(["high", "medium", "low", "low", undefined]);
    expect(figure.spectrum.peaks.map((peak) => peak.estimated)).toEqual([undefined, undefined, undefined, undefined, true]);
  });

  it("plots a tight ppm window around the peaks (~1 ppm buffer, not the whole ¹H range)", () => {
    const proton: NmrPredictionResult = {
      ...result,
      resonances: [
        { id: "a", nucleus: "1H", deltaPpm: 9.51, atomRefs: [{ sourceAtomIndex: 0, element: "H", equivalentCount: 1 }], equivalentNuclei: 1, flags: [] },
        { id: "b", nucleus: "1H", deltaPpm: 0.95, atomRefs: [{ sourceAtomIndex: 1, element: "H", equivalentCount: 3 }], equivalentNuclei: 3, flags: [] }
      ]
    };
    const figure = composePredictionReport(source, proton).sections.find((section) => section.kind === "linkedFigure");
    if (!figure || figure.kind !== "linkedFigure") throw new Error("expected a linkedFigure section");
    const { min, max } = figure.spectrum.domain;
    // ~1 ppm below the lowest / above the highest peak, snapped — not the old [-5, 15].
    expect(min).toBeGreaterThan(-1.01);
    expect(min).toBeLessThanOrEqual(0.95);
    expect(max).toBeGreaterThanOrEqual(9.51);
    expect(max).toBeLessThan(11.01);
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
