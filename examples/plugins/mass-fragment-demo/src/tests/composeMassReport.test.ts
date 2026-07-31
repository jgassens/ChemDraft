import type { PluginIsotopeEnvelopeResult, PluginSelectedMolecule } from "@chemdraft/plugin-api";
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
  netCharge: 0,
  monoisotopicMass: 78.047,
  averageMass: 78.11,
  ions: [
    { species: "[M+H]+", mz: 79.0542, charge: 1 },
    { species: "[M-H]-", mz: 77.0397, charge: -1 }
  ],
};

/** What the host returns for a neutral structure it could compute. */
const ENVELOPE: PluginIsotopeEnvelopeResult = {
  available: true,
  peaks: [
    { mass: 78.04695, relativeIntensity: 100 },
    { mass: 79.05031, relativeIntensity: 6.49 }
  ],
  truncation: { policy: "relative-intensity-threshold", threshold: 1e-4, coveredProbability: 0.9998 },
  engine: { id: "isospec-wasm", version: "2.3.5" },
  conventions: ["natural abundances from IsoSpec's built-in tables"]
};

describe("composeMassReport", () => {
  it("renders formula/mass, an ion table, an isotope table, and carries the source ref for staleness", () => {
    const panel = composeMassReport(source, report);
    expect(panel.title).toBe("Mass Analysis");
    expect(panel.source).toEqual({ objectId: "m1", sourceFingerprint: "fp1" });
    expect(panel.sections.map((section) => section.kind)).toEqual(["keyValue", "table", "text", "text"]);

    const ionTable = panel.sections.find((section) => section.kind === "table" && section.title?.includes("ions"));
    expect(ionTable && ionTable.kind === "table" && ionTable.rows[0]).toEqual(["[M+H]+", "79.0542", "+1"]);
    expect(ionTable && ionTable.kind === "table" && ionTable.rows[1]).toEqual(["[M-H]-", "77.0397", "-1"]);
    expect(panel.sections[0]).toMatchObject({
      kind: "keyValue",
      rows: expect.arrayContaining([{ label: "Net charge", value: "0" }])
    });
  });

  it("labels a charged structure's native ion and explains why neutral adducts are omitted", () => {
    const charged = composeMassReport(source, {
      ...report,
      formula: "C4H12N",
      netCharge: 1,
      monoisotopicMass: 74.0964,
      averageMass: 74.14,
      ions: [{ species: "[M]+", mz: 74.0964, charge: 1 }]
    });
    const ionTable = charged.sections.find((section) => section.kind === "table" && section.title?.includes("Native"));
    // The LAST text section: the isotope section is also text, and it comes first.
    const note = charged.sections.filter((section) => section.kind === "text").at(-1);

    expect(ionTable && ionTable.kind === "table" && ionTable.rows).toEqual([["[M]+", "74.0964", "+1"]]);
    expect(note && note.kind === "text" && note.body).toContain("neutral-precursor adducts are omitted");
  });

  it("renders the host's envelope, naming the engine that produced it", () => {
    const panel = composeMassReport(source, report, ENVELOPE);
    const table = panel.sections.find((section) => section.kind === "table" && section.title?.startsWith("Isotope"));

    expect(table && table.kind === "table" && table.columns).toEqual(["Mass (Da)", "Rel. intensity"]);
    expect(table && table.kind === "table" && table.rows[0]).toEqual(["78.04695", "100.00 %"]);
    expect(table?.title).toContain("2 peaks");
    expect(table?.title).toContain("% of the distribution");

    // The engine and its conventions travel with the number: which abundance table produced these
    // intensities is not something the plugin may quietly drop on the way to the panel.
    const note = panel.sections.filter((section) => section.kind === "text").at(-2);
    expect(note && note.kind === "text" && note.body).toContain("isospec-wasm 2.3.5");
    expect(note && note.kind === "text" && note.body).toContain("IsoSpec's built-in tables");
  });

  it("says why there is no pattern when the host declined, rather than estimating one", () => {
    const panel = composeMassReport(source, report, {
      available: false,
      reason: "C2H3O2 carries a formal charge of -1."
    });
    const section = panel.sections.find((entry) => entry.kind === "text" && entry.title === "Isotope pattern");
    expect(section && section.kind === "text" && section.body).toContain("carries a formal charge");
    expect(panel.sections.some((entry) => entry.kind === "table" && entry.title?.startsWith("Isotope"))).toBe(false);
  });

  it("says so when chemistry.compute was never granted", () => {
    // Distinct from a decline: nothing was asked, because nothing could be. The retired approximation
    // is deliberately NOT a fallback — a missing capability is reported, not papered over.
    const panel = composeMassReport(source, report);
    const section = panel.sections.find((entry) => entry.kind === "text" && entry.title === "Isotope pattern");
    expect(section && section.kind === "text" && section.body).toContain("chemistry.compute");
  });

  it("renders a source-tagged error report", () => {
    const panel = composeMassErrorReport(source, "boom");
    expect(panel.source).toEqual({ objectId: "m1", sourceFingerprint: "fp1" });
    expect(panel.sections[0]).toMatchObject({ kind: "text", body: "boom" });
  });
});
