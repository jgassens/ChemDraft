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
        mkRes(
          "r5",
          4,
          {
            method: "rule-estimated",
            environmentCode: "E",
            estimator: { id: "rules", version: "1", method: "generic-sp3-carbon" }
          },
          ["rule-estimated"]
        )
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
    expect(figure.spectrum.comparison).toEqual({
      primaryLabel: "HOSE",
      alternativeLabel: "increment",
      alternativeMarker: "ᵢ"
    });
    expect(textBodies(report)).toContain(
      "Additive-increment table calculations are not applicable to any of the 4 HOSE-predicted resonances"
    );
    // Measured-data results carry the reference-solvent context; the synthetic fixture must not.
    expect(figure.spectrum.solvent).toContain("CDCl₃");
    const fixtureFigure = composePredictionReport(source, result).sections.find(
      (section) => section.kind === "linkedFigure"
    );
    expect(fixtureFigure && fixtureFigure.kind === "linkedFigure" ? fixtureFigure.spectrum.solvent : "set").toBeUndefined();
  });

  it("labels an all-rule OCL fallback as coarse rule data, not an experimental-reference prediction", () => {
    const ruleOnly: NmrPredictionResult = {
      ...result,
      backend: { id: "chemdraft.ocl-hose", version: "1", method: "hose-fragment" },
      resonances: [
        {
          id: "estimated",
          nucleus: "1H",
          deltaPpm: 1.2,
          atomRefs: [{ sourceAtomIndex: 0, element: "H", equivalentCount: 3 }],
          equivalentNuclei: 3,
          evidence: {
            method: "rule-estimated",
            estimator: { id: "rules", version: "1", method: "shoolery-alpha-beta-gamma" }
          },
          flags: ["rule-estimated"]
        }
      ],
      warnings: []
    };

    const report = composePredictionReport(source, ruleOnly);
    expect(textBodies(report)).toContain("no HOSE reference match contributed");
    expect(textBodies(report)).not.toContain("Statistical predictions from aggregated experimental reference shifts");
    expect(textBodies(report)).toContain('"label":"Method","value":"rule-estimated"');
    const figure = report.sections.find((section) => section.kind === "linkedFigure");
    expect(figure && figure.kind === "linkedFigure" ? figure.spectrum.solvent : "set").toBeUndefined();
    expect(figure && figure.kind === "linkedFigure" ? figure.caption : "").toContain("Rule-estimated spectrum");
  });

  it("labels a mixed OCL result with separate HOSE and rule provenance", () => {
    const mixed: NmrPredictionResult = {
      ...result,
      backend: { id: "chemdraft.ocl-hose", version: "1", method: "hose-fragment" },
      resonances: [
        {
          id: "matched",
          nucleus: "1H",
          deltaPpm: 7.2,
          atomRefs: [{ sourceAtomIndex: 0, element: "H", equivalentCount: 1 }],
          evidence: { method: "hose-fragment", matchedSphere: 3, sampleCount: 10 },
          flags: []
        },
        {
          id: "estimated",
          nucleus: "1H",
          deltaPpm: 1.2,
          atomRefs: [{ sourceAtomIndex: 1, element: "H", equivalentCount: 3 }],
          evidence: {
            method: "rule-estimated",
            estimator: { id: "rules", version: "1", method: "shoolery-alpha-beta-gamma" }
          },
          flags: ["rule-estimated"]
        }
      ],
      warnings: []
    };

    const report = composePredictionReport(source, mixed);
    expect(textBodies(report)).toContain("Mixed result");
    expect(textBodies(report)).toContain("rule-estimated shifts are marked ≈ in the table");
    expect(textBodies(report)).toContain('"label":"Method","value":"hose-fragment + rule-estimated"');
    const figure = report.sections.find((section) => section.kind === "linkedFigure");
    expect(figure && figure.kind === "linkedFigure" ? figure.spectrum.solvent : "").toContain("CDCl₃");
    expect(figure && figure.kind === "linkedFigure" ? figure.caption : "").toContain("Mixed HOSE and rule-estimated");
    expect(figure && figure.kind === "linkedFigure" ? figure.caption : "").toContain("muted italic peaks");
  });

  it("labels a zero-resonance OCL result as no applicable prediction", () => {
    const empty: NmrPredictionResult = {
      ...result,
      backend: { id: "chemdraft.ocl-hose", version: "1", method: "hose-fragment" },
      resonances: [],
      warnings: [
        { code: "NMR_NO_FRAGMENT_MATCH", message: "Unsupported chemistry was omitted.", severity: "warning" }
      ]
    };
    const report = composePredictionReport(source, empty);
    expect(textBodies(report)).toContain('"label":"Method","value":"no applicable prediction"');
    expect(textBodies(report)).toContain("No applicable resonance was produced");
    expect(textBodies(report)).not.toContain("Statistical predictions from aggregated experimental reference shifts");
  });

  it("uses a method-neutral disclaimer for non-HOSE model results", () => {
    const gnn: NmrPredictionResult = {
      ...result,
      backend: { id: "model", version: "1", method: "gnn" },
      resonances: [
        {
          id: "model-peak",
          nucleus: "1H",
          deltaPpm: 2.1,
          atomRefs: [{ sourceAtomIndex: 0, element: "H" }],
          evidence: { method: "gnn" },
          flags: []
        }
      ],
      warnings: []
    };
    const report = composePredictionReport(source, gnn);
    expect(textBodies(report)).toContain("Method-derived predicted shifts from the reported backend");
    expect(textBodies(report)).not.toContain("Statistical predictions from aggregated experimental reference shifts");
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

  it("carries a disagreeing increment cross-check into the figure peak and the table", () => {
    const estimator = {
      id: "chemdraft.h1-additive-increment",
      version: "1.3.0",
      method: "shoolery-alpha-beta-gamma"
    };
    const withCrossCheck: NmrPredictionResult = {
      ...result,
      resonances: [
        {
          id: "r",
          nucleus: "1H",
          deltaPpm: 2.52,
          atomRefs: [{ sourceAtomIndex: 0, element: "H", equivalentCount: 1 }],
          equivalentNuclei: 1,
          evidence: { method: "hose-fragment", matchedSphere: 1, sampleCount: 5, environmentCode: "X" },
          crossCheck: { incrementPpm: 0.7, disagrees: true, reason: "weak-applicability", estimator },
          flags: []
        }
      ]
    };
    const report = composePredictionReport(source, withCrossCheck);
    const figure = report.sections.find((section) => section.kind === "linkedFigure");
    expect(figure && figure.kind === "linkedFigure" ? figure.spectrum.peaks[0].alternativePpm : undefined).toBe(0.7);
    expect(figure && figure.kind === "linkedFigure" ? figure.spectrum.comparison : undefined).toEqual({
      primaryLabel: "HOSE",
      alternativeLabel: "increment",
      alternativeMarker: "ᵢ"
    });
    expect(figure && figure.kind === "linkedFigure" ? figure.spectrum.domain.min : Infinity).toBeLessThanOrEqual(0.7);
    const table = report.sections.find((section) => section.kind === "table");
    const row = table && table.kind === "table" ? table.rows[0] : [];
    expect(row.some((cell) => cell.includes("vs inc 0.70"))).toBe(true);
    const provenance = report.sections.find(
      (section) => section.kind === "keyValue" && section.title === "Estimate provenance"
    );
    expect(JSON.stringify(provenance)).toContain("chemdraft.h1-additive-increment v1.3.0");
    expect(JSON.stringify(provenance)).toContain("shoolery-alpha-beta-gamma");
    expect(textBodies(report)).toContain("Limited additive-increment comparison");
    expect(textBodies(report)).toContain("exceeds the comparison threshold");
  });

  it("keeps an applicable increment comparison visible even when it is below the disagreement threshold", () => {
    const withCloseCrossCheck: NmrPredictionResult = {
      ...result,
      warnings: [],
      resonances: [
        {
          id: "close",
          nucleus: "1H",
          deltaPpm: 1.2,
          atomRefs: [{ sourceAtomIndex: 0, element: "H", equivalentCount: 3 }],
          equivalentNuclei: 3,
          evidence: { method: "hose-fragment", matchedSphere: 1, sampleCount: 8, environmentCode: "X" },
          crossCheck: {
            incrementPpm: 1.05,
            disagrees: false,
            reason: "high-dispersion",
            estimator: {
              id: "chemdraft.h1-additive-increment",
              version: "1.3.0",
              method: "shoolery-alpha-beta-gamma"
            }
          },
          flags: []
        }
      ]
    };

    const report = composePredictionReport(source, withCloseCrossCheck);
    const figure = report.sections.find((section) => section.kind === "linkedFigure");
    expect(figure && figure.kind === "linkedFigure" ? figure.spectrum.peaks[0].alternativePpm : undefined).toBe(1.05);
    const table = report.sections.find((section) => section.kind === "table");
    expect(table && table.kind === "table" ? table.rows[0].join(" ") : "").toContain("vs inc 1.05");
    const notices = report.sections.find((section) => section.kind === "text" && section.title === "Notices");
    expect(notices && notices.kind === "text" ? notices.body : "").toContain("Coverage is too limited");
    expect(notices && notices.kind === "text" ? notices.body : "").toContain("is within the comparison threshold");
    expect(notices && notices.kind === "text" ? notices.body : "").toContain(
      "broad reference distribution (σ ≥ 0.50 ppm)"
    );
  });

  it("reports exact limited comparison coverage instead of implying molecule-wide agreement", () => {
    const resonances: NmrPredictionResult["resonances"] = Array.from({ length: 4 }, (_, index) => ({
      id: `h-${index}`,
      nucleus: "1H" as const,
      deltaPpm: 5 - index,
      atomRefs: [{ sourceAtomIndex: index, element: "H", equivalentCount: 1 }],
      equivalentNuclei: 1,
      evidence: { method: "hose-fragment" as const, matchedSphere: 3, sampleCount: 12 },
      ...(index === 0
        ? {
            crossCheck: {
              incrementPpm: 4.86,
              disagrees: false,
              reason: "routine-applicability" as const,
              estimator: {
                id: "chemdraft.h1-additive-increment",
                version: "1.3.0",
                method: "functional-class-vinylic"
              }
            }
          }
        : {}),
      flags: []
    }));
    const report = composePredictionReport(source, {
      ...result,
      backend: { id: "chemdraft.ocl-hose", version: "1", method: "hose-fragment" },
      resonances,
      warnings: []
    });
    expect(textBodies(report)).toContain("1 of 4 HOSE-predicted resonances");
    expect(textBodies(report)).toContain("differs from HOSE by 0.14 ppm");
    expect(textBodies(report)).toContain("too limited to assess general agreement");
  });

  it("uses general agreement language only when comparison count and coverage are sufficient", () => {
    const resonances: NmrPredictionResult["resonances"] = Array.from({ length: 3 }, (_, index) => ({
      id: `h-${index}`,
      nucleus: "1H" as const,
      deltaPpm: 3 - index,
      atomRefs: [{ sourceAtomIndex: index, element: "H", equivalentCount: 1 }],
      evidence: { method: "hose-fragment" as const, matchedSphere: 3, sampleCount: 12 },
      crossCheck: {
        incrementPpm: 2.9 - index,
        disagrees: false,
        reason: "routine-applicability" as const,
        estimator: {
          id: "chemdraft.h1-additive-increment",
          version: "1.3.0",
          method: "shoolery-alpha-beta-gamma"
        }
      },
      flags: []
    }));
    const report = composePredictionReport(source, {
      ...result,
      backend: { id: "chemdraft.ocl-hose", version: "1", method: "hose-fragment" },
      resonances,
      warnings: []
    });
    expect(textBodies(report)).toContain("in general agreement with the HOSE predictions");
    expect(textBodies(report)).toContain("3 of 3 HOSE-predicted resonances covered");
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
