import type { PluginSelectedMolecule } from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";

import { composeMassErrorReport, composeMassReport } from "../composeMassReport";
import type { MassReport } from "../massAnalysis";

const source: PluginSelectedMolecule = {
  objectId: "m1",
  documentId: "doc1",
  pageId: "p1",
  structureFormat: "smiles",
  structure: "c1ccccc1",
  sourceFingerprint: "fp1"
};

const report: MassReport = {
  formula: "C6H6",
  monoisotopicMass: 78.047,
  averageMass: 78.11,
  ions: [
    { species: "[M+H]+", mz: 79.0542, charge: 1 },
    { species: "[M-H]-", mz: 77.0397, charge: -1 }
  ],
  isotopePattern: [
    { label: "M", relativeIntensity: 100 },
    { label: "M+1", relativeIntensity: 6.49 }
  ]
};

describe("composeMassReport", () => {
  it("renders formula/mass, an ion table, an isotope table, and carries the source ref for staleness", () => {
    const panel = composeMassReport(source, report);
    expect(panel.title).toBe("Mass Analysis");
    expect(panel.source).toEqual({ objectId: "m1", sourceFingerprint: "fp1" });
    expect(panel.sections.map((section) => section.kind)).toEqual(["keyValue", "table", "table", "text"]);

    const ionTable = panel.sections.find((section) => section.kind === "table" && section.title?.includes("ions"));
    expect(ionTable && ionTable.kind === "table" && ionTable.rows[0]).toEqual(["[M+H]+", "79.0542", "+1"]);
    expect(ionTable && ionTable.kind === "table" && ionTable.rows[1]).toEqual(["[M-H]-", "77.0397", "-1"]);
  });

  it("renders a source-tagged error report", () => {
    const panel = composeMassErrorReport(source, "boom");
    expect(panel.source).toEqual({ objectId: "m1", sourceFingerprint: "fp1" });
    expect(panel.sections[0]).toMatchObject({ kind: "text", body: "boom" });
  });
});
